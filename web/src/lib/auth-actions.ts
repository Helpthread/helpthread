'use server'

/**
 * Login/logout server actions (HT-51) — the only two places the operator
 * password is ever compared, and the only two places the session cookie is
 * ever written. Both run on the Node runtime (server actions default to
 * Node, unlike `middleware.ts`), so the password comparison uses
 * `node:crypto`'s `timingSafeEqual` directly rather than the Web Crypto
 * path `lib/session.ts` uses for the cookie MAC (that module's comment
 * explains why the cookie side needs Web Crypto and this side doesn't).
 *
 * `timingSafeEqual` throws if its two buffers differ in length, which a
 * naive `timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))`
 * would do for almost every wrong guess (most wrong passwords aren't the
 * same length as the real one) — turning "wrong password" into a thrown
 * error and, worse, leaking the correct length's presence/absence through
 * which path failed. Hashing both sides to a fixed-length SHA-256 digest
 * first sidesteps that: `timingSafeEqual` always sees two 32-byte buffers,
 * length is never data, and the digest comparison is byte-for-byte
 * time-independent.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { sanitizeNextPath } from './next-path'
import {
  mintSessionCookie,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  uiAuthConfig,
} from './session'

/** Per-instance-only throttle (see the module comment on `loginAction`). */
const LOGIN_FAILURE_DELAY_MS = 500

export interface LoginActionResult {
  ok: boolean
  message?: string
}

/**
 * Checks the submitted password against `HELPTHREAD_UI_PASSWORD` and, on a
 * match, signs in and redirects to `nextPathRaw` (sanitized — see
 * `lib/next-path.ts`; falls back to the inbox default when absent or
 * unsafe). On a mismatch, waits ~500ms before returning the failure so a
 * scripted guesser can't fire requests back-to-back — this is a per-process
 * delay, not a rate limit: it does nothing against many parallel requests or
 * multiple deployment instances. v1 is a single operator behind one
 * password; a real rate limiter is out of scope until that stops being true.
 */
export async function loginAction(
  password: string,
  nextPathRaw: string,
): Promise<LoginActionResult> {
  const { password: expected } = uiAuthConfig()

  if (!passwordMatches(password, expected)) {
    await sleep(LOGIN_FAILURE_DELAY_MS)
    return { ok: false, message: "That password didn't match." }
  }

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, await mintSessionCookie(), sessionCookieOptions())

  // Throws internally (Next's redirect signal) — this call never returns.
  redirect(sanitizeNextPath(nextPathRaw))
}

/** Clears the session cookie and sends the operator back to `/login`. */
export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE_NAME)
  redirect('/login')
}

function passwordMatches(candidate: string, expected: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(candidateDigest, expectedDigest)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
