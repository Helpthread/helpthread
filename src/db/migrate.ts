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
 * Migration 012 — `inbound_deliveries`, the delivery ledger (HT-36;
 * specs/mail/inbound-ingestion.md §4).
 *
 * One row per `(mailbox_id, provider_message_id)` — simultaneously the
 * **idempotency record**, the **claim/lease**, and the **retry queue** (spec
 * §4's own three-way framing). `provider_message_id`, not the RFC
 * `Message-ID`, is the dedup authority: the inbound `Message-ID` is optional
 * and entirely sender-controlled (`NewThread.messageId` permits `null`,
 * `src/store/conversations.ts`), while the transport's own message id is
 * stable and provider-issued (spec §4).
 *
 * `id` is a conventional surrogate `uuid` PRIMARY KEY (matching every other
 * table in this schema), separate from the UNIQUE claim key below — the
 * same "surrogate PK + a separate business-key unique index" shape
 * migration 003 already uses for `threads`' own idempotency key
 * (`threads_conversation_idempotency_key_idx`).
 *
 * ## The claim key
 *
 * `inbound_deliveries_mailbox_id_provider_message_id_key` is what the
 * ingest pipeline's step 1 targets (spec §3 step 1): `INSERT ... ON
 * CONFLICT (mailbox_id, provider_message_id) DO NOTHING RETURNING *`. A
 * fresh insert means the caller owns processing this delivery; a conflict
 * means a concurrent or prior delivery already claimed or completed it, and
 * the caller must return THAT row's outcome rather than double-process
 * (spec §3 step 1, §8's "two concurrent deliveries... exactly one
 * conversation" acceptance case). Ordinary `UNIQUE`, not partial: unlike
 * `threads.idempotency_key` (optional, migration 003),
 * `provider_message_id` is always present (spec §2: the transport rejects a
 * delivery it cannot resolve to a `providerMessageId`), so every row
 * participates in the constraint.
 *
 * `status` defaults to `'received'` — the state a row is inserted in at the
 * step-1 claim, before parse/thread/store (steps 2-5) even run. The CHECK
 * list is spelled `'dead-letter'` (hyphen) to match
 * specs/mail/inbound-ingestion.md §4's own spelling, used consistently
 * throughout that spec (and matching the industry-standard "dead-letter
 * queue" term); HT-36's ticket text listed the same value with an
 * underscore (`dead_letter`) in one place, which reads as a transcription
 * slip against the spec's consistent hyphenated usage — flagged for
 * explicit confirmation in the implementation report rather than resolved
 * silently.
 *
 * `attempts`/`last_error` are the retry-queue bookkeeping the spec's "retry
 * queue" framing implies (§4) — no schema-level opinion on the attempts
 * ceiling or backoff; that policy belongs to the worker that consumes this
 * table (a later ticket).
 *
 * `conversation_id`/`thread_id` are the ledger's recorded OUTCOME (spec §3
 * step 5, §4: "recording the resulting conversationId/threadId"), nullable
 * because most statuses (`received`, `suppressed`, `failed`, `dead-letter`)
 * never resolve to one. Declared as real FKs, matching this schema's
 * unbroken convention that every id-shaped reference column is one, but
 * `ON DELETE SET NULL` rather than `CASCADE` (migration 001's `threads`
 * choice): unlike a thread, which has no meaning without its conversation,
 * a ledger row's audit/idempotency value ("we received message X for
 * mailbox Y, and here is what happened") does not depend on the
 * conversation it produced still existing — invariant #1's
 * never-silently-lost applies to the fact of ingestion, not just the
 * resulting conversation, so the ledger row survives and only the
 * now-unresolvable pointer clears.
 *
 * No cross-column CHECK tying `status` to `conversation_id`/`thread_id`
 * nullability (e.g. "non-null iff `stored`") — deliberately deferred: the
 * exact invariant depends on retry/dead-letter edge cases the consuming
 * store methods (a later ticket) haven't been written yet to pin down, and
 * this ticket is schema-only. Worth adding once that implementation settles
 * the question for real.
 *
 * No index beyond the UNIQUE claim key: the ticket's own framing ("the
 * unique index IS the claim key") reads as the one index this migration
 * needs; a `status`-scoped index for a future retry-sweep/dead-letter-review
 * query is deferred to whichever ticket implements that query, so as not to
 * carry write-time index cost for a read pattern that doesn't exist yet.
 */
const MIGRATION_012_INBOUND_DELIVERIES = `
CREATE TABLE inbound_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','stored','suppressed','failed','dead-letter')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES threads(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inbound_deliveries_mailbox_id_provider_message_id_key ON inbound_deliveries (mailbox_id, provider_message_id);
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
]

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
 * individual statements itself. This is safe specifically because
 * migration bodies are our own embedded string constants — never data —
 * and none of them contain a semicolon inside a string literal or a
 * dollar-quoted body; that invariant is worth re-checking if a future
 * migration ever needs one (e.g. a function body), at which point a
 * smarter splitter would be warranted.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
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
