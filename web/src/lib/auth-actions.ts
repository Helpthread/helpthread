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
 * We derive a fixed-length key from each side with `scrypt` (a slow KDF)
 * first, then `timingSafeEqual` always sees two equal-length digests, length
 * is never data, and the comparison is byte-for-byte time-independent — see
 * `passwordMatches` for why a *slow* KDF specifically (online-guess cost, and
 * what static analysis expects of any password comparison).
 */

import { scryptSync, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { sanitizeNextPath } from './next-path'
import {
  mintSessionCookie,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  uiAuthConfig,
} from './session'

/** scrypt output length; 32 bytes matches a SHA-256-sized digest. */
const SCRYPT_KEYLEN = 32

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

function passwordMatches(candidate: string, expected: string, salt: string): boolean {
  // Derive a fixed-length key from each side with scrypt (a deliberately slow
  // KDF) before the constant-time compare. Two things fall out of this:
  //  1. Length-blinding: both digests are SCRYPT_KEYLEN bytes, so
  //     `timingSafeEqual` never sees unequal lengths and length is never data.
  //  2. Online-guess cost: scrypt's work factor makes each comparison cost
  //     ~tens of ms, so an attacker who reaches this endpoint can't cheaply
  //     brute-force the password. (There is no password hash *at rest* to
  //     protect — the expected value is the plaintext HELPTHREAD_UI_PASSWORD
  //     env — but a slow KDF still raises the cost of online guessing, and it
  //     is what static analysis expects of any password comparison.)
  // The salt is the deployment session secret; both sides use the same salt so
  // their derived keys are comparable.
  const saltBuf = Buffer.from(salt)
  const candidateKey = scryptSync(candidate, saltBuf, SCRYPT_KEYLEN)
  const expectedKey = scryptSync(expected, saltBuf, SCRYPT_KEYLEN)
  return timingSafeEqual(candidateKey, expectedKey)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
