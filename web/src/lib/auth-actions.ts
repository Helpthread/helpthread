'use server'

/**
 * Login/setup/invite-accept/logout server actions (HT-51, extended HT-54) —
 * the only places the session cookie is ever written. Password verification
 * is no longer this module's job at all: the engine is the sole verification
 * authority now (spec §4/§9 — scrypt hash-at-rest, constant-time compare, no
 * account enumeration), reached through `postVerify`/`postSetup`/
 * `acceptInvite` (`lib/api.ts`). This module's whole job is: call the right
 * engine endpoint, and on success mint a cookie carrying the returned
 * Agent's id as `sub` (`lib/session.ts`).
 *
 * The HT-51 ~500ms failure delay is DELETED, not carried over: it existed to
 * blunt a scripted guesser hitting a web-side plaintext-env compare. That
 * compare is gone — the engine now does the verification, with its own
 * timing posture (spec §9: comparable timing across unknown-email/
 * wrong-password/invited/disabled, scrypt work against a dummy hash on a
 * missing Agent). A web-side sleep on top of that adds nothing but latency.
 */

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ApiError, acceptInvite, postSetup, postVerify } from './api'
import { sanitizeNextPath } from './next-path'
import { mintSessionCookie, SESSION_COOKIE_NAME, sessionCookieOptions } from './session'

export interface LoginActionResult {
  ok: boolean
  message?: string
}

/**
 * Verifies `email`/`password` against the named provider (`providerKey`,
 * from the `AuthProviderDescriptor` the login screen rendered this form
 * for — v1 has exactly one, `'password'`) and, on success, signs in and
 * redirects to `nextPathRaw` (sanitized — see `lib/next-path.ts`; falls back
 * to the inbox default when absent or unsafe). Every failure mode the
 * engine reports as `401` (unknown email, wrong password, an
 * `invited`/`disabled` Agent) becomes the SAME generic copy here — the
 * engine already refuses to distinguish these (spec §9's no-oracle rule);
 * repeating that distinction client-side would just be a second place to
 * leak it.
 */
export async function loginAction(
  providerKey: string,
  email: string,
  password: string,
  nextPathRaw: string,
): Promise<LoginActionResult> {
  let agentId: string
  try {
    const { agent } = await postVerify({ providerKey, email, password })
    agentId = agent.id
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { ok: false, message: "That email and password didn't match." }
    }
    return { ok: false, message: 'Could not reach the server. Please try again.' }
  }

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, await mintSessionCookie(agentId), sessionCookieOptions())

  // Throws internally (Next's redirect signal) — this call never returns.
  redirect(sanitizeNextPath(nextPathRaw))
}

/** Clears the session cookie and sends the Agent back to `/login`. */
export async function logoutAction(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE_NAME)
  redirect('/login')
}

export interface SetupActionResult {
  ok: boolean
  message?: string
}

/**
 * First-run bootstrap (`/setup`, spec §6): creates the first admin, signs
 * them in, and redirects to the inbox. The engine's own `409` ("setup has
 * already been completed") is safe to show verbatim — it tells whoever
 * lands here late to go to `/login` instead.
 */
export async function setupAction(
  name: string,
  email: string,
  password: string,
): Promise<SetupActionResult> {
  let agentId: string
  try {
    const { agent } = await postSetup({ name, email, password })
    agentId = agent.id
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, message: error.message }
    }
    return { ok: false, message: 'Could not reach the server. Please try again.' }
  }

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, await mintSessionCookie(agentId), sessionCookieOptions())
  redirect('/inbox/unassigned')
}

export interface AcceptInviteActionResult {
  ok: boolean
  message?: string
}

/** `/invite/{token}` (spec §6): validates the token, sets the password, activates, signs in. */
export async function acceptInviteAction(
  token: string,
  password: string,
): Promise<AcceptInviteActionResult> {
  let agentId: string
  try {
    const { agent } = await acceptInvite(token, password)
    agentId = agent.id
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { ok: false, message: "That invite link isn't valid or has expired." }
    }
    return { ok: false, message: 'Could not reach the server. Please try again.' }
  }

  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, await mintSessionCookie(agentId), sessionCookieOptions())
  redirect('/inbox/unassigned')
}
