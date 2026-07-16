/**
 * The composition root (HT-43) — the ONE place concrete platform adapters are
 * constructed from config and wired into the framework-agnostic engine. Per
 * `src/providers/README.md`: "an adapter is selected at the composition
 * root... engine modules never `import` an adapter themselves; they only ever
 * see the interface type." Every `import` of a concrete adapter
 * (`@supabase/*`, the Gmail adapters, the Postgres queue, `PostgresDb`) lives
 * here and nowhere in `src/api/**`, `src/mail/**`, or `src/store/**`.
 *
 * ## What this builds
 *
 * {@link buildApp} constructs, from an {@link AppConfig}:
 * - the `PostgresDb` (Supabase pooler) + every store over it,
 * - the token encryption seam (`createMailboxTokenStore` with the decoded key),
 * - the Gmail OAuth token service + the outbound `EmailSender`,
 * - the Gmail push signature verifier (JWKS source built ONCE — see below),
 * - the durable Postgres job queue,
 * - the Gmail connect/consent service,
 * - `createInboxApi` with `gmailPush` + `gmailConnect` PRESENT (they are
 *   absent-by-default on the engine; this root is where they get wired), and
 * - the two internal cron closures (queue drain, watch maintenance),
 *
 * then hands them to {@link createAppHandler} (`./app.ts`) as one
 * `(request) => Promise<Response>`.
 *
 * ## Per-instance singleton
 *
 * On Vercel each warm function instance loads this module once; {@link getApp}
 * memoizes the built handler so the `pg.Pool` and the Gmail JWKS cache
 * (`createGooglePushKeySource`, whose fetch cache only caches if the source is
 * reused across requests) are constructed once per instance, not per request.
 *
 * ## Secrets in, never out
 *
 * The refresh-token encryption key, OAuth client secret, and every OAuth token
 * are threaded to the exact adapter that needs them and nowhere else; none is
 * ever logged (the adapters enforce that themselves — see `token-crypto.ts`,
 * `gmail-oauth.ts`, `sender.ts`). This module adds no logging of config at all.
 */

import type { GmailConnectDeps } from '../api/gmail-connect.js'
import {
  GMAIL_RECONCILE_TOPIC,
  type GmailPushDeps,
  type GmailReconcileJob,
} from '../api/gmail-webhook.js'
import { createInboxApi } from '../api/index.js'
import type { Db } from '../db/client.js'
import { createPostgresDb } from '../db/postgres.js'
import { createGmailConnectService } from '../mail/gmail-connect.js'
import { createGmailOAuthTokenService } from '../mail/gmail-oauth.js'
import { createGmailReconcileHandler } from '../mail/gmail-reconcile.js'
import {
  type GmailWatchMaintenanceDeps,
  runGmailWatchMaintenance,
} from '../mail/gmail-watch-maintenance.js'
import { ingestInboundMessage } from '../mail/ingest.js'
import type { Keyring } from '../mail/reply-token.js'
import {
  createGmailEmailSender,
  createGmailHistoryClient,
  createGmailPushSignatureVerifier,
  createGmailWatchClient,
  createGooglePushKeySource,
} from '../providers/adapters/gmail/index.js'
import { createPostgresQueue } from '../providers/adapters/postgres-queue/index.js'
import { createSupabaseStorageBlobStore } from '../providers/adapters/supabase-storage/index.js'
import type { BlobStore } from '../providers/blob.js'
import type { QueueMessage, QueueMessageHandler } from '../providers/queue.js'
import {
  createConversationStore,
  createGmailWatchStateStore,
  createInboundDeliveryStore,
  createMailboxStore,
  createMailboxTokenStore,
  createThreadAttachmentStore,
} from '../store/index.js'
import { createAppHandler } from './app.js'
import { type AppConfig, loadConfig } from './config.js'

/**
 * The OAuth scopes the connect flow requests (gmail-connect.md §3, least
 * privilege for the dogfood): read inbound mail + send replies. `watch()`
 * needs `gmail.readonly`; `users.messages.send` needs `gmail.send`.
 */
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

/**
 * The keyId stamped into every minted reply/state/view token (`Keyring`,
 * `src/mail/reply-token.ts`). FIXED and stable across deploys — it is embedded
 * in every outbound `Message-ID`, so changing it would break threading of
 * replies to already-sent mail. This deploy runs a single signing secret
 * (`HELPTHREAD_SIGNING_SECRET`); rotating that secret while keeping this keyId
 * invalidates tokens minted under the old secret (the keyring's `retired` keys
 * — a future multi-secret enhancement — is how a non-breaking rotation would
 * work, and is deliberately not built for the single-mailbox dogfood).
 */
const SIGNING_KEY_ID = 'ht1'

/** Overrides for {@link buildApp}, injected only by tests so the wiring is exercised without real Postgres/Supabase or any network. */
export interface BuildAppOverrides {
  /** A `Db` to use instead of constructing a `PostgresDb` from `config.databaseUrl` (e.g. an in-memory PGlite `Db`). */
  db?: Db
  /** A `BlobStore` to use instead of the Supabase Storage adapter (e.g. an in-memory fake). */
  blobStore?: BlobStore
}

/**
 * Construct every concrete adapter from `config` and wire them into the
 * unified request handler. `overrides` lets a test substitute an in-memory
 * `Db`/`BlobStore`; production passes none. Async because constructing the
 * `PostgresDb` is (it validates any configured schema before returning —
 * though the dogfood uses none, so no network round-trip happens at build).
 *
 * Does NOT run migrations: schema creation is a separate one-shot
 * (`scripts/migrate.ts`, runbook Part B2), never something every cold start
 * re-runs.
 */
export async function buildApp(
  config: AppConfig,
  overrides?: BuildAppOverrides,
): Promise<(request: Request) => Promise<Response>> {
  const db = overrides?.db ?? (await createPostgresDb({ connectionString: config.databaseUrl }))
  const blobStore =
    overrides?.blobStore ??
    createSupabaseStorageBlobStore({
      url: config.supabaseUrl,
      serviceRoleKey: config.supabaseServiceRoleKey,
      bucket: config.blobBucket,
    })

  // --- Stores (all over the one Db). ---
  const store = createConversationStore(db)
  const mailboxStore = createMailboxStore(db)
  const tokenStore = createMailboxTokenStore(db, config.tokenEncryptionKey)
  const watchStateStore = createGmailWatchStateStore(db)
  const inboundDeliveryStore = createInboundDeliveryStore(db)
  const attachmentStore = createThreadAttachmentStore(db)

  // --- The HMAC keyring backing reply/state/view tokens (single current key). ---
  const keyring: Keyring = { current: { keyId: SIGNING_KEY_ID, secret: config.signingSecret } }

  // --- Durable job queue — ONE instance shared by the webhook enqueue, the
  // maintenance sweep enqueue, and the drain, so they share tunables. ---
  const queue = createPostgresQueue(db)

  // --- Gmail OAuth token service (reads the encrypted refresh token, refreshes). ---
  const tokenService = createGmailOAuthTokenService({
    tokenStore,
    mailboxStore,
    clientId: config.gmailOAuthClientId,
    clientSecret: config.gmailOAuthClientSecret,
  })

  // --- Outbound EmailSender. Gmail sends are per-mailbox (per access token);
  // for the single-mailbox dogfood, resolve the support mailbox by address at
  // SEND time (it is created dynamically at connect, so it may not exist when
  // this root is first built) and bind its live token. ---
  const sender = createGmailEmailSender({
    getAccessToken: async () => {
      const mailbox = await mailboxStore.getMailboxByAddress(config.supportAddress)
      if (mailbox === null) {
        throw new Error(
          `composition: no connected mailbox for support address ${config.supportAddress} — connect it via the OAuth flow first`,
        )
      }
      return tokenService.getAccessToken(mailbox.id)
    },
  })

  // --- Gmail push webhook deps. The JWKS key source is built ONCE here and
  // reused across every request (its fetch cache only caches if reused — see
  // createGooglePushKeySource's doc). ---
  const gmailPush: GmailPushDeps = {
    verifySignature: createGmailPushSignatureVerifier(
      {
        endpointUrl: `${config.publicBaseUrl}/api/v1/inbound/gmail`,
        serviceAccountEmail: config.gmailPushServiceAccount,
      },
      createGooglePushKeySource(),
    ),
    subscription: config.gmailPubsubSubscription,
    mailboxes: mailboxStore,
    queue,
  }

  // --- Gmail connect/consent service. ---
  const connectService = createGmailConnectService({
    db,
    clientId: config.gmailOAuthClientId,
    clientSecret: config.gmailOAuthClientSecret,
    redirectUri: `${config.publicBaseUrl}/api/v1/inbound/gmail/callback`,
    topicName: config.gmailPubsubTopic,
    scopes: GMAIL_SCOPES,
    keyring,
    mailboxStore,
    tokenStore,
    watchStateStore,
    createWatchClient: (getAccessToken) => createGmailWatchClient({ getAccessToken }),
  })
  const gmailConnect: GmailConnectDeps = { service: connectService }

  // --- The Agent Inbox API, with gmailPush + gmailConnect PRESENT (the engine
  // leaves them absent by default; this root is the one place they are wired).
  // openTracking is intentionally OMITTED — the shipped privacy default is OFF
  // (v1.1 designed contract). ---
  const inboxApi = createInboxApi({
    store,
    apiToken: config.apiToken,
    sender,
    keyring,
    mailDomain: config.mailDomain,
    supportAddress: config.supportAddress,
    gmailPush,
    gmailConnect,
    attachments: { store: attachmentStore, blobStore },
  })

  // --- The reconcile handler the queue drain dispatches to. ---
  const reconcileHandler = createGmailReconcileHandler({
    tokenService,
    mailboxStore,
    watchStateStore,
    blobStore,
    ingest: (raw) => ingestInboundMessage(raw, { db, inboundDeliveryStore, blobStore, keyring }),
    createHistoryClient: (getAccessToken) => createGmailHistoryClient({ getAccessToken }),
  })

  // The drain's handler map is typed `QueueMessageHandler<unknown>` (the queue
  // stores arbitrary JSON payloads); the topic string is what guarantees the
  // payload is a GmailReconcileJob, so the narrowing cast at this single wiring
  // point is the honest boundary between "any queued job" and "this topic's
  // job shape".
  const drainHandlers: Record<string, QueueMessageHandler<unknown>> = {
    [GMAIL_RECONCILE_TOPIC]: (message) =>
      reconcileHandler(message as QueueMessage<GmailReconcileJob>),
  }

  // --- Watch-maintenance deps (daily re-arm + sweep). ---
  const watchMaintenanceDeps: GmailWatchMaintenanceDeps = {
    tokenService,
    mailboxStore,
    watchStateStore,
    queue,
    createWatchClient: (getAccessToken) => createGmailWatchClient({ getAccessToken }),
    topicName: config.gmailPubsubTopic,
  }

  return createAppHandler({
    inboxApi,
    cronSecret: config.cronSecret,
    drainQueue: () => queue.drainOnce({ handlers: drainHandlers }),
    runWatchMaintenance: () => runGmailWatchMaintenance(watchMaintenanceDeps),
  })
}

/**
 * The per-instance memoized handler the Vercel entry (`api/[...path].ts`)
 * calls. Reads + validates `process.env` via `loadConfig` and builds the app
 * once; a config error becomes a rejected (cached) promise the entry maps to a
 * generic 500 — a misconfigured instance stays down loudly rather than
 * rebuilding the pool on every request.
 */
let appPromise: Promise<(request: Request) => Promise<Response>> | undefined

export function getApp(): Promise<(request: Request) => Promise<Response>> {
  if (appPromise === undefined) {
    // The IIFE turns even loadConfig's synchronous throw into a rejected
    // promise, so the entry's single try/await/catch covers both.
    appPromise = (async () => buildApp(loadConfig()))()
  }
  return appPromise
}
