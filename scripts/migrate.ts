/**
 * One-shot database migration runner (HT-43; specs/deploy/gmail-inbound-runbook.md
 * Part B2). Applies every migration (`src/db/migrate.ts`) against
 * `DATABASE_URL`.
 *
 * This is the MANUAL/local-dev path: run it once after provisioning the
 * Supabase database, and again whenever new migrations are added and you're
 * not deploying through Vercel (or want to migrate ahead of a deploy by
 * hand). A production Vercel deploy applies pending migrations itself, at
 * build time, via `scripts/migrate-if-production.ts` (issue #152;
 * specs/deploy/single-project.md's Migrations section) — that script is a
 * thin `VERCEL_ENV === 'production'` gate around the exact same
 * `runMigration` this file exports, so a build and a manual run apply
 * migrations identically. The composition root (`src/composition/root.ts`)
 * still deliberately does NOT migrate on cold start — schema changes remain
 * a build/operator step, never something every serverless instance re-runs.
 *
 * Usage:
 *   DATABASE_URL='postgres://...' npx tsx scripts/migrate.ts
 *   # or: npm run migrate  (with DATABASE_URL in the environment)
 *
 * For the one-time DDL you may use the direct (5432) connection string instead
 * of the 6543 transaction-mode pooler — either works, since `migrate()`'s
 * advisory lock is transaction-scoped and pooler-safe (`src/db/postgres.ts`).
 *
 * Like `scripts/dev-api.ts`, this lives outside the checked TypeScript project
 * (tsconfig `include` covers `src`/`tests`); it is operator tooling run via
 * `tsx`, not engine code that ships.
 *
 * The `import.meta.url` guard below is load-bearing, not decoration:
 * `scripts/migrate-if-production.ts` imports {@link runMigration} from this
 * SAME module, and without the guard that import would also re-run this
 * file's own CLI `main()` (DATABASE_URL check, `migrate()`, `process.exit`)
 * as an unwanted side effect of being imported, racing/duplicating the
 * importer's own call.
 */

import { fileURLToPath } from 'node:url'
import { migrate } from '../src/db/migrate.js'
import { createPostgresDb } from '../src/db/postgres.js'

/** Connect, apply every pending migration, and disconnect. Shared by this script's `main` and `scripts/migrate-if-production.ts`'s build-time gate, so both apply migrations through the exact same path. */
export async function runMigration(connectionString: string): Promise<void> {
  const db = await createPostgresDb({ connectionString })
  try {
    await migrate(db)
  } finally {
    await db.close()
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString.trim().length === 0) {
    console.error('scripts/migrate: DATABASE_URL is required (the Postgres connection string).')
    process.exit(1)
  }

  await runMigration(connectionString)
  console.log('scripts/migrate: all migrations applied.')
}

// Only run the CLI entrypoint when this file is the one `tsx`/`node` was
// invoked on directly — not when another module (`scripts/migrate-if-
// production.ts`) imports `runMigration` from it. See the module doc above.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error('scripts/migrate: migration failed', err)
    process.exit(1)
  })
}
