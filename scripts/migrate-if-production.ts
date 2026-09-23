/**
 * Build-time migration gate for Vercel deploys (issue #152;
 * specs/deploy/single-project.md's Migrations section).
 *
 * `web/package.json`'s `prebuild` runs this on EVERY Vercel build — preview
 * and development included, since `next build` fires the same npm lifecycle
 * everywhere. `decideMigrationGate` (`src/composition/migration-gate.ts`) is
 * the actual rule; this script only acts on its verdict and does the I/O:
 *
 * - `skip` (not a production build, OR a production build of the SPLIT
 *   deployment's UI project — `HELPTHREAD_API_URL` set, meaning this `web/`
 *   project doesn't host the engine): log one line naming why, touch
 *   nothing, exit 0. Neither a preview/development build nor a split-UI
 *   build owns the database it would be migrating.
 * - `fail` (a production, single-project build with no `DATABASE_URL`/
 *   `POSTGRES_URL`): log the fix and exit 1, FAILING THE BUILD. Deploying
 *   code against a database nobody migrated is exactly the outage this gate
 *   exists to prevent — the outage observed and written up in issue #152's
 *   field-evidence comment.
 * - `migrate`: apply every pending migration via `runMigration`
 *   (`./migrate.ts`) — the SAME advisory-locked, one-transaction, idempotent
 *   `migrate()` (`src/db/migrate.ts`) a manual `npm run migrate` uses. A
 *   migration failure also fails the build (exit 1): the alternative is
 *   deploying code against a half-migrated schema, which is worse than not
 *   deploying.
 *
 * Never logs `DATABASE_URL`/`POSTGRES_URL` (or any part of either), on any path.
 */

import { decideMigrationGate } from '../src/composition/migration-gate.js'
import { runMigration } from './migrate.js'

async function main(): Promise<void> {
  const decision = decideMigrationGate(process.env)

  if (decision.action === 'skip') {
    console.log(`scripts/migrate-if-production: ${decision.reason}`)
    return
  }
  if (decision.action === 'fail') {
    console.error(`scripts/migrate-if-production: ${decision.reason}`)
    process.exit(1)
  }

  try {
    // decision.databaseUrl is DATABASE_URL, or its POSTGRES_URL fallback —
    // decideMigrationGate resolved whichever is set (issue #151/#153).
    await runMigration(decision.databaseUrl)
    console.log('scripts/migrate-if-production: production build — all migrations applied.')
  } catch (err) {
    console.error(
      'scripts/migrate-if-production: migration failed — stopping the build so code never deploys against an unmigrated schema.',
      err,
    )
    process.exit(1)
  }
}

main().catch((err: unknown) => {
  console.error('scripts/migrate-if-production: unexpected failure', err)
  process.exit(1)
})
