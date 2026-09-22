/**
 * The build-time production-migration gate (issue #152;
 * specs/deploy/single-project.md's Migrations section).
 *
 * Pure decision logic for `scripts/migrate-if-production.ts`, which
 * `web/package.json`'s `prebuild` runs on EVERY Vercel build — preview and
 * development included, since `next build` fires the same npm lifecycle
 * everywhere (see `web/package.json`'s existing `prebuild`/`predev` split).
 * `VERCEL_ENV` (`'production' | 'preview' | 'development'`, set by Vercel at
 * both build and runtime; unset entirely off Vercel) is the only thing that
 * tells those builds apart, so this is the one place that decides — kept
 * here, under `src/**`, rather than in `scripts/` itself, so it runs under
 * the ordinary vitest suite instead of needing a harness of its own for two
 * branches of an if/else.
 *
 * A non-production build always `skip`s: it must never touch the database,
 * migrated or not — a preview deployment does not own the database it's
 * configured against.
 *
 * A production build for a SPLIT deployment (the UI and the engine as
 * separate Vercel projects — specs/deploy/single-project.md's Configuration
 * table, and `web/src/lib/api.ts`'s own `apiBaseUrl()`) also `skip`s: this
 * `web/` project doesn't host the engine, so it doesn't own the database
 * either — the separate engine project's database keeps migrating manually
 * (`npm run migrate`). `HELPTHREAD_API_URL` being set is the SAME signal
 * `apiBaseUrl()` already uses to mean "point elsewhere"; reused here rather
 * than invented twice. (The root-level engine project, `api/index.ts`, is
 * unaffected either way — its `package.json` has no `build`/`prebuild`
 * script, so this gate never runs there at all.)
 *
 * A production, single-project build with no `DATABASE_URL` (or its
 * `POSTGRES_URL` fallback — issue #151/#153, the Vercel⇄Supabase Marketplace
 * integration's own name for the same pooled connection string) `fail`s
 * rather than silently skipping: deploying code against a database nobody
 * migrated is exactly the outage this gate exists to prevent.
 */

import { withLibpqSslCompat } from './postgres-url-compat.js'

/** What `scripts/migrate-if-production.ts` should do, and why. */
export type MigrationGateDecision =
  | { action: 'skip'; reason: string }
  | { action: 'fail'; reason: string }
  | { action: 'migrate'; databaseUrl: string }

/**
 * `DATABASE_URL`, falling back to `POSTGRES_URL` — the Vercel⇄Supabase
 * Marketplace integration's pooled connection string (issue #151/#153) —
 * when `DATABASE_URL` itself is unset or blank. An explicit `DATABASE_URL`
 * always wins and is returned byte-for-byte untouched; mirrors
 * `src/composition/config.ts`'s identical fallback (kept separate rather
 * than shared, since this module intentionally takes no dependency on
 * `config.ts` — see the module doc). The `POSTGRES_URL` fallback gets
 * `withLibpqSslCompat` (`./postgres-url-compat.ts`) applied, same as
 * `config.ts`'s own fallback: the integration's URL carries
 * `sslmode=require`, which our `pg`/`pg-connection-string` treats as
 * verify-full unless told otherwise.
 */
function resolveDatabaseUrl(env: {
  DATABASE_URL?: string
  POSTGRES_URL?: string
}): string | undefined {
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL.trim().length > 0) {
    return env.DATABASE_URL
  }
  if (env.POSTGRES_URL !== undefined && env.POSTGRES_URL.trim().length > 0) {
    return withLibpqSslCompat(env.POSTGRES_URL)
  }
  return undefined
}

/**
 * Decide the action for this build. `env` is shaped like `process.env` so a
 * caller can pass it directly; this function does no I/O itself, which is
 * what makes it unit-testable without a real Vercel build or database.
 */
export function decideMigrationGate(env: {
  VERCEL_ENV?: string
  DATABASE_URL?: string
  POSTGRES_URL?: string
  HELPTHREAD_API_URL?: string
}): MigrationGateDecision {
  if (env.VERCEL_ENV !== 'production') {
    const observed = env.VERCEL_ENV === undefined ? 'unset' : `'${env.VERCEL_ENV}'`
    return {
      action: 'skip',
      reason: `VERCEL_ENV is ${observed}, not 'production' — preview and development builds never touch the database.`,
    }
  }
  if (env.HELPTHREAD_API_URL !== undefined && env.HELPTHREAD_API_URL.trim().length > 0) {
    return {
      action: 'skip',
      reason:
        "HELPTHREAD_API_URL is set — this is the split deployment's UI project, not the one hosting the engine. Its database is a separate engine project's, migrated manually with `npm run migrate`.",
    }
  }
  const databaseUrl = resolveDatabaseUrl(env)
  if (databaseUrl === undefined) {
    return {
      action: 'fail',
      reason:
        'DATABASE_URL (or POSTGRES_URL, written by the Vercel Supabase integration) is required for a production build (it applies pending migrations before the deploy goes live). Set it in the Production environment variables — Supabase dashboard → the project → Connect — then redeploy.',
    }
  }
  return { action: 'migrate', databaseUrl }
}
