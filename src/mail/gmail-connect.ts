/**
 * Gmail OAuth connect/consent flow (HT-40; specs/mail/gmail-connect.md) —
 * the write-side gmail-push.md deliberately stubbed. Runs Google's OAuth2
 * authorization-code flow to obtain a mailbox's first refresh token,
 * persists it encrypted-at-rest, arms the initial `users.watch()`, and
 * seeds the baseline `gmail_watch_state` cursor the reconcile consumer
 * (gmail-push.md §3, HT-41) reads. Lives in `src/mail/` as Gmail-specific
 * orchestration, exactly like `./gmail-oauth.ts` and `./gmail-reconcile.ts`
 * beside it — not under `src/providers/adapters/gmail/`, which holds only
 * thin, single-purpose HTTP adapters (`./gmail-connect.ts` composes THREE
 * of them: the OAuth token endpoint, `GmailWatchClient`, and the store
 * layer).
 *
 * ## The two routes this module backs (gmail-connect.md §2)
 *
 * - `POST /api/v1/inbound/gmail/connect` — Bearer-gated (an operator
 *   action): {@link GmailConnectService.beginConnect} mints a `state` token
 *   and returns the Google consent URL as JSON. The API layer
 *   (`src/api/gmail-connect.ts`) never redirects itself.
 * - `GET /api/v1/inbound/gmail/callback?code&state` — pre-auth (Google
 *   redirects the operator's browser here with no service Bearer token):
 *   {@link GmailConnectService.completeConnect} runs the callback sequence
 *   below.
 *
 * ## The `state` token: a stateless CSRF defence (RFC 6749 §10.12)
 *
 * ```
 * gmc.{keyId}.{issuedAtMs}.{nonce}.{sig}
 * ```
 *
 * Mirrors `src/mail/reply-token.ts`/`./open-tracking.ts`'s signed-token
 * shape off the same {@link Keyring} (full HMAC-SHA256, base64url,
 * constant-time verification, current+retired key rotation) — the same
 * stateless, server-session-free pattern those surfaces already use, a
 * natural fit for a serverless deployment with no session store. `gmc` is
 * the domain separator (distinct from reply tokens' `ht` and view tokens'
 * `v`): a signature minted for one purpose can never verify for another.
 * Unlike those two, a connect `state` carries no domain payload (no
 * conversation/thread id) — its only job is proving "we minted this
 * recently" — so instead it carries a random `nonce` (replay-resistance)
 * and an `issuedAtMs` timestamp ({@link mintConnectState}/{@link
 * verifyConnectState} check freshness against a TTL, default 10 minutes,
 * gmail-connect.md §2b) rather than an id `{@link verifyConnectState}`
 * hands back. Minting is STRICT (a malformed keyring is our bug — throw
 * loudly); verification is TOTAL over the token string (a hostile/expired
 * `state` on the public callback must never throw).
 *
 * ## The callback sequence (gmail-connect.md §4) — nothing persisted until the grant is proven
 *
 * {@link GmailConnectService.completeConnect}, in order:
 *
 * 1. **Verify `state`.** Bad signature / expired / malformed → throw {@link
 *    GmailConnectError} `invalid_state`, nothing else runs.
 * 2. **Exchange the code** ({@link exchangeAuthCode} — the
 *    authorization-code sibling of `./gmail-oauth.ts`'s refresh-token POST,
 *    same injected `fetch`, same "never log `client_secret` or any token"
 *    discipline). A response with no `refresh_token` is a hard error
 *    (`no_refresh_token`) — Google only issues one on a fresh consent
 *    grant (`prompt=consent` forces that).
 * 3. **Resolve the mailbox address authoritatively from the grant** —
 *    `getProfile()` with the fresh access token, never operator input, so a
 *    connected `mailboxes.address` can never disagree with the account that
 *    actually granted access.
 * 4. **Arm `watch()`** with the same fresh access token — BEFORE any
 *    persistence, so a failure here (`watch_failed`) aborts cleanly with
 *    nothing written. `watch()`'s `historyId` — NOT `getProfile`'s — is the
 *    baseline cursor: the exact watermark `history.list` resumes from: using
 *    `getProfile`'s separately-read `historyId` could straddle the arm and
 *    miss or replay a sliver of history.
 * 5. **Persist**, now that the grant is proven usable — three writes keyed
 *    by the resolved mailbox: {@link MailboxStore.upsertConnectedMailbox}
 *    (upsert BY ADDRESS — a reconnect reactivates the existing row rather
 *    than colliding with `mailboxes`' `UNIQUE(address)`), {@link
 *    MailboxTokenStore.upsertTokens} (the refresh token encrypted at rest —
 *    this module NEVER writes a token to the database itself), and {@link
 *    GmailWatchStateStore.seedBaseline} (both `history_id` AND
 *    `watch_expiration`, from the SAME `watch()` response). All three run in
 *    ONE `db.transaction` — a mid-persist failure rolls the whole thing back
 *    rather than leaving a PARTIAL connect (e.g. an `active` mailbox with no
 *    cursor, which would silently no-op every push the already-armed
 *    `watch()` delivers — worse than no mailbox at all, since the webhook
 *    would enqueue reconcile jobs that find nothing to resume from).
 * 6. Return `{ mailboxId, address }` — the API layer renders the success
 *    page.
 *
 * The whole sequence is **idempotent by mailbox address** (gmail-connect.md
 * §5): every step-5 write is an upsert keyed by the resolved mailbox, so a
 * reconnect (an operator re-consenting a `needs_reconnect`/`paused`
 * mailbox, or simply retrying) reactivates the row, replaces the stored
 * tokens, re-arms `watch()`, and REBASELINES the cursor to the fresh
 * `historyId` — never a second mailbox row for the same address.
 *
 * ## Typed errors: what the API layer can safely show an operator
 *
 * {@link GmailConnectError} distinguishes the four operator-fixable 4xx
 * outcomes (`invalid_state`, `exchange_failed`, `no_refresh_token`,
 * `watch_failed`) from an unexpected failure (a DB blip, a network error
 * from `getProfile`) that the API layer maps to a 500 instead
 * (`src/api/gmail-connect.ts`). Every {@link GmailConnectError} message is
 * built to be safe to render on the public callback page: no `code`,
 * `state`, `client_secret`, or token ever appears in one.
 *
 * ## Never log or leak a token (same discipline as `./gmail-oauth.ts`)
 *
 * `client_secret`, the authorization `code`, and every token value
 * (access, refresh) never appear in a thrown error message anywhere in
 * this module. Error messages are built ONLY from HTTP status codes, the
 * OAuth `error`/`error_description` fields (which by protocol design never
 * carry credential material), and this module's own fixed prose.
 *
 * ## What this module does NOT do
 *
 * - **Import a concrete Gmail adapter.** {@link
 *   GmailConnectServiceDeps.createWatchClient} is injected — exactly how
 *   `./gmail-reconcile.ts` takes `createHistoryClient` — per
 *   `src/providers/README.md`'s rule that engine modules only ever see
 *   adapter INTERFACES, never `import` a concrete adapter module. The real
 *   `createGmailWatchClient` (`../providers/adapters/gmail/watch.ts`) is
 *   wired in at the composition root (HT-43); this module only imports its
 *   TYPE.
 * - **Token refresh / `invalid_grant` handling** → `./gmail-oauth.ts`
 *   (HT-38); this module mints and stores only the FIRST refresh token that
 *   service later reads.
 * - **`watch()` renewal + the reconciliation lease** → HT-42
 *   (gmail-push.md §6); this module arms `watch()` exactly once, at
 *   connect.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db } from '../db/client.js'
import type { GmailWatchClient, GmailWatchResult } from '../providers/adapters/gmail/index.js'
import type { GmailWatchStateStore } from '../store/gmail-watch-state.js'
import type { MailboxTokenStore } from '../store/mailbox-tokens.js'
import type { MailboxStore } from '../store/mailboxes.js'
import { assertValidKeyring, type Keyring, type SigningKey } from './reply-token.js'

/** Google's OAuth2 authorization endpoint (RFC 6749 §3.1). Fixed — not configurable, since Google has exactly one. */
const GOOGLE_OAUTH_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

/** Google's OAuth2 token endpoint (RFC 6749 §3.2) — same endpoint `./gmail-oauth.ts` refreshes against, duplicated locally (that module does not export its own copy; matches how each Gmail adapter independently defines its own `GMAIL_API_BASE`). */
const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Default bound on the token-exchange HTTP call, matching `./gmail-oauth.ts`'s own default. */
const DEFAULT_TIMEOUT_MS = 30_000

// --- consent URL -------------------------------------------------------

/**
 * Build the Google OAuth2 consent-screen URL (gmail-connect.md §3):
 * `response_type=code`, `access_type=offline` + `prompt=consent` (BOTH
 * required to be handed a refresh token — RFC 6749 §6), the space-joined
 * `scope` list, and the signed `state`.
 */
export function buildConsentUrl(params: {
  clientId: string
  redirectUri: string
  scopes: string[]
  state: string
}): string {
  const url = new URL(GOOGLE_OAUTH_AUTH_ENDPOINT)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', params.scopes.join(' '))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', params.state)
  return url.toString()
}

// --- state token ---------------------------------------------------------

/** Fixed literal prefix marking a connect `state` token — domain-separated from reply tokens' `ht` and view tokens' `v` (module doc). */
const STATE_PREFIX = 'gmc'

/** Number of dot-separated segments in a well-formed state token: `gmc`, keyId, issuedAtMs, nonce, sig. */
const STATE_SEGMENT_COUNT = 5

/** Random nonce size (bytes) minted into every `state` token — replay-resistance alongside the issued-at freshness check. */
const STATE_NONCE_BYTES = 16

/** Default `state` freshness window: 10 minutes (gmail-connect.md §2b). */
export const DEFAULT_STATE_TTL_MS = 600_000

/** The exact bytes signed: `gmc.{keyId}.{issuedAtMs}.{nonce}`. */
function stateCanonicalString(keyId: string, issuedAtMs: string, nonce: string): string {
  return `${STATE_PREFIX}.${keyId}.${issuedAtMs}.${nonce}`
}

function sign(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('base64url')
}

/**
 * Mint a `state` token, signing with `keyring.current`. STRICT: throws on a
 * malformed keyring (module doc) — emitting an unverifiable token would
 * silently break the connect flow for that request.
 */
export function mintConnectState(keyring: Keyring): string {
  assertValidKeyring(keyring)
  const { keyId, secret } = keyring.current
  const issuedAtMs = String(Date.now())
  const nonce = randomBytes(STATE_NONCE_BYTES).toString('base64url')
  const sig = sign(secret, stateCanonicalString(keyId, issuedAtMs, nonce))
  return `${STATE_PREFIX}.${keyId}.${issuedAtMs}.${nonce}.${sig}`
}

/**
 * Verify a candidate `state` token: well-formed, correctly signed by a
 * known (current or retired) key, and minted no more than `ttlMs` ago.
 * TOTAL — never throws over `state`, the untrusted input the public
 * callback endpoint feeds this raw query-string bytes (module doc); every
 * rejection is a uniform `false`. `keyring` is trusted deploy-time
 * configuration, so a malformed one still fails loudly via {@link
 * assertValidKeyring} — mirrors `reply-token.ts`'s
 * `verifyReplyMessageId`, whose doc explains why that does not weaken
 * totality over the untrusted argument.
 */
export function verifyConnectState(
  state: string,
  keyring: Keyring,
  ttlMs: number = DEFAULT_STATE_TTL_MS,
): boolean {
  assertValidKeyring(keyring)

  if (typeof state !== 'string') return false
  const segments = state.split('.')
  if (segments.length !== STATE_SEGMENT_COUNT) return false
  const [prefix, keyId, issuedAtStr, nonce, sig] = segments
  if (prefix !== STATE_PREFIX) return false
  if (keyId.length === 0 || issuedAtStr.length === 0 || nonce.length === 0 || sig.length === 0) {
    return false
  }

  // Freshness: a finite, non-negative, not-in-the-future timestamp within
  // ttlMs of now. A tampered issuedAtMs (with the rest of the token left
  // alone) already fails the signature check below, since issuedAtStr is
  // itself part of the signed canonical string — this check exists to
  // reject an OTHERWISE validly-signed but stale or clock-nonsensical token.
  const issuedAtMs = Number(issuedAtStr)
  const now = Date.now()
  if (!Number.isFinite(issuedAtMs) || issuedAtMs < 0 || issuedAtMs > now) return false
  if (now - issuedAtMs > ttlMs) return false

  const canonical = stateCanonicalString(keyId, issuedAtStr, nonce)
  for (const key of candidateKeys(keyring, keyId)) {
    if (signatureMatches(key.secret, canonical, sig)) {
      return true
    }
  }
  return false
}

/** Keys in the ring (current first, then retired) whose keyId matches the token's. Same helper reply-token.ts/open-tracking.ts each keep a local copy of. */
function candidateKeys(keyring: Keyring, keyId: string): SigningKey[] {
  const all = keyring.retired ? [keyring.current, ...keyring.retired] : [keyring.current]
  return all.filter((key) => key.keyId === keyId)
}

/** Constant-time signature check — same length-guarded pattern as reply-token.ts/open-tracking.ts. */
function signatureMatches(secret: string, canonical: string, providedSig: string): boolean {
  const expected = Buffer.from(sign(secret, canonical))
  const provided = Buffer.from(providedSig)
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

// --- typed errors ----------------------------------------------------------

/** The four operator-fixable outcomes {@link GmailConnectService.completeConnect} can fail with. See the module doc. */
export type GmailConnectErrorCode =
  | 'invalid_state'
  | 'exchange_failed'
  | 'no_refresh_token'
  | 'watch_failed'

/**
 * A `completeConnect` failure the API layer (`src/api/gmail-connect.ts`)
 * renders as a 4xx callback error page, distinct from an unexpected
 * failure (mapped to 500). `message` is always safe to render to the
 * operator's browser — see the module doc's "never log or leak a token"
 * section.
 */
export class GmailConnectError extends Error {
  readonly code: GmailConnectErrorCode

  constructor(code: GmailConnectErrorCode, message: string) {
    super(message)
    this.name = 'GmailConnectError'
    this.code = code
  }
}

/** Extract a safe-to-reuse message from a caught value. The errors this module ever wraps (exchangeAuthCode's, GmailWatchClient's) are already secret-free by their own construction (module doc), so forwarding `.message` verbatim adds no new leak. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// --- authorization-code exchange -------------------------------------------

/** Options for {@link exchangeAuthCode}. */
export interface ExchangeAuthCodeOptions {
  /** The `code` Google's redirect carried back. */
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Injectable `fetch`, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Milliseconds before the exchange HTTP call is abandoned. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** The tokens a successful {@link exchangeAuthCode} call returns. */
export interface ExchangedTokens {
  accessToken: string
  refreshToken: string
  /** Seconds until `accessToken` expires (the token endpoint's raw `expires_in`). */
  expiresIn: number
  /** The granted OAuth `scope` string, when the response includes one. */
  scope?: string
}

/** Shape of the fields this module reads from a token-endpoint JSON response — mirrors `./gmail-oauth.ts`'s own `TokenResponseBody`. */
interface TokenExchangeResponseBody {
  access_token?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  scope?: unknown
  error?: unknown
  error_description?: unknown
}

/**
 * Best-effort parse of a response body as a JSON object — identical
 * fallback-to-`{}` behavior as `./gmail-oauth.ts`'s own copy (duplicated
 * locally rather than shared, since that module does not export it).
 */
async function parseJsonObject(response: Response): Promise<TokenExchangeResponseBody> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null ? (value as TokenExchangeResponseBody) : {}
  } catch {
    return {}
  }
}

/**
 * Exchange an authorization `code` for tokens (RFC 6749 §4.1.3) — the
 * authorization-code sibling of `./gmail-oauth.ts`'s `refresh_token` POST:
 * same endpoint, same injected `fetch`, same "never log `client_secret` or
 * any token" discipline (module doc).
 *
 * Throws a plain `Error` on any non-2xx (built from the HTTP status plus
 * the OAuth `error`/`error_description` fields only) or a malformed 2xx
 * body (missing/invalid `access_token`/`expires_in`). Throws a {@link
 * GmailConnectError} `no_refresh_token` specifically when the response has
 * no non-empty `refresh_token` — gmail-connect.md §4 step 2 treats this as
 * its own operator-actionable outcome (retry with a fresh consent), not a
 * generic transport failure, so it carries its own typed code rather than
 * being folded into a generic exchange failure.
 */
export async function exchangeAuthCode(options: ExchangeAuthCodeOptions): Promise<ExchangedTokens> {
  const {
    code,
    clientId,
    clientSecret,
    redirectUri,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  })

  const response = await fetchImpl(GMAIL_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // Bounds the whole exchange, same rationale as gmail-oauth.ts's
    // identical use of AbortSignal.timeout.
    signal: AbortSignal.timeout(timeoutMs),
  })

  const parsed = await parseJsonObject(response)

  if (!response.ok) {
    const errorCode = typeof parsed.error === 'string' ? parsed.error : undefined
    const description =
      typeof parsed.error_description === 'string' ? parsed.error_description : undefined
    throw new Error(
      `exchangeAuthCode: token exchange failed: HTTP ${response.status}` +
        (errorCode ? ` (${errorCode}${description ? `: ${description}` : ''})` : ''),
    )
  }

  const accessToken = parsed.access_token
  const expiresIn = parsed.expires_in
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn)
  ) {
    throw new Error(
      'exchangeAuthCode: malformed token exchange response (missing or invalid access_token/expires_in)',
    )
  }

  const refreshToken = parsed.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new GmailConnectError(
      'no_refresh_token',
      'The connect attempt did not receive a refresh token from Google. This usually means a prior ' +
        'grant already exists for this account. Please retry — the consent screen will be shown again ' +
        'and should issue a new refresh token.',
    )
  }

  const scope = parsed.scope
  return {
    accessToken,
    refreshToken,
    expiresIn,
    scope: typeof scope === 'string' && scope.length > 0 ? scope : undefined,
  }
}

// --- the service -------------------------------------------------------------

/** Dependencies {@link createGmailConnectService} needs. */
export interface GmailConnectServiceDeps {
  /**
   * The database handle whose {@link Db.transaction} wraps the step-5 persist
   * (mailbox row + token row + watch-state seed) into one atomic unit — see
   * the module doc's step 5. The three stores below must be the SAME `Db`'s
   * stores, so the transaction's `Queryable` targets the same database.
   */
  db: Db
  /** The deployment's Internal OAuth app client id/secret (gmail-connect.md §3) — injected config, never hardcoded. */
  clientId: string
  clientSecret: string
  /** Must exactly match `/api/v1/inbound/gmail/callback` on the deployment's public origin AND a redirect URI registered on the OAuth client (gmail-connect.md §3). */
  redirectUri: string
  /**
   * The Cloud Pub/Sub topic `watch()` arms notifications to
   * (`projects/{project}/topics/{topic}`, HT-43-provisioned) — injected config.
   *
   * OPTIONAL as of HT-94. When absent, push is not configured for this
   * deployment: connect skips the `watch()` arm entirely and seeds the
   * baseline cursor from `getProfile()` instead, leaving the bounded
   * scheduled fetch as the sole inbound transport.
   */
  topicName?: string
  /** OAuth scopes requested on the consent screen (gmail-connect.md §3: `gmail.readonly` + `gmail.send` for the dogfood). */
  scopes: string[]
  /** Signs/verifies the `state` CSRF token (module doc). */
  keyring: Keyring
  mailboxStore: MailboxStore
  tokenStore: MailboxTokenStore
  watchStateStore: GmailWatchStateStore
  /**
   * Builds a {@link GmailWatchClient} bound to a per-call `getAccessToken`.
   * REQUIRED and injected — `src/providers/README.md`'s rule that engine
   * modules never import a concrete adapter; see how `./gmail-reconcile.ts`
   * takes `createHistoryClient` the same way. The composition root (HT-43)
   * wires in the real `createGmailWatchClient`
   * (`../providers/adapters/gmail/watch.ts`); tests pass a fake.
   */
  createWatchClient: (getAccessToken: () => Promise<string>) => GmailWatchClient
  /** Injectable `fetch` for the token-exchange call, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** TTL for a minted `state` token. Defaults to {@link DEFAULT_STATE_TTL_MS}. */
  stateTtlMs?: number
}

/** The connect/consent orchestration service. See the module doc for the full flow. */
export interface GmailConnectService {
  /** Mint a fresh `state` and build the Google consent URL (gmail-connect.md §2a, §3). */
  beginConnect(): { consentUrl: string }

  /**
   * Run the callback sequence (gmail-connect.md §4) for a `code`+`state`
   * pair Google redirected back with. Throws {@link GmailConnectError} for
   * every operator-fixable failure; any other throw is unexpected (the
   * caller should treat it as a 5xx). Nothing is persisted unless this
   * resolves — see the module doc.
   */
  completeConnect(params: { code: string; state: string }): Promise<{
    mailboxId: string
    address: string
  }>
}

/** Throw a clear, field-named error unless `value` is a non-empty string. Matches `./gmail-oauth.ts`'s own `assertNonEmpty` (duplicated locally, not shared, per that module's precedent). */
function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`createGmailConnectService: ${field} must be a non-empty string`)
  }
}

/**
 * Build the Gmail connect/consent service. Eagerly validates every
 * required config field (fails at construction/boot, not on a request —
 * matches `./gmail-oauth.ts`'s "misconfigured deploy fails at boot"
 * discipline) and the `keyring` ({@link assertValidKeyring} — both
 * {@link mintConnectState} and {@link verifyConnectState} need it valid
 * anyway, so checking once here fails fast rather than on first use).
 */
export function createGmailConnectService(deps: GmailConnectServiceDeps): GmailConnectService {
  const {
    db,
    clientId,
    clientSecret,
    redirectUri,
    topicName,
    scopes,
    keyring,
    mailboxStore,
    tokenStore,
    watchStateStore,
    createWatchClient,
    fetchImpl = fetch,
    stateTtlMs = DEFAULT_STATE_TTL_MS,
  } = deps

  assertNonEmpty('clientId', clientId)
  assertNonEmpty('clientSecret', clientSecret)
  assertNonEmpty('redirectUri', redirectUri)
  // Optional (HT-94): absent means push is not configured for this deployment.
  // Present-but-blank is still a misconfiguration and still rejected — the
  // all-or-nothing shape is enforced at the composition root (`resolveGmailPush`).
  if (topicName !== undefined) assertNonEmpty('topicName', topicName)
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('createGmailConnectService: scopes must be a non-empty array')
  }
  assertValidKeyring(keyring)

  return {
    beginConnect() {
      const state = mintConnectState(keyring)
      const consentUrl = buildConsentUrl({ clientId, redirectUri, scopes, state })
      return { consentUrl }
    },

    async completeConnect(params) {
      // --- Step 1: verify state — bad/expired aborts before anything else runs. ---
      if (!verifyConnectState(params.state, keyring, stateTtlMs)) {
        throw new GmailConnectError(
          'invalid_state',
          'This connect link is invalid or has expired. Please restart the connect flow.',
        )
      }

      // --- Step 2: exchange the code. ---
      let exchanged: ExchangedTokens
      try {
        exchanged = await exchangeAuthCode({
          code: params.code,
          clientId,
          clientSecret,
          redirectUri,
          fetchImpl,
        })
      } catch (err) {
        // no_refresh_token already carries its own typed code — preserve it
        // verbatim rather than re-wrapping as a generic exchange failure.
        if (err instanceof GmailConnectError) throw err
        throw new GmailConnectError(
          'exchange_failed',
          `Token exchange failed: ${errorMessage(err)}`,
        )
      }

      // --- Step 3: resolve the mailbox address authoritatively from the grant. ---
      const watchClient = createWatchClient(() => Promise.resolve(exchanged.accessToken))
      const profile = await watchClient.getProfile()

      // --- Step 4: arm watch() BEFORE any persistence (module doc).
      //
      // SKIPPED ENTIRELY when push is not configured (HT-94, CHARTER.md §2 as
      // amended 2026-07-20): there is no topic to arm against, and the bounded
      // scheduled fetch is the transport. The baseline then comes from the
      // `getProfile()` call step 3 ALREADY made.
      //
      // That substitution is safe for exactly the reason the module doc gives
      // for rejecting it in the push case: getProfile's separately-read
      // historyId "could straddle the arm." With no arm, there is nothing to
      // straddle — one read, one baseline, and the sweep resumes from it. No
      // extra API call is made either; step 3's response carries the value. ---
      let baseline: { historyId: string; watchExpiration?: Date }
      if (topicName === undefined) {
        baseline = { historyId: profile.historyId }
      } else {
        let armed: GmailWatchResult
        try {
          armed = await watchClient.watch({ topicName })
        } catch (err) {
          throw new GmailConnectError(
            'watch_failed',
            `Enabling Gmail push failed: ${errorMessage(err)}`,
          )
        }
        baseline = { historyId: armed.historyId, watchExpiration: armed.expiration }
      }

      // --- Step 5: persist, now that the grant is proven usable — ONE atomic
      // transaction (module doc) so a mid-persist failure never leaves a
      // partial connect. ---
      const mailbox = await db.transaction(async (tx) => {
        const created = await mailboxStore.upsertConnectedMailbox(
          { address: profile.emailAddress, provider: 'gmail' },
          tx,
        )
        await tokenStore.upsertTokens(
          created.id,
          {
            refreshToken: exchanged.refreshToken,
            accessToken: exchanged.accessToken,
            accessTokenExpiresAt: new Date(Date.now() + exchanged.expiresIn * 1000),
            scopes: exchanged.scope,
          },
          tx,
        )
        await watchStateStore.seedBaseline(created.id, baseline, tx)
        return created
      })

      // --- Step 6: the mailbox is live. ---
      return { mailboxId: mailbox.id, address: profile.emailAddress }
    },
  }
}
