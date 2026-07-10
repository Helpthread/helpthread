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
