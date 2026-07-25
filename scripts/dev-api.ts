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

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { createInboxApi } from '../src/api/index.js'
import { createPasswordAuthProvider } from '../src/auth/password-provider.js'
import type { AuthProvider } from '../src/auth/provider.js'
import { createPgliteDb } from '../src/db/client.js'
import { migrate } from '../src/db/migrate.js'
import { createDevEmailSender } from '../src/dev/dev-sender.js'
import { createHttpBridge } from '../src/dev/http-adapter.js'
import { seedDevData } from '../src/dev/seed.js'
import { createImapConnectService } from '../src/mail/imap-connect.js'
import type { Keyring } from '../src/mail/reply-token.js'
import type { SenderResolver } from '../src/mail/sender-resolver.js'
import { createImapClient } from '../src/providers/adapters/imap/index.js'
import { verifySmtpConnection } from '../src/providers/adapters/smtp/index.js'
import { createAgentStore } from '../src/store/agents.js'
import { createConversationStore } from '../src/store/conversations.js'
import { createImapConfigStore } from '../src/store/imap-config.js'
import { createImapCredentialStore } from '../src/store/imap-credentials.js'
import { createImapWatchStateStore } from '../src/store/imap-watch-state.js'
import { createMailboxStore } from '../src/store/mailboxes.js'

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

// A fixed dev-only AES-256-GCM key (exactly 32 bytes) for the IMAP app-password
// store — never used outside this local harness; a real deployment supplies
// HELPTHREAD_TOKEN_ENC_KEY (`src/composition/config.ts`). Anything encrypted
// under this key is throwaway dev data by construction.
const DEV_TOKEN_ENC_KEY = Buffer.from('helpthread-dev-only-enc-key-32b!', 'utf8')

async function main(): Promise<void> {
  const db = await createPgliteDb(DB_PATH !== undefined ? { dataDir: DB_PATH } : undefined)
  await migrate(db)
  const store = createConversationStore(db)
  const sender = createDevEmailSender()

  // Agents & Authentication (HT-54) — core, required by createInboxApi.
  // No HELPTHREAD_UI_BASE_URL in this harness (there is no web dev server
  // wired up here), so uiBaseUrl stays absent: sendInvite still creates the
  // Agent but inviteSent is always false, matching a fresh, UI-less deploy.
  const agentStore = createAgentStore(db)
  const mailboxStore = createMailboxStore(db)
  const authProviders: AuthProvider[] = [createPasswordAuthProvider({ agentStore })]

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

  // --- IMAP/SMTP mailbox connection (HT-101) ------------------------------
  // The real adapters and stores, wired exactly as `src/composition/root.ts`
  // wires them, so `POST /inbound/imap/{connect,check}` and `GET
  // /mailboxes/{id}/imap-config` actually work in this harness. Without this
  // the routes are simply absent (`imapConnect` is optional on InboxApiDeps)
  // and the connect UI 404s against a dev server — which is exactly what
  // happened before this was added. `createImapClient`/`verifySmtpConnection`
  // make REAL outbound connections, so a connect attempt here talks to the
  // operator's actual mail server, same as production.
  const imapConfigStore = createImapConfigStore(db)
  const imapCredentialStore = createImapCredentialStore(db, DEV_TOKEN_ENC_KEY)
  const imapWatchStateStore = createImapWatchStateStore(db)
  const imapConnectService = createImapConnectService({
    db,
    mailboxStore,
    configStore: imapConfigStore,
    credentialStore: imapCredentialStore,
    watchStateStore: imapWatchStateStore,
    createImapClient,
    verifySmtp: verifySmtpConnection,
  })

  // Every reply in this harness goes through the console dev sender, whatever
  // inbox its conversation belongs to — the harness never transmits real mail.
  // Production resolves a per-inbox sender instead (`src/mail/sender-resolver.ts`).
  const senderResolver: SenderResolver = {
    async resolve() {
      return { sender, from: SUPPORT_ADDRESS }
    },
  }

  const api = createInboxApi({
    store,
    apiToken: API_TOKEN,
    sender,
    senderResolver,
    keyring: KEYRING,
    mailDomain: MAIL_DOMAIN,
    supportAddress: SUPPORT_ADDRESS,
    agents: { store: agentStore, providers: authProviders, mailboxStore },
    imapConnect: {
      service: imapConnectService,
      configStore: imapConfigStore,
      mailboxStore,
    },
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
