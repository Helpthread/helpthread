/**
 * Barrel for the DB layer (`src/db/**`). Store modules (`src/store/**`) and
 * anything wiring up a database connection import from here — never reach
 * into `client.ts`/`migrate.ts` directly, and never import `@electric-sql/pglite`
 * outside this directory (see `src/db/client.ts` for why the raw-SQL seam
 * exists: the same SQL must run unmodified against a future Supabase-backed
 * `Db`, so nothing above this barrel should know PGlite exists).
 */

export type { Db, Queryable, Row, SqlValue } from './client.js'
export { createPgliteDb, PgliteDb } from './client.js'
export type { Migration } from './migrate.js'
export { migrate } from './migrate.js'
