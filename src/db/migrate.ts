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
