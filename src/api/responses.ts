/**
 * Response helpers shared by every Agent Inbox API handler
 * (specs/api/agent-inbox-v1.md §3, "conventions apply to every endpoint").
 *
 * Two rules apply to EVERY response this API sends, success or error, and
 * both are centralized here so no handler can forget either one:
 *
 * - `Cache-Control: no-store` on every single response. This is
 *   authenticated support data — a conversation's subject, a customer's
 *   email, message bodies — and per spec §3 it must never sit in an edge or
 *   CDN cache, not even a 404 or a 401 (a cached auth failure could mask a
 *   real one later).
 * - The error envelope (`{ error: { code, message } }`, spec §3) is built in
 *   exactly one place ({@link apiError}), so every error response has the
 *   same shape and callers can't accidentally leak an internal detail
 *   through a one-off `Response` — see the doc note on `message` below.
 */

/** The wire shape of every non-2xx response body (specs/api/agent-inbox-v1.md §3). */
export interface ApiError {
  error: {
    code: string
    message: string
  }
}

/**
 * Build a JSON `Response` with the required `Content-Type` and
 * `Cache-Control: no-store` headers. `body` is serialized as-is via
 * `JSON.stringify` — callers are responsible for having already converted
 * any `Date` fields to ISO strings (this module knows nothing about the
 * domain shapes flowing through it, by design).
 */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

/**
 * Build an empty `204 No Content` response (spec §4d's successful soft
 * delete, v1.1 — the one success in this API with no body). Still carries
 * `Cache-Control: no-store` like every other response; no `Content-Type`,
 * since there is no content for it to describe.
 */
export function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  })
}

/**
 * Build an error `Response` in the standard envelope (spec §3).
 *
 * `message` MUST be user-safe: never a stack trace, never a raw SQL error,
 * never an upstream provider's response body, never an id the caller didn't
 * already supply themselves. It is shown to whoever is holding the service
 * Bearer token — today that's the operator, but the contract is written for
 * the day an AI assistant or a less-trusted integration holds it instead.
 * When in doubt, write a generic message and let server-side logging (not
 * this response) carry the detail.
 */
export function apiError(status: number, code: string, message: string): Response {
  const body: ApiError = { error: { code, message } }
  return json(status, body)
}
