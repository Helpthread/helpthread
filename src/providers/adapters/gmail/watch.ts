/**
 * Gmail `users.watch` + `users.getProfile` HTTP client (specs/mail/
 * gmail-connect.md §4 steps 3-4) — the transport the connect/consent
 * orchestration (`src/mail/gmail-connect.ts`, HT-40) uses to resolve a
 * freshly-granted mailbox's address and arm Gmail push for it. Mirrors
 * `./history.ts`'s shape (itself mirroring `./sender.ts`): injectable
 * `fetchImpl`, `userId` (default `'me'`), `AbortSignal.timeout`, Bearer
 * auth, throwing on any unexpected non-2xx with a bounded response-body
 * snippet, and the access token never touched by a log line or a thrown
 * error — see `history.ts`'s module doc for the shared rationale, not
 * repeated here.
 *
 * Unlike `history.ts`, neither method here has an expected/typed non-throw
 * outcome: gmail-connect.md §4 treats a `watch()` or `getProfile()` failure
 * as a hard abort of the whole connect attempt (nothing persisted — see
 * that spec's step 4), so every non-2xx from either call throws.
 */

/** Options for {@link createGmailWatchClient}. Mirrors `GmailHistoryClientOptions` (`./history.ts`). */
export interface GmailWatchClientOptions {
  /**
   * Returns a valid OAuth2 access token for ONE mailbox. During the
   * connect flow this is bound to the token just returned by the
   * authorization-code exchange (`src/mail/gmail-connect.ts`'s
   * `exchangeAuthCode`), not a cached/refreshed token — see that module's
   * doc. Called once per underlying HTTP request (never cached in this
   * module), matching `history.ts`'s "always fetch a live token"
   * discipline.
   */
  getAccessToken: () => Promise<string>

  /** Injectable `fetch`, for tests (see `watch.test.ts`). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch

  /** Gmail API `userId` path segment. Defaults to `'me'`. */
  userId?: string

  /** Milliseconds before an individual HTTP call is abandoned. Defaults to 30 000 (matches `history.ts`/`sender.ts`). */
  timeoutMs?: number
}

/** Input to {@link GmailWatchClient.watch} — `users.watch`'s request body (https://developers.google.com/gmail/api/reference/rest/v1/users/watch). */
export interface GmailWatchInput {
  /** The Cloud Pub/Sub topic to publish change notifications to (`projects/{project}/topics/{topic}`) — deployment-provisioned (HT-43), injected config. */
  topicName: string
  /** Restrict notifications to these label ids. Omitted entirely from the request body when undefined (gmail-connect.md's v1 scope — every message, no label filter). */
  labelIds?: string[]
  /** `'include'` or `'exclude'` `labelIds` from notifications. Omitted entirely from the request body when undefined. */
  labelFilterBehavior?: 'include' | 'exclude'
}

/** Result of a successful {@link GmailWatchClient.watch} call. */
export interface GmailWatchResult {
  /** The baseline `history.list` cursor (gmail-connect.md §4 step 4 — THIS value, not `getProfile`'s, is what seeds the mailbox's stored cursor). */
  historyId: string
  /** When this `watch()` arm expires (~7 days out) and must be renewed (HT-42, gmail-push.md §6). */
  expiration: Date
}

/** Result of a successful {@link GmailWatchClient.getProfile} call. */
export interface GmailProfileResult {
  /** The authoritative mailbox address for the granted account (gmail-connect.md §4 step 3). */
  emailAddress: string
  /** The mailbox's current `historyId` watermark AT THE TIME OF THIS CALL — NOT the connect baseline; see the module doc and gmail-connect.md §4 step 4 for why `watch()`'s `historyId` is used instead. */
  historyId: string
}

/** The Gmail watch-arm + profile-resolve client HT-40's connect orchestration consumes. See the module doc. */
export interface GmailWatchClient {
  /**
   * Arm Gmail push for this mailbox (`POST users.watch`). Returns the
   * initial `historyId` watermark and the arm's expiration. Throws on any
   * non-2xx — gmail-connect.md §4 treats this as a hard abort of the whole
   * connect attempt, with nothing persisted.
   */
  watch(input: GmailWatchInput): Promise<GmailWatchResult>

  /**
   * Resolve the authenticated mailbox's address (`GET users.getProfile`).
   * Throws on any non-2xx.
   */
  getProfile(): Promise<GmailProfileResult>
}

/** Gmail API base URL. Kept as a constant so the endpoint is grep-able/testable in one place — matches `history.ts`/`sender.ts`. */
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'

/** Cap on how much of a non-2xx response body we fold into a thrown error, so a large/weird error page can't blow up log lines. Matches `history.ts`'s `MAX_ERROR_BODY_CHARS`. */
const MAX_ERROR_BODY_CHARS = 500

/** Shape of a `users.watch` response body, narrowed to the fields this client reads. */
interface WatchResponseBody {
  historyId?: string
  expiration?: string
}

/** Shape of a `users.getProfile` response body, narrowed to the fields this client reads. */
interface ProfileResponseBody {
  emailAddress?: string
  historyId?: string
}

/**
 * Build the error a non-2xx response translates to. Returns the `Error`
 * rather than throwing it directly so callers can `throw await
 * unexpectedStatusError(...)` — matches `history.ts`'s identical helper.
 */
async function unexpectedStatusError(response: Response, context: string): Promise<Error> {
  let bodySnippet = ''
  try {
    bodySnippet = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS)
  } catch {
    // Body unreadable (e.g. already consumed/stream error) — proceed
    // without it; the status code alone is still informative.
  }
  return new Error(
    `createGmailWatchClient: ${context} failed with ${response.status} ${response.statusText}` +
      (bodySnippet ? `: ${bodySnippet}` : ''),
  )
}

/**
 * Build the Gmail watch-arm + profile-resolve client. See the module doc
 * for the token-injection and error-handling contracts.
 */
export function createGmailWatchClient(options: GmailWatchClientOptions): GmailWatchClient {
  const { getAccessToken, fetchImpl = fetch, userId = 'me', timeoutMs = 30_000 } = options
  const usersBase = `${GMAIL_API_BASE}/users/${encodeURIComponent(userId)}`

  /** One authenticated call — token fetched fresh per call (module doc). */
  async function authedFetch(url: string, init: RequestInit): Promise<Response> {
    const accessToken = await getAccessToken()
    return fetchImpl(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
      // Bounds the whole exchange — connection, response headers, AND the
      // body reads below — same rationale as history.ts's identical use.
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  return {
    async watch(input) {
      const body: Record<string, unknown> = { topicName: input.topicName }
      if (input.labelIds !== undefined) {
        body.labelIds = input.labelIds
      }
      if (input.labelFilterBehavior !== undefined) {
        body.labelFilterBehavior = input.labelFilterBehavior
      }

      const response = await authedFetch(`${usersBase}/watch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        throw await unexpectedStatusError(response, 'watch')
      }

      const parsed = (await response.json()) as WatchResponseBody
      if (typeof parsed.historyId !== 'string' || parsed.historyId.length === 0) {
        throw new Error('createGmailWatchClient: watch response is missing historyId')
      }
      const expirationMs = Number(parsed.expiration)
      if (typeof parsed.expiration !== 'string' || !Number.isFinite(expirationMs)) {
        throw new Error(
          'createGmailWatchClient: watch response has a missing or invalid expiration',
        )
      }

      return { historyId: parsed.historyId, expiration: new Date(expirationMs) }
    },

    async getProfile() {
      const response = await authedFetch(`${usersBase}/profile`, { method: 'GET' })

      if (!response.ok) {
        throw await unexpectedStatusError(response, 'getProfile')
      }

      const parsed = (await response.json()) as ProfileResponseBody
      if (typeof parsed.emailAddress !== 'string' || parsed.emailAddress.length === 0) {
        throw new Error('createGmailWatchClient: getProfile response is missing emailAddress')
      }
      if (typeof parsed.historyId !== 'string' || parsed.historyId.length === 0) {
        throw new Error('createGmailWatchClient: getProfile response is missing historyId')
      }

      return { emailAddress: parsed.emailAddress, historyId: parsed.historyId }
    },
  }
}
