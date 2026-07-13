/**
 * Sentinel `error.digest` set by `lib/api.ts` on a 401 so the client error
 * boundary can select the AuthFailure screen.
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
