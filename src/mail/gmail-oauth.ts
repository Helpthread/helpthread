/**
 * Gmail OAuth2 access-token acquisition + refresh (HT-38; gmail-push.md §7:
 * "OAuth token acquisition/refresh → HT-38; the connect/consent flow →
 * HT-40"). This is what turns a stored, encrypted refresh token
 * (`src/store/mailbox-tokens.ts`, migration 010) into the live bearer access
 * token the Gmail adapters need — most directly, `getAccessToken` here is
 * built to be handed to `createGmailEmailSender`'s `getAccessToken: () =>
 * Promise<string>` option (`src/providers/adapters/gmail/sender.ts`), bound
 * to one mailbox: `() => tokenService.getAccessToken(mailboxId)`.
 *
 * ## What this module does NOT do
 *
 * - **Mint the first refresh token.** That is the connect/consent OAuth
 *   flow (HT-40) — this module only ever reads a refresh token that flow
 *   already stored via `MailboxTokenStore.upsertTokens`.
 * - **Encrypt or decrypt anything directly.** `MailboxTokenStore` owns that
 *   boundary (`src/store/mailbox-tokens.ts`, `src/store/token-crypto.ts`) —
 *   this module only ever sees plaintext token strings, already
 *   decrypted-on-read / about to be encrypted-on-write by the store.
 * - **Renew a Gmail `watch()` subscription.** That's HT-42, which has its
 *   OWN failure→`needs_reconnect` transition (gmail-push.md §6) but reuses
 *   {@link MailboxStore.markNeedsReconnect} rather than duplicating it.
 *
 * ## Caching and the expiry skew
 *
 * `getAccessToken` returns the cached access token from `MailboxTokenStore`
 * without a network call whenever one exists AND is not within
 * {@link GmailOAuthTokenServiceOptions.expirySkewMs} of its real expiry.
 * The skew exists so a token is never handed to a caller a moment before it
 * expires mid-use (e.g. a slow Gmail `messages.send` call straddling the
 * expiry instant): refreshing a little early is free (Google does not
 * invalidate the old access token when a new one is issued — see below),
 * whereas a request that starts with an about-to-expire token can fail
 * partway through. The default, {@link DEFAULT_EXPIRY_SKEW_MS} (5 minutes),
 * mirrors the same margin Google's own `google-auth-library` client uses for
 * this exact purpose.
 *
 * ## The refresh call (RFC 6749 §6; Google's token endpoint)
 *
 * One `POST https://oauth2.googleapis.com/token`, `application/
 * x-www-form-urlencoded`, `grant_type=refresh_token` +
 * `client_id`/`client_secret`/`refresh_token` — verified against Google's
 * own OAuth2 web-server-flow documentation. Deliberately a raw injected
 * `fetch` call, not the `googleapis` SDK: a token refresh is one POST with a
 * small, stable JSON response shape, and adding a whole SDK dependency for
 * it would be exactly the kind of unrequested complexity CLAUDE.md's
 * "simplicity first" rule warns against. `fetchImpl` is injected (default
 * the global `fetch`) purely so tests never hit Google — the same pattern
 * `createGmailEmailSender` already uses (`src/providers/adapters/gmail/sender.ts`).
 *
 * A refresh response MAY include a new `refresh_token` (RFC 6749 §6: "the
 * authorization server MAY issue a new refresh token"); when present it
 * replaces the stored one, otherwise the existing refresh token is kept
 * (Google's normal behavior: refresh tokens are not rotated on every
 * refresh). Google does not invalidate the previous access token when
 * issuing a new one, so an early/skewed refresh can never race a still-valid
 * cached token into invalidity.
 *
 * ## `invalid_grant`: the mailbox needs reconnecting, not a crash
 *
 * A refresh token can die outside this module's control — the user revoked
 * Helpthread's access, an admin disabled the OAuth grant, or Google expired
 * it. The token endpoint reports this as an `invalid_grant` error (RFC 6749
 * §5.2). This is an EXPECTED, operator-actionable outcome, not a bug: on
 * `invalid_grant`, {@link GmailOAuthTokenService.getAccessToken} marks the
 * mailbox `needs_reconnect` (`MailboxStore.markNeedsReconnect` —
 * gmail-push.md §5/§6's same operator-visible state) and THROWS a clear,
 * specific error — it does not return a sentinel, and it does not let the
 * process crash uncaught. Every other refresh failure (network error,
 * timeout, `invalid_client`, a malformed response, an unrelated non-2xx)
 * also throws, but WITHOUT touching mailbox status: those are not proof the
 * grant itself is dead, so marking the mailbox for manual reconnection would
 * be an overreaction to what may be a transient fault.
 *
 * ## Never log or leak a token
 *
 * `client_secret` and the refresh/access token values never appear in a
 * thrown error message or a log line anywhere in this module — matching
 * `createGmailEmailSender`'s same discipline for the access token it
 * consumes. Error messages here are built ONLY from the mailbox id, HTTP
 * status, and the OAuth `error`/`error_description` fields (which by
 * protocol design never carry credential material).
 *
 * ## No cross-call refresh locking
 *
 * If two `getAccessToken` calls for the SAME mailbox race while its cached
 * token is stale, both may independently POST a refresh. This is wasted
 * work, not a correctness bug: Google does not invalidate the loser's
 * freshly-issued access token, both calls still return a valid token, and
 * the store's last write simply wins for what gets cached next time. Adding
 * a lock/single-flight guard would be a reasonable follow-up if refresh
 * volume ever makes the duplicate calls matter, but is speculative
 * complexity this ticket does not add — see the HT-38 implementation report.
 *
 * ## Never resurrect a disconnected mailbox's token row (HT-47)
 *
 * One specific race IS worth guarding, unlike the harmless one above: a
 * refresh already in flight when `src/mail/gmail-disconnect.ts`'s
 * `disconnect()` commits (deletes the token/watch-state rows, marks the
 * mailbox `disconnected`) must not then persist its own freshly-fetched
 * token — that would re-create exactly the row disconnect just deleted, for
 * a mailbox an operator explicitly took offline. `refresh()` re-checks the
 * mailbox's CURRENT status immediately before writing and skips the write
 * (but still returns the fetched access token to its caller) when it reads
 * `disconnected` — see the guard in `refresh()` below and
 * `gmail-disconnect.ts`'s own module doc for the other half of this defense
 * (disconnect re-running its deletes even on an already-`disconnected`
 * mailbox, so a resurrected row is cleaned up on the next retry either way).
 */

import type { MailboxTokenStore, StoredMailboxTokens } from '../store/mailbox-tokens.js'
import type { MailboxStore } from '../store/mailboxes.js'

/** Google's OAuth2 token endpoint (RFC 6749 §3.2). Fixed — not configurable, since Google has exactly one. */
const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * Default safety margin before a cached access token's real expiry at which
 * it is treated as already expired and proactively refreshed. See the
 * module doc's "Caching and the expiry skew" section.
 */
export const DEFAULT_EXPIRY_SKEW_MS = 5 * 60 * 1000

/** Default bound on the refresh HTTP call, matching `createGmailEmailSender`'s own default (`src/providers/adapters/gmail/sender.ts`). */
const DEFAULT_TIMEOUT_MS = 30_000

/** Options for {@link createGmailOAuthTokenService}. */
export interface GmailOAuthTokenServiceOptions {
  /** Where encrypted tokens are read from / written back to. See `src/store/mailbox-tokens.ts`. */
  tokenStore: MailboxTokenStore

  /** Used to mark a mailbox `needs_reconnect` on an `invalid_grant` refresh failure. See `src/store/mailboxes.ts`. */
  mailboxStore: MailboxStore

  /**
   * The Google OAuth2 client's id/secret (an Internal Workspace app per the
   * inbound-email architecture decision — memory, 2026-07-13). Deploy-time
   * configuration, e.g. `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET` —
   * injected by the composition root, NEVER hardcoded (same discipline as
   * the token encryption key; see `token-crypto.ts`'s module doc). Both must
   * be non-empty strings; validated eagerly at construction so a
   * misconfigured deploy fails at boot, not on a mailbox's first send.
   */
  clientId: string
  clientSecret: string

  /**
   * Injectable `fetch` implementation, for tests (see `gmail-oauth.test.ts`).
   * Defaults to the global `fetch`. Matches `createGmailEmailSender`'s
   * `fetchImpl` option (`src/providers/adapters/gmail/sender.ts`).
   */
  fetchImpl?: typeof fetch

  /** Safety margin before real expiry at which a cached token is treated as stale. Defaults to {@link DEFAULT_EXPIRY_SKEW_MS}. */
  expirySkewMs?: number

  /** Milliseconds before the refresh HTTP call is abandoned. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** The Gmail OAuth token service: one method, {@link getAccessToken}. See the module doc for its full contract. */
export interface GmailOAuthTokenService {
  /**
   * Return a live Gmail API access token for `mailboxId` — from cache when
   * still fresh, otherwise by refreshing against Google's token endpoint
   * first. See the module doc for the caching, refresh, and
   * `invalid_grant`→`needs_reconnect` behavior.
   *
   * Throws if: no tokens are stored for `mailboxId` (never connected); the
   * refresh token was rejected as `invalid_grant` (mailbox is marked
   * `needs_reconnect` first — see the module doc); the refresh call fails
   * for any other reason (network, timeout, non-2xx, malformed response).
   * Never returns an invalid/expired token, and never silently swallows a
   * failure into an empty or fabricated string.
   */
  getAccessToken(mailboxId: string): Promise<string>
}

/** Shape of the fields this module reads from a token-endpoint JSON response. Every field is read defensively (typeof-checked) since it comes off the network. */
interface TokenResponseBody {
  access_token?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  scope?: unknown
  error?: unknown
  error_description?: unknown
}

/** Build the Gmail OAuth token service. See the module doc for the full contract. */
export function createGmailOAuthTokenService(
  options: GmailOAuthTokenServiceOptions,
): GmailOAuthTokenService {
  const {
    tokenStore,
    mailboxStore,
    clientId,
    clientSecret,
    fetchImpl = fetch,
    expirySkewMs = DEFAULT_EXPIRY_SKEW_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  assertNonEmpty('clientId', clientId)
  assertNonEmpty('clientSecret', clientSecret)

  return {
    async getAccessToken(mailboxId: string): Promise<string> {
      const tokens = await tokenStore.getTokens(mailboxId)
      if (tokens === null) {
        throw new Error(
          `getAccessToken: mailbox ${mailboxId} has no stored OAuth tokens — connect it via the OAuth flow first`,
        )
      }

      if (isStillFresh(tokens, expirySkewMs)) {
        // isStillFresh only returns true when accessToken is non-null.
        return tokens.accessToken as string
      }

      return refresh(mailboxId, tokens, {
        tokenStore,
        mailboxStore,
        clientId,
        clientSecret,
        fetchImpl,
        timeoutMs,
      })
    },
  }
}

/** True when `tokens` carries a cached access token that will remain valid for at least `skewMs` longer. */
function isStillFresh(tokens: StoredMailboxTokens, skewMs: number): boolean {
  if (tokens.accessToken === null || tokens.accessTokenExpiresAt === null) {
    return false
  }
  return tokens.accessTokenExpiresAt.getTime() - Date.now() > skewMs
}

/**
 * Refresh `mailboxId`'s access token against Google's token endpoint,
 * persist the result, and return the new access token. See the module doc
 * for the full request/response/error-handling contract.
 */
async function refresh(
  mailboxId: string,
  tokens: StoredMailboxTokens,
  deps: {
    tokenStore: MailboxTokenStore
    mailboxStore: MailboxStore
    clientId: string
    clientSecret: string
    fetchImpl: typeof fetch
    timeoutMs: number
  },
): Promise<string> {
  const { tokenStore, mailboxStore, clientId, clientSecret, fetchImpl, timeoutMs } = deps

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refreshToken,
  })

  const response = await fetchImpl(GMAIL_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // Bounds the whole exchange, same rationale as createGmailEmailSender's
    // identical use of AbortSignal.timeout (src/providers/adapters/gmail/sender.ts).
    signal: AbortSignal.timeout(timeoutMs),
  })

  const parsed = await parseJsonObject(response)

  if (!response.ok) {
    const errorCode = typeof parsed.error === 'string' ? parsed.error : undefined
    if (errorCode === 'invalid_grant') {
      // The refresh token itself is dead (revoked/expired) — no retry of
      // ours can fix this; the mailbox needs a human to reconnect it.
      await mailboxStore.markNeedsReconnect(mailboxId)
      throw new Error(
        `getAccessToken: mailbox ${mailboxId}'s refresh token was rejected (invalid_grant — revoked or expired). ` +
          `Marked the mailbox needs_reconnect; it must be reconnected via the OAuth flow before it can send or receive again.`,
      )
    }
    const description =
      typeof parsed.error_description === 'string' ? parsed.error_description : undefined
    throw new Error(
      `getAccessToken: token refresh failed for mailbox ${mailboxId}: HTTP ${response.status}` +
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
      `getAccessToken: malformed token refresh response for mailbox ${mailboxId} (missing or invalid access_token/expires_in)`,
    )
  }

  // RFC 6749 §6: the server MAY issue a new refresh token; Google normally
  // does not on an ordinary refresh, so keep the existing one unless a new
  // one was actually returned. Likewise carry the existing scopes forward
  // when the response omits `scope` (Google may omit it when unchanged). Both
  // fall back on an EMPTY string too, not just a missing field — a blank
  // `refresh_token` would otherwise silently clobber a good stored one with
  // an unusable value, permanently breaking the mailbox until reconnect.
  const refreshToken =
    typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : tokens.refreshToken
  const scopes =
    typeof parsed.scope === 'string' && parsed.scope.length > 0
      ? parsed.scope
      : (tokens.scopes ?? undefined)
  const accessTokenExpiresAt = new Date(Date.now() + expiresIn * 1000)

  // Guard against resurrecting a token row for a mailbox an operator has
  // since disconnected (HT-47's `src/mail/gmail-disconnect.ts`; flagged in
  // its own review). This refresh's Google round-trip can straddle an
  // in-flight `disconnect()` call: if THAT call's transaction (delete
  // tokens, delete watch state, mark `disconnected`) commits while this
  // request is still in flight, persisting the freshly-fetched token below
  // would re-create the very row disconnect just deleted — "tokens must not
  // persist even as ciphertext" (`gmail-disconnect.ts`'s module doc) would
  // no longer hold, and outbound send would resolve a live token for a
  // mailbox the operator explicitly took offline. Re-checking the mailbox's
  // CURRENT status here (not the one this call started with) closes that
  // window down to this one extra query; a disconnect that lands in the
  // remaining gap between this check and the write below is caught on the
  // NEXT `getAccessToken` or `disconnect()` retry (`gmail-disconnect.ts`'s
  // idempotent-but-still-deletes handling of an already-`disconnected`
  // mailbox). The freshly-fetched `accessToken` is still returned either
  // way — this caller's own in-flight use of it (e.g. one `history.list`
  // call already underway) cannot be un-requested, only its persistence can
  // be skipped.
  const currentMailbox = await mailboxStore.getMailboxById(mailboxId)
  if (currentMailbox?.status !== 'disconnected') {
    await tokenStore.upsertTokens(mailboxId, {
      refreshToken,
      accessToken,
      accessTokenExpiresAt,
      scopes,
    })
  }

  return accessToken
}

/**
 * Best-effort parse of a response body as a JSON object. Returns `{}` on any
 * failure (non-JSON body, empty body, a JSON value that isn't an object) so
 * callers can uniformly read fields off the result without a second
 * try/catch — a body that fails to parse simply has no fields, which the
 * caller's `typeof` checks already treat as "absent."
 */
async function parseJsonObject(response: Response): Promise<TokenResponseBody> {
  try {
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null ? (value as TokenResponseBody) : {}
  } catch {
    return {}
  }
}

/** Throw a clear error unless `value` is a non-empty string. Used for eager, boot-time validation of required config. */
function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`createGmailOAuthTokenService: ${field} must be a non-empty string`)
  }
}
