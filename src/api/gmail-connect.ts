/**
 * The two Gmail connect/consent HTTP handlers (HT-40; specs/mail/
 * gmail-connect.md §2) — thin wrappers around `src/mail/gmail-connect.ts`'s
 * `GmailConnectService`. Neither handler does any OAuth, HTTP, or
 * persistence work itself; both just translate the service's result (or
 * thrown error) into a `Response`.
 *
 * ## Two routes, two authentication models (gmail-connect.md §2)
 *
 * - {@link handleGmailConnect} — `POST /api/v1/inbound/gmail/connect`, a
 *   normal Bearer-gated route in the authenticated route table
 *   (`src/api/router.ts`). The router guarantees the method is `POST`
 *   before this is ever called.
 * - {@link handleGmailConnectCallback} — `GET
 *   /api/v1/inbound/gmail/callback?code&state`, the PRE-AUTH carve-out
 *   Google's redirect lands on (matched and dispatched by `src/api/index.ts`
 *   BEFORE the Bearer gate — exactly like the open-tracking pixel and the
 *   Gmail push webhook). Its own `state` signature (verified inside
 *   `GmailConnectService.completeConnect`) is the authentication.
 *
 * ## The callback renders HTML, not the JSON envelope
 *
 * A human's browser lands on the callback (Google's redirect), so its
 * response is a minimal `text/html` page — success or error — built by
 * {@link htmlResponse}, never the `{ error: { code, message } } ` JSON
 * envelope the rest of this API uses (`src/api/responses.ts`). Every
 * dynamic value interpolated into that HTML (the connected address, an
 * error message) is escaped ({@link escapeHtml}) before insertion — the
 * connected address originates from Google's `getProfile`, and an error
 * message can echo a bounded snippet of an upstream HTTP error body
 * (`src/providers/adapters/gmail/watch.ts`'s `unexpectedStatusError`), so
 * neither is safe to splice into HTML unescaped even though neither is
 * directly attacker-supplied on THIS request.
 *
 * ## What is NEVER rendered on either page
 *
 * The authorization `code`, the `state` token, any OAuth access/refresh
 * token, or `client_secret` — gmail-connect.md §2b is explicit that the
 * callback page "never renders any token, `code`, `client_secret`, email
 * body, or other secret." `GmailConnectError`'s messages
 * (`src/mail/gmail-connect.ts`) are already built secret-free; this module
 * adds nothing further to either page's body beyond that message and (on
 * success) the resolved address.
 */

import { GmailConnectError, type GmailConnectService } from '../mail/gmail-connect.js'
import { apiError, json } from './responses.js'

/** Dependencies both handlers need. ABSENT BY DEFAULT on `InboxApiDeps` (`src/api/index.ts`) — a deployment that hasn't provisioned Gmail OAuth yet (HT-43) simply never configures this. */
export interface GmailConnectDeps {
  service: GmailConnectService
}

/** Minimal HTML escaping for the handful of dynamic values ever spliced into a callback page — see the module doc. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Build a minimal, inline-styled `text/html` page. `title` and `bodyHtml`
 * are both escaped/trusted by the caller's construction — callers pass
 * `bodyHtml` as already-composed markup (with any dynamic value already
 * run through {@link escapeHtml}), matching the module doc's "nothing
 * secret is ever rendered" contract. Always `Cache-Control: no-store`,
 * matching every other response this API returns
 * (`src/api/responses.ts`'s convention, reimplemented here rather than
 * reused since this is the one surface in the API that answers with HTML,
 * not JSON).
 */
function htmlResponse(status: number, title: string, bodyHtml: string): Response {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>${bodyHtml}</body>
</html>`
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Handle `POST /api/v1/inbound/gmail/connect` (gmail-connect.md §2a). The
 * router (`src/api/router.ts`) guarantees the method is `POST` and the
 * caller already cleared the Bearer gate before this runs. Mints a fresh
 * `state` and returns the Google consent URL as JSON — this handler never
 * redirects itself (see `GmailConnectService.beginConnect`'s doc for why).
 *
 * Own try/catch: `beginConnect` only ever throws on an unexpected internal
 * failure (state-minting requires a valid keyring, already validated at
 * service construction), so any throw here is a genuine 500.
 */
export async function handleGmailConnect(
  _request: Request,
  deps: GmailConnectDeps,
): Promise<Response> {
  try {
    const { consentUrl } = deps.service.beginConnect()
    return json(200, { consentUrl })
  } catch (err) {
    console.error('[gmail-connect] unhandled error beginning connect', err)
    return apiError(500, 'server_error', 'Internal server error.')
  }
}

/**
 * Handle `GET /api/v1/inbound/gmail/callback?code&state` (gmail-connect.md
 * §2b, §4) — the pre-auth carve-out Google's redirect lands on. Reads
 * `code`/`state` from the query string, runs
 * `GmailConnectService.completeConnect`, and renders an HTML page:
 *
 * - Missing `code` or `state` → `400` (never even calls the service — there
 *   is nothing to verify).
 * - A caught {@link GmailConnectError} (`invalid_state` / `exchange_failed`
 *   / `no_refresh_token` / `watch_failed` — every one of them an
 *   operator-fixable outcome gmail-connect.md §4/§7 names explicitly) →
 *   `400` with the error's own (already secret-free) message.
 * - Any other error (a DB blip, a `getProfile` network failure — genuinely
 *   unexpected) → `500`, generic message.
 * - Success → `200` confirming the connected address.
 *
 * Wrapped in its own try/catch: like `handleGmailPushWebhook`
 * (`src/api/gmail-webhook.ts`), this handler runs in a PRE-AUTH branch of
 * `createInboxApi` (`src/api/index.ts`), before the outer try/catch that
 * protects the normal authenticated routes, so it must guarantee no
 * exception escapes on its own.
 */
export async function handleGmailConnectCallback(
  request: Request,
  deps: GmailConnectDeps,
): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams
    const code = params.get('code')
    const state = params.get('state')

    if (code === null || code.length === 0 || state === null || state.length === 0) {
      return htmlResponse(
        400,
        'Connection failed',
        '<p>This connect link is missing required parameters. Please restart the connect flow.</p>',
      )
    }

    try {
      const { address } = await deps.service.completeConnect({ code, state })
      return htmlResponse(
        200,
        'Mailbox connected',
        `<p>Successfully connected <strong>${escapeHtml(address)}</strong>. You can close this window.</p>`,
      )
    } catch (err) {
      if (err instanceof GmailConnectError) {
        return htmlResponse(400, 'Connection failed', `<p>${escapeHtml(err.message)}</p>`)
      }
      throw err
    }
  } catch (err) {
    console.error('[gmail-connect] unhandled error completing connect', err)
    return htmlResponse(
      500,
      'Connection failed',
      '<p>An unexpected error occurred. Please try again or contact support.</p>',
    )
  }
}
