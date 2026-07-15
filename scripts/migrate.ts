/**
 * One-shot database migration runner (HT-43; specs/deploy/gmail-inbound-runbook.md
 * Part B2). Applies every migration (`src/db/migrate.ts`) against
 * `DATABASE_URL`.
 *
 * Run ONCE after provisioning the Supabase database, and again whenever new
 * migrations are added. The composition root (`src/composition/root.ts`)
 * deliberately does NOT migrate on cold start — schema changes are an operator
 * step, not something every serverless instance re-runs.
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
 */

import { migrate } from '../src/db/migrate.js'
import { createPostgresDb } from '../src/db/postgres.js'

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (connectionString === undefined || connectionString.trim().length === 0) {
    console.error('scripts/migrate: DATABASE_URL is required (the Postgres connection string).')
    process.exit(1)
  }

  const db = await createPostgresDb({ connectionString })
  try {
    await migrate(db)
    console.log('scripts/migrate: all migrations applied.')
  } finally {
    await db.close()
  }
}

main().catch((err: unknown) => {
  console.error('scripts/migrate: migration failed', err)
  process.exit(1)
})
