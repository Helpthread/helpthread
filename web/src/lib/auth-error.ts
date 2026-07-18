/**
 * Sentinel `error.digest` values set by `lib/api.ts` on a 401 so the client
 * error boundary (`AppError`) can pick the right recovery — two DIFFERENT
 * 401 causes, per HT-54 (spec §8):
 *
 * - {@link AUTH_ERROR_DIGEST} — a 401 from a call that did NOT carry the
 *   acting-Agent header: the deployment's own `HELPTHREAD_API_TOKEN` is
 *   missing or wrong. Routes to `AuthFailure` ("can't reach your inbox").
 * - {@link SESSION_ERROR_DIGEST} — a 401 from a call that DID carry the
 *   acting-Agent header: the session cookie is stale (the Agent it names is
 *   now disabled/deleted) or otherwise invalid. Routes to a redirect back to
 *   `/login`, clearing the cookie via the existing logout-action pattern —
 *   this is "your sign-in itself needs refreshing," not a deployment
 *   misconfiguration.
 *
 * WHY digest and not message: errors thrown from Server Components are
 * sanitized in production — Next.js replaces `error.message` with a generic
 * string and forwards only `error.digest` to the client boundary. A custom
 * digest survives (the same channel `notFound()`/`redirect()` use), so it is
 * the one signal reliable in BOTH dev and prod.
 *
 * This module intentionally has no `server-only` import so it can be shared by
 * the server-only API client AND the client-side `AppError` boundary.
 */
export const AUTH_ERROR_DIGEST = 'unauthorized'
export const SESSION_ERROR_DIGEST = 'session_expired'
