/**
 * Barrel for the DB layer (`src/db/**`). Store modules (`src/store/**`) and
 * anything wiring up a database connection import from here — never reach
 * into `client.ts`/`migrate.ts`/`postgres.ts` directly, and never import
 * `@electric-sql/pglite` or `pg` outside this directory (see
 * `src/db/client.ts` for why the raw-SQL seam exists: the same SQL runs
 * unmodified against PGlite locally and real Postgres/Supabase in
 * production, so nothing above this barrel should know which one it got).
 */

export type { Db, Queryable, Row, SqlValue } from './client.js'
export { createPgliteDb, PgliteDb } from './client.js'
export type { Migration } from './migrate.js'
export { migrate } from './migrate.js'
export type { PostgresDbOptions } from './postgres.js'
export { createPostgresDb, PostgresDb } from './postgres.js'
