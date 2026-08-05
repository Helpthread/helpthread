/**
 * Tiny, forward-only migration runner.
 *
 * Migrations are plain SQL, embedded as string CONSTANTS in this file
 * rather than kept as separate `.sql` files on disk. That is deliberate,
 * not a shortcut: CHARTER.md §4 commits Helpthread to a serverless,
 * push-only compute model with no long-lived filesystem to rely on at
 * runtime, and a Vercel build bundles source, not arbitrary sibling files a
 * bundler wasn't told about. Embedding the SQL as TypeScript string
 * literals means `migrate()` needs nothing beyond what got bundled with the
 * rest of the module graph — no `fs.readFile`, no asset-copy build step, no
 * risk of a migration file silently not shipping to a serverless bundle.
 *
 * There is no down-migration support. Forward-only matches how this schema
 * is actually operated (CHARTER.md invariant #4, "main stays releasable") —
 * a bad migration is fixed by shipping a new forward migration that
 * corrects it, not by reversing history on a database that may already have
 * production writes against it.
 */

import type { Db } from './client.js'

/** One forward-only migration: a stable `id`, a human-readable `name`, and its SQL body. */
export interface Migration {
  id: number
  name: string
  sql: string
}

/**
 * Migration 001 — the founding schema: `conversations` and `threads`.
 *
 * A conversation has many threads; a thread is one message (inbound or
 * outbound) — see `src/store/conversations.ts` for the store built on this
 * shape. `gen_random_uuid()` is used as-is from Postgres core: verified
 * against the installed PGlite 0.5.4, which bundles PostgreSQL 18, where
 * `gen_random_uuid()` has been a core built-in (no `pgcrypto` extension
 * needed) since Postgres 13. Supabase's hosted Postgres is likewise modern
 * enough that this needs no extension there either.
 */
const MIGRATION_001_CONVERSATIONS_AND_THREADS = `
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL DEFAULT '',
  customer_email text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  message_id text,
  in_reply_to text,
  from_address text NOT NULL,
  body_text text,
  body_html text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX threads_conversation_id_idx ON threads (conversation_id);
`

/**
 * Migration 002 — outbound delivery status (specs/mail/sending.md §3).
 *
 * An outbound thread is an outbox item: it carries `pending`/`sent`/`failed`
 * to make "persisted" and "delivered" distinct facts (a crash mid-send must
 * never be misreported as delivered). Inbound threads have no delivery
 * concept, so the column stays `NULL` for them.
 *
 * The constraint is a CROSS-COLUMN (table-level) invariant tying status to
 * direction, not a value-only check: an inbound row MUST be `NULL` and an
 * outbound row MUST be one of the three states. This makes the illegal
 * states — an inbound thread marked `'sent'`, or an outbound thread with a
 * `NULL` status invisible to a future delivery worker — unrepresentable at
 * the database level, not merely discouraged in application code (a
 * table-level constraint is added with a separate `ADD CONSTRAINT` because an
 * inline `ADD COLUMN ... CHECK` may only reference its own column).
 */
// NOTE on the explicit \`delivery_status IS NOT NULL\` in the outbound branch:
// a CHECK constraint passes on TRUE *or* NULL (unknown) and only fails on
// FALSE. Without the IS-NOT-NULL guard, an outbound row with a NULL status
// makes \`delivery_status IN (...)\` evaluate to NULL, so the whole CHECK is
// NULL and the row is (wrongly) ACCEPTED — the exact "outbound with no status,
// invisible to the delivery worker" state this constraint exists to forbid.
// The guard forces that case to FALSE so it is rejected.
// The BACKFILL between ADD COLUMN and ADD CONSTRAINT is load-bearing, not
// cosmetic: on a database that already ran migration 001 and stored outbound
// threads, ADD COLUMN gives those rows a NULL delivery_status, which the new
// direction-tied CHECK (with its IS NOT NULL guard) would then REJECT —
// failing the whole migration on any non-fresh database. Backfilling existing
// outbound rows to 'pending' (a truthful "delivery state unknown/unconfirmed"
// for rows that predate delivery tracking) makes them satisfy the constraint
// before it is added. Inbound rows correctly stay NULL.
const MIGRATION_002_ADD_THREAD_DELIVERY_STATUS = `
ALTER TABLE threads ADD COLUMN delivery_status text;
UPDATE threads SET delivery_status = 'pending' WHERE direction = 'outbound' AND delivery_status IS NULL;
ALTER TABLE threads ADD CONSTRAINT threads_delivery_status_by_direction CHECK (
  (direction = 'inbound' AND delivery_status IS NULL)
  OR (direction = 'outbound' AND delivery_status IS NOT NULL AND delivery_status IN ('pending','sent','failed'))
);
`

/**
 * Migration 003 — send idempotency + delivery leasing (HT-16).
 *
 * Three new nullable columns on `threads`, all outbound-only:
 *
 * - `idempotency_key` — the caller-supplied dedup key (`SendReplyInput.idempotencyKey`,
 *   `src/mail/send.ts`). A retry that supplies the SAME key on the SAME
 *   conversation must find the row `appendThread` already created for the
 *   first attempt — never mint a second thread/`Message-ID` for one logical
 *   send. `threads_conversation_idempotency_key_idx` is what makes that
 *   lookup atomic: a PARTIAL unique index (predicate `idempotency_key IS NOT
 *   NULL`) so it only constrains rows that opted into dedup — every row
 *   with a `NULL` key (every inbound thread, and any outbound thread sent
 *   without a key) is invisible to it and never collides with another
 *   `NULL`. `src/store/conversations.ts`'s `appendThread` targets this exact
 *   index with `INSERT ... ON CONFLICT (conversation_id, idempotency_key)
 *   WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING *`, then falls
 *   back to a `SELECT` of the pre-existing row on a conflict (0 rows
 *   returned) — the "atomic get-or-insert" the store module doc describes.
 * - `send_envelope` — a `jsonb` snapshot of `{ to, cc?, subject, references?
 *   }`, written ONCE at insert and read back verbatim on every retry
 *   (worker-driven or caller-replayed). **This is deliberately a snapshot,
 *   not a recomputation.** A retry must resend the EXACT envelope the first
 *   attempt would have sent — recomputing `references` from the
 *   conversation's CURRENT thread list would let mail that arrived *between*
 *   the original attempt and the retry silently change what the retry
 *   sends, which is exactly the kind of silent mail-semantics drift
 *   CHARTER.md invariant #5 forbids. Persisted for every outbound send
 *   (keyed or not) so the delivery worker (`src/mail/delivery-worker.ts`)
 *   can rebuild any eligible row's `OutboundEmail` uniformly, without caring
 *   whether the original call carried a dedup key.
 * - `claimed_until` — a lease: a worker or a keyed-retry `sendReply` call
 *   "claims" a row by setting this to a near-future timestamp (`UPDATE ...
 *   WHERE claimed_until IS NULL OR claimed_until < now()`, an ordinary
 *   Postgres row-level-locked `UPDATE`, so two concurrent claimants can
 *   never both win), attempts delivery, then clears it back to `NULL` when
 *   marking `sent`/`failed`. Kept as its own nullable column, separate from
 *   `delivery_status`, precisely so the existing three-value
 *   `delivery_status` contract (`StoredThread`, the wire `ThreadView`,
 *   specs/api/agent-inbox-v1.md §2) is untouched — a lease is a NEW axis
 *   ("is anyone attempting this right now"), not a fourth delivery state.
 *
 * No backfill step is needed here (unlike migration 002): all three columns
 * are nullable with no `NOT NULL`/CHECK that a pre-existing row could
 * violate by defaulting to `NULL` — an inbound row and a pre-HT-16 outbound
 * row both get `NULL` for all three and satisfy every constraint below
 * as-is.
 *
 * The two CHECK constraints below mirror migration 002's cross-column style
 * and its NULL-semantics care: `(direction = 'outbound') OR (<column> IS
 * NULL)` is TRUE for every inbound row with a NULL column (the only legal
 * inbound state) and for every outbound row regardless of the column's value
 * (outbound may or may not carry one) — and, critically, is a plain boolean
 * OR of two independently-evaluable booleans, so there is no "NULL makes the
 * whole CHECK vacuously pass" trap the way an un-guarded `IN (...)` has
 * (migration 002's comment explains that trap in full).
 */
const MIGRATION_003_SEND_IDEMPOTENCY = `
ALTER TABLE threads ADD COLUMN idempotency_key text;
ALTER TABLE threads ADD COLUMN send_envelope jsonb;
ALTER TABLE threads ADD COLUMN claimed_until timestamptz;
ALTER TABLE threads ADD CONSTRAINT threads_idempotency_key_outbound_only CHECK (
  (direction = 'outbound') OR (idempotency_key IS NULL)
);
ALTER TABLE threads ADD CONSTRAINT threads_send_envelope_outbound_only CHECK (
  (direction = 'outbound') OR (send_envelope IS NULL)
);
CREATE UNIQUE INDEX threads_conversation_idempotency_key_idx ON threads (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`

/**
 * Migration 004 — the four-state conversation status model (HT-26;
 * specs/api/agent-inbox-v1.md §2, v1.1).
 *
 * `ConversationStatus` grows from `open | closed` to `active | pending |
 * closed | spam` (`deleted` unchanged — still never surfaced). `active` is
 * the working state and what v1.0's `open` becomes; `pending` and `spam` are
 * Agent statements, never set automatically (spec §2's status semantics).
 *
 * Statement order is load-bearing: the old CHECK (`conversations_status_check`,
 * migration 001's inline column CHECK under Postgres's default
 * `<table>_<column>_check` naming) forbids `'active'`, so it must be DROPPED
 * before the `open → active` backfill runs — updating first would fail the
 * whole migration on any database with existing rows. The new CHECK is added
 * only after the backfill, when every row satisfies it (same
 * backfill-before-constraint discipline as migration 002). The column DEFAULT
 * moves to `'active'` so `createConversation`'s status-less INSERT (the
 * inbound-mail path) keeps working unchanged — inbound mail creates
 * conversations `active`, per spec.
 */
const MIGRATION_004_FOUR_STATE_CONVERSATION_STATUS = `
ALTER TABLE conversations DROP CONSTRAINT conversations_status_check;
UPDATE conversations SET status = 'active' WHERE status = 'open';
ALTER TABLE conversations ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE conversations ADD CONSTRAINT conversations_status_check CHECK (status IN ('active','pending','closed','spam','deleted'));
`

/**
 * Migration 005 — the human-facing conversation `number` (HT-27;
 * specs/api/agent-inbox-v1.md §2, v1.1).
 *
 * A small sequential per-deployment integer for humans (inbox rows,
 * notifications, "#482" in conversation), assigned from a dedicated sequence
 * at insert. Display-only by contract: the uuid stays the canonical id and
 * `number` is never accepted as an identifier anywhere in the API.
 *
 * Statement order is load-bearing, in the 002/004 backfill-before-constraint
 * tradition:
 *
 * 1. ADD COLUMN (nullable) — existing rows get NULL, legal at this point.
 * 2. BACKFILL existing rows in `(created_at, id)` order via `row_number()` —
 *    the spec's "existing rows are backfilled in creation order" (§2), `id`
 *    as the stable tiebreak for same-instant rows.
 * 3. CREATE SEQUENCE + `setval(max(number) + 1, false)` so the next insert
 *    continues where the backfill left off (on an EMPTY table this is
 *    `setval(1, false)` — the first conversation is #1). The sequence is
 *    OWNED BY the column so a future drop cascades cleanly.
 * 4. Only THEN: SET DEFAULT nextval(...), SET NOT NULL, and the UNIQUE
 *    constraint — each of which every row now satisfies.
 *
 * Postgres resolves the `nextval('conversation_number_seq')` DEFAULT to the
 * sequence's OID at ALTER time (a `regclass` bind, not a runtime name
 * lookup), so the HT-20 Postgres adapter's schema option is honored — the
 * default points at the sequence in the configured schema regardless of the
 * connection's later search_path.
 */
const MIGRATION_005_CONVERSATION_NUMBER = `
ALTER TABLE conversations ADD COLUMN number integer;
UPDATE conversations SET number = numbered.rn FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn FROM conversations) AS numbered WHERE conversations.id = numbered.id;
CREATE SEQUENCE conversation_number_seq;
ALTER SEQUENCE conversation_number_seq OWNED BY conversations.number;
SELECT setval('conversation_number_seq', COALESCE((SELECT max(number) FROM conversations), 0) + 1, false);
ALTER TABLE conversations ALTER COLUMN number SET DEFAULT nextval('conversation_number_seq');
ALTER TABLE conversations ALTER COLUMN number SET NOT NULL;
ALTER TABLE conversations ADD CONSTRAINT conversations_number_key UNIQUE (number);
`

/**
 * Migration 006 — conversation tags + single-Agent assignee (HT-29, HT-31;
 * specs/api/agent-inbox-v1.md §4e/§4f, v1.1).
 *
 * - `tags` is `jsonb NOT NULL DEFAULT '[]'` — a replace-set of short
 *   lowercase labels, always written whole by `setConversationTags` (the
 *   same caller-serialized-JSON convention as `threads.send_envelope`).
 *   jsonb over a normalized tag table on purpose: v1 has no tag-filtered
 *   listing (spec §4e — "display and organization until a real query need
 *   appears"), so a side table would be structure with no query to serve.
 * - `assignee` is nullable text CHECKed to `'me'` — v1 is single-Agent and
 *   the flag is deliberately not identity (spec §4f); the CHECK keeps any
 *   future multi-Agent migration honest about widening it explicitly. The
 *   `IS NULL OR` arm is required, not decorative: a bare `IN ('me')` CHECK
 *   passes NULL anyway (three-valued logic — see migration 002's comment),
 *   but spelling it out records that NULL ("Anyone") is a legal state, not
 *   an accident of SQL semantics.
 *
 * No backfill: both defaults (`'[]'`, `NULL`) are the correct value for
 * every existing row, so ADD COLUMN alone leaves a valid database.
 */
const MIGRATION_006_TAGS_AND_ASSIGNEE = `
ALTER TABLE conversations ADD COLUMN tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE conversations ADD COLUMN assignee text;
ALTER TABLE conversations ADD CONSTRAINT conversations_assignee_check CHECK (assignee IS NULL OR assignee = 'me');
`

/**
 * Migration 007 — the `note` thread direction (HT-28;
 * specs/api/agent-inbox-v1.md §4c, v1.1).
 *
 * An internal note is Agent-only context on a conversation: it rides the
 * `threads` table like mail but is NEVER emailed — no reply token, no outbox
 * row, invisible to the delivery worker (whose queries all scope to
 * `direction = 'outbound'`).
 *
 * Two constraint swaps, both drop-then-re-add (constraints cannot be
 * altered in place), neither needing a backfill — every existing row
 * satisfies the widened versions as-is:
 *
 * - `threads_direction_check` (migration 001's inline column CHECK, under
 *   Postgres's default `<table>_<column>_check` naming) widens to admit
 *   `'note'`.
 * - `threads_delivery_status_by_direction` (migration 002): a note must
 *   have a NULL `delivery_status`, exactly like inbound — delivery is not a
 *   concept for a message that is never sent. Without this swap the OLD
 *   constraint would reject every note row (a note satisfies neither of its
 *   two arms), so the two swaps ship together or not at all.
 */
const MIGRATION_007_NOTE_DIRECTION = `
ALTER TABLE threads DROP CONSTRAINT threads_direction_check;
ALTER TABLE threads ADD CONSTRAINT threads_direction_check CHECK (direction IN ('inbound','outbound','note'));
ALTER TABLE threads DROP CONSTRAINT threads_delivery_status_by_direction;
ALTER TABLE threads ADD CONSTRAINT threads_delivery_status_by_direction CHECK (
  (direction IN ('inbound','note') AND delivery_status IS NULL)
  OR (direction = 'outbound' AND delivery_status IS NOT NULL AND delivery_status IN ('pending','sent','failed'))
);
`

/**
 * Migration 008 — `customer_viewed_at` for open tracking (HT-32;
 * specs/api/agent-inbox-v1.md §4g, v1.1).
 *
 * Nullable, outbound-only (same cross-column CHECK style as migrations
 * 002/003, same NULL-semantics care): the first time a customer's mail
 * client fetches an outbound reply's tracking pixel — feature enabled, token
 * verified — the timestamp is recorded once, idempotently
 * (`ConversationStore.recordThreadView`). Inbound threads and notes never
 * carry one; the schema forbids it, not just the application. No backfill:
 * NULL is the correct value for every existing row (nothing was tracked
 * before the feature existed).
 */
const MIGRATION_008_CUSTOMER_VIEWED_AT = `
ALTER TABLE threads ADD COLUMN customer_viewed_at timestamptz;
ALTER TABLE threads ADD CONSTRAINT threads_customer_viewed_at_outbound_only CHECK (
  (direction = 'outbound') OR (customer_viewed_at IS NULL)
);
`

/**
 * Migration 009 — `mailboxes`, the inbound-ingestion namespace anchor
 * (HT-36; specs/mail/inbound-ingestion.md §2, §7).
 *
 * One row per connected mailbox. `id` is `mailboxId` everywhere else in the
 * mail-ingestion specs (inbound-ingestion.md §2, gmail-push.md §3) — the
 * value every other table this migration group adds is namespaced by, and
 * the anchor for storage, blob keys, and dedup today, and tenancy later
 * (inbound-ingestion.md §7: "the schema carries mailboxId from day one...
 * but behavior is single-tenant for the dogfood").
 *
 * - `address` is UNIQUE: gmail-push.md §3 resolves a push notification's
 *   `emailAddress` to "a known, active connected mailbox" and rejects
 *   anything that doesn't map to exactly one — a duplicate address would
 *   make that resolution ambiguous, so uniqueness is enforced here rather
 *   than trusted to application code.
 * - `provider` is plain `text`, deliberately NOT CHECK-constrained (unlike
 *   `status` below). Constraining it to a fixed list would couple a
 *   provider-agnostic pipeline (inbound-ingestion.md's own framing) to a
 *   schema migration every time a new transport ships an adapter
 *   (`src/providers/inbound-email.ts` already anticipates "Postmark inbound,
 *   SES inbound, etc." arriving as adapter code, not schema changes);
 *   `'gmail'` is simply the only value written today.
 * - `status` IS CHECK-constrained — a mailbox's own lifecycle is a small,
 *   engine-owned set, matching this file's standing convention of
 *   CHECK-constraining every closed-set lifecycle column
 *   (`conversations.status`, `threads.direction`, `threads.delivery_status`).
 *   `'needs_reconnect'` is the state gmail-push.md §5 (an expired/404 history
 *   cursor) and §6 (a failed `watch()` renewal) put a mailbox into —
 *   operator-visible and resolvable, never a silent failure. `'paused'` is
 *   the deliberate dogfood response to §5's expired-cursor case ("pause the
 *   mailbox and flag it for manual rebaseline"). Default `'active'`: a
 *   mailbox starts usable the moment it is connected (HT-40).
 *
 * No `updated_at` trigger: exactly like `conversations`/`threads`, this
 * schema has no auto-bump mechanism anywhere — `updated_at` is maintained by
 * whichever application code writes the row (a later ticket for this table;
 * HT-36 is schema only).
 */
const MIGRATION_009_MAILBOXES = `
CREATE TABLE mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  address text NOT NULL UNIQUE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','needs_reconnect')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`

/**
 * Migration 010 — `mailbox_oauth_tokens`, per-mailbox OAuth credential
 * storage (HT-36, schema only; gmail-push.md §7: "OAuth token
 * acquisition/refresh → HT-38; the connect/consent flow → HT-40").
 *
 * `mailbox_id` is the PRIMARY KEY, not a separate surrogate `id` — this is a
 * per-mailbox singleton (one OAuth grant per connected mailbox today), the
 * same 1:1-sidecar shape `gmail_watch_state` below uses, deliberately kept
 * consistent between the two.
 *
 * ## This migration stores ciphertext. It does not encrypt anything.
 *
 * `refresh_token_ciphertext` is `bytea` — opaque encrypted bytes — and
 * `NOT NULL` because a row only exists once an OAuth grant actually produced
 * a refresh token (HT-40); there is no legal "connected but tokenless" row.
 * **No encryption or decryption logic exists anywhere in this codebase
 * yet.** HT-38 ("OAuth token acquisition/refresh") is the ticket that
 * implements the actual encrypt/decrypt and is the only code ever meant to
 * hold plaintext; this migration only reserves the column shape a
 * ciphertext value will live in. `bytea` (not `text`) because encrypted
 * output is arbitrary binary, not necessarily valid text — and because
 * `SqlValue` (`src/db/client.ts`) already treats `Uint8Array` as a
 * first-class bindable value precisely for columns like this one (see the
 * `pg`/PGlite round-trip proof in `src/db/postgres.test.ts`).
 *
 * `access_token_ciphertext`/`access_token_expires_at` are the short-lived
 * (~1h, for Gmail) OAuth access-token cache — nullable (absent until the
 * first token exchange). The access token is ALSO stored as ciphertext
 * (`bytea`), not plaintext: it is itself a bearer credential that grants
 * mailbox access for its whole lifetime, so a database dump alone must not
 * yield usable mailbox access even for that ~1h window. Encrypting BOTH
 * secrets means an attacker needs the encryption key (held only by HT-38's
 * code, never the DB) to use either — a plaintext access-token column would
 * hand a DB thief ~1h of live mailbox access for free, defeating the point
 * of encrypting the refresh token beside it. As with the refresh token,
 * HT-38 owns the encrypt/decrypt; this migration only reserves the column.
 *
 * `scopes` is raw nullable `text` — the OAuth token endpoint's own
 * space-delimited `scope` string (RFC 6749 §5.1), stored verbatim and
 * unparsed, not a `jsonb` array like `conversations.tags`. This is provider
 * metadata for audit/debugging, not a queried or filtered feature, so no
 * structure is imposed on it until something actually needs one — the
 * `jsonb` alternative is noted as an open option in the implementation
 * report.
 *
 * `ON DELETE CASCADE` mirrors this schema's one existing FK precedent
 * (`threads.conversation_id`, migration 001): a token row has no purpose
 * once its owning mailbox is gone.
 */
const MIGRATION_010_MAILBOX_OAUTH_TOKENS = `
CREATE TABLE mailbox_oauth_tokens (
  mailbox_id uuid PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  refresh_token_ciphertext bytea NOT NULL,
  access_token_ciphertext bytea,
  access_token_expires_at timestamptz,
  scopes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`

/**
 * Migration 011 — `gmail_watch_state`, per-mailbox Gmail push cursor state
 * (HT-36; gmail-push.md §4 "the cursor", §6 "watch() renewal").
 *
 * Kept as its own table, OUT of the generic `mailboxes` schema, on purpose:
 * inbound-ingestion.md's pipeline is provider-agnostic and never reads this
 * table — only the Gmail transport (gmail-push.md) does — so a future
 * non-Gmail provider (the forwarding-address transport, or any other) adds
 * nothing here and this table needs no change for it to ship. Same
 * 1:1-sidecar shape as `mailbox_oauth_tokens`: `mailbox_id` is the PRIMARY
 * KEY (one watch state per mailbox), not a separate surrogate `id`.
 *
 * - `history_id` is `text`, not an integer type, even though Gmail's
 *   `historyId` is numeric-looking. Gmail's own API represents it as a
 *   string, the engine only ever treats it as an opaque watermark —
 *   compared and passed back to `history.list?startHistoryId=`, never
 *   arithmetic'd (gmail-push.md §1: "historyId is a watermark, not a
 *   message id") — and `text` sidesteps any bigint range/precision question
 *   entirely rather than assuming Gmail's values always fit one. Nullable:
 *   a mailbox between connection and its first successful `watch()` call
 *   has no cursor yet.
 * - `watch_expiration` is nullable `timestamptz`: `watch()`'s returned
 *   expiration (~7 days out, gmail-push.md §6), null until the first
 *   successful `watch()`.
 *
 * No `created_at` (unlike `mailboxes`/`inbound_deliveries`): this is a 1:1
 * mutable operational state whose "created" moment adds nothing beyond its
 * owning mailbox's own `created_at` — only `updated_at` is meaningful here,
 * tracking cursor freshness.
 */
const MIGRATION_011_GMAIL_WATCH_STATE = `
CREATE TABLE gmail_watch_state (
  mailbox_id uuid PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  history_id text,
  watch_expiration timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`

/**
 * Migration 012 — `inbound_deliveries`, the delivery ledger
 * (specs/mail/inbound-ingestion.md §4).
 *
 * One row per `(mailbox_id, provider_message_id)` — simultaneously the
 * **idempotency record**, the **claim/lease**, and the **retry queue**.
 * `provider_message_id`, not the RFC `Message-ID`, is the dedup authority:
 * the inbound `Message-ID` is optional and entirely sender-controlled
 * (`NewThread.messageId` permits `null`), while the transport's own id is
 * stable and provider-issued.
 *
 * `id` is a conventional surrogate `uuid` PRIMARY KEY, separate from the
 * UNIQUE claim key below — the same "surrogate PK plus a separate
 * business-key unique index" shape migration 003 uses for `threads`'
 * idempotency key.
 *
 * ## The claim key
 *
 * `inbound_deliveries_mailbox_id_provider_message_id_key` is what the ingest
 * pipeline's step 1 targets: `INSERT ... ON CONFLICT (mailbox_id,
 * provider_message_id) DO NOTHING RETURNING *`. A fresh insert means the
 * caller owns processing; a conflict means a concurrent or prior delivery
 * already claimed or completed it, and the caller must return THAT row's
 * outcome rather than double-process (spec §3 step 1, and §8's "two
 * concurrent deliveries... exactly one conversation" acceptance case).
 *
 * Ordinary `UNIQUE`, not partial: unlike `threads.idempotency_key`
 * (optional, migration 003), `provider_message_id` is always present — the
 * transport rejects a delivery it cannot resolve to one — so every row
 * participates in the constraint.
 *
 * `status` defaults to `'received'`, the state a row is inserted in at the
 * step-1 claim, before parse/thread/store run. The CHECK list is spelled
 * `'dead-letter'` (hyphen) to match the spec's own consistent spelling and
 * the industry-standard "dead-letter queue" term.
 *
 * `attempts`/`last_error` are the retry-queue bookkeeping. No schema-level
 * opinion on the attempts ceiling or backoff: that policy belongs to
 * `src/mail/ingest.ts` and `src/store/inbound-deliveries.ts`.
 *
 * ## `thread_id` is the recorded outcome
 *
 * Nullable, because most statuses (`received`, `suppressed`, `failed`,
 * `dead-letter`) never resolve to a thread. The resulting CONVERSATION is
 * deliberately NOT a second column: a thread belongs to exactly one
 * conversation (`threads.conversation_id`, `NOT NULL`, migration 001), so
 * `thread_id` already determines it. A separate column would be
 * derivable-but-denormalized, and two independent FKs would let a row pair a
 * conversation with a thread from a DIFFERENT conversation — a corrupt
 * outcome the schema should not be able to represent. Join to `threads` when
 * an audit query needs it.
 *
 * Declared a real FK (this schema's convention for id-shaped columns) but
 * `ON DELETE SET NULL` rather than `CASCADE`, unlike migration 001's
 * `threads`: a ledger row's audit and idempotency value — "we received
 * message X for mailbox Y, and here is what happened" — does not depend on
 * the thread it produced still existing. Invariant #1's never-silently-lost
 * applies to the fact of ingestion, so the row survives and only the
 * now-unresolvable pointer clears.
 *
 * ## Two deliberate omissions
 *
 * No cross-column CHECK tying `status` to `thread_id` nullability (e.g.
 * "non-null iff `stored`"): the exact invariant depends on
 * retry/dead-letter edge cases, and this migration is schema-only. Worth
 * adding now that the consuming store methods have settled the question.
 *
 * No index beyond the UNIQUE claim key — the unique index IS the claim key.
 * A `status`-scoped index for a retry-sweep or dead-letter-review query
 * belongs to whichever change implements that query, rather than carrying
 * write-time index cost for a read pattern that does not exist.
 */
const MIGRATION_012_INBOUND_DELIVERIES = `
CREATE TABLE inbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','stored','suppressed','failed','dead-letter')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inbound_deliveries_mailbox_id_provider_message_id_key ON inbound_deliveries (mailbox_id, provider_message_id);
`

/**
 * Migration 013 — `queue_jobs`, the durable Postgres-backed queue behind
 * `createPostgresQueue` (`src/providers/adapters/postgres-queue/`). The
 * production `QueueProvider`: the Gmail push webhook
 * (`src/api/gmail-webhook.ts`) enqueues a reconcile job, and a Vercel Cron
 * tick drains a bounded batch (`PostgresQueue.drainOnce`). Chosen over
 * Vercel Queues (still beta) because it reuses the Supabase Postgres every
 * deployment already provisions.
 *
 * One row per enqueued job, simultaneously the **dedupe record**, the
 * **claim/lease**, and the **retry/dead-letter bookkeeping** — the same
 * three-way framing migration 012 uses for `inbound_deliveries`, applied to
 * outbound queue work.
 *
 * ## Dedupe: a partial unique index
 *
 * `queue_jobs_topic_dedupe_key` constrains `(topic, dedupe_key)` only when
 * `dedupe_key IS NOT NULL` — the shape migration 003's
 * `threads_conversation_idempotency_key_idx` established: only rows that
 * opted into dedup constrain each other, and every `NULL`-key row is
 * invisible to the index, so ordinary enqueues never collide. `enqueue`
 * targets this index with `INSERT ... ON CONFLICT (topic, dedupe_key) WHERE
 * dedupe_key IS NOT NULL AND dead_lettered_at IS NULL DO NOTHING`, so a
 * retried enqueue sharing a `(topic, dedupeKey)` with a still-live job is
 * silently suppressed, matching `EnqueueOptions.dedupeKey`'s contract.
 *
 * The `AND dead_lettered_at IS NULL` arm is a deliberate WIDENING beyond
 * migration 003, not a copy-paste. A `threads` row is never reprocessed
 * after a terminal send state, so 003 needed no such arm. A queue job's
 * dedupe key must become reusable once the job it protected reaches its own
 * terminal failure — otherwise a poison job's key would permanently block
 * every future enqueue for that key, even after an operator fixes the root
 * cause. Excluding dead-lettered rows is what makes re-enqueue possible
 * while still retaining the dead-lettered row.
 *
 * ## `run_after` + `locked_until`: eligible and leased are separate axes
 *
 * `run_after` is the earliest time a job may be claimed — `now()` for an
 * immediate enqueue, later for `delaySeconds` or a backed-off retry.
 * `locked_until` is a lease: `drainOnce`'s claim sets a near-future expiry
 * so a crashed or timed-out worker's claim lapses and the job becomes
 * reclaimable rather than stuck behind a lock nobody will release — the
 * lease shape migration 003's `threads.claimed_until` uses, applied to queue
 * jobs.
 *
 * A job is claimable exactly when BOTH hold: `run_after <= now()` (eligible)
 * AND `locked_until IS NULL OR locked_until < now()` (unleased). Two columns
 * rather than one combined timestamp, because "eligible but currently
 * leased" is a real, common state a single value could not distinguish from
 * "not yet eligible."
 *
 * ## `dead_lettered_at` rows are retained forever
 *
 * A job exhausting its retry ceiling is dead-lettered, not deleted: the
 * column is stamped and the row stays permanently, queryable via
 * `PostgresQueue.getStats()`'s `deadLettered` count or a direct `SELECT ...
 * WHERE dead_lettered_at IS NOT NULL`. CHARTER.md invariant #1 ("never
 * silently drop") applied to queue work, matching migration 012's retention
 * of `inbound_deliveries.status = 'dead-letter'`. Deleting on terminal
 * failure would make "did this job ever run, and why did it fail?"
 * unanswerable during an incident.
 *
 * ## The two indexes
 *
 * - `queue_jobs_topic_dedupe_key` — the dedupe constraint above; also the
 *   lookup a future admin tool would use to find the live job for a key.
 * - `queue_jobs_ready_idx` — `(topic, run_after) WHERE dead_lettered_at IS
 *   NULL`, sized for the drain hot path, which filters to a topic set and
 *   orders by `run_after`. Excluding dead-lettered rows keeps the index from
 *   accumulating entries for jobs that can never be claimed again.
 *   `locked_until` is deliberately NOT indexed: it churns on every
 *   claim/release, and "find the oldest eligible, unleased jobs" is already
 *   served by ordering on `(topic, run_after)` and re-checking
 *   `locked_until` in the claim query's `WHERE`.
 *
 * No CHECK ties `dead_lettered_at` to `attempts`/`max_attempts`: the
 * attempts-vs-ceiling decision is adapter-level policy
 * (`PostgresQueue.drainOnce`'s own `maxAttempts` option — see that module's
 * doc for why it is a call-level knob rather than this row's column), not a
 * database-level invariant. `max_attempts` is retained as head-room for a
 * future per-job override, matching migration 010's reserve-the-column
 * precedent.
 */
const MIGRATION_013_QUEUE_JOBS = `
CREATE TABLE queue_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX queue_jobs_topic_dedupe_key ON queue_jobs (topic, dedupe_key) WHERE dedupe_key IS NOT NULL AND dead_lettered_at IS NULL;
CREATE INDEX queue_jobs_ready_idx ON queue_jobs (topic, run_after) WHERE dead_lettered_at IS NULL;
`

/**
 * Migration 014 — `inbound_deliveries.claimed_until`, the inbound delivery
 * lease (HT-45; `src/store/inbound-deliveries.ts`, specs/mail/inbound-
 * ingestion.md §4).
 *
 * Closes the never-drop gap HT-37 shipped without: a process crash (SIGKILL
 * / OOM / redeploy) between `InboundDeliveryStore.claim` committing
 * `'received'` and the ingest pipeline's step-5 store transaction (or the
 * catch-block `markFailed`) stranded the delivery at `'received'` forever —
 * `claim()` reclaimed a `'failed'` row but had no notion of a `'received'`
 * row's claim ever going stale, so re-delivery just replayed the same stuck
 * `'in-progress'` outcome, and (HT-41's cursor coupling) could block the
 * mailbox's reconcile cursor from ever advancing past it.
 *
 * This is the inbound mirror of migration 003's `threads.claimed_until`
 * (the outbound send lease `ConversationStore.claimThreadForDelivery` reads
 * and writes): a nullable lease timestamp, `NULL` or in the past meaning
 * "free to claim." Unlike migration 003, no new index is added — every
 * lookup here is still by the existing `(mailbox_id, provider_message_id)`
 * unique key (`InboundDeliveryStore.claim`'s own get-or-insert), never a
 * batch scan over `claimed_until`, so there is no query this column needs
 * to speed up.
 *
 * A pre-existing `'received'` row from before this migration has
 * `claimed_until IS NULL` — `InboundDeliveryStore.claim`'s reclaim check
 * treats `NULL` as an already-expired lease (see that module's doc comment),
 * so any delivery already stranded at `'received'` in production becomes
 * immediately reclaimable on its next claim() call, not just newly-stranded
 * ones — a deliberate, desirable side effect of the `NULL`-is-free
 * semantics, not a special backfill case.
 */
const MIGRATION_014_INBOUND_DELIVERY_LEASE = `
ALTER TABLE inbound_deliveries ADD COLUMN claimed_until timestamptz;
`

/**
 * Migration 015 — `thread_attachments` (HT-46): blob-reference rows for
 * inbound attachment bytes.
 *
 * `src/mail/parse.ts`'s `ParsedEmail.attachments` carries bytes; this table
 * carries the reference to where those bytes actually live once the ingest
 * pipeline writes them to the `BlobStore` (specs/mail/inbound-ingestion.md
 * §3's closing paragraph) — never the bytes themselves. One row per
 * attachment, `thread_id` a plain FK (a thread has zero or many), `ON DELETE
 * CASCADE` matching `threads.conversation_id`'s own cascade (migration 001):
 * deleting a thread's row deletes its attachment references with it, the
 * same "storage row lifetime tracks its parent" policy already used
 * throughout this schema. This table does NOT delete the underlying blob
 * object on cascade — `BlobStore` cleanup for an orphaned/cascaded key is
 * left to a future GC pass (see `src/mail/ingest.ts`'s doc comment on why an
 * orphaned blob from an aborted ingest attempt is tolerable), not built here.
 *
 * `blob_key` is the mailbox-namespaced `BlobStore` key
 * (`<mailboxId>/<attachmentId>/<filename>`, `src/mail/ingest.ts`) — an opaque
 * string as far as this table and `BlobStore` itself are concerned (`src/
 * providers/blob.ts`'s key-namespacing contract). `filename` is nullable
 * because `ParsedAttachment.filename` (`src/mail/parse.ts`) is: some
 * attachments (e.g. an inline image referenced only by `Content-Id`) arrive
 * with no `Content-Disposition` filename at all. `size` is `integer`
 * (bytes) — ample headroom below Gmail's ~25MB message cap, the only inbound
 * transport this engine has today.
 */
const MIGRATION_015_THREAD_ATTACHMENTS = `
CREATE TABLE thread_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  filename text,
  content_type text NOT NULL,
  size integer NOT NULL,
  blob_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thread_attachments_thread_id_idx ON thread_attachments (thread_id);
`

/**
 * Migration 016 — the per-mailbox Gmail reconciliation lease (HT-48;
 * specs/mail/gmail-push.md §6, "reconciliation lease → HT-48"). Adds
 * `claimed_until` to `gmail_watch_state` (migration 011) — the inbound
 * analogue of migration 003's `threads.claimed_until` outbound delivery
 * lease, same column name and same `UPDATE ... WHERE claimed_until IS NULL
 * OR claimed_until < now()` claim shape (`GmailWatchStateStore
 * .claimReconcileLease`/`.releaseReconcileLease`, `src/store/gmail-watch-
 * state.ts`).
 *
 * Unlike the outbound lease, there is no accompanying "status" to record on
 * release — this lease guards nothing but redundant Gmail API work
 * (`history.list`/`messages.get`) between a push-triggered reconcile
 * (HT-41) and the daily sweep (HT-42) landing on the SAME mailbox at
 * overlapping times. It is a pure efficiency guard, not a correctness one:
 * `src/mail/gmail-reconcile.ts`'s own cursor-advance rule (step 6) and the
 * ingest pipeline's dedup on `(mailboxId, providerMessageId)`
 * (inbound-ingestion.md §4) already make either ordering safe with no lease
 * at all. A run that cannot claim it retries shortly (a short
 * `backoffSeconds` hint, not an ack) rather than skipping outright — see
 * `src/mail/gmail-reconcile.ts`'s module doc ("Why a failed claim retries
 * instead of acking") for why an unconditional skip can silently drop a
 * message that arrives after the holder's own `history.list` snapshot.
 *
 * No `NOT NULL`/CHECK: `NULL` is "unclaimed," matching `threads.claimed_
 * until`'s own nullability. No index: this column is only ever read via an
 * equality match on the `mailbox_id` PRIMARY KEY (migration 011), which
 * already has its own index.
 */
const MIGRATION_016_GMAIL_RECONCILE_LEASE = `
ALTER TABLE gmail_watch_state ADD COLUMN claimed_until timestamptz;
`

/**
 * Migration 017 — `mailboxes` grows a `'disconnected'` lifecycle status
 * (HT-47; specs/mail/gmail-connect.md's disconnect section). The inverse of
 * HT-40's connect flow (migration 009's original `active`/`paused`/
 * `needs_reconnect` set) needs a FOURTH state: a mailbox an operator has
 * explicitly disconnected, as distinct from `paused` (an automatic,
 * resumable pause the ingest pipeline itself applies, gmail-push.md §5) or
 * `needs_reconnect` (a dead grant awaiting reconnection). `'disconnected'` is
 * a terminal, operator-initiated state — the DEFAULT this ticket chose is to
 * keep the `mailboxes` row (not delete it, preserving the address's history
 * and its `UNIQUE` claim) while deleting its `mailbox_oauth_tokens` and
 * `gmail_watch_state` rows (the disconnect service's own job, `src/mail/
 * gmail-disconnect.ts`) — this migration only widens the CHECK that row's
 * `status` column accepts.
 *
 * Same DROP-then-ADD shape as migration 004/006's own CHECK-constraint
 * widenings: `mailboxes_status_check` is Postgres's default `<table>_
 * <column>_check` name for migration 009's inline column CHECK (no rename,
 * no rewrite needed here — see the module doc's precedent for the exact
 * naming logic). No backfill/UPDATE statement is needed, unlike migration
 * 004's status widening: `'disconnected'` is a brand-new value no existing
 * row could already hold, so there is nothing to migrate INTO the new set,
 * only room to grow.
 */
const MIGRATION_017_MAILBOXES_DISCONNECTED_STATUS = `
ALTER TABLE mailboxes DROP CONSTRAINT mailboxes_status_check;
ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_status_check CHECK (status IN ('active','paused','needs_reconnect','disconnected'));
`

/**
 * Migration 018 — `agents`, `agent_auth_identities`, `agent_mailbox_access`,
 * and the `conversations.assignee` → `assignee_agent_id` swap (HT-54;
 * specs/auth/agents-and-auth.md §3).
 *
 * ## `agents` — the identity (spec §3.1)
 *
 * One row per human support-staff member (never an Assistant — CLAUDE.md's
 * vocabulary rule). `role`/`status` are both CHECK-constrained closed sets,
 * matching this file's standing convention for closed-set lifecycle columns
 * (`conversations.status`, `mailboxes.status`, ...). `email` is written
 * already-lowercased by every application writer (`src/store/agents.ts`
 * normalizes before every INSERT); `agents_email_key` on `lower(email)` is
 * schema-level defense-in-depth, not the only place normalization happens.
 * `status = 'invited'` is produced ONLY by the invite-provisioning path
 * (spec §8) — every other creation path (`/setup`, the admin-set-password
 * fallback) inserts `'active'` directly, so a credential-less `active` row
 * is unrepresentable by construction, not just by application discipline.
 *
 * ## `agent_auth_identities` — how an Agent proves who they are (spec §3.2)
 *
 * The marketplace seam: one row per (Agent, auth method). `secret_hash` is
 * NULL for every non-`'password'` provider (an OAuth module never writes a
 * hash) — nullable rather than a second table, since every row already
 * carries `provider` to discriminate. `UNIQUE (provider, subject)` is the
 * ordinary "no two Agents can claim the same external identity" invariant;
 * `agent_auth_identities_one_password_per_agent` is a SEPARATE, additional
 * invariant that constraint alone cannot express — see the inline SQL
 * comment (kept in the SQL, not just here, because the "why not just the
 * UNIQUE above" reasoning is exactly the kind of non-obvious constraint
 * rationale that belongs beside the DDL it explains, matching how migration
 * 002's NULL-semantics comment lives next to its CHECK).
 *
 * ## `agent_mailbox_access` — schema now, behavior deferred (spec §3.4)
 *
 * Modeled so a future per-Agent mailbox-scoping increment is a store/API
 * change, not a migration against live rows (maintainer, 2026-07-18, spec §12.4).
 * Nothing in this build reads or writes this table — an EMPTY table means
 * "every Agent may access every mailbox" by definition, not by a runtime
 * check anywhere. `PRIMARY KEY (agent_id, mailbox_id)` needs no separate
 * surrogate `id`: this is a pure many-to-many join with no attributes of
 * its own beyond `created_at`.
 *
 * ## `conversations.assignee` → `assignee_agent_id` — breaking (spec §3.3)
 *
 * `assignee` (migration 006) was deliberately NOT identity — a `text CHECK
 * (assignee IS NULL OR assignee = 'me')` flag for the single-operator era.
 * Multi-Agent replaces it with a real FK. **No UPDATE/backfill step**: every
 * existing `'me'` row has no Agent to map to (Agents are created only
 * starting with THIS migration, at first-run) — spec §3.3 is explicit that
 * those rows become unassigned (`NULL`) by construction, simply by the new
 * column defaulting `NULL` and the old column being dropped, not by any
 * migrated value. `ON DELETE SET NULL` (not `CASCADE`): deleting an Agent
 * un-assigns their conversations, it does not delete them — the same
 * "the record outlives the pointer" policy migration 012's
 * `inbound_deliveries.thread_id` already uses. Dropping `assignee` also
 * drops `conversations_assignee_check` (migration 006's CHECK, which
 * references only that column) automatically — Postgres removes a
 * single-column constraint along with the column it's built on, no
 * explicit `DROP CONSTRAINT`/`CASCADE` needed.
 */
const MIGRATION_018_AGENTS_AND_AUTH = `
CREATE TABLE agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  name        text NOT NULL,
  role        text NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  status      text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  timezone    text NOT NULL DEFAULT 'UTC',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agents_email_key ON agents (lower(email));
CREATE TABLE agent_auth_identities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider     text NOT NULL,
  subject      text NOT NULL,
  secret_hash  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject),
  CONSTRAINT agent_auth_identities_password_secret_check
    CHECK (provider <> 'password' OR secret_hash IS NOT NULL)
);
CREATE INDEX agent_auth_identities_agent ON agent_auth_identities (agent_id);
CREATE UNIQUE INDEX agent_auth_identities_one_password_per_agent ON agent_auth_identities (agent_id) WHERE provider = 'password';
CREATE TABLE agent_mailbox_access (
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mailbox_id  uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, mailbox_id)
);
ALTER TABLE conversations ADD COLUMN assignee_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX conversations_assignee_agent ON conversations (assignee_agent_id);
ALTER TABLE conversations DROP COLUMN assignee;
`

/**
 * Migration 019 — `inbound_deliveries.forged_token_count` (HT-44,
 * specs/mail/inbound-ingestion.md §6).
 *
 * Persists `decideThreading`'s `forgedTokenCount` — how many reply-token
 * candidates on this message matched our Message-ID pattern but FAILED
 * signature verification (threading.md §3 rule 3) — onto the delivery's
 * ledger row at the `stored` transition. Until this column, the count
 * existed only as a field on one structured log line, which Vercel's log
 * viewer can display but nothing can aggregate or alert on; a queryable
 * column is what lets the internal health endpoint
 * (`src/composition/health.ts`) compute "forged-token deliveries in the
 * last 24h" and trip an alert on a burst — threading.md §5's security
 * signal, made consumable.
 *
 * Written ONLY by `markStoredInTx` (the `stored` transition): `suppressed`
 * rows never reach the threading decision (the loop guard is step 3, the
 * decision step 4), and the `failed`/`dead-letter` paths abandon the
 * attempt before any outcome write carries the decision — a retried
 * message's count lands when its retry finally stores. Rows predating this
 * migration read the DEFAULT `0` regardless of what their messages
 * actually carried — the signal genuinely begins at this migration, and a
 * backfill is impossible (the raw headers were never retained on the
 * ledger).
 *
 * No index: the health endpoint's aggregate scans a 24h `updated_at`
 * window over a table whose dogfood volume is tens of rows a day, and
 * migration 012's own convention ("no index beyond the UNIQUE claim key"
 * until a real read pattern demands one) still holds at that scale.
 */
const MIGRATION_019_INBOUND_DELIVERY_FORGED_TOKENS = `
ALTER TABLE inbound_deliveries ADD COLUMN forged_token_count integer NOT NULL DEFAULT 0;
`

/**
 * Migration 020 — `assistants`, the AI-actor principal table (HT-68;
 * specs/plugins/substrate-v1.md §3 — the module substrate's assistant
 * principals; "module" here means an out-of-process Helpthread extension,
 * never the legal "plugin exception" phrase CHARTER.md §7 uses).
 *
 * One row per Assistant — an AI actor (never a human; CLAUDE.md's
 * Agents-vs-Assistants vocabulary rule) that authenticates with a
 * `ht_asst_<id>_<secret>` bearer token (spec §3) and may read conversations
 * and post drafts/notes (wave 2/3; this migration is schema only). Created
 * MUST precede migration 021's `threads.author_assistant_id` FK — that
 * ordering, not the spec's own section numbering, is why this table is
 * migration 020 rather than folded into the "actor model" migration that
 * follows it.
 *
 * - `module` (spec §1's additive-forward rule): the slug of the module
 *   operating this Assistant, attributing every row to its owner from day
 *   one so a future `module_installs` bundle references existing rows
 *   instead of backfilling identity. Free text today — no registry exists
 *   yet to validate it against.
 * - `token_hash` — the SHA-256 digest of the token's secret part, compared
 *   constant-time at verification (spec §3). This migration only reserves
 *   the column; hashing and verification are wave 3's concern (this
 *   ticket's boundary excludes auth wiring), matching migration 010's
 *   "reserve the column, a later ticket owns the crypto" precedent.
 * - `status` — `active`/`disabled`, the same two-state closed set
 *   `agent_auth_identities` has no equivalent for for Agents (Agents use
 *   `invited`/`active`/`disabled`, migration 018) — an Assistant has no
 *   invite flow, so `active` is simply the creation default.
 * - `created_by_agent_id` is nullable with `ON DELETE SET NULL`, not `NOT
 *   NULL`/`CASCADE`: matching `conversations.assignee_agent_id`'s "the
 *   record outlives the pointer" policy (migration 018) — deleting the
 *   admin who created an Assistant must not delete or orphan the Assistant
 *   itself, since it may still be actively authenticating.
 */
const MIGRATION_020_ASSISTANTS = `
CREATE TABLE assistants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  module text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`

/**
 * Migration 021 — the `threads` actor model + draft lifecycle
 * (specs/modules/substrate-v1.md §2). Closes a gap that spec names:
 * CHARTER.md §4 promises an authoring-actor-kind and draft-before-send shape
 * "day one," but the shipped schema (migrations 001/007) only ever had
 * `direction IN ('inbound','outbound','note')`. Recorded here rather than
 * coded through.
 *
 * ## `author_kind` + identity (backfill before constraint)
 *
 * Same ordering as migrations 004/005: added nullable, backfilled (`inbound`
 * → `customer`; `outbound`/`note` → `agent`, since every pre-substrate row
 * was human-authored — Assistants did not exist yet), THEN `NOT NULL` and
 * CHECK-constrained.
 *
 * **No column `DEFAULT`.** Every application insert
 * (`src/store/conversations.ts`'s `insertThread`) always computes and
 * supplies `author_kind` explicitly, so a default could only ever mask a
 * hand-written INSERT that forgot the column. That silent-wrong-value risk
 * is exactly what this schema's CHECK-heavy convention exists to avoid. Not
 * even `DEFAULT 'agent'` for fixture convenience: a masking default is worse
 * than giving the handful of raw-SQL fixtures an explicit value (see
 * `src/db/migrate.test.ts`).
 *
 * `threads_author_kind_direction_check` is the invariant a default would
 * have masked: `(direction = 'inbound') = (author_kind = 'customer')` — a
 * biconditional, both sides always boolean, never NULL (`direction` is `NOT
 * NULL` since migration 001, `author_kind` as of the statement above).
 * Inbound mail is ALWAYS customer-authored and only inbound mail is;
 * outbound and note rows may be `'agent'` or `'assistant'` but never
 * `'customer'`. Stronger than the backfill alone: the backfill sets the
 * right value once, this keeps it right forever, rejecting a mislabeled row
 * at insert/update time.
 *
 * `author_agent_id`/`author_assistant_id` need no backfill — `NULL` is the
 * honest value for every backfilled row and every future service-token
 * caller with no acting-agent header (spec §3: "a service-token caller
 * without the header still writes author_kind='agent' with NULL identity").
 * `threads_author_identity_check` makes the three-way rule
 * unrepresentable-otherwise: a `customer` row carries neither id; an
 * `assistant` row carries `author_assistant_id` and never
 * `author_agent_id`; an `agent` row may carry `author_agent_id` and never
 * `author_assistant_id`.
 *
 * ## Draft lifecycle
 *
 * `draft_status` is nullable, legal only on `direction = 'outbound'`
 * (`threads_draft_status_outbound_only`, matching every other outbound-only
 * column, e.g. migration 003's `idempotency_key`) and only from the closed
 * set `awaiting_review`/`approved`/`discarded`
 * (`threads_draft_status_check`). The audit columns (`approved_by_agent_id`,
 * `draft_resolved_at`, `draft_edited`) need no CHECK: they are meaningful
 * only alongside a non-null `draft_status`, which the store layer is
 * responsible for setting together, and no illegal state results from them
 * on a non-draft row.
 *
 * ## The delivery/draft CHECK replacement
 *
 * DROPS migration 007's `threads_delivery_status_by_direction` (whose `note`
 * arm is reproduced verbatim below, not narrowed) and replaces it with two
 * CHECKs:
 *
 * 1. `threads_draft_status_outbound_only` — listed above, but load-bearing
 *    here too: without it the second CHECK says nothing about a `note` row
 *    carrying a stray `draft_status`, since its first arm (`direction IN
 *    ('inbound','note') AND delivery_status IS NULL`) never inspects
 *    `draft_status`.
 * 2. `threads_delivery_draft_status_check` — an unapproved draft
 *    (`awaiting_review`/`discarded`) MUST have `delivery_status IS NULL`, so
 *    it is invisible to the delivery worker, which scopes every query to
 *    `delivery_status IN (...)`. Only `draft_status IS NULL` (an ordinary
 *    send or note) or `'approved'` may carry a real delivery status.
 *
 * **Deviation from spec §2's literal SQL, caught by this migration's own
 * tests.** The spec's predicate omits explicit `IS NOT NULL` guards on both
 * `IN (...)` tests over nullable columns — the second arm's `draft_status IN
 * ('awaiting_review','discarded')` and the third's `delivery_status IN
 * ('pending','sent','failed')`. Copied verbatim, an ordinary outbound row
 * with both columns NULL — never a legal state, since a plain send always
 * carries a delivery status — slipped through: `NULL IN (...)` evaluates to
 * SQL NULL rather than FALSE, both arms evaluated to NULL, and a CHECK
 * treats NULL as a PASS. This is the trap migration 002's doc comment names
 * ("a CHECK constraint passes on TRUE *or* NULL... the guard forces that
 * case to FALSE so it is rejected"). Both guards are restored here rather
 * than reproducing the bug the spec's prose missed.
 *
 * `listDeliverableThreads`/`claimThreadForDelivery` additionally gain an
 * explicit `draft_status IS DISTINCT FROM 'awaiting_review'` guard — belt on
 * top of this CHECK's braces.
 *
 * ## The partial index
 *
 * `threads_awaiting_review_idx` serves
 * `ConversationStore.listAwaitingDrafts` (`GET
 * /api/v1/drafts?status=awaiting_review`, spec §6) — a query shipped in this
 * same change, not speculative head-room, so it lands alongside the column
 * it scans (matching migration 013's `queue_jobs_ready_idx`: an index ships
 * with the query that needs it).
 */
const MIGRATION_021_THREADS_ACTOR_MODEL = `
ALTER TABLE threads ADD COLUMN author_kind text;
UPDATE threads SET author_kind = CASE WHEN direction = 'inbound' THEN 'customer' ELSE 'agent' END;
ALTER TABLE threads ALTER COLUMN author_kind SET NOT NULL;
ALTER TABLE threads ADD CONSTRAINT threads_author_kind_check CHECK (author_kind IN ('customer','agent','assistant'));
ALTER TABLE threads ADD CONSTRAINT threads_author_kind_direction_check CHECK ((direction = 'inbound') = (author_kind = 'customer'));
ALTER TABLE threads ADD COLUMN author_agent_id uuid REFERENCES agents(id);
ALTER TABLE threads ADD COLUMN author_assistant_id uuid REFERENCES assistants(id);
ALTER TABLE threads ADD CONSTRAINT threads_author_identity_check CHECK (
  (author_kind = 'customer' AND author_agent_id IS NULL AND author_assistant_id IS NULL)
  OR (author_kind = 'assistant' AND author_assistant_id IS NOT NULL AND author_agent_id IS NULL)
  OR (author_kind = 'agent' AND author_assistant_id IS NULL)
);
ALTER TABLE threads ADD COLUMN draft_status text;
ALTER TABLE threads ADD CONSTRAINT threads_draft_status_check CHECK (draft_status IS NULL OR draft_status IN ('awaiting_review','approved','discarded'));
ALTER TABLE threads ADD CONSTRAINT threads_draft_status_outbound_only CHECK (draft_status IS NULL OR direction = 'outbound');
ALTER TABLE threads ADD COLUMN approved_by_agent_id uuid REFERENCES agents(id);
ALTER TABLE threads ADD COLUMN draft_resolved_at timestamptz;
ALTER TABLE threads ADD COLUMN draft_edited boolean NOT NULL DEFAULT false;
ALTER TABLE threads DROP CONSTRAINT threads_delivery_status_by_direction;
ALTER TABLE threads ADD CONSTRAINT threads_delivery_draft_status_check CHECK (
  (direction IN ('inbound','note') AND delivery_status IS NULL)
  OR (direction = 'outbound'
      AND draft_status IS NOT NULL AND draft_status IN ('awaiting_review','discarded')
      AND delivery_status IS NULL)
  OR (direction = 'outbound'
      AND (draft_status IS NULL OR draft_status = 'approved')
      AND delivery_status IS NOT NULL AND delivery_status IN ('pending','sent','failed'))
);
CREATE INDEX threads_awaiting_review_idx ON threads (created_at DESC, id DESC) WHERE draft_status = 'awaiting_review';
`

/**
 * Migration 022 — `webhook_endpoints` (HT-68; specs/plugins/substrate-v1.md
 * §5). Schema only — registration/admin API, delivery, and SSRF-pinning are
 * wave 2/3.
 *
 * - `url` carries a cheap defense-in-depth CHECK (`LIKE 'https://%'`)
 *   mirroring spec §5's "https only" posture at the one layer where it costs
 *   nothing to enforce; it is NOT a substitute for the delivery handler's
 *   resolve-then-connect SSRF pinning (spec §5's closing bullet), which
 *   needs a live DNS resolution this migration cannot perform.
 * - `secret_ciphertext` is `bytea`, the same shape `mailbox_oauth_tokens`
 *   (migration 010) reserves for its own secrets — this migration reserves
 *   the column; `src/store/token-crypto.ts`'s existing AES-256-GCM envelope
 *   (iv || authTag || ciphertext, one flat `Uint8Array`) is what the store
 *   layer (`src/store/webhook-endpoints.ts`) writes into it, the same
 *   module `mailbox-tokens.ts` already depends on — no new crypto code, a
 *   second caller of the existing one.
 * - `events` is `jsonb NOT NULL DEFAULT '[]'`, the same "caller-serialized
 *   JSON, persisted verbatim" convention `conversations.tags` (migration
 *   006) uses — a subset of spec §4's event-type list. Whether an empty
 *   array means "no events" or "all events" is an API-layer interpretation
 *   (spec §5: "or all") this migration takes no position on; the column
 *   only stores whatever the caller serializes.
 * - `module text NULL` (spec §1's additive-forward rule, spec §5): the
 *   attribution slug mirroring `assistants.module` above — nullable because
 *   an operator-registered endpoint (not tied to any installed module) is a
 *   legal, unattributed row.
 * - `status` starts `'active'`; `'auto_disabled'` is written only by the
 *   delivery handler's failure path (wave 3) at the consecutive-failure
 *   threshold (spec §5, spec §9 decision 2: 20, admin re-enable);
 *   `'disabled'` is an operator's own deliberate choice, kept as a distinct
 *   value so an auto-disable can never masquerade as (or be silently
 *   overwritten by) a manual one.
 * - `consecutive_failures` is the counter the store layer's
 *   `recordDeliveryFailure`/`recordDeliverySuccess` (`src/store/
 *   webhook-endpoints.ts`) increments/resets — no CHECK on it beyond the
 *   `integer` type; the auto-disable threshold is application logic (the
 *   same "policy lives in the consuming code, not a schema CHECK"
 *   convention migration 013's doc comment uses for `queue_jobs.max_
 *   attempts`).
 */
const MIGRATION_022_WEBHOOK_ENDPOINTS = `
CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL CHECK (url LIKE 'https://%'),
  secret_ciphertext bytea NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  module text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','auto_disabled')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`

/**
 * Migration 023 — `event_outbox` (HT-68; specs/plugins/substrate-v1.md §4).
 * Schema only — emission call sites (every state change §4's vocabulary
 * table lists) and the drain-to-queue step are wave 2/3; this migration
 * only reserves where a transactionally-written event row lives.
 *
 * One row per domain event, written in the SAME transaction as the state
 * change it describes (spec §4: "an event never fires for a change that
 * rolled back, and no committed change silently drops its event") — the
 * transactional-outbox pattern, the only reliable shape serverless allows.
 * `event_id` IS the envelope's `eventId` (spec §4's JSON shape) — the
 * dedupe key carried all the way to the webhook consumer, so the PK doubles
 * as that stable identity rather than a separate surrogate id existing
 * alongside it.
 *
 * `conversation_id` is `NOT NULL REFERENCES conversations(id) ON DELETE
 * CASCADE`: every event type in spec §4's vocabulary table carries a
 * `conversationId` in its envelope — there is no event shape this schema
 * needs to represent without one. `ON DELETE CASCADE` matches migration
 * 001's `threads.conversation_id` precedent, though in practice conversations
 * are only ever soft-deleted (`status = 'deleted'`), never hard-deleted, so
 * this cascade is dormant defense-in-depth rather than a live path.
 *
 * ## Claim/drain bookkeeping — deliberately thinner than `queue_jobs`
 *
 * Unlike migration 013's `queue_jobs` (which IS the retry queue), this
 * table is only the DURABLE STAGING AREA between "the state change
 * committed" and "the drain step handed this off to the real queue" (spec
 * §4: "a drain step... turns outbox rows into QueueProvider deliveries").
 * One outbox row FANS OUT to one `queue_jobs` row PER matching active
 * webhook endpoint (spec §5's subset filter — an event can have several
 * subscribers), keyed `dedupe_key = ` `` `${eventId}:${endpointId}` ``
 * (HT-69, `src/webhooks/outbox-drain.ts`) — per-pair, not per-event, since
 * a single shared `eventId` key would collide the first endpoint's enqueue
 * against every other endpoint's and silently drop their deliveries. A
 * double-enqueue of the SAME pair (a crashed drain retried on the next
 * tick) is harmless per migration 013's own dedupe precedent. ALL retry/
 * backoff/dead-letter bookkeeping for actually delivering an event lives in
 * `queue_jobs`, not here — this table needs no `attempts`/`last_error`/
 * `dead_lettered_at` columns of its own.
 *
 * What it DOES need, mirroring `queue_jobs`'s lease shape narrowly: `locked_
 * until`, so two overlapping drain invocations (an overlapping cron tick, a
 * retry racing a slow run — the same scenario migration 013's doc comment
 * names) don't both read and enqueue the same undispatched batch; and
 * `dispatched_at`, the terminal marker (`NULL` = still pending drain,
 * non-`NULL` = already hand-off-to-queue, never revisited). `event_outbox_
 * ready_idx` is `(occurred_at) WHERE dispatched_at IS NULL`, the same
 * "exclude terminal rows from the hot-path index" shape as `queue_jobs_
 * ready_idx`.
 */
const MIGRATION_023_EVENT_OUTBOX = `
CREATE TABLE event_outbox (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dispatched_at timestamptz,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_outbox_ready_idx ON event_outbox (occurred_at) WHERE dispatched_at IS NULL;
`

/**
 * Migration 024 — `saved_replies` (HT-76; specs/api/agent-inbox-v1.md's
 * saved-replies-and-macros amendment). A saved reply is a per-mailbox
 * reusable message an Agent can post as a reply body; a "macro" is the same
 * row with `actions` attached (a set of state changes to also apply once
 * the reply is sent). The engine's whole job here is DEFINITION storage —
 * applying a macro's `actions` is the client composing this ticket's other
 * two features (`PATCH .../status`, `PUT .../tags`, `PUT .../assignee`) and
 * `POST .../replies`; this table and its API add zero new mail or status
 * semantics of their own.
 *
 * `mailbox_id` is `NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE` —
 * every saved reply belongs to exactly one mailbox (this deployment's
 * single-mailbox dogfood still models it this way, matching
 * `agent_mailbox_access`'s per-mailbox shape, migration 018): a saved reply
 * has no purpose once its owning mailbox is gone, the same "storage row
 * lifetime tracks its parent" policy `thread_attachments` (migration 015)
 * already uses.
 *
 * `body_text` is `NOT NULL` (a saved reply always has plain-text content to
 * post, mirroring `POST .../replies`' own `text` requirement, spec §4a);
 * `body_html` is nullable, matching `threads.body_html`'s own optionality.
 *
 * `actions` is `jsonb NOT NULL DEFAULT '{}'::jsonb` — the SAME
 * caller-serialized-JSON convention `conversations.tags` (migration 006)
 * and `webhook_endpoints.events` (migration 022) already use. Its shape
 * (`{ setStatus?: 'closed'|'pending'; addTags?: string[]; assignToSelf?:
 * bool }`) is validated at the API layer (`src/api/saved-replies.ts`), not
 * by a schema CHECK — the same "this store does not validate against that
 * list; the caller is the only writer" posture `event-types.ts`'s own doc
 * comment states for `event_outbox.type`, chosen here because a CHECK
 * expressive enough to validate nested jsonb shape would be unreadable SQL
 * for a shape that is still likely to grow.
 *
 * `sort_order` is a plain `integer DEFAULT 0` — the display order within a
 * mailbox's list; no uniqueness or gap-free invariant is enforced (an
 * operator/API reorder is free to leave gaps or ties, same "policy lives in
 * the consuming code" posture migration 013's `queue_jobs.max_attempts`
 * doc comment uses).
 */
const MIGRATION_024_SAVED_REPLIES = `
CREATE TABLE saved_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  actions jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_replies_mailbox_id_idx ON saved_replies (mailbox_id);
`

/**
 * Migration 025 — `conversations.snoozed_until` (HT-77;
 * specs/api/agent-inbox-v1.md's snooze amendment to HT-26's status model).
 * A snooze is a TIMED `pending`: an Agent statement that a conversation
 * should come back to `active` on its own at a future moment, layered onto
 * the existing `pending` state rather than adding a fifth
 * `ConversationStatus` value (HT-26's four-state model, migration 004,
 * stays exactly as spec'd — nothing here widens it).
 *
 * `conversations_snoozed_until_pending_only` is the load-bearing invariant:
 * `snoozed_until IS NULL OR status = 'pending'` — a snooze timestamp can
 * only ever be set on a `pending` conversation, never `active`/`closed`/
 * `spam`/`deleted`. This is what makes "plain pending stays manual, timed
 * pending wakes itself" representable at the database level, not merely
 * discouraged in application code — the same CHECK-constrained-invariant
 * discipline this file uses throughout (migration 002's direction-tied
 * delivery_status, migration 021's draft/delivery predicate, etc.). Every
 * write path that changes `status` away from `pending` — `setConversationStatus`
 * (`src/store/conversations.ts`), the inbound-wake reopen branch
 * (`appendThreadInTx`), AND `deleteConversation` (soft delete can target a
 * snoozed `pending` row) — must clear `snoozed_until` to `NULL` in the SAME
 * statement, or this CHECK rejects the write; see those methods' own doc
 * comments for where each does so.
 *
 * No backfill: this is a brand-new nullable column with no existing value
 * that could violate the CHECK — every pre-existing row gets `NULL`, which
 * trivially satisfies `snoozed_until IS NULL OR ...` regardless of its
 * `status`.
 */
const MIGRATION_025_CONVERSATION_SNOOZE = `
ALTER TABLE conversations ADD COLUMN snoozed_until timestamptz;
ALTER TABLE conversations ADD CONSTRAINT conversations_snoozed_until_pending_only CHECK (
  snoozed_until IS NULL OR status = 'pending'
);
`

/**
 * Migration 026 — passkey (WebAuthn) login (HT-75; specs/auth/passkeys.md
 * §2). Three new tables; neither `agents` nor `agent_auth_identities`
 * changes (spec §1: "additive only").
 *
 * ## `webauthn_credentials` (spec §2.1)
 *
 * A provider-owned credential table, deliberately NOT a row shape inside
 * `agent_auth_identities` — the spec's own §2.1 argues this at length
 * (mutable per-use state that would turn a low-write table into a
 * mixed-traffic one; a public key / counter / transports / backup-flags
 * shape that doesn't fit `agent_auth_identities`' one `secret_hash` column).
 * `credential_id` is the WebAuthn authenticator's own id, globally unique
 * (not scoped to `agent_id`) and NOT NULL — it is the lookup key the
 * discoverable-credential authentication ceremony resolves an Agent from
 * BEFORE it knows who is signing in (spec §6.2). `name` is NOT NULL at the
 * database even though optional on the wire (spec §6.1, §9): the API layer
 * defaults a blank/omitted name to `"Passkey — {date}"` before the INSERT
 * ever runs. `sign_count_regression_at` is the HT-44 health-check signal
 * (spec §8) — a marker column, not an audit trail, overwritten on each new
 * Tier-2 regression. `ON DELETE CASCADE` mirrors `agent_auth_identities`'
 * own cascade (migration 018): a deleted Agent's credentials go with them.
 *
 * ## `webauthn_challenges` (spec §2.2, §7)
 *
 * One row per minted WebAuthn ceremony challenge, keyed by its `nonce`
 * (the SAME nonce embedded in the signed `htw.` token, `src/auth/
 * webauthn-token.ts`) — the DB-backed single-use layer a bare signed token
 * cannot provide on its own (spec §7: "a bare signature+TTL check can be
 * satisfied twice"). `ceremony` has three values (`registration` /
 * `authentication` / `step-up`) and is part of BOTH the mint and the
 * consume statement (`AND ceremony = $2`) — the database-level half of
 * spec §7's "ceremony discriminator enforced, not just recorded" fix.
 * `agent_id` is set for registration/step-up (session-bound at mint) and
 * NULL for authentication (pre-identification, spec §6.2's discoverable
 * flow) — nullable, `ON DELETE CASCADE` so a deleted Agent's in-flight
 * challenges go with them same as their credentials.
 *
 * ## `webauthn_stepup_tokens` (spec §2.3, §5)
 *
 * Backs the enrollment-hardening step-up proof (spec §5): a credential
 * mints a durable, independent factor, so registering one requires fresh
 * evidence of an EXISTING factor, not just a live session. Same shape and
 * discipline as `webauthn_challenges` (nonce PK, `expires_at`,
 * `consumed_at`) — a separate table because a step-up token proves a
 * DIFFERENT thing (an existing factor was just demonstrated) than a
 * WebAuthn ceremony challenge does, even though both reuse the identical
 * signed-token-plus-DB-row mechanism. `agent_id` is NOT NULL here (unlike
 * `webauthn_challenges`) — a step-up token always proves step-up for a
 * SPECIFIC, already-session-identified Agent; there is no anonymous case.
 *
 * ## No cron — opportunistic purge on mint (spec §2.2)
 *
 * Neither challenge table gets a cleanup job. `WebAuthnStore`'s mint
 * methods (`src/store/webauthn.ts`) precede every INSERT with `DELETE ...
 * WHERE expires_at < now()` in the SAME transaction, piggybacking the
 * cleanup on a write that was happening anyway (spec §2.2's "the cost of
 * self-cleaning is one indexed DELETE"). The two `_expires` indexes below
 * are what makes that DELETE cheap.
 */
const MIGRATION_026_WEBAUTHN = `
CREATE TABLE webauthn_credentials (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                  uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  credential_id             text NOT NULL,
  public_key                bytea NOT NULL,
  sign_count                bigint NOT NULL DEFAULT 0,
  transports                text[] NOT NULL DEFAULT '{}',
  backup_eligible           boolean NOT NULL,
  backup_state              boolean NOT NULL,
  name                      text NOT NULL,
  sign_count_regression_at  timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  last_used_at              timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON webauthn_credentials (credential_id);
CREATE INDEX webauthn_credentials_agent ON webauthn_credentials (agent_id);
CREATE TABLE webauthn_challenges (
  nonce        text PRIMARY KEY,
  ceremony     text NOT NULL CHECK (ceremony IN ('registration', 'authentication', 'step-up')),
  agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges (expires_at);
CREATE TABLE webauthn_stepup_tokens (
  nonce        text PRIMARY KEY,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX webauthn_stepup_tokens_expires ON webauthn_stepup_tokens (expires_at);
`

/**
 * Migration 027 — close the PostgREST Data API surface.
 *
 * ## What was wrong
 *
 * Supabase exposes the `public` schema through PostgREST, and its stock
 * setup grants `anon` and `authenticated` full
 * `SELECT/INSERT/UPDATE/DELETE/TRUNCATE` there. RLS is what normally makes
 * those grants safe, but no migration up to 026 enabled it, so every table
 * stood open to anyone holding the project's anon key — which is public by
 * design, since it ships to browsers. That is unauthenticated read AND
 * write: dumping `conversations`/`threads`, INSERTing into `agents`,
 * `agent_auth_identities`, `agent_mailbox_access` and
 * `webauthn_credentials` to self-provision an authenticated Agent, or
 * TRUNCATEing the lot. `mailbox_oauth_tokens` is the one partial mercy —
 * its token columns are AES-256-GCM ciphertext
 * (`src/store/token-crypto.ts`) keyed outside the database, so a dump
 * yields ciphertext.
 *
 * Nothing in this codebase uses that surface: the app reaches Postgres
 * directly over the pooler (`DATABASE_URL`, `src/db/postgres.ts`) and
 * Supabase Storage with the `service_role` key. There is no anon-key client
 * anywhere in the repo, which is what makes closing it entirely safe.
 *
 * ## Defence in depth, not either/or
 *
 * Both halves are applied because they fail independently: RLS alone would
 * be undone by a future `GRANT` plus a permissive policy, and revoked grants
 * alone by anything that re-grants.
 *
 * **The `ALTER DEFAULT PRIVILEGES` calls are easy to overrate.** `ALTER
 * DEFAULT PRIVILEGES ... REVOKE` *deletes a default-ACL entry*; it does not
 * install a standing deny. Without `FOR ROLE` it applies only to the role
 * executing it — the one running this migration. So it stops tables created
 * by THIS role from arriving pre-granted, and nothing more. It does not
 * survive Supabase re-running its stock bootstrap, and it does not touch
 * defaults defined for other roles such as `supabase_admin`. The durable
 * protection is the standing rule below.
 *
 * 1. **RLS on every table**, spelled out one `ALTER TABLE` per table rather
 *    than looped, so the set is reviewable in the diff and a table added
 *    later fails loudly by omission instead of being silently swept in. With
 *    no policies attached this is deny-by-default. It does not affect the
 *    application: these tables are owned by `postgres`, and an owner
 *    bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set, which we
 *    deliberately do not set.
 * 2. **Revoke the grants**, including `ALTER DEFAULT PRIVILEGES` subject to
 *    the limits above. `REVOKE ... FROM anon` removes only that role's own
 *    ACL entry — privileges held via the `PUBLIC` pseudo-role are
 *    unaffected, which is why `anon` still reports schema `USAGE`
 *    afterwards. The table-level grants are the gate that matters; schema
 *    `USAGE` alone conveys no access to any table.
 *
 * Neither half hardcodes `public`, because `PostgresDb` supports a `schema`
 * option that puts every table in a named schema. The `ALTER TABLE`s are
 * unqualified, so they resolve wherever search_path finds the table; the
 * revokes then derive that SAME schema from `'conversations'::regclass`
 * rather than `current_schema()`. That distinction is load-bearing and is
 * why the `DO` block below carries its own comment: the two disagree
 * whenever the first entry on search_path is not the schema holding the
 * tables, and picking the wrong one fails silently, leaving the grants in
 * place while reporting success.
 *
 * ## Why the `DO` block
 *
 * `anon`/`authenticated` are Supabase-created roles. They do not exist in
 * PGlite, which the test suite runs `migrate()` against (`createPgliteDb`,
 * `src/db/client.ts`), and an unguarded `REVOKE ... FROM anon` is a hard
 * error when the role is missing — it would fail every test that migrates.
 * The `pg_roles` guard makes the revokes a no-op off Supabase while still
 * applying in production. This block is also why {@link splitStatements} had
 * to learn about dollar quoting.
 *
 * ## Standing rule for future migrations
 *
 * A migration that adds a table MUST also `ENABLE ROW LEVEL SECURITY` on it.
 * The `ALTER DEFAULT PRIVILEGES` above means such a table arrives without
 * anon grants, so RLS is the second layer rather than the only one — but the
 * rule stands so the two stay in step.
 */
export const MIGRATION_027_LOCK_DOWN_DATA_API = `
ALTER TABLE _migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_watch_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_auth_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_mailbox_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_stepup_tokens ENABLE ROW LEVEL SECURITY;
DO $migration027$
DECLARE
  target_schema name;
  role_name text;
  leftover integer;
BEGIN
  -- Resolve the target schema the SAME way the unqualified ALTER TABLEs
  -- above did: by asking where an actual application table landed, not via
  -- current_schema(). Those two rules can DIVERGE — an unqualified name scans
  -- search_path for a schema that CONTAINS the table, while current_schema()
  -- is just the first existing entry on the path — and the failure is silent:
  -- RLS would be enabled in one schema while the revokes hit another, with
  -- the migration reporting success and the grants still in place. Anchoring
  -- to 'conversations'::regclass (migration 001, so always present here)
  -- makes both halves land in the same schema by construction.
  --
  -- Scope this honestly: it is defence, not a fix for a reachable bug. Via
  -- migrate() the divergent state cannot arise today, because migrate()'s own
  -- CREATE TABLE IF NOT EXISTS _migrations uses creation semantics
  -- (current_schema()) — a shadowed search_path makes it land in the leading
  -- schema, find no applied rows, and re-bootstrap every table there, after
  -- which both rules agree. Divergence needs _migrations in one schema and
  -- the app tables in another, which no path here produces. Resolving via
  -- current_schema() would rely on the caller's search_path; this keeps the
  -- migration correct on its own terms instead.
  SELECT n.nspname INTO STRICT target_schema
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = 'conversations'::regclass;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      CONTINUE;
    END IF;
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', target_schema, role_name);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', target_schema, role_name);
    -- ROUTINES, not FUNCTIONS: ALL FUNCTIONS IN SCHEMA covers functions and
    -- aggregates but NOT procedures, which would leave those grants standing.
    EXECUTE format('REVOKE ALL ON ALL ROUTINES IN SCHEMA %I FROM %I', target_schema, role_name);
    EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM %I', target_schema, role_name);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I',
      target_schema, role_name
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I',
      target_schema, role_name
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I',
      target_schema, role_name
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TYPES FROM %I',
      target_schema, role_name
    );
  END LOOP;

  -- Revoking from anon/authenticated by name is not sufficient: a privilege
  -- granted to the PUBLIC pseudo-role is held by EVERY role, so a lone
  -- 'GRANT SELECT ... TO PUBLIC' leaves both of them able to read the table
  -- with no ACL entry of their own to revoke. Relations only — deliberately
  -- NOT routines, where Postgres grants EXECUTE to PUBLIC by default and
  -- stripping it could break an extension living in this schema. Table data
  -- is what the PostgREST surface exposes and what this migration is about.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM PUBLIC', target_schema);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM PUBLIC', target_schema);

  -- Verify rather than assume. REVOKE only strips ACL entries whose GRANTOR is
  -- the executing role (or a role it can act as); against entries granted by
  -- someone else — Supabase's bootstrap runs as supabase_admin — it emits a
  -- warning and completes successfully, leaving the privileges in place. That
  -- is the same silent-success shape the schema resolution above guards
  -- against, and this migration exists precisely to close a hole that nobody
  -- noticed, so it fails loudly rather than reporting a lockdown it did not
  -- achieve. grantee = 0 is PUBLIC, which has no pg_roles row — hence the
  -- LEFT JOIN, so an effective privilege held that way is counted too.
  SELECT count(*) INTO leftover
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN LATERAL aclexplode(c.relacl) acl
    LEFT JOIN pg_roles r ON r.oid = acl.grantee
   WHERE n.nspname = target_schema
     AND c.relkind IN ('r', 'v', 'm', 'p', 'f')
     AND (acl.grantee = 0 OR r.rolname IN ('anon', 'authenticated'));

  IF leftover > 0 THEN
    RAISE EXCEPTION
      'migration 027: % privilege(s) reachable by anon/authenticated (directly or via PUBLIC) remain on relations in schema % after REVOKE. The migrating role is probably not the grantor of those grants, so REVOKE only warned. Re-run as the grantor, or as a role that is a member of it.',
      leftover, target_schema;
  END IF;
END
$migration027$;
`

/**
 * Migration 028 — `imap_mailbox_config`, `imap_mailbox_credentials`,
 * `imap_watch_state` (specs/mail/mailbox-connection.md).
 *
 * Stage 1 (`src/providers/adapters/imap/*`, `smtp/*`) built the pure
 * fetch/send adapters with NO persistence of their own — every dependency
 * (an `ImapClient`, an `SmtpTransporter`) is injected. This migration is
 * where that persistence lands: three per-mailbox sidecar tables, kept OUT
 * of the generic `mailboxes` schema exactly as
 * `mailbox_oauth_tokens`/`gmail_watch_state` (migrations 010/011) are, so
 * `mailboxes` stays provider-agnostic and an IMAP-specific column set adds
 * nothing a future non-IMAP, non-Gmail transport would have to carry. Same
 * 1:1-sidecar shape throughout: `mailbox_id` is the PRIMARY KEY on all
 * three, not a separate surrogate `id`.
 *
 * ## `imap_mailbox_config` — the non-secret connection parameters
 *
 * Host/port for BOTH transports (`imap_host`/`imap_port`,
 * `smtp_host`/`smtp_port`) live in one row, because a single IMAP/SMTP
 * mailbox is configured as one unit in the connect flow this table backs —
 * an operator supplies one server pair and one account, never a fetch-only
 * or send-only half-connection. `username` is one column shared by both
 * transports: for an app-password mailbox the overwhelmingly common case is
 * one account authenticating IMAP and SMTP identically, and a
 * split-credential mailbox is a schema change for whoever needs it rather
 * than a checkbox guessed at now. `secure` defaults `true` (TLS-first);
 * `imapflow`/`nodemailer` both take an explicit boolean, so this is a
 * pass-through, not a schema opinion about either library.
 *
 * ## `imap_mailbox_credentials` — the secret, in its OWN table
 *
 * Deliberately separate from `imap_mailbox_config` rather than one more
 * nullable column on it, which narrows which code path ever `SELECT`s an
 * encrypted column: the connect-flow and settings-display code that reads
 * back host/port/username never has a reason to touch ciphertext. Keeping
 * the secret physically apart makes "this query cannot leak the password"
 * true by construction for every config-only reader, not merely by
 * discipline.
 *
 * `password_ciphertext bytea NOT NULL` — this migration only reserves the
 * column shape, as migration 010 does for `mailbox_oauth_tokens`;
 * `src/store/imap-credentials.ts` does the encrypting, reusing
 * `token-crypto.ts`'s AES-256-GCM envelope rather than inventing a second
 * one.
 *
 * ## `imap_watch_state` — the fetch cursor, reusing `ImapCursor` verbatim
 *
 * `uid_validity`/`last_uid` are the exact two fields of
 * `src/providers/adapters/imap/fetch.ts`'s `ImapCursor`. `bigint`, not
 * `integer`: IMAP UIDs and UIDVALIDITY are unsigned 32-bit (RFC 3501
 * §2.3.1), so `bigint` gives full headroom without the range-overflow
 * question migration 011 sidestepped with `text` for Gmail's `historyId`.
 * An IMAP UID is a true integer counter this store compares and increments,
 * so `bigint` is right here; `pg`/PGlite's string-or-number wire
 * representation is handled the same way `webauthn_credentials.sign_count`
 * already is (`src/store/webauthn.ts`'s `toSignCount`).
 *
 * Both columns are `NOT NULL`, unlike `gmail_watch_state.history_id`
 * (nullable until Gmail's first async `watch()` completes): an IMAP `SELECT
 * INBOX` returns `UIDVALIDITY` synchronously in the same connect-time round
 * trip that establishes the mailbox (`fetch.ts`'s `selectInbox`), so there
 * is no "connected but not yet baselined" gap for this transport — a row is
 * inserted only once both values are known, by
 * `ImapWatchStateStore.seedBaseline`.
 *
 * `claimed_until` is the fetch lease (the never-double-fetch guard), folded
 * in from the start — unlike Gmail's, which shipped two migrations after its
 * cursor (011, then 016). IMAP's overlapping-invocation hazard (a cron tick
 * still running when the next fires) exists from the first cursor-advancing
 * caller, so the lease ships with the cursor rather than as a later patch.
 * Nullable, `NULL` meaning unclaimed — same convention as
 * `gmail_watch_state.claimed_until` and `threads.claimed_until`.
 *
 * `lease_token` is a per-claim `uuid`, and it — not `claimed_until` — is
 * what a holder proves ownership with. Gmail's lease
 * (`GmailWatchStateStore.claimReconcileLease`) uses the rendered
 * `claimed_until::text` as its token, which is too weak to fence a *write*:
 * two successive claims landing within one clock tick mint the SAME token,
 * so a stale holder's compares equal to the live holder's and passes the
 * check. A test forced exactly that collision (2026-07-31). A fresh
 * `gen_random_uuid()` per claim cannot collide regardless of clock
 * resolution. `claimed_until` is retained for expiry (`WHERE claimed_until
 * IS NULL OR claimed_until < now()`), the token for ownership — two
 * questions, both needed.
 *
 * **The same weakness remains in `gmail_watch_state`'s timestamp-derived
 * token.** Not fixed here and filed as a follow-up; Gmail's token guards
 * only `releaseReconcileLease`, never a cursor advance, so the blast radius
 * there is a prematurely-cleared lease rather than a corrupted cursor.
 *
 * ## RLS, per migration 027's standing rule
 *
 * All three tables `ENABLE ROW LEVEL SECURITY` here. Migration 027 enabled
 * RLS on every table existing at that point and states the rule: a migration
 * that adds a table MUST also enable RLS on it. These are created AFTER 027
 * runs, so it cannot cover them — without this they would ship reachable
 * through the PostgREST Data API, and `imap_mailbox_credentials` holds
 * encrypted app passwords.
 *
 * No index beyond each PRIMARY KEY: every lookup across all three tables is
 * a single-row fetch by `mailbox_id`, which the PK already serves.
 */
const MIGRATION_028_IMAP_TRANSPORT = `
CREATE TABLE imap_mailbox_config (
  mailbox_id uuid PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  imap_host text NOT NULL,
  imap_port integer NOT NULL CHECK (imap_port BETWEEN 1 AND 65535),
  smtp_host text NOT NULL,
  smtp_port integer NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
  username text NOT NULL,
  secure boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE imap_mailbox_credentials (
  mailbox_id uuid PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  password_ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE imap_watch_state (
  mailbox_id uuid PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  uid_validity bigint NOT NULL CHECK (uid_validity BETWEEN 0 AND 4294967295),
  last_uid bigint NOT NULL CHECK (last_uid BETWEEN 0 AND 4294967295),
  claimed_until timestamptz,
  lease_token uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE imap_mailbox_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE imap_mailbox_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE imap_watch_state ENABLE ROW LEVEL SECURITY;
`

/**
 * Migration 029 — `conversations.mailbox_id`, recording which connected
 * mailbox took inbound delivery of a conversation's first message (HT-101
 * Stage 2b-i; the per-inbox outbound-routing foundation Stage 2b-ii builds
 * on).
 *
 * Nullable, with NO backfill: every conversation that exists before this
 * migration runs legitimately has no known mailbox (the column didn't exist
 * when they were created, and this migration does not guess one), and
 * `NULL` is exactly the value Stage 2b-ii's send path will read as "no
 * mailbox on record — fall back to the deployment's default sender."
 * `src/mail/ingest.ts` stamps this column ONLY on the `'new'`-conversation
 * branch, from the inbound `RawInboundMessage`'s own `mailboxId` (already in
 * scope there — see `src/providers/inbound-email.ts`) — a reply threaded
 * onto an EXISTING conversation never touches this column, so the value
 * recorded here is always the mailbox that took the conversation's very
 * first inbound message, never overwritten by a later reply that happens to
 * arrive at a different connected mailbox.
 *
 * Not `CASCADE`: the same "the record outlives the pointer" policy migration
 * 018 already applies to this table's `assignee_agent_id` — deleting a mailbox
 * must never delete customer conversations. The exact action is `RESTRICT`,
 * for the reasons in the section below. **Not `SET NULL`.**
 *
 * No index: nothing yet queries "every conversation for mailbox X" — the
 * one planned reader (Stage 2b-ii's send path) looks up ONE conversation's
 * own `mailbox_id` alongside its already-indexed primary key, the same
 * "no index needed, this is only ever read via a single-row fetch"
 * reasoning migration 028's doc comment applies to its own `mailbox_id`
 * columns.
 *
 * ## `ON DELETE RESTRICT`, not `SET NULL`
 *
 * `ON DELETE SET NULL` silently violates provenance. `NULL` already has a
 * meaning here — "this conversation predates the column, so send from the
 * deployment default" (`../mail/sender-resolver.ts`'s `resolve(null)`).
 * `SET NULL` overloads that same value with a second, incompatible meaning:
 * "this conversation HAD an inbox and it was deleted." The two are
 * indistinguishable afterwards, so deleting a mailbox would silently reroute
 * every one of its in-flight replies through the default inbox — changing the
 * `From:` address a customer sees mid-thread, with no error anywhere.
 * CHARTER.md §2 makes authorship explicit; a transport that quietly re-signs
 * a reply as somebody else is exactly what that forbids.
 *
 * `RESTRICT` makes the ambiguous state unrepresentable rather than handling
 * it: a mailbox that still owns conversations cannot be deleted, so `NULL`
 * keeps its single original meaning forever. No product code path deletes a
 * `mailboxes` row today (disconnect sets `status`, it does not delete), so
 * this constrains nothing that currently happens — it closes the door before
 * something walks through it. A future "delete a mailbox" feature must decide
 * deliberately what happens to its conversations; that is a product decision,
 * not something a foreign-key action should answer by default.
 */
const MIGRATION_029_CONVERSATION_MAILBOX_ID = `
ALTER TABLE conversations ADD COLUMN mailbox_id uuid REFERENCES mailboxes(id) ON DELETE RESTRICT;
`

/**
 * Migration 030 — the operator-deployer persistence layer (HT-119):
 * `vercel_connections`, `module_installs`, `module_install_events`.
 *
 * The schema half of "the operator's own engine deploys paid modules into
 * the operator's OWN Vercel account" (CHARTER.md's
 * never-hold-operator-credentials, never-host-anything invariant). Nothing
 * here talks to Vercel — that is `src/providers/adapters/vercel-deployer/`.
 * This migration's job is to make the state that adapter reads and writes
 * impossible to corrupt: the thing modeled is a team-admin-equivalent
 * bearer credential plus a multi-network-call pipeline that can crash,
 * retry, or race with itself at any step.
 *
 * ## `vercel_connections` — exactly one operator credential, ever active
 *
 * One row per connected Vercel account: `team_id`, its encrypted bearer
 * token, who connected it, and a `token_fingerprint` for display.
 *
 * - **`team_id` is immutable once set.** Every `module_installs` row
 *   hanging off a connection must be able to trust it always targets the
 *   SAME team. `team_id` is `NOT NULL` from the first INSERT — there is no
 *   "connected, pending verification" row with a NULL team;
 *   `last_verified_at` is the nullable field modeling that — and immutable
 *   via the `vercel_connections_team_id_immutable` trigger: an `UPDATE`
 *   changing `team_id` is rejected at the database, not merely by
 *   `src/store/vercel-connection.ts` never issuing one. A CHECK cannot
 *   compare against a row's OLD value, so this needs a trigger.
 * - **`token_ciphertext bytea NOT NULL`** holds the SAME `iv || authTag ||
 *   ciphertext` envelope `src/store/token-crypto.ts` defines for mailbox
 *   OAuth tokens and IMAP app passwords (migrations 010, 028) — one crypto
 *   format, three callers. The plaintext is never a column, and
 *   `VercelConnectionStore.getToken`'s decrypted return value must never
 *   cross an HTTP response boundary (same discipline as
 *   `ImapCredentialStore.getPassword`).
 * - **`token_fingerprint text NOT NULL`** is a short ONE-WAY display value
 *   (a truncated hex digest, computed by the store; this migration only
 *   reserves the column) so an operator can confirm which token is
 *   connected without the engine holding, logging, or returning the
 *   reversible secret.
 * - **Exactly one active connection is a database invariant, not app
 *   logic.** `revoked_at timestamptz` (`NULL` while live) plus
 *   `CREATE UNIQUE INDEX ... ON vercel_connections ((true)) WHERE
 *   revoked_at IS NULL`: indexing the constant `true` gives the partial
 *   index exactly one possible key, so Postgres rejects a second live row
 *   even under concurrent inserts. `revoked_at` rather than a hard DELETE
 *   keeps history — including every `module_installs` row referencing it —
 *   and leaves room for a reconnect flow (revoke, then insert).
 * - **`connected_by_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE
 *   RESTRICT`** — step-up gating is meaningless if nobody can later answer
 *   "which agent connected this." No product path deletes an `agents` row
 *   today (agents are disabled, not deleted — migration 018).
 *
 * ## `module_installs` — the install state machine
 *
 * One row per (module, domain, environment) install attempt. This
 * migration makes illegal STATES unrepresentable; which TRANSITIONS are
 * legal is application logic in `src/store/module-installs.ts`,
 * deliberately not encoded here — legal edges change far more often than
 * the state set, and a CHECK per edge would need a migration per tweak.
 *
 * - **`idempotency_key text NOT NULL UNIQUE`** is the one true dedupe key,
 *   upserted against by `ModuleInstallStore.create` with the same
 *   `INSERT ... ON CONFLICT ... DO NOTHING` / fallback-`SELECT` shape
 *   `InboundDeliveryStore.claim` uses. A retried install call after a
 *   timeout can never create two competing rows. `module_slug`,
 *   `entitlement_id`, `domain`, and `environment` are plain columns, not
 *   part of a composite key, because "every install for entitlement X" and
 *   "every install for domain Y" must be readable independently of
 *   idempotency. `environment` is CHECK-constrained to `'production'` or
 *   `'preview'` — Vercel's own vocabulary, and nothing needs a third value.
 * - **`lease_token uuid NOT NULL` fences every transition, not just
 *   retries.** Re-minted by every successful `create` and `transition`, it
 *   is the same claim-generation concept `inbound_deliveries.attempts`
 *   serves and `postgres-queue` uses for lease-fenced dequeues, applied to
 *   a longer many-step pipeline. `transition` fences its `UPDATE` on
 *   `state = fromState AND lease_token = fenceToken`, so a worker stalled
 *   past its lease can never resurrect an install another worker has since
 *   reclaimed. Every step commits and returns control between Vercel API
 *   calls — never a DB transaction across a network call — so a crash
 *   between steps is expected, not exceptional. `lease_expires_at
 *   timestamptz` is the wall-clock half a reconciler reads to decide a
 *   lease is stale: the token proves generation, the timestamp answers when
 *   a NEW generation may reclaim.
 * - **Remote resource ids are nullable and written as they are won.**
 *   `remote_project_id`, `remote_deployment_id text` are not filled at row
 *   creation; the orchestrator writes each the instant its Vercel call
 *   returns success, in its own commit, never batched with the call that
 *   produced it. A row legitimately sits at `state = 'project_created'`
 *   with `remote_project_id` set and `remote_deployment_id` still `NULL` —
 *   the intended recoverable shape, since the created remote object is now
 *   on record and never has to be guessed at or double-created.
 * - **`previous_active_deployment_id text`** is written once, as a NEW
 *   deployment is about to take over from a currently-active one, and read
 *   by the rollback path (`state = 'rollback_pending'`). A plain column,
 *   not derived from `module_install_events`, so a rollback never replays
 *   history to find its target.
 * - **Retry bookkeeping**: `attempt integer NOT NULL DEFAULT 0`,
 *   `last_error_class text`, `next_retry_at timestamptz` — the same triad
 *   `queue_jobs` (migration 013) carries. `last_error_class` is a
 *   CLASS/CODE, never a raw message: an adapter error touching this
 *   credential must be classified before it reaches storage, in case the
 *   underlying Vercel error string echoes request details back.
 * - **`state`**: `planned` → `credentials_issued` → `project_created` →
 *   `artifact_uploaded` → `deployment_created` → `build_pending` →
 *   (`build_failed` | `bootstrap_pending`) → `endpoint_verified` →
 *   `active` is the happy path. No build step ever runs on module code, so
 *   `build_pending`/`build_failed` describe VERCEL processing an
 *   already-prebuilt artifact, never a build the engine triggers.
 *   `bootstrap_pending` → `endpoint_verified` is the candidate-then-cutover
 *   gate: a deployed module proves possession of its webhook endpoint via a
 *   signed challenge BEFORE `active` routes traffic to it, so a module that
 *   never proves possession never leaves `bootstrap_pending`. Failure and
 *   recovery branches: `verification_failed` (reachable only on this NEW
 *   install — nothing here touches whatever is currently `active` for the
 *   domain), `rollback_pending` (restores via
 *   `previous_active_deployment_id`), `cleanup_required` (remote resources
 *   needing teardown), and `abandoned` (terminal give-up).
 *
 * ## `module_install_events` — append-only, never mutated
 *
 * One row per transition: `from_state` NULLABLE (the creation event has no
 * prior state), `to_state` NOT NULL. Postgres has no insert-only-table
 * primitive short of revoking UPDATE/DELETE from the app's role, which
 * would break every other table, so the append-only contract is enforced by
 * `src/store/module-installs.ts` never exposing an update or delete method
 * — the same way `_migrations` relies on nothing writing it another way.
 *
 * `actor_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL` — unlike
 * `vercel_connections.connected_by_agent_id`, an audit attribution may go
 * anonymous without invalidating its row: the event (`from_state`,
 * `to_state`, `at`, `detail`) stays meaningful with no actor. `detail jsonb
 * NOT NULL DEFAULT '{}'::jsonb` carries per-transition detail (a deployment
 * id, an error class, a challenge nonce) without a schema change per field.
 *
 * ## RLS, per migration 027's standing rule
 *
 * All three tables `ENABLE ROW LEVEL SECURITY` here: they are created AFTER
 * 027 runs, so its blanket lockdown cannot cover them, and
 * `vercel_connections.token_ciphertext` is exactly the kind of column that
 * must never be reachable through the PostgREST Data API.
 */
const MIGRATION_030_MODULE_DEPLOYER = `
CREATE TABLE vercel_connections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id                 text NOT NULL,
  token_ciphertext        bytea NOT NULL,
  token_fingerprint       text NOT NULL,
  connected_by_agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  connected_at            timestamptz NOT NULL DEFAULT now(),
  last_verified_at        timestamptz,
  revoked_at              timestamptz
);
CREATE UNIQUE INDEX vercel_connections_one_active ON vercel_connections ((true)) WHERE revoked_at IS NULL;
CREATE FUNCTION vercel_connections_team_id_immutable() RETURNS trigger AS $team_id_guard$
BEGIN
  IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    RAISE EXCEPTION 'vercel_connections.team_id is immutable once set (row %, old %, new %)',
      OLD.id, OLD.team_id, NEW.team_id;
  END IF;
  RETURN NEW;
END;
$team_id_guard$ LANGUAGE plpgsql;
CREATE TRIGGER vercel_connections_team_id_immutable
  BEFORE UPDATE ON vercel_connections
  FOR EACH ROW EXECUTE FUNCTION vercel_connections_team_id_immutable();

CREATE TABLE module_installs (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key                text NOT NULL UNIQUE,
  module_slug                    text NOT NULL,
  entitlement_id                 text NOT NULL,
  domain                         text NOT NULL,
  environment                    text NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'preview')),
  vercel_connection_id           uuid NOT NULL REFERENCES vercel_connections(id) ON DELETE RESTRICT,
  remote_project_id              text,
  remote_deployment_id           text,
  desired_release_version        text NOT NULL,
  artifact_digest                text NOT NULL,
  manifest_key_id                text NOT NULL,
  config_generation               integer NOT NULL DEFAULT 1,
  previous_active_deployment_id  text,
  state                          text NOT NULL DEFAULT 'planned' CHECK (state IN (
                                    'planned', 'credentials_issued', 'project_created',
                                    'artifact_uploaded', 'deployment_created', 'build_pending',
                                    'build_failed', 'bootstrap_pending', 'endpoint_verified',
                                    'active', 'verification_failed', 'rollback_pending',
                                    'cleanup_required', 'abandoned'
                                  )),
  attempt                        integer NOT NULL DEFAULT 0,
  lease_token                    uuid NOT NULL DEFAULT gen_random_uuid(),
  lease_expires_at               timestamptz,
  last_error_class               text,
  next_retry_at                  timestamptz,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX module_installs_vercel_connection ON module_installs (vercel_connection_id);
CREATE INDEX module_installs_entitlement ON module_installs (entitlement_id);
CREATE INDEX module_installs_domain ON module_installs (domain);

CREATE TABLE module_install_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id       uuid NOT NULL REFERENCES module_installs(id) ON DELETE CASCADE,
  from_state       text,
  to_state         text NOT NULL,
  actor_agent_id   uuid REFERENCES agents(id) ON DELETE SET NULL,
  at               timestamptz NOT NULL DEFAULT now(),
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX module_install_events_install ON module_install_events (install_id, at);

ALTER TABLE vercel_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_install_events ENABLE ROW LEVEL SECURITY;
`

/**
 * Migration 031 — `webhook_endpoints(url)` uniqueness (HT-119).
 *
 * Before this, `WebhookEndpointStore.create` had no way to refuse two
 * endpoints pointed at the SAME url: two workers racing to bootstrap the
 * same module install (or a crash-retry re-running `stepBootstrapPending`
 * against the same deployment url) could each insert their own row,
 * leaving every future conversation event delivered twice, forever, with
 * only one of the two duplicates ever referenced by an install. The store
 * layer now inserts with `ON CONFLICT (url) DO NOTHING`, coalescing a
 * second attempt onto the row a first attempt already created instead of
 * duplicating it — this index is what makes that conflict exist to catch
 * in the first place.
 *
 * ## Existing duplicates, on a self-hosted operator's own database
 *
 * Migrations here are forward-only and applied inside one transaction (see
 * {@link migrate}'s doc) — a `CREATE UNIQUE INDEX` that fails on pre-existing
 * duplicate rows aborts this migration AND every migration after it,
 * forever, until an operator hand-edits their data. This engine's own
 * production database holds zero `webhook_endpoints` rows as of this
 * migration, so that failure is not reachable here — but this is the public
 * engine repo, and a self-hosting operator who registered webhooks by hand
 * (or ran an earlier, pre-031 build long enough to accumulate a genuine
 * duplicate) cannot be assumed to be in the same position.
 *
 * So this migration DE-DUPLICATES before creating the index, deterministically
 * and without deleting anything:
 *
 * - Per `url`, the row with the latest `created_at` (ties broken by `id`) is
 *   the keeper — the newest registration is the one most likely still
 *   correct/in-use.
 * - Every OTHER row sharing that `url` is flipped to `status = 'disabled'`
 *   (an operator-facing state this table already has — migration 022's
 *   doc — never auto-re-enabled) and has its `url` rewritten to
 *   `<original>#duplicate-<id>`, a value the `https://%` CHECK still accepts
 *   (the prefix is untouched) but that can never collide with the keeper or
 *   any other row. The row survives, inspectable and disabled, instead of
 *   being deleted — an operator can recover its original url from the
 *   suffix and re-register it by hand if it turns out it wasn't really a
 *   duplicate of the keeper.
 *
 * After this runs, `url` is unique across every row by construction, and
 * `CREATE UNIQUE INDEX` always succeeds.
 */
const MIGRATION_031_WEBHOOK_ENDPOINTS_URL_UNIQUE = `
WITH ranked AS (
  SELECT id, url,
         row_number() OVER (
           PARTITION BY url ORDER BY created_at DESC, id DESC
         ) AS rank
  FROM webhook_endpoints
)
UPDATE webhook_endpoints
SET status = 'disabled',
    url = webhook_endpoints.url || '#duplicate-' || webhook_endpoints.id::text
FROM ranked
WHERE webhook_endpoints.id = ranked.id
  AND ranked.rank > 1;

CREATE UNIQUE INDEX webhook_endpoints_url_unique ON webhook_endpoints (url);
`

/**
 * Migration 032 — `module_install_credential_escrow` (HT-119).
 *
 * `module_install_events` (migration 030) is append-only and permanent by
 * design — exactly the wrong home for the ONE thing an install pipeline
 * needs to carry across a crash before its Assistant token and webhook
 * signing secret are baked into the deployed module's env vars: a
 * recoverable, plaintext-decryptable copy of those credentials. Recording
 * that ciphertext on an audit event means it never leaves, ever, even
 * though the recovery need it exists for ends the moment the install
 * reaches `active` (the secret is now live in the deployment) or any
 * terminal state (there is nothing left to recover into).
 *
 * This table holds exactly that recoverable copy, and nothing else:
 *
 * - `install_id uuid NOT NULL UNIQUE REFERENCES module_installs(id) ON
 *   DELETE CASCADE` — one row per install, ever. `UNIQUE` is what makes
 *   `src/store/module-installs.ts`'s escrow upsert (`ON CONFLICT
 *   (install_id) DO UPDATE`) coalesce onto the SAME row rather than
 *   accumulating one per mint attempt; `ON DELETE CASCADE` (unlike
 *   `vercel_connections.connected_by_agent_id`'s `RESTRICT`) is correct
 *   here because this row's only reason to exist is the install it
 *   belongs to — nothing else in this schema ever references it back.
 * - `ciphertext bytea NOT NULL` — the SAME `iv || authTag || ciphertext`
 *   envelope `src/store/token-crypto.ts` already defines for every other
 *   encrypted-at-rest secret in this codebase (migrations 010, 028, 030's
 *   `vercel_connections.token_ciphertext`), reused rather than reinvented.
 * - `created_at timestamptz NOT NULL DEFAULT now()` — informational only;
 *   nothing reads it to decide when to expire a row. Deletion is driven by
 *   the install's own lifecycle (see below), never by age.
 *
 * The row is written (via `ModuleInstallStore.transition`'s
 * `credentialCiphertext` option, in the SAME transaction as the
 * `credentials_issued` state write) and deleted (via that same method's
 * `deleteCredentialEscrow` option, in the SAME transaction as the
 * transition into `active` or into any terminal failure state) — never by
 * a standalone statement outside a fenced transition, so this row's
 * lifetime is always exactly as long as, and no longer than, the recovery
 * need it exists for.
 *
 * RLS, per migration 030's own standing rule for every table this pipeline
 * introduces: created after migration 027's blanket lockdown, so it is
 * enabled explicitly here, and a `bytea` column holding decryptable
 * credential material is exactly the kind of thing that must never be
 * reachable through the PostgREST Data API.
 */
const MIGRATION_032_MODULE_INSTALL_CREDENTIAL_ESCROW = `
CREATE TABLE module_install_credential_escrow (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id   uuid NOT NULL UNIQUE REFERENCES module_installs(id) ON DELETE CASCADE,
  ciphertext   bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE module_install_credential_escrow ENABLE ROW LEVEL SECURITY;
`

/**
 * Migration 033 — `module_installs.state` gains `cleanup_pending` (HT-119).
 *
 * A terminal-failure transition (\`build_failed\` / \`verification_failed\` /
 * \`cleanup_required\`) always needs two things to be true first: any
 * Assistant this install minted is disabled, and any webhook endpoint it
 * bootstrapped is disabled. Landing directly on the terminal state and
 * treating that cleanup as best-effort meant a transient failure in either
 * step (most plausibly a DB hiccup, since neither is a remote Vercel call)
 * was silently swallowed — the row read as fully, terminally handled while
 * a credential that should have been revoked was still live.
 *
 * \`cleanup_pending\` is the fenced, RETRYABLE stop between "this install
 * has failed" and "cleanup has actually finished": \`src/modules/install/
 * installer.ts\`'s \`failInstall\` transitions into it first, and only
 * transitions onward to the real terminal state once revoking the
 * Assistant and disabling the endpoint have BOTH actually succeeded. A
 * failure at that point leaves the row here — inspectable, and picked up
 * again by the next delivery — rather than reporting a clean terminal
 * state that isn't true yet.
 */
const MIGRATION_033_MODULE_INSTALLS_CLEANUP_PENDING_STATE = `
ALTER TABLE module_installs DROP CONSTRAINT module_installs_state_check;
ALTER TABLE module_installs ADD CONSTRAINT module_installs_state_check CHECK (state IN (
  'planned', 'credentials_issued', 'project_created',
  'artifact_uploaded', 'deployment_created', 'build_pending',
  'build_failed', 'bootstrap_pending', 'endpoint_verified',
  'active', 'verification_failed', 'rollback_pending',
  'cleanup_required', 'abandoned', 'cleanup_pending'
));
`

/**
 * Every migration, in the order they must apply. `id` is the sole ordering
 * key (ascending) — array position is not relied upon, so re-sorting this
 * array by accident is harmless.
 */
const MIGRATIONS: Migration[] = [
  { id: 1, name: 'conversations_and_threads', sql: MIGRATION_001_CONVERSATIONS_AND_THREADS },
  {
    id: 2,
    name: 'add_thread_delivery_status',
    sql: MIGRATION_002_ADD_THREAD_DELIVERY_STATUS,
  },
  {
    id: 3,
    name: 'add_thread_send_idempotency',
    sql: MIGRATION_003_SEND_IDEMPOTENCY,
  },
  {
    id: 4,
    name: 'four_state_conversation_status',
    sql: MIGRATION_004_FOUR_STATE_CONVERSATION_STATUS,
  },
  {
    id: 5,
    name: 'conversation_number',
    sql: MIGRATION_005_CONVERSATION_NUMBER,
  },
  {
    id: 6,
    name: 'tags_and_assignee',
    sql: MIGRATION_006_TAGS_AND_ASSIGNEE,
  },
  {
    id: 7,
    name: 'note_thread_direction',
    sql: MIGRATION_007_NOTE_DIRECTION,
  },
  {
    id: 8,
    name: 'customer_viewed_at',
    sql: MIGRATION_008_CUSTOMER_VIEWED_AT,
  },
  {
    id: 9,
    name: 'mailboxes',
    sql: MIGRATION_009_MAILBOXES,
  },
  {
    id: 10,
    name: 'mailbox_oauth_tokens',
    sql: MIGRATION_010_MAILBOX_OAUTH_TOKENS,
  },
  {
    id: 11,
    name: 'gmail_watch_state',
    sql: MIGRATION_011_GMAIL_WATCH_STATE,
  },
  {
    id: 12,
    name: 'inbound_deliveries',
    sql: MIGRATION_012_INBOUND_DELIVERIES,
  },
  {
    id: 13,
    name: 'queue_jobs',
    sql: MIGRATION_013_QUEUE_JOBS,
  },
  {
    id: 14,
    name: 'inbound_delivery_lease',
    sql: MIGRATION_014_INBOUND_DELIVERY_LEASE,
  },
  {
    id: 15,
    name: 'thread_attachments',
    sql: MIGRATION_015_THREAD_ATTACHMENTS,
  },
  {
    id: 16,
    name: 'gmail_reconcile_lease',
    sql: MIGRATION_016_GMAIL_RECONCILE_LEASE,
  },
  {
    id: 17,
    name: 'mailboxes_disconnected_status',
    sql: MIGRATION_017_MAILBOXES_DISCONNECTED_STATUS,
  },
  {
    id: 18,
    name: 'agents_and_auth',
    sql: MIGRATION_018_AGENTS_AND_AUTH,
  },
  {
    id: 19,
    name: 'inbound_delivery_forged_tokens',
    sql: MIGRATION_019_INBOUND_DELIVERY_FORGED_TOKENS,
  },
  {
    id: 20,
    name: 'assistants',
    sql: MIGRATION_020_ASSISTANTS,
  },
  {
    id: 21,
    name: 'threads_actor_model',
    sql: MIGRATION_021_THREADS_ACTOR_MODEL,
  },
  {
    id: 22,
    name: 'webhook_endpoints',
    sql: MIGRATION_022_WEBHOOK_ENDPOINTS,
  },
  {
    id: 23,
    name: 'event_outbox',
    sql: MIGRATION_023_EVENT_OUTBOX,
  },
  {
    id: 24,
    name: 'saved_replies',
    sql: MIGRATION_024_SAVED_REPLIES,
  },
  {
    id: 25,
    name: 'conversation_snooze',
    sql: MIGRATION_025_CONVERSATION_SNOOZE,
  },
  {
    id: 26,
    name: 'webauthn',
    sql: MIGRATION_026_WEBAUTHN,
  },
  {
    id: 27,
    name: 'lock_down_data_api',
    sql: MIGRATION_027_LOCK_DOWN_DATA_API,
  },
  // HT-101's two migrations were authored as 027/028 and renumbered to 028/029
  // when `lock_down_data_api` took 027 on main first. `id` is the applied-once
  // key, so shipping a second 027 would have been recorded as already-applied
  // and SKIPPED — the IMAP tables would simply never have been created.
  {
    id: 28,
    name: 'imap_transport',
    sql: MIGRATION_028_IMAP_TRANSPORT,
  },
  {
    id: 29,
    name: 'conversation_mailbox_id',
    sql: MIGRATION_029_CONVERSATION_MAILBOX_ID,
  },
  {
    id: 30,
    name: 'module_deployer',
    sql: MIGRATION_030_MODULE_DEPLOYER,
  },
  {
    id: 31,
    name: 'webhook_endpoints_url_unique',
    sql: MIGRATION_031_WEBHOOK_ENDPOINTS_URL_UNIQUE,
  },
  {
    id: 32,
    name: 'module_install_credential_escrow',
    sql: MIGRATION_032_MODULE_INSTALL_CREDENTIAL_ESCROW,
  },
  {
    id: 33,
    name: 'module_installs_cleanup_pending_state',
    sql: MIGRATION_033_MODULE_INSTALLS_CLEANUP_PENDING_STATE,
  },
]

/**
 * The highest migration id this BUILD knows about — the schema version the
 * running code expects.
 *
 * Exists so `src/composition/health.ts` can compare it against the database's
 * own `max(_migrations.id)` and report a version skew. That skew is reachable
 * by construction: `src/composition/root.ts` deliberately does not migrate on
 * cold start (see `scripts/migrate.ts` — schema changes are an operator step),
 * so every deploy opens a window where new code runs against an older schema
 * until someone runs `npm run migrate`.
 *
 * Before this existed the window announced itself only as whatever happened to
 * break first — a cron erroring every two minutes against a table that did not
 * exist yet, one failing request at a time, with nothing naming the cause.
 * Derived from {@link MIGRATIONS} rather than written down, so it cannot drift
 * from the list it describes.
 */
export const LATEST_MIGRATION_ID = MIGRATIONS.reduce((max, m) => (m.id > max ? m.id : max), 0)

/**
 * Every migration id this build carries, ascending. `src/composition/health.ts`
 * compares the whole set against `_migrations` rather than only the highest:
 * `max(id)` alone calls a database healthy when it holds 1..26 plus 29 and is
 * missing 27 and 28. `migrate()`'s single transaction makes that unreachable
 * through the normal path — manual repair and hand-edited bookkeeping are
 * precisely the cases a health check exists for.
 */
export const MIGRATION_IDS: readonly number[] = MIGRATIONS.map((m) => m.id).sort((a, b) => a - b)

/**
 * Split a migration's SQL body into individual statements on `;`.
 *
 * `Db.query`/`Queryable.query` (`src/db/client.ts`) is deliberately typed
 * to run ONE statement per call — under PGlite this is backed by
 * Postgres's "Extended Query" wire protocol, which is parameterized-query
 * shaped and rejects a multi-statement string outright ("cannot insert
 * multiple commands into a prepared statement"); real `pg`-protocol
 * clients against Supabase have the same restriction on parameterized
 * queries. A migration body, though, is naturally multiple `CREATE TABLE`/
 * `CREATE INDEX` statements. Rather than widen `Queryable` with a second,
 * multi-statement-capable method just for this one caller, `migrate` stays
 * inside the same thin `query`-only seam every other module uses, and
 * splits the (fully first-party, never user-controlled) migration SQL into
 * individual statements itself.
 *
 * ## Why this is no longer a plain `split(';')`
 *
 * The original splitter split on every semicolon, resting on the invariant
 * that no migration body contained one inside a string literal or a
 * dollar-quoted block — with a note that a smarter splitter would be
 * warranted the first time one did. Migration 027 is that first time: its
 * role-guarded `REVOKE`s live in a `DO $$ ... $$` block whose body is full
 * of semicolons, and a naive split would tear it into fragments that are
 * not valid SQL on their own.
 *
 * So this scanner tracks the lexical contexts in which a `;` is NOT a
 * statement terminator:
 *
 * - `'...'` single-quoted literals (with `''` escaping),
 * - `E'...'` escape strings, where a backslash escapes the next character
 *   (so `E'a\';b'` is ONE literal, not a literal followed by `;b`),
 * - `"..."` quoted identifiers,
 * - `$tag$ ... $tag$` dollar-quoted bodies (tag matched exactly, so a
 *   nested `$$` inside a `$body$` does not close it),
 * - `-- ...` line comments and `/* ... *\/` block comments (which nest in
 *   Postgres, so the scanner counts depth).
 *
 * Everything outside those contexts splits on `;` exactly as before, so
 * migrations 001–026 tokenize identically to the old implementation —
 * verified by `splitStatements` tests in `./migrate.test.ts`, which is
 * also why this is exported despite having no non-test caller.
 *
 * Deliberately NOT handled, both latent and unreachable from any migration
 * in this file:
 *
 * - `standard_conforming_strings = off`, under which a plain `'...'` would
 *   also honour backslash escapes. Postgres has defaulted it to `on` since
 *   9.1 and nothing here depends on it.
 * - An `E'...'` immediately following a dollar-quote terminator
 *   (`$e$x$e$E'a\';b'`). The token-boundary guard includes `$` in its
 *   look-behind because Postgres identifiers may contain `$` and
 *   `foo$e'x'` must NOT be read as an escape string — which makes the two
 *   cases genuinely ambiguous to a scanner this size. Postgres resolves it
 *   by longest-match; we accept the false negative, since the alternative
 *   breaks the commoner case.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let index = 0

  while (index < sql.length) {
    const rest = sql.slice(index)

    // Line comment — consume through end of line (or end of input).
    if (rest.startsWith('--')) {
      const newline = sql.indexOf('\n', index)
      const stop = newline === -1 ? sql.length : newline
      current += sql.slice(index, stop)
      index = stop
      continue
    }

    // Block comment — Postgres nests these, so track depth.
    if (rest.startsWith('/*')) {
      let depth = 0
      let scan = index
      while (scan < sql.length) {
        if (sql.startsWith('/*', scan)) {
          depth += 1
          scan += 2
        } else if (sql.startsWith('*/', scan)) {
          depth -= 1
          scan += 2
          if (depth === 0) break
        } else {
          scan += 1
        }
      }
      current += sql.slice(index, scan)
      index = scan
      continue
    }

    // Dollar-quoted body — the tag must match exactly to close it.
    // Tag grammar per Postgres: `$$`, or `$tag$` where tag starts with a
    // letter/underscore and may then contain digits (`$migration027$`).
    const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)
    if (dollarTag !== null) {
      const tag = dollarTag[0]
      const close = sql.indexOf(tag, index + tag.length)
      const stop = close === -1 ? sql.length : close + tag.length
      current += sql.slice(index, stop)
      index = stop
      continue
    }

    // Escape string (`E'...'` / `e'...'`) — a backslash escapes the next
    // character, so the closing quote must be found by scanning rather than
    // by indexOf. Handled before the plain-quote branch below, which would
    // otherwise stop at the backslash-escaped quote in `E'a\';b'`.
    // The `[A-Za-z0-9_$]` look-behind keeps this from firing on the tail of
    // an identifier that happens to end in `e` (Postgres only lexes `E'` as
    // an escape string at a token boundary).
    const escapeString = /^[Ee]'/.exec(rest)
    if (escapeString !== null && !/[A-Za-z0-9_$]/.test(sql[index - 1] ?? '')) {
      let scan = index + 2
      while (scan < sql.length) {
        if (sql[scan] === '\\') {
          scan += 2
        } else if (sql[scan] === "'") {
          // A doubled '' is an escaped quote here too, not a close.
          if (sql[scan + 1] === "'") scan += 2
          else {
            scan += 1
            break
          }
        } else {
          scan += 1
        }
      }
      current += sql.slice(index, Math.min(scan, sql.length))
      index = scan
      continue
    }

    const char = sql[index]

    // Single-quoted literal or double-quoted identifier. A doubled quote
    // ('' / "") is an escaped quote, not a close, and falls out naturally:
    // the close is consumed, then the next iteration re-opens on the second.
    if (char === "'" || char === '"') {
      const close = sql.indexOf(char, index + 1)
      const stop = close === -1 ? sql.length : close + 1
      current += sql.slice(index, stop)
      index = stop
      continue
    }

    if (char === ';') {
      statements.push(current)
      current = ''
      index += 1
      continue
    }

    current += char
    index += 1
  }

  statements.push(current)

  return statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0)
}

/**
 * A fixed key for the Postgres advisory lock `migrate()` holds while it runs
 * (see the concurrency note on {@link migrate}). Arbitrary but STABLE — every
 * caller must use the same key to serialize against each other. Chosen larger
 * than `int4`'s max (2^31-1) so it binds unambiguously to
 * `pg_advisory_xact_lock`'s `bigint` overload rather than its `(int, int)`
 * one.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4_137_231_984

/**
 * Apply every not-yet-applied migration in `MIGRATIONS`, in ascending `id`
 * order. Idempotent: safe to call on every boot/test-setup — a migration
 * already recorded in `_migrations` is skipped, so a second call with no
 * new migrations is a clean no-op.
 *
 * ## One locked transaction
 *
 * The whole run — take the lock, ensure `_migrations`, read what's applied,
 * apply what's pending, record it — happens inside a SINGLE transaction, so
 * a migration that fails partway rolls back entirely: never a half-applied
 * schema change recorded as done, never a fully-applied change left
 * unrecorded (which would be reapplied and fail on `CREATE TABLE` next run).
 *
 * ## Concurrency
 *
 * The transaction first takes a transaction-scoped Postgres advisory lock on
 * {@link MIGRATION_ADVISORY_LOCK_KEY}. On real multi-connection Postgres
 * (Supabase) two serverless instances can cold-start and call `migrate()` at
 * the same moment; without the lock both could read `_migrations`, both see
 * the same migration as pending, and race on the same `CREATE TABLE`. The
 * lock makes the second caller WAIT until the first commits, at which point
 * it reads the now-updated `_migrations` and finds nothing to do. The lock
 * releases automatically when the transaction commits or rolls back.
 *
 * (Under the single-connection, in-process PGlite used in tests and local
 * dev this lock is an uncontended no-op — the cross-process race it guards is
 * only reproducible against a real multi-connection server, so it is not
 * unit-testable here. The idempotency test covers the apply-once bookkeeping;
 * true concurrent-migrate coverage waits for the Supabase-backed `Db`.)
 *
 * ## `throughId`
 *
 * `options.throughId` applies only migrations with `id <= throughId`, leaving
 * later ones pending. Its main use is staged rollouts and testing forward
 * UPGRADE paths — applying an earlier schema, writing data against it, then
 * applying the next migration over that data (exactly what a real deploy does,
 * and what a fresh-only test never exercises). Omitted, every pending
 * migration is applied.
 */
export async function migrate(db: Db, options?: { throughId?: number }): Promise<void> {
  const throughId = options?.throughId
  await db.transaction(async (tx) => {
    // Serialize concurrent migrate() runs before touching any state. A bare
    // integer key needs no table, so this is safe to take before `_migrations`
    // even exists. Cast to bigint so the bigint overload is chosen explicitly.
    await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY])

    await tx.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const applied = await tx.query<{ id: number }>('SELECT id FROM _migrations')
    const appliedIds = new Set(applied.map((row) => row.id))

    const pending = MIGRATIONS.filter(
      (migration) =>
        !appliedIds.has(migration.id) && (throughId === undefined || migration.id <= throughId),
    ).sort((a, b) => a.id - b.id)

    for (const migration of pending) {
      for (const statement of splitStatements(migration.sql)) {
        await tx.query(statement)
      }
      await tx.query('INSERT INTO _migrations (id, name) VALUES ($1, $2)', [
        migration.id,
        migration.name,
      ])
    }
  })
}
