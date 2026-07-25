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
 * - the Gmail connect/consent service and its disconnect counterpart (HT-47),
 * - `createInboxApi` with `gmailPush` + `gmailConnect` + `gmailDisconnect`
 *   PRESENT (they are absent-by-default on the engine; this root is where
 *   they get wired), and
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
import type { GmailDisconnectDeps } from '../api/gmail-disconnect.js'
import {
  GMAIL_RECONCILE_TOPIC,
  type GmailPushDeps,
  type GmailReconcileJob,
} from '../api/gmail-webhook.js'
import { createInboxApi } from '../api/index.js'
import type { WebAuthnApiDeps } from '../api/webauthn.js'
import { createPasswordAuthProvider } from '../auth/password-provider.js'
import type { AuthProvider } from '../auth/provider.js'
import { createWebAuthnAuthProvider } from '../auth/webauthn-provider.js'
import { resolveWebAuthnRp } from '../auth/webauthn-rp.js'
import type { Db } from '../db/client.js'
import { createPostgresDb } from '../db/postgres.js'
import { createGmailConnectService } from '../mail/gmail-connect.js'
import { createGmailDisconnectService } from '../mail/gmail-disconnect.js'
import { createGmailOAuthTokenService } from '../mail/gmail-oauth.js'
import { createGmailReconcileHandler } from '../mail/gmail-reconcile.js'
import {
  type GmailReconcileSweepDeps,
  runGmailReconcileSweep,
} from '../mail/gmail-reconcile-sweep.js'
import {
  type GmailWatchMaintenanceDeps,
  runGmailWatchMaintenance,
} from '../mail/gmail-watch-maintenance.js'
import { ingestInboundMessage } from '../mail/ingest.js'
import type { Keyring } from '../mail/reply-token.js'
import { runSnoozeWake } from '../mail/snooze-wake.js'
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
import { createAgentStore } from '../store/agents.js'
import { createAssistantStore } from '../store/assistants.js'
import {
  createConversationStore,
  createEventOutboxStore,
  createGmailWatchStateStore,
  createInboundDeliveryStore,
  createMailboxStore,
  createMailboxTokenStore,
  createSavedReplyStore,
  createThreadAttachmentStore,
  createWebhookEndpointStore,
} from '../store/index.js'
import { createWebAuthnStore } from '../store/webauthn.js'
import {
  createWebhookDeliveryHandler,
  WEBHOOK_DELIVERY_TOPIC,
  type WebhookDeliveryJob,
} from '../webhooks/delivery.js'
import { drainEventOutbox } from '../webhooks/outbox-drain.js'
import { createAppHandler } from './app.js'
import { type AppConfig, loadConfig } from './config.js'
import { runHealthCheck } from './health.js'

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

/** Deployment display name shown in the OS passkey UI (HT-75; specs/auth/passkeys.md §6.1's `rpName` — "config or a fixed string"; no `AppConfig` field exists for this yet, so a fixed string is used). */
const WEBAUTHN_RP_NAME = 'Helpthread'

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
  const agentStore = createAgentStore(db)
  const assistantStore = createAssistantStore(db)
  const savedReplyStore = createSavedReplyStore(db)
  const webAuthnStore = createWebAuthnStore(db)

  // --- Module substrate (HT-69; specs/modules/substrate-v1.md §4/§5): the
  // event outbox and webhook endpoint stores. `webhookEndpointStore` reuses
  // the SAME `tokenEncryptionKey` as `tokenStore` above (mailbox OAuth
  // tokens) — `src/store/webhook-endpoints.ts`'s own module doc: "no new
  // crypto code — this module reuses mailbox-tokens.ts's crypto primitives,
  // not a second key hierarchy". ---
  const eventOutboxStore = createEventOutboxStore(db)
  const webhookEndpointStore = createWebhookEndpointStore(db, config.tokenEncryptionKey)

  // --- The HMAC keyring backing reply/state/view/webauthn tokens (single current key). ---
  const keyring: Keyring = { current: { keyId: SIGNING_KEY_ID, secret: config.signingSecret } }

  // --- Agents & Authentication (HT-54): the core provider registry is just
  // `[password]` — an ordered list, no discovery mechanism (spec §4's
  // honest-scope note). HT-75 (specs/auth/passkeys.md §3) pushes a SECOND
  // provider onto this SAME array below, once `sender` exists — see that
  // block's own comment for why it's conditional on `config.uiBaseUrl`. ---
  const authProviders: AuthProvider[] = [createPasswordAuthProvider({ agentStore })]

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

  // --- Passkeys (HT-75; specs/auth/passkeys.md §3) — ONLY when
  // `config.uiBaseUrl` is set AND resolves to a domain-form hostname: there
  // is no safe fallback origin to bind WebAuthn ceremonies to, so a
  // deployment with no known (or WebAuthn-unusable) UI origin simply never
  // gets the passkey login option (`GET /auth/providers` omits the
  // descriptor, and `webauthn` stays `undefined` — every route in
  // `src/api/webauthn.ts` 404s) — the same degrade-by-omission shape
  // `agents.uiBaseUrl` already uses for invites.
  //
  // The `uiBaseUrl`-set-but-IP-literal case is a deliberate judgment call,
  // not directly pinned by the spec: `resolveWebAuthnRp` THROWS for that
  // case (module doc), and letting that throw propagate would crash
  // `buildApp()` entirely — taking down the WHOLE engine (mail ingestion,
  // conversations, everything) over a passkeys-only misconfiguration that
  // spec §3 itself frames as "every other HT-54 feature working, passkeys
  // silently failing at the first ceremony," not "the deployment doesn't
  // boot." Caught here and treated identically to `uiBaseUrl` being unset —
  // the SAME degrade-by-omission this block already applies, just reached
  // by a different path — rather than an unbounded-blast-radius boot crash.
  // authProviders.push below mutates the SAME array reference already
  // passed to `createPasswordAuthProvider`'s sibling above and threaded
  // into both `webauthn.providers` (step-up/password reuses the registered
  // `password` provider) and `agents.providers` below. ---
  let webauthn: WebAuthnApiDeps | undefined
  if (config.uiBaseUrl !== undefined) {
    let rp: ReturnType<typeof resolveWebAuthnRp> | undefined
    try {
      rp = resolveWebAuthnRp(config.uiBaseUrl)
    } catch (err) {
      console.error(
        '[composition] HELPTHREAD_UI_BASE_URL is set but not WebAuthn-usable (an IP literal, not a domain) — passkeys are disabled for this deployment; every other feature is unaffected',
        err,
      )
    }
    if (rp !== undefined) {
      webauthn = {
        db,
        store: webAuthnStore,
        agentStore,
        providers: authProviders,
        keyring,
        rp,
        rpName: WEBAUTHN_RP_NAME,
        sender,
        mailDomain: config.mailDomain,
        supportAddress: config.supportAddress,
      }
      authProviders.push(createWebAuthnAuthProvider({ db, store: webAuthnStore, keyring, rp }))
    }
  }

  // --- Gmail push webhook deps. The JWKS key source is built ONCE here and
  // reused across every request (its fetch cache only caches if reused — see
  // createGooglePushKeySource's doc). ---
  // Built ONLY when push is configured (HT-94). With `config.gmailPush`
  // absent there is no subscription to authenticate against and no OIDC
  // service account to match, so the webhook must not be routable at all —
  // an endpoint that accepts deliveries it cannot verify is worse than one
  // that isn't there.
  const gmailPush: GmailPushDeps | undefined =
    config.gmailPush === undefined
      ? undefined
      : {
          verifySignature: createGmailPushSignatureVerifier(
            {
              endpointUrl: `${config.publicBaseUrl}/api/v1/inbound/gmail`,
              serviceAccountEmail: config.gmailPush.serviceAccount,
            },
            createGooglePushKeySource(),
          ),
          subscription: config.gmailPush.subscription,
          mailboxes: mailboxStore,
          queue,
        }

  // --- Gmail connect/consent service. ---
  const connectService = createGmailConnectService({
    db,
    clientId: config.gmailOAuthClientId,
    clientSecret: config.gmailOAuthClientSecret,
    redirectUri: `${config.publicBaseUrl}/api/v1/inbound/gmail/callback`,
    // Absent when push isn't configured: connect then skips the watch() arm
    // and seeds the baseline from getProfile() (HT-94, gmail-connect.ts step 4).
    ...(config.gmailPush !== undefined ? { topicName: config.gmailPush.topic } : {}),
    scopes: GMAIL_SCOPES,
    keyring,
    mailboxStore,
    tokenStore,
    watchStateStore,
    createWatchClient: (getAccessToken) => createGmailWatchClient({ getAccessToken }),
  })
  const gmailConnect: GmailConnectDeps = { service: connectService }

  // --- Gmail disconnect admin action (HT-47) — the inverse of connect. ---
  const disconnectService = createGmailDisconnectService({
    db,
    mailboxStore,
    tokenStore,
    watchStateStore,
    tokenService,
    createWatchClient: (getAccessToken) => createGmailWatchClient({ getAccessToken }),
  })
  const gmailDisconnect: GmailDisconnectDeps = { service: disconnectService }

  // --- The Agent Inbox API, with gmailPush + gmailConnect + gmailDisconnect
  // PRESENT (the engine leaves them absent by default; this root is the one
  // place they are wired). openTracking is intentionally OMITTED — the
  // shipped privacy default is OFF (v1.1 designed contract). ---
  const inboxApi = createInboxApi({
    store,
    apiToken: config.apiToken,
    sender,
    keyring,
    mailDomain: config.mailDomain,
    supportAddress: config.supportAddress,
    gmailPush,
    gmailConnect,
    gmailDisconnect,
    attachments: { store: attachmentStore, blobStore },
    // Agents & Authentication (HT-54) — CORE, required (unlike the
    // absent-by-default fields above). uiBaseUrl is spread in only when
    // configured (config.ts's own optional-field convention) so the invite
    // path stays genuinely absent, not present-with-undefined. mailboxStore
    // reuses the SAME MailboxStore instance built above (HT-54 follow-up,
    // spec §3.4/§6's mailbox-access endpoints) — no second store needed.
    agents: {
      store: agentStore,
      providers: authProviders,
      mailboxStore,
      ...(config.uiBaseUrl !== undefined ? { uiBaseUrl: config.uiBaseUrl } : {}),
    },
    // Webhooks admin API (HT-69) — CORE, required like `agents` (spec §1:
    // the substrate is core, free forever). `queue` is the SAME
    // `PostgresQueue` instance every other enqueue in this root shares.
    webhooks: { store: webhookEndpointStore, queue },
    // Assistants + drafts (HT-70) — CORE, required (same posture as
    // `agents` above).
    assistants: { store: assistantStore },
    // Saved replies & macros (HT-76) — CORE, required, same posture as
    // `agents`/`webhooks`/`assistants` above. mailboxStore reuses the SAME
    // MailboxStore instance every other mailbox-scoped feature in this root
    // shares — no second store needed.
    savedReplies: { store: savedReplyStore, mailboxStore },
    // Passkeys (HT-75) — spread in only when configured (uiBaseUrl set),
    // matching agents.uiBaseUrl's own optional-field convention above.
    ...(webauthn !== undefined ? { webauthn } : {}),
    // HT-49 review fix: Gmail delivers a sent reply's own copy back into the
    // SAME mailbox it was sent from, where reconcile would otherwise re-ingest
    // it as a phantom inbound message (src/mail/send.ts's "The reply token's
    // own self-echo" section). Wired unconditionally here — every deployment
    // this root builds is Gmail-backed.
    selfEchoGuard: { mailboxStore, inboundDeliveryStore },
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

  // --- The webhook delivery handler the SAME queue drain also dispatches to
  // (HT-69) — the outbox drain (wired below, its own cron tick) is what
  // ENQUEUES onto this topic; this handler is what the existing every-minute
  // `queue.drainOnce` call actually DELIVERS with. ---
  const webhookDeliveryHandler = createWebhookDeliveryHandler({
    webhookEndpoints: webhookEndpointStore,
  })

  // The drain's handler map is typed `QueueMessageHandler<unknown>` (the queue
  // stores arbitrary JSON payloads); the topic string is what guarantees the
  // payload is a GmailReconcileJob/WebhookDeliveryJob, so the narrowing cast
  // at this single wiring point is the honest boundary between "any queued
  // job" and "this topic's job shape".
  const drainHandlers: Record<string, QueueMessageHandler<unknown>> = {
    [GMAIL_RECONCILE_TOPIC]: (message) =>
      reconcileHandler(message as QueueMessage<GmailReconcileJob>),
    [WEBHOOK_DELIVERY_TOPIC]: (message) =>
      webhookDeliveryHandler(message as QueueMessage<WebhookDeliveryJob>),
  }

  // --- Reconciliation-sweep deps (HT-94). Deliberately NO tokenService and no
  // watch client: the sweep reads a cursor and enqueues, making no Gmail call
  // of its own, which is what makes every-minute cadence affordable. ---
  const reconcileSweepDeps: GmailReconcileSweepDeps = {
    mailboxStore,
    watchStateStore,
    queue,
  }

  // --- Watch-maintenance deps (daily re-arm). Only meaningful when push is
  // configured — with no topic there is no watch to re-arm. The reconciliation
  // sweep is NOT part of this any more (HT-94): it runs on its own every-minute
  // cron as the primary intake, independent of whether push exists. ---
  const watchMaintenanceDeps: GmailWatchMaintenanceDeps | undefined =
    config.gmailPush === undefined
      ? undefined
      : {
          tokenService,
          mailboxStore,
          watchStateStore,
          createWatchClient: (getAccessToken) => createGmailWatchClient({ getAccessToken }),
          topicName: config.gmailPush.topic,
        }

  return createAppHandler({
    inboxApi,
    cronSecret: config.cronSecret,
    // `GET /`'s redirect target (app.ts's bare-root response) — spread in
    // only when configured, like agents.uiBaseUrl above.
    ...(config.uiBaseUrl !== undefined ? { uiBaseUrl: config.uiBaseUrl } : {}),
    drainQueue: async () => {
      const report = await queue.drainOnce({ handlers: drainHandlers })
      // The drain's report otherwise exists ONLY in the cron response body,
      // which Vercel Cron discards — this line is what makes per-tick queue
      // outcomes (spec §6's retry outcome, and especially staleSkipped —
      // the drains-are-overlapping signal) visible in the platform logs at
      // all (HT-44). Quiet ticks (nothing claimed, nothing stale-skipped)
      // are deliberately not logged: the invocation itself already appears
      // in the request log, and an every-minute all-zeros line would bury
      // the signal.
      if (report.claimed > 0 || report.staleSkipped > 0) {
        console.info(JSON.stringify({ event: 'queue_drain', ...report }))
      }
      return report
    },
    // --- Outbox drain (HT-69) — a SEPARATE cron tick from the queue drain
    // above: this one turns `event_outbox` rows into `queue_jobs` fan-out
    // (`drainEventOutbox`, `src/webhooks/outbox-drain.ts`); the queue drain
    // above is what then actually DELIVERS them, via `webhookDeliveryHandler`
    // registered on `WEBHOOK_DELIVERY_TOPIC` in `drainHandlers`. Same
    // quiet-tick log suppression as `drainQueue` above. ---
    drainOutbox: async () => {
      const report = await drainEventOutbox({
        eventOutbox: eventOutboxStore,
        webhookEndpoints: webhookEndpointStore,
        queue,
      })
      if (report.claimed > 0) {
        console.info(JSON.stringify({ event: 'outbox_drain', ...report }))
      }
      return report
    },
    // The primary inbound transport (HT-94) — runs regardless of whether push
    // is configured, since push only makes the SAME reconcile job run sooner.
    // Quiet ticks are logged unlike the drains': a sweep that stops sweeping is
    // an intake outage, and its every-minute silence is the only signal.
    runReconcileSweep: async () => {
      const report = await runGmailReconcileSweep(reconcileSweepDeps)
      console.info(JSON.stringify({ event: 'reconcile_sweep', ...report }))
      return report
    },
    // With push unconfigured there is no watch() to re-arm, so this cron has
    // nothing to do. It stays ROUTED rather than 404-ing (HT-94): `vercel.json`
    // is static, so a deployment without push would otherwise log a daily
    // not-found that reads like a fault. Reporting a skip is the honest,
    // greppable alternative — and it must never be silent, since a genuinely
    // broken maintenance cron is the failure mode the runbook's external
    // monitor exists to catch.
    runWatchMaintenance: async () => {
      if (watchMaintenanceDeps === undefined) {
        const report = { skipped: 'push-not-configured' as const }
        // Same event name the module itself logs under — one endpoint must not
        // produce two event names, or a log filter finds half its own history.
        console.info(JSON.stringify({ event: 'gmail_watch_maintenance', ...report }))
        return report
      }
      return runGmailWatchMaintenance(watchMaintenanceDeps)
    },
    // Snooze wake pass (HT-77) — a SEPARATE cron tick from the two drains
    // above: flips due `pending`+snoozed conversations back to `active`
    // (`runSnoozeWake`, `src/mail/snooze-wake.ts`) via the SAME
    // `setConversationStatus` path a PATCH would use, so it needs no
    // event-emission logic of its own. Quiet-tick log suppression matches
    // `drainQueue`/`drainOutbox` above — an every-minute all-zeros line
    // would bury the signal.
    runSnoozeWake: async () => {
      const report = await runSnoozeWake({ store })
      if (report.due > 0) {
        console.info(JSON.stringify({ event: 'snooze_wake', ...report }))
      }
      return report
    },
    runHealthCheck: () =>
      runHealthCheck({ db, queue, pushConfigured: config.gmailPush !== undefined }),
  })
}

/**
 * The per-instance memoized handler the Vercel entry (`api/index.ts`)
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
