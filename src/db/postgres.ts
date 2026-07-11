/**
 * `Db` implementation backed by a real Postgres server over the wire —
 * the production counterpart to `PgliteDb` (`src/db/client.ts`). Same seam,
 * same SQL: anything the stores run against PGlite locally runs unmodified
 * here, which is the whole point of keeping the abstraction at "run this
 * SQL, get these rows".
 *
 * Wraps `pg` (node-postgres, MIT) — the boring, battle-tested driver. A
 * `pg.Pool` underneath; every parameterized query goes through the extended
 * query protocol as an UNNAMED prepared statement, which is compatible with
 * transaction-mode connection poolers (Supabase's Supavisor on port 6543,
 * PgBouncer) — named prepared statements are not, and this adapter never
 * creates one.
 *
 * ## Deploying against Supabase
 *
 * Use the **transaction-mode pooler connection string (port 6543)** — the
 * serverless-correct choice: many short-lived function instances share a
 * small set of real backend connections. Direct 5432 connections would
 * exhaust Postgres's connection slots under serverless fan-out.
 *
 * ## The `schema` option — and why it is enforced per-transaction
 *
 * With `schema: 'helpthread'`, every table this adapter touches lives in
 * that Postgres schema instead of `public`, without qualifying a single
 * store SQL string. That containment is a deployment concern (e.g. renting
 * a corner of an existing database), so it lives here in deployment config,
 * not in the product's SQL.
 *
 * The mechanism has to survive transaction pooling, which rules out the
 * obvious approaches: a session-level `SET search_path` on connect does NOT
 * stick, because a transaction-mode pooler hands each *transaction* —
 * including each autocommit statement — to whatever backend connection is
 * free, and session state set on one backend is invisible on the next. Even
 * two sequential statements on the same client ("SET, then INSERT") can land
 * on different backends. The only placement the pooler contractually keeps
 * together is a single transaction. So:
 *
 * - `transaction()` pins one pooled client, opens the transaction, and sets
 *   a transaction-local search_path (`set_config(..., is_local => true)`)
 *   before running the callback.
 * - `query()` in schema mode routes through `transaction()` — a
 *   single-statement transaction. A few extra round trips per query, priced
 *   in deliberately: correctness under pooling beats saving milliseconds on
 *   a helpdesk's write volume. Without `schema`, `query()` is a plain
 *   single-round-trip `pool.query`.
 *
 * (The RIQ deployment ALSO sets a role-level default search_path via
 * `ALTER ROLE ... SET search_path` — belt and braces, and it makes ad-hoc
 * psql sessions land in the right schema — but this adapter does not rely
 * on it.)
 *
 * Note: the transaction-local search_path is exactly the configured schema
 * (plus the implicit `pg_catalog`) — `public` is deliberately NOT on it, so
 * a deployment sharing a database cannot accidentally read or create tables
 * outside its schema. Everything the engine's SQL needs from core Postgres
 * (`gen_random_uuid()`, `now()`, ...) lives in `pg_catalog`, which Postgres
 * always searches.
 *
 * `migrate()` (`src/db/migrate.ts`) needs no special handling: its advisory
 * lock is `pg_advisory_xact_lock` — transaction-scoped, released on
 * commit/rollback — which is the one advisory-lock flavor that is safe
 * behind a transaction pooler (a session-scoped lock could be "released"
 * onto a backend the caller no longer holds).
 *
 * ## Caveat: no non-transactional statements in schema mode
 *
 * Because schema mode wraps every `query()` in a transaction, statements
 * Postgres refuses to run inside one (`CREATE INDEX CONCURRENTLY`,
 * `VACUUM`, ...) cannot go through this adapter with `schema` set. Nothing
 * in the engine issues any today; if one ever becomes necessary it will
 * need an explicit, documented side door.
 */

import pg from 'pg'
import type { Db, Queryable, Row, SqlValue } from './client.js'

/**
 * What a configured `schema` name must look like: an unquoted lowercase
 * Postgres identifier (≤63 bytes), with the `pg_`-reserved namespace
 * rejected. Deliberately much narrower than what Postgres would accept
 * quoted — the name is interpolated into `CREATE SCHEMA` DDL (identifiers
 * cannot be bound as `$n` parameters), so the whitelist IS the injection
 * boundary. A deployment wanting `"Wéird Schema!"` doesn't get it.
 */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/

/** Postgres error codes the schema-creation race can surface (see `ensureSchema`). */
const DUPLICATE_SCHEMA = '42P06'
const UNIQUE_VIOLATION = '23505'
const INSUFFICIENT_PRIVILEGE = '42501'

export interface PostgresDbOptions {
  /**
   * Standard Postgres connection string. For Supabase, use the
   * transaction-mode pooler string (port 6543) — see the module doc.
   */
  connectionString: string
  /**
   * Postgres schema to contain every table this `Db` touches (created if
   * absent, permissions allowing). Omitted, SQL runs against the
   * connection's default search_path (normally `public`) with no
   * per-transaction setup. Must match `^[a-z_][a-z0-9_]{0,62}$` and not
   * start with `pg_`.
   */
  schema?: string
  /**
   * Max pooled connections (passed to `pg.Pool`; its default applies when
   * omitted). Against a transaction-mode pooler these are cheap client
   * slots, not real backend connections — but serverless functions should
   * still keep this small (1–2) since each instance opens its own pool.
   */
  max?: number
  /**
   * TLS settings, passed through to `pg.Pool` verbatim. Prefer expressing
   * TLS in the connection string (`?sslmode=...`); this override exists for
   * setups needing an explicit CA bundle or similar.
   */
  ssl?: pg.PoolConfig['ssl']
}

/**
 * `pg` serializes parameters it doesn't recognize by JSON-stringifying
 * them — and it recognizes `Buffer`, not `Uint8Array`, so a raw
 * `Uint8Array` bound to a `bytea` column would be stored as a JSON string
 * (PGlite, by contrast, handles `Uint8Array` natively). Wrapping in a
 * `Buffer` view (no copy — same underlying memory) keeps the two backends
 * behaviorally identical at the seam.
 */
function toPgParams(params: SqlValue[]): SqlValue[] {
  return params.map((value) =>
    value instanceof Uint8Array && !Buffer.isBuffer(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : value,
  )
}

/** Narrow an unknown thrown value to a `pg` error code, if it carries one. */
function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/**
 * `Db` over a `pg.Pool`. Construct via {@link createPostgresDb} — the
 * factory validates the schema name and ensures the schema exists before
 * any store SQL can run.
 */
export class PostgresDb implements Db {
  readonly #pool: pg.Pool
  readonly #schema: string | undefined

  constructor(pool: pg.Pool, schema?: string) {
    this.#pool = pool
    this.#schema = schema
  }

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    if (this.#schema === undefined) {
      const result = await this.#pool.query(sql, toPgParams(params))
      return result.rows as T[]
    }
    // Schema mode: even a single statement must ride inside a transaction so
    // the transaction-local search_path and the statement reach the SAME
    // pooled backend — see the module doc.
    return this.transaction((tx) => tx.query<T>(sql, params))
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect()
    // pg tolerates neither a double release nor a query on a released
    // client, so exactly one release must run on every path — tracked
    // explicitly because the broken-connection path has to release EARLY
    // (destructively) rather than in `finally`.
    let released = false
    try {
      await client.query('BEGIN')
      try {
        if (this.#schema !== undefined) {
          // is_local => true: scoped to this transaction, gone at
          // commit/rollback — never leaks onto whatever backend connection
          // the pooler hands out next.
          await client.query('SELECT set_config($1, $2, true)', ['search_path', this.#schema])
        }
        const tx: Queryable = {
          query: async <U = Row>(sql: string, params: SqlValue[] = []) => {
            const result = await client.query(sql, toPgParams(params))
            return result.rows as U[]
          },
        }
        const result = await fn(tx)
        await client.query('COMMIT')
        return result
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // ROLLBACK itself failed — the connection is in an unknown state.
          // Destroy it (release(true)) instead of returning it to the pool,
          // and surface the ORIGINAL error (the rollback failure is a
          // symptom, not the cause).
          released = true
          client.release(true)
        }
        throw err
      }
    } finally {
      if (!released) {
        client.release()
      }
    }
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}

/**
 * Ensure `schema` exists, tolerating the two legitimate "already handled"
 * outcomes:
 *
 * - **Pre-created by an operator** (the expected production shape: an admin
 *   creates the schema and grants a scoped app role `USAGE, CREATE` on it —
 *   such a role typically lacks database-level CREATE, so this function
 *   checks existence FIRST and never attempts DDL it doesn't need).
 * - **Concurrent creation race**: two instances cold-start simultaneously,
 *   both see the schema missing, both CREATE — Postgres reports the loser
 *   as `duplicate_schema` (or a `pg_namespace` unique violation, a known
 *   race window even with IF NOT EXISTS). The loser's goal is nonetheless
 *   achieved, so both codes are swallowed.
 *
 * A genuinely missing schema that this role cannot create is a
 * misconfiguration — rethrown with instructions rather than left to fail
 * later as a confusing `search_path` miss.
 */
async function ensureSchema(pool: pg.Pool, schema: string): Promise<void> {
  const existing = await pool.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [
    schema,
  ])
  if (existing.rows.length > 0) return

  try {
    // Identifier, not a value — cannot be a $n parameter. Safe to interpolate
    // only because SCHEMA_NAME_PATTERN already constrained it to a plain
    // lowercase identifier; quoted for defense in depth.
    await pool.query(`CREATE SCHEMA "${schema}"`)
  } catch (err) {
    const code = pgErrorCode(err)
    if (code === DUPLICATE_SCHEMA || code === UNIQUE_VIOLATION) return
    if (code === INSUFFICIENT_PRIVILEGE) {
      throw new Error(
        `createPostgresDb: schema "${schema}" does not exist and this role may not create it. ` +
          `Create it as an administrator (CREATE SCHEMA ${schema}; GRANT USAGE, CREATE ON SCHEMA ${schema} TO <app role>;) and retry.`,
        { cause: err },
      )
    }
    throw err
  }
}

/**
 * Create a `Db` backed by a real Postgres server. Validates `schema` (when
 * given) and ensures it exists before returning, so by the time a store
 * runs its first unqualified `CREATE TABLE` there is a schema for the
 * search_path to land it in. Connections themselves are opened lazily by
 * the pool (schema-less construction touches the network not at all — a
 * bad connection string surfaces on first query).
 */
export async function createPostgresDb(options: PostgresDbOptions): Promise<Db> {
  const { connectionString, schema, max, ssl } = options

  if (schema !== undefined) {
    if (!SCHEMA_NAME_PATTERN.test(schema)) {
      throw new Error(
        `createPostgresDb: invalid schema name ${JSON.stringify(schema)} — must match ${SCHEMA_NAME_PATTERN} (unquoted lowercase Postgres identifier).`,
      )
    }
    if (schema.startsWith('pg_')) {
      throw new Error(
        `createPostgresDb: invalid schema name ${JSON.stringify(schema)} — the "pg_" prefix is reserved by Postgres.`,
      )
    }
  }

  const pool = new pg.Pool({
    connectionString,
    ...(max !== undefined ? { max } : {}),
    ...(ssl !== undefined ? { ssl } : {}),
  })

  if (schema !== undefined) {
    try {
      await ensureSchema(pool, schema)
    } catch (err) {
      // Don't leak a live pool on a failed construction.
      await pool.end().catch(() => {})
      throw err
    }
  }

  return new PostgresDb(pool, schema)
}
