/**
 * Gmail `EmailSender` adapter — transmits `OutboundEmail`s via
 * `users.messages.send` (https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send).
 *
 * Per `../../email-sender.ts`'s module doc and `specs/mail/sending.md` §4,
 * this is a thin transport: build the raw MIME message (`mime.ts`, which
 * carries the verbatim `Message-ID` contract), base64url-encode it (Gmail's
 * `raw` field requires base64url, not standard base64 — see
 * https://developers.google.com/gmail/api/guides/sending), POST it, and
 * translate the HTTP outcome into the `EmailSender` contract: throw on any
 * non-2xx response so `sendReply` (`src/mail/send.ts`) marks the outbound
 * thread `'failed'` rather than reporting a delivery that never happened.
 *
 * ## OAuth2 token acquisition is explicitly NOT this adapter's concern
 *
 * `getAccessToken` is injected rather than this module owning an OAuth2
 * client, refresh-token exchange, or credential storage. Token lifecycle
 * (initial grant, refresh, rotation, which Google Cloud project/service
 * account is in play) is deploy-time wiring — the composition root's job
 * per `src/providers/README.md` — not something a provider *interface*
 * implementation should hardcode. `getAccessToken` is called once per
 * `send()` (never cached here) precisely so the caller's refresh logic is
 * always consulted for a live token; see the module's test suite for the
 * per-send-call assertion.
 *
 * ## Never log or leak the token
 *
 * The access token is a bearer credential for the configured Gmail
 * mailbox's `gmail.send` scope. It must never appear in a thrown error
 * message, a console log, or anywhere else observable — see the non-2xx
 * handling below, which reports the response status/body but deliberately
 * never touches the `Authorization` header's value.
 */

import type { EmailSender, EmailSendResult, OutboundEmail } from '../../email-sender.js'
import { buildRawMessage } from './mime.js'

/** Options for {@link createGmailEmailSender}. */
export interface GmailEmailSenderOptions {
  /**
   * Returns a valid OAuth2 access token carrying the `gmail.send` scope for
   * the mailbox this adapter should send as. Called once per `send()` — no
   * caching happens in this module — so token acquisition/refresh is
   * entirely the caller's concern (deploy-time composition root), not this
   * adapter's. See the module doc.
   */
  getAccessToken: () => Promise<string>

  /**
   * Injectable `fetch` implementation, for tests (see `sender.test.ts`).
   * Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch

  /**
   * Gmail API `userId` path segment — almost always the literal `'me'`
   * (the authenticated user implied by the access token). Overridable for
   * domain-wide-delegation service-account setups that impersonate a
   * specific mailbox address. Defaults to `'me'`.
   */
  userId?: string

  /**
   * Milliseconds before the Gmail HTTP call (request AND response-body read
   * — the abort signal covers both) is abandoned. Defaults to 30 000. Without
   * a bound, a stalled Gmail API or intermediary would hang `send()` — and
   * whatever serverless invocation is paying for the wait — indefinitely.
   *
   * A timeout REJECTS, so `sendReply` records the outbound thread as
   * `'failed'` — but the request may in fact have reached Gmail (the
   * delivered-but-reported-failed window every network sender has; the
   * HT-16 idempotency work is where retry-safety lands). This is the safe
   * direction: never report a delivery that can't be confirmed.
   */
  timeoutMs?: number
}

/** Shape of a successful `users.messages.send` response body we care about. */
interface GmailSendResponseBody {
  id?: string
}

/** Gmail API base URL. Kept as a constant so the endpoint is grep-able/testable in one place. */
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1'

/** Cap on how much of a non-2xx response body we fold into the thrown error, so a large/weird error page can't blow up log lines. */
const MAX_ERROR_BODY_CHARS = 500

/**
 * Strip any Helpthread reply-token msg-id (`<ht.…@…>`) out of an error snippet
 * before it reaches a thrown error (and thus logs). A bad-request body from
 * Gmail — or an intermediary proxy/gateway — can echo the request content,
 * which includes the raw MIME we sent, whose `Message-ID` IS the outbound
 * threading token. That token is what a later inbound reply is threaded on, so
 * keeping it out of server logs is worthwhile log hygiene (the OAuth bearer
 * token is already never included).
 */
function redactReplyTokens(text: string): string {
  return (
    text
      // The literal token, if echoed as-is.
      .replace(/<ht\.[^>]*>/g, '<ht.REDACTED>')
      // AND any long base64url run: a bad-request body could echo our
      // base64url-encoded `raw` request (the whole MIME — which contains the
      // token decodably). No human-readable error message has an unbroken
      // 100-char base64url run, so this only ever strips our own payload.
      .replace(/[A-Za-z0-9_-]{100,}/g, '[REDACTED-BASE64]')
  )
}

/**
 * Build the `EmailSender` implementation for Gmail. See the module doc for
 * the token-injection and error-handling contracts.
 */
export function createGmailEmailSender(options: GmailEmailSenderOptions): EmailSender {
  const { getAccessToken, fetchImpl = fetch, userId = 'me', timeoutMs = 30_000 } = options
  const endpoint = `${GMAIL_API_BASE}/users/${encodeURIComponent(userId)}/messages/send`

  return {
    async send(email: OutboundEmail): Promise<EmailSendResult> {
      const raw = buildRawMessage(email)
      const encoded = Buffer.from(raw, 'utf8').toString('base64url')

      // Fetched fresh on every send — see the module doc on why this is
      // never cached here.
      const accessToken = await getAccessToken()

      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: encoded }),
        // Bounds the whole exchange — connection, response headers, AND the
        // body reads below (an aborted signal cancels the response stream
        // too). See the `timeoutMs` option doc for the failure semantics.
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (!response.ok) {
        // A failed send must NEVER be reported as success (specs/mail/sending.md
        // §3 relies on this to mark the outbound thread 'failed', not 'sent').
        // Include the status and a bounded snippet of the response body for
        // debuggability; NEVER include accessToken or any request header.
        let bodySnippet = ''
        try {
          bodySnippet = redactReplyTokens((await response.text()).slice(0, MAX_ERROR_BODY_CHARS))
        } catch {
          // Body unreadable (e.g. already consumed/stream error) — proceed
          // without it; the status code alone is still informative.
        }
        throw new Error(
          `createGmailEmailSender: Gmail send failed with ${response.status} ${response.statusText}` +
            (bodySnippet ? `: ${bodySnippet}` : ''),
        )
      }

      const body = (await response.json()) as GmailSendResponseBody
      return { providerMessageId: body.id }
    },
  }
}
