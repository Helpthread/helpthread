/**
 * The portable raw-SQL seam — `Db`/`Queryable` — that every store module
 * (`src/store/**`) is built on.
 *
 * Per CHARTER.md §4 ("the engine's core never calls a platform directly"),
 * storage sits behind a thin interface the project owns. This one is
 * deliberately THIN: raw parameterized SQL in, plain rows out — no ORM, no
 * query builder, no schema-mapping magic. The reason is portability, not
 * minimalism for its own sake: the exact same SQL strings run unmodified
 * against **PGlite** (`PgliteDb`, this file) locally and in tests, and
 * against **Supabase's hosted Postgres** in production (a future `Db`
 * implementation talking to it directly over `pg` or Supabase's REST/edge
 * connection — not written yet, but the seam is shaped for it today). A
 * query builder or ORM would tie the codebase to one library's SQL dialect
 * quirks; writing Postgres SQL directly and keeping the abstraction to
 * "run this SQL, get these rows" avoids that entirely.
 *
 * ## Why PGlite
 *
 * PGlite (`@electric-sql/pglite`, dual-licensed Apache-2.0 or the PostgreSQL
 * License — either may be used) is a WASM build of real
 * Postgres packaged as an in-process Node/browser library — not a mock, not
 * SQLite-with-a-Postgres-flavored-dialect. Tests and local dev run against
 * the genuine Postgres engine (see the version note on {@link createPgliteDb}),
 * so SQL that passes locally is SQL that behaves the same way against
 * Supabase, not SQL that merely *resembles* it.
 *
 * ## Parameterization is not optional
 *
 * Every query in this codebase MUST use `$1, $2, ...` positional
 * placeholders (Postgres/Supabase-portable — the same placeholder syntax
 * both backends speak) and pass values via `params`. Values are never
 * string-interpolated into SQL text — see `src/store/conversations.test.ts`
 * for an injection-safety test that proves this holds for user-controlled
 * fields like `customerEmail`.
 */

import { PGlite } from '@electric-sql/pglite'

/**
 * A value safe to bind as a query parameter. Deliberately narrow — the set
 * of JS types `pg`-wire-protocol drivers (and PGlite, which speaks the same
 * protocol) know how to serialize without ambiguity. Anything richer (a
 * plain object meant as `jsonb`, for instance) should be `JSON.stringify`'d
 * by the caller before it reaches `query`, so this seam never has to guess
 * a caller's serialization intent.
 */
export type SqlValue = string | number | boolean | null | Date | Uint8Array

/** One result row: column name to value, shape unknown until the caller narrows it. */
export type Row = Record<string, unknown>

/**
 * The minimal query surface — what both a top-level `Db` and an in-flight
 * transaction expose. Kept separate from `Db` so that `transaction`'s
 * callback can be typed to accept exactly this (a transaction handle is
 * queryable but is not itself something you can open a nested transaction
 * on or close).
 */
export interface Queryable {
  /**
   * Run one parameterized SQL statement and return its result rows.
   * `params[i]` binds to `$${i + 1}` in `sql`. Never interpolate untrusted
   * values into `sql` itself — always bind them through `params`.
   */
  query<T = Row>(sql: string, params?: SqlValue[]): Promise<T[]>
}

/**
 * A top-level database handle: `Queryable` plus transaction control and
 * lifecycle management. This is the interface store modules depend on —
 * never `PgliteDb` or `PGlite` directly — so a future Supabase-backed `Db`
 * implementation is a drop-in replacement.
 */
export interface Db extends Queryable {
  /**
   * Run `fn` inside a single database transaction. If `fn` throws (or its
   * returned promise rejects), the transaction is rolled back and the
   * error propagates — no partial writes survive. If `fn` resolves, the
   * transaction commits and its return value is passed through.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>

  /** Release the underlying connection/engine. Safe to call once, at shutdown. */
  close(): Promise<void>
}

/**
 * `Db` implementation backed by an in-process PGlite instance — real
 * Postgres compiled to WASM, not a mock or a SQLite stand-in. See the
 * module doc for why this is the right local/test backend for SQL that must
 * also run unmodified against Supabase.
 */
export class PgliteDb implements Db {
  readonly #pglite: PGlite

  constructor(pglite: PGlite) {
    this.#pglite = pglite
  }

  async query<T = Row>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.#pglite.query<T>(sql, params)
    return result.rows
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.#pglite.transaction(async (tx) => {
      const queryable: Queryable = {
        query: async <U = Row>(sql: string, params: SqlValue[] = []) => {
          const result = await tx.query<U>(sql, params)
          return result.rows
        },
      }
      return fn(queryable)
    })
  }

  async close(): Promise<void> {
    await this.#pglite.close()
  }
}

/**
 * Create a `Db` backed by PGlite: in-memory when `options.dataDir` is
 * omitted (the right choice for tests — fast, fully isolated, nothing to
 * clean up), file-backed via PGlite's Node filesystem adapter when given a
 * `dataDir` path (for local development, where data should survive a
 * restart).
 *
 * Deliberately does NOT run migrations — callers call {@link migrate}
 * (`src/db/migrate.ts`) explicitly. Keeping schema setup out of this
 * factory means a caller can open a `Db` against an already-migrated
 * database (e.g. a long-lived local dev file) without re-running migration
 * logic on every connect, and keeps "connect" and "ensure schema" as two
 * separately testable steps.
 *
 * Verified against the installed PGlite 0.5.4 (bundling PostgreSQL 18):
 * `PGlite.create()` with no `dataDir` argument is in-memory, and
 * `PGlite.create(dataDir)` persists to that directory via PGlite's Node
 * filesystem backend — no `memory://`/`idb://` URL prefix needed on either
 * path in Node (those prefixes are for selecting a filesystem backend in a
 * browser, where Node's plain directory semantics don't apply).
 *
 * The in-memory-vs-file choice branches on whether `dataDir` was *provided*
 * (`!== undefined`), not on its truthiness — an explicitly passed empty
 * string is a misconfiguration (a persistence path was intended but is
 * blank), so it is rejected loudly rather than silently degrading to an
 * ephemeral in-memory database that would drop data on restart.
 */
export async function createPgliteDb(options?: { dataDir?: string }): Promise<Db> {
  const dataDir = options?.dataDir
  if (dataDir !== undefined && dataDir.trim() === '') {
    throw new Error(
      'createPgliteDb: `dataDir` was provided but empty — pass a real directory path for a file-backed database, or omit `dataDir` entirely for an in-memory one.',
    )
  }
  const pglite = dataDir !== undefined ? await PGlite.create(dataDir) : await PGlite.create()
  return new PgliteDb(pglite)
}
