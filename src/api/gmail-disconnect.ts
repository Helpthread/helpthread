/**
 * `POST /api/v1/inbound/gmail/disconnect` (HT-47; specs/mail/gmail-connect.md's
 * disconnect section) — a thin wrapper around `src/mail/gmail-disconnect.ts`'s
 * `GmailDisconnectService`. This handler does no OAuth, HTTP, or persistence
 * work itself; it only translates the service's result (or thrown error)
 * into a `Response`.
 *
 * Unlike its sibling `/connect`/`/callback` (`src/api/gmail-connect.ts`),
 * disconnect has no pre-auth carve-out: it is an ORDINARY Bearer-gated route
 * in the authenticated route table (`src/api/router.ts`), the same as the
 * conversation-CRUD routes — mirroring `/connect`'s own auth model
 * (gmail-connect.md §2a), since disconnecting is exactly as much an
 * operator action as initiating a connect. The router guarantees the method
 * is `POST` and the caller already cleared the Bearer gate before this ever
 * runs.
 *
 * The request body identifies the mailbox by its connected `address`
 * (matching how `MailboxStore.getMailboxByAddress` is already the
 * resolution key elsewhere — the Gmail push webhook, `src/api/
 * gmail-webhook.ts` — and how the connect flow's own response names a
 * mailbox), not an internal `mailboxId` an operator would have no way to
 * know.
 */

import { GmailDisconnectError, type GmailDisconnectService } from '../mail/gmail-disconnect.js'
import { apiError, json } from './responses.js'

/** Dependencies {@link handleGmailDisconnect} needs. ABSENT BY DEFAULT on `InboxApiDeps` (`src/api/index.ts`) — a deployment that hasn't provisioned Gmail OAuth yet (HT-43) simply never configures this. */
export interface GmailDisconnectDeps {
  service: GmailDisconnectService
}

/** Best-effort parse of a request body as a JSON object. Mirrors `src/api/conversations.ts`'s `parseJsonBody` convention. */
async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

/**
 * Handle `POST /api/v1/inbound/gmail/disconnect`.
 *
 * - Missing/invalid JSON body, or a missing/empty `address` field →
 *   `400 validation_failed`.
 * - A caught {@link GmailDisconnectError} (`not_found` — the only code that
 *   type carries today) → `404 not_found`.
 * - Any other error (a DB blip, a network failure reaching Google — genuinely
 *   unexpected) → `500 server_error`.
 * - Success (including the idempotent no-op on an already-disconnected
 *   mailbox) → `200` with `{ mailboxId, address, alreadyDisconnected,
 *   revoked, watchStopped }` — `revoked`/`watchStopped` let the caller see
 *   whether either best-effort remote step (module doc,
 *   `gmail-disconnect.ts`) needs a manual follow-up at Google's end; the
 *   mailbox is unconditionally deactivated locally either way, so this is
 *   never a non-2xx.
 *
 * Own try/catch: every exit from here must be a `Response` this module
 * built, matching every other handler's convention
 * (`src/api/conversations.ts`, `src/api/gmail-connect.ts`).
 */
export async function handleGmailDisconnect(
  request: Request,
  deps: GmailDisconnectDeps,
): Promise<Response> {
  try {
    const parsedBody = await parseJsonBody(request)
    if (!parsedBody.ok) {
      return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
    }
    const body = parsedBody.value
    const address =
      typeof body === 'object' && body !== null && 'address' in body
        ? (body as { address: unknown }).address
        : undefined
    if (typeof address !== 'string' || address.length === 0) {
      return apiError(
        400,
        'validation_failed',
        'address is required and must be a non-empty string.',
      )
    }

    try {
      const result = await deps.service.disconnect(address)
      return json(200, result)
    } catch (err) {
      if (err instanceof GmailDisconnectError) {
        return apiError(404, 'not_found', err.message)
      }
      throw err
    }
  } catch (err) {
    console.error('[gmail-disconnect] unhandled error disconnecting mailbox', err)
    return apiError(500, 'server_error', 'Internal server error.')
  }
}
