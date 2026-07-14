/**
 * Gmail `history.list` + raw-message-fetch HTTP client (specs/mail/gmail-
 * push.md §3) — the transport HT-41's reconcile handler (`src/mail/gmail-
 * reconcile.ts`) uses to turn a mailbox's stored cursor into the raw RFC822
 * bytes of every message added since. Mirrors `./sender.ts`'s shape:
 * injectable `fetchImpl`, `userId` (default `'me'`), `AbortSignal.timeout`,
 * Bearer auth, throwing on any unexpected non-2xx with a bounded response-body
 * snippet, and the access token never touched by a log line or a thrown
 * error — see that module's doc for the shared rationale, not repeated
 * here.
 *
 * ## Two outcomes this client reports as typed results, not thrown errors
 *
 * - `history.list` 404s when `startHistoryId` is older than Gmail's
 *   retention window (gmail-push.md §5) — an expected, caller-actionable
 *   outcome (pause the mailbox), not a transport failure. {@link
 *   GmailHistoryClient.listAddedMessageIds} reports this as `{ kind:
 *   'expired' }` rather than throwing.
 * - `messages.get` 404s when a message existed at `history.list` time but
 *   was deleted (or otherwise removed) before the raw fetch ran.
 *   gmail-push.md doesn't speak to this directly, but it is the same "the
 *   resource is legitimately gone, not a transport error" shape, so {@link
 *   GmailHistoryClient.getRawMessage} reports it as `null` (the caller
 *   skips this message) rather than throwing.
 *
 * Every OTHER non-2xx from either call still throws, exactly like
 * `sender.ts`.
 *
 * ## Pagination and id de-duplication
 *
 * `history.list` paginates via `nextPageToken`; {@link
 * GmailHistoryClient.listAddedMessageIds} follows every page to the end
 * before returning. Gmail's history records can repeat a message id across
 * records (e.g. a message that is both added and labeled within the same
 * batch appears in more than one `history[]` entry), so ids are collected
 * into a `Set` and returned de-duplicated — a caller fetching each id
 * exactly once matters both for correctness (no redundant ingest attempt
 * per id) and for cost (no redundant `messages.get` call). `newHistoryId`
 * is taken from whichever page's top-level `historyId` field is read last
 * (Gmail includes it on every page as the mailbox's then-current watermark;
 * taking the LAST page's value is what "follow pagination to the end"
 * requires — see gmail-push.md §4, "the cursor").
 */

/** Options for {@link createGmailHistoryClient}. Mirrors `GmailEmailSenderOptions` (`./sender.ts`). */
export interface GmailHistoryClientOptions {
  /**
   * Returns a valid OAuth2 access token for ONE mailbox — the caller binds
   * this to a specific mailbox id before constructing the client (e.g. `()
   * => tokenService.getAccessToken(mailboxId)`, `src/mail/gmail-oauth.ts`).
   * Called once per underlying HTTP request (never cached in this module),
   * matching `GmailEmailSenderOptions.getAccessToken`'s "always fetch a
   * live token" discipline — including across `history.list`'s own
   * multi-page pagination, so a long-running reconciliation never carries a
   * token that goes stale mid-run.
   */
  getAccessToken: () => Promise<string>

  /** Injectable `fetch`, for tests (see `history.test.ts`). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch

  /** Gmail API `userId` path segment. Defaults to `'me'`. */
  userId?: string

  /** Milliseconds before an individual HTTP call is abandoned. Defaults to 30 000 (matches `sender.ts`). */
  timeoutMs?: number
}

/**
 * The result of {@link GmailHistoryClient.listAddedMessageIds}: either the
 * de-duplicated ids added since `startHistoryId` plus the new watermark to
 * advance to, or an expired-cursor signal (module doc). Tagged on `kind` on
 * BOTH branches (unlike the brief's shorthand) so callers narrow with an
 * ordinary `kind` check — matching this codebase's discriminated-union
 * convention (see `RawMessageContent`, `src/providers/inbound-email.ts`)
 * rather than requiring an `in` check against a branch with no shared
 * field.
 */
export type ListAddedMessageIdsResult =
  | { kind: 'ok'; messageIds: string[]; newHistoryId: string }
  | { kind: 'expired' }

/** One message's raw RFC822 bytes plus when Gmail recorded it. `null` (not this type) is returned when the message no longer exists — see the module doc. */
export interface RawGmailMessage {
  rawBytes: Uint8Array
  receivedAt: Date
}

/** The Gmail history + raw-fetch client HT-41's reconcile handler consumes. See the module doc. */
export interface GmailHistoryClient {
  /**
   * List every message id added to the mailbox since `startHistoryId`
   * (Gmail's own `history.list?startHistoryId=` semantics), following
   * `nextPageToken` pagination to the end and de-duplicating ids (module
   * doc). Returns `{ kind: 'expired' }` on a 404 (cursor older than
   * Gmail's retention window, gmail-push.md §5); throws on any other
   * non-2xx.
   */
  listAddedMessageIds(startHistoryId: string): Promise<ListAddedMessageIdsResult>

  /**
   * Fetch one message's raw RFC822 bytes (`format=raw`) and its
   * Gmail-recorded receipt time (`internalDate`). Returns `null` on a 404
   * (the message was deleted between `history.list` and this call — module
   * doc); throws on any other non-2xx.
   */
  getRawMessage(messageId: string): Promise<RawGmailMessage | null>
}

/** Gmail API base URL. Kept as a constant so the endpoint is grep-able/testable in one place — matches `sender.ts`. */
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'

/** Cap on how much of a non-2xx response body we fold into a thrown error, so a large/weird error page can't blow up log lines. Matches `sender.ts`'s `MAX_ERROR_BODY_CHARS`. */
const MAX_ERROR_BODY_CHARS = 500

/**
 * Base64url alphabet (RFC 4648 §5), with optional `=` padding.
 * `Buffer.from(x, 'base64url')` SILENTLY truncates at the first
 * out-of-alphabet character instead of throwing, so a malformed `raw` from
 * Gmail would otherwise decode to corrupt/truncated RFC822 and be ingested as
 * if valid — {@link GmailHistoryClient.getRawMessage} validates against this
 * first and throws instead, biasing to a loud (retryable) failure over
 * silently storing wrong bytes.
 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/

/** Shape of a `users.history.list` response body, narrowed to the fields this client reads. */
interface HistoryListResponseBody {
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>
  nextPageToken?: string
  historyId?: string
}

/** Shape of a `users.messages.get?format=raw` response body, narrowed to the fields this client reads. */
interface GetMessageRawResponseBody {
  raw?: string
  internalDate?: string
}

/**
 * Build the error a non-2xx (and not the 404-is-expected-outcome case)
 * response translates to. Returns the `Error` rather than throwing it
 * directly so callers can `throw await unexpectedStatusError(...)` — a
 * `throw` statement's control-flow-terminates-this-path guarantee holds
 * regardless of what expression is being thrown, which keeps call sites
 * simple without needing a `never`-returning async helper.
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
    `createGmailHistoryClient: ${context} failed with ${response.status} ${response.statusText}` +
      (bodySnippet ? `: ${bodySnippet}` : ''),
  )
}

/**
 * Build the Gmail history + raw-fetch client. See the module doc for the
 * token-injection, pagination, and error-handling contracts.
 */
export function createGmailHistoryClient(options: GmailHistoryClientOptions): GmailHistoryClient {
  const { getAccessToken, fetchImpl = fetch, userId = 'me', timeoutMs = 30_000 } = options
  const usersBase = `${GMAIL_API_BASE}/users/${encodeURIComponent(userId)}`

  /** One authenticated GET — token fetched fresh per call (module doc). */
  async function authedGet(url: string): Promise<Response> {
    const accessToken = await getAccessToken()
    return fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      // Bounds the whole exchange — connection, response headers, AND the
      // body reads below — same rationale as sender.ts's identical use.
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  return {
    async listAddedMessageIds(startHistoryId) {
      const messageIds = new Set<string>()
      let newHistoryId: string | undefined
      let pageToken: string | undefined

      for (;;) {
        const url = new URL(`${usersBase}/history`)
        url.searchParams.set('startHistoryId', startHistoryId)
        url.searchParams.set('historyTypes', 'messageAdded')
        if (pageToken !== undefined) {
          url.searchParams.set('pageToken', pageToken)
        }

        const response = await authedGet(url.toString())

        if (response.status === 404) {
          // Cursor expired (gmail-push.md §5) — an expected, typed outcome,
          // not a transport failure. Drain the body so the connection can
          // be reused; its content is unused.
          await response.text().catch(() => undefined)
          return { kind: 'expired' }
        }
        if (!response.ok) {
          throw await unexpectedStatusError(response, 'history.list')
        }

        const body = (await response.json()) as HistoryListResponseBody
        for (const record of body.history ?? []) {
          for (const added of record.messagesAdded ?? []) {
            const id = added.message?.id
            if (typeof id === 'string' && id.length > 0) {
              messageIds.add(id)
            }
          }
        }
        if (typeof body.historyId === 'string' && body.historyId.length > 0) {
          // Overwritten on every page on purpose — the LAST page's value is
          // the one "follow pagination to the end" requires (module doc).
          newHistoryId = body.historyId
        }

        if (typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0) {
          pageToken = body.nextPageToken
          continue
        }
        break
      }

      if (newHistoryId === undefined) {
        // Defensive: every real Gmail history.list response includes
        // historyId, even a zero-change one. Thrown rather than silently
        // returning a result the caller could mistake for "no watermark
        // change needed."
        throw new Error(
          'createGmailHistoryClient: history.list response never included a historyId watermark on any page',
        )
      }

      return { kind: 'ok', messageIds: [...messageIds], newHistoryId }
    },

    async getRawMessage(messageId) {
      const url = new URL(`${usersBase}/messages/${encodeURIComponent(messageId)}`)
      url.searchParams.set('format', 'raw')

      const response = await authedGet(url.toString())

      if (response.status === 404) {
        // Deleted between list and get — an expected, typed outcome, not a
        // transport failure (module doc).
        await response.text().catch(() => undefined)
        return null
      }
      if (!response.ok) {
        throw await unexpectedStatusError(response, 'messages.get')
      }

      const body = (await response.json()) as GetMessageRawResponseBody
      if (typeof body.raw !== 'string' || body.raw.length === 0) {
        throw new Error(
          `createGmailHistoryClient: messages.get response for ${messageId} is missing 'raw'`,
        )
      }
      if (!BASE64URL_RE.test(body.raw)) {
        // A malformed `raw` (out-of-alphabet chars) would be SILENTLY
        // truncated by `Buffer.from(..., 'base64url')` into corrupt RFC822 —
        // see BASE64URL_RE's doc. Fail loudly instead of ingesting wrong bytes.
        throw new Error(
          `createGmailHistoryClient: messages.get response for ${messageId} has a malformed base64url 'raw' payload`,
        )
      }
      const internalDateMs = Number(body.internalDate)
      if (typeof body.internalDate !== 'string' || !Number.isFinite(internalDateMs)) {
        throw new Error(
          `createGmailHistoryClient: messages.get response for ${messageId} has a missing or invalid internalDate`,
        )
      }

      return {
        // Gmail's `raw` is base64url (https://developers.google.com/gmail/api/guides/sending) —
        // matches sender.ts's own encode side.
        rawBytes: Buffer.from(body.raw, 'base64url'),
        receivedAt: new Date(internalDateMs),
      }
    },
  }
}
