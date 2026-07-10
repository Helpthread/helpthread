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
 * Every migration, in the order they must apply. `id` is the sole ordering
 * key (ascending) — array position is not relied upon, so re-sorting this
 * array by accident is harmless.
 */
const MIGRATIONS: Migration[] = [
  { id: 1, name: 'conversations_and_threads', sql: MIGRATION_001_CONVERSATIONS_AND_THREADS },
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
 * Apply every not-yet-applied migration in `MIGRATIONS`, in ascending `id`
 * order. Idempotent: safe to call on every boot/test-setup — a migration
 * already recorded in `_migrations` is skipped, so a second call with no
 * new migrations is a clean no-op.
 *
 * Each migration runs inside its own transaction alongside the
 * `_migrations` bookkeeping insert, so a migration that fails partway never
 * leaves a half-applied schema change recorded as done (or a fully-applied
 * change left unrecorded, which would cause it to be reapplied and fail on
 * `CREATE TABLE` next run).
 */
export async function migrate(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const applied = await db.query<{ id: number }>('SELECT id FROM _migrations')
  const appliedIds = new Set(applied.map((row) => row.id))

  const pending = MIGRATIONS.filter((migration) => !appliedIds.has(migration.id)).sort(
    (a, b) => a.id - b.id,
  )

  for (const migration of pending) {
    await db.transaction(async (tx) => {
      for (const statement of splitStatements(migration.sql)) {
        await tx.query(statement)
      }
      await tx.query('INSERT INTO _migrations (id, name) VALUES ($1, $2)', [
        migration.id,
        migration.name,
      ])
    })
  }
}
