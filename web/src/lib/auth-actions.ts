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
 * error and, worse, leaking the correct length through which path failed.
 * We blind both sides to a fixed-length **keyed HMAC** first, then
 * `timingSafeEqual` always sees two equal-length digests, length is never
 * data, and the comparison is byte-for-byte time-independent.
 *
 * The HMAC is keyed with the deployment's session secret (not a bare
 * `createHash`): this is the standard constant-time-compare-of-unequal-length
 * idiom (cf. Django's `constant_time_compare`), and — because there is no
 * *stored* password hash to brute-force here (the expected value is the
 * plaintext `HELPTHREAD_UI_PASSWORD` env, deployment config like the API
 * token) — a slow password KDF (bcrypt/scrypt/argon2) would buy nothing: it
 * exists to make cracking a leaked hash-at-rest expensive, and there is no
 * hash at rest. The keyed HMAC is purely a length-blinding step for the
 * constant-time equality, not a storage hash.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
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
  const { password: expected, sessionSecret } = uiAuthConfig()

  if (!passwordMatches(password, expected, sessionSecret)) {
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

function passwordMatches(candidate: string, expected: string, key: string): boolean {
  // Keyed HMAC blinds both sides to a fixed 32-byte length before the
  // constant-time compare (see the module comment). The key is the session
  // secret; it is not a salt for storage — there is no stored hash.
  const candidateMac = createHmac('sha256', key).update(candidate).digest()
  const expectedMac = createHmac('sha256', key).update(expected).digest()
  return timingSafeEqual(candidateMac, expectedMac)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
