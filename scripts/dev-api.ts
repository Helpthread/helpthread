/**
 * Local dev API harness (HT-24) — the first runnable entry point for the
 * Helpthread engine.
 *
 * Run via `npm run dev:api` (tsx, a devDependency — see package.json).
 * Deliberately NOT part of the checked TypeScript project: `tsconfig.json`'s
 * `include` only covers `src/**` and `tests/**`, so this file (and the rest
 * of `scripts/`) is outside `tsc`'s project and outside anything that would
 * ever ship — this is dev tooling, not engine code. The reusable pieces it
 * wires together (`src/dev/**`) DO live under `src/` and stay normally
 * typechecked/linted/tested, same as the rest of the engine.
 *
 * What this does: creates a PGlite `Db` (in-memory by default, optionally
 * file-backed for persistence across restarts), runs migrations, seeds demo
 * conversations (in-memory mode only), builds the real `createInboxApi`
 * (`src/api/index.ts`) with a dev-only `EmailSender` that logs instead of
 * delivering, and serves it over plain `node:http` via the hand-rolled
 * bridge in `src/dev/http-adapter.ts`. This is the integration target for
 * the upcoming Agent Inbox UI (HT-23) and a standing dogfood surface for the
 * engine in the meantime.
 *
 * ## Configuration (env vars)
 *
 * - `HT_DEV_TOKEN` — the Bearer token every request must carry. Defaults to
 *   the clearly-dev-only `helpthread-dev-token` (`createInboxApi` requires
 *   at least 16 characters — see `MIN_API_TOKEN_LENGTH`, `src/api/index.ts`
 *   — so the default is chosen to clear that floor) — never reuse this
 *   default outside a local machine.
 * - `HT_DEV_PORT` — HTTP port to listen on. Defaults to `8787`.
 * - `HT_DEV_DB_PATH` — optional PGlite data directory. Omitted (the default)
 *   runs a fresh in-memory database, seeded with demo conversations on every
 *   boot. Set to persist data across restarts — in that mode seeding is
 *   skipped, since the whole point is that the data survives.
 */

import { createServer } from 'node:http'
import { createInboxApi } from '../src/api/index.js'
import { createPgliteDb } from '../src/db/client.js'
import { migrate } from '../src/db/migrate.js'
import { createDevEmailSender } from '../src/dev/dev-sender.js'
import { createHttpBridge } from '../src/dev/http-adapter.js'
import { seedDevData } from '../src/dev/seed.js'
import type { Keyring } from '../src/mail/reply-token.js'
import { createConversationStore } from '../src/store/conversations.js'

const PORT = Number(process.env.HT_DEV_PORT ?? 8787)
const API_TOKEN = process.env.HT_DEV_TOKEN ?? 'helpthread-dev-token'
const DB_PATH = process.env.HT_DEV_DB_PATH
const MAIL_DOMAIN = 'mail.dev.localhost'
const SUPPORT_ADDRESS = 'support@dev.localhost'

// A fixed dev-only signing key — never used outside this local harness. A
// real deployment must supply its own high-entropy secret (see
// src/mail/reply-token.ts's MIN_SECRET_LENGTH, 32 chars minimum).
const KEYRING: Keyring = {
  current: { keyId: 'dev', secret: 'dev-only-signing-secret-not-for-production-use' },
}

async function main(): Promise<void> {
  const db = await createPgliteDb(DB_PATH !== undefined ? { dataDir: DB_PATH } : undefined)
  await migrate(db)
  const store = createConversationStore(db)
  const sender = createDevEmailSender()

  let seededCount: number | undefined
  if (DB_PATH === undefined) {
    const seeded = await seedDevData({
      db,
      store,
      sender,
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
    })
    seededCount = seeded.conversationCount
  }

  const api = createInboxApi({
    store,
    apiToken: API_TOKEN,
    sender,
    keyring: KEYRING,
    mailDomain: MAIL_DOMAIN,
    supportAddress: SUPPORT_ADDRESS,
  })

  const baseUrl = `http://127.0.0.1:${PORT}`
  const server = createServer(createHttpBridge(api, baseUrl))
  // Bind explicitly to loopback — this dev harness must never listen on the
  // LAN (the default token is public knowledge, right there in this file).
  await new Promise<void>((resolve) => {
    server.listen(PORT, '127.0.0.1', resolve)
  })

  console.log('')
  console.log(`Helpthread dev API listening at ${baseUrl}`)
  console.log(`  Auth token: ${API_TOKEN}`)
  console.log(
    `  Database:   ${DB_PATH !== undefined ? `file-backed (${DB_PATH})` : 'in-memory (reset on every restart)'}`,
  )
  console.log(
    `  Seeded:     ${seededCount !== undefined ? `${seededCount} conversations` : 'skipped (file-backed db keeps its existing data)'}`,
  )
  console.log('')
  console.log('Example requests:')
  console.log(`  curl -s ${baseUrl}/api/v1/conversations \\`)
  console.log(`    -H "Authorization: Bearer ${API_TOKEN}"`)
  console.log('')
  console.log(`  curl -s -X POST ${baseUrl}/api/v1/conversations/<conversation-id>/replies \\`)
  console.log(`    -H "Authorization: Bearer ${API_TOKEN}" \\`)
  console.log('    -H "Content-Type: application/json" \\')
  console.log('    -H "Idempotency-Key: <any-unique-string>" \\')
  console.log('    -d \'{"text": "Thanks for reaching out!"}\'')
  console.log('')

  const shutdown = async (): Promise<void> => {
    console.log('\n[dev-api] shutting down...')
    // Wait for in-flight requests to drain before closing the db/exiting.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
    await db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

main().catch((err: unknown) => {
  console.error('[dev-api] fatal error starting server', err)
  process.exit(1)
})
