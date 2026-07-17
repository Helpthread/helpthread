/**
 * Operator session model (HT-51) — the v1 "log in" story is deliberately
 * thin: there is one operator per deployment (the Agent Inbox API's own
 * posture, `specs/api/agent-inbox-v1.md` §1/§5 — single-Agent, no per-user
 * identity), so there is exactly one password (`HELPTHREAD_UI_PASSWORD`) and
 * exactly one session shape. This module is the whole of that shape: mint a
 * signed cookie value, verify one back, nothing else. It holds no I/O beyond
 * reading two env vars, so it is safe to import from both a Node server
 * action (the login/logout actions) and `middleware.ts`.
 *
 * ## Why Web Crypto, not `node:crypto`
 *
 * `middleware.ts` runs on Next's Edge runtime, where `node:crypto` does not
 * exist. `crypto.subtle` (Web Crypto) is available as a global in BOTH the
 * Edge runtime and Node 20+ (this repo's `engines.node`), so writing the
 * sign/verify pair against Web Crypto lets the exact same code run in the
 * middleware (Edge) and the login/logout server actions (Node) with no
 * runtime branch. It also gives constant-time MAC comparison for free:
 * `crypto.subtle.verify` never decodes a MAC to a string and `===`s it —
 * that comparison happens inside the WebCrypto implementation itself, which
 * is the actual constant-time primitive, not a hand-rolled one. (The
 * operator PASSWORD comparison is a separate concern, handled in
 * `auth-actions.ts` with `node:crypto`'s `timingSafeEqual` — that comparison
 * only ever needs to run in the login server action, which is Node-only, so
 * there's no Edge constraint pushing it toward Web Crypto too.)
 *
 * ## Cookie format
 *
 * `<payload>.<mac>`, both base64url. `payload` is the JSON string
 * `{"v":1,"iat":<unix-ms>}` and `mac = HMAC-SHA256(secret, payload)` — signed
 * over the base64url TEXT of the payload (not the raw JSON bytes), so
 * verification never has to re-derive the exact encoding that was signed.
 * `v` exists so a future session shape can change the payload without a
 * previous cookie verifying as something it isn't; a `v` this module doesn't
 * recognize fails closed (verifies to `null`), same as a bad MAC.
 *
 * ## Expiry model — sliding, simplest-correct option
 *
 * A minted cookie is valid for `SESSION_MAX_AGE_MS` (7 days) from its `iat`.
 * Two ways to make that "slide" with activity: re-sign on literally every
 * request (correct, but a wasted HMAC on every single navigation), or never
 * slide at all (simple, but forces a re-login every 7 days regardless of how
 * active the operator is — a worse experience for zero extra safety). This
 * module picks the middle option: `verifySessionCookie` reports
 * `shouldRefresh: true` once the cookie is more than a day old, and the
 * caller (middleware, on any authenticated request) re-stamps a fresh cookie
 * at that point. An active operator's session then rolls forward roughly a
 * day at a time; an idle one still lapses within a week of their last
 * request. This is the one sliding-window shape simple enough to hold in
 * your head during review — no configurable policy, no separate "absolute
 * max" cap to reason about.
 */

export const SESSION_COOKIE_NAME = 'ht_session'

const SESSION_VERSION = 1
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const SESSION_REFRESH_AGE_MS = 24 * 60 * 60 * 1000

export interface SessionPayload {
  v: typeof SESSION_VERSION
  /** Unix ms this session was minted (or last re-stamped). */
  iat: number
}

export interface VerifiedSession {
  payload: SessionPayload
  /** True once the cookie is older than a day — see the expiry model above. */
  shouldRefresh: boolean
}

export interface UiAuthConfig {
  sessionSecret: string
  password: string
}

/**
 * Reads and validates the two env vars the login flow needs, the same guard
 * shape as `lib/api.ts`'s `config()`: required (with a minimum length) in
 * production, with harmless dev defaults everywhere else, skipped during
 * `next build` (`NEXT_PHASE=phase-production-build`) where prerendering runs
 * in production mode without the runtime env available yet.
 */
export function uiAuthConfig(): UiAuthConfig {
  const sessionSecret = process.env.HELPTHREAD_UI_SESSION_SECRET
  const password = process.env.HELPTHREAD_UI_PASSWORD
  const isBuild = process.env.NEXT_PHASE === 'phase-production-build'

  if (
    process.env.NODE_ENV === 'production' &&
    !isBuild &&
    (sessionSecret === undefined ||
      sessionSecret.length < 32 ||
      password === undefined ||
      password.length < 12)
  ) {
    throw new Error(
      'HELPTHREAD_UI_SESSION_SECRET (>=32 chars) and HELPTHREAD_UI_PASSWORD (>=12 chars) ' +
        'must both be set in production — refusing to fall back to dev defaults.',
    )
  }

  // Dev defaults are obviously-dev values, matching the HT-24 harness's
  // `helpthread-dev-token` convention — never valid in a real deployment
  // because the production guard above refuses to start without real ones.
  return {
    sessionSecret: sessionSecret ?? 'helpthread-dev-session-secret-do-not-use-in-production-00',
    password: password ?? 'helpthread-dev-password',
  }
}

/** The `Set-Cookie` attributes shared by every place that writes the session cookie. */
export function sessionCookieOptions(): {
  httpOnly: true
  secure: boolean
  sameSite: 'lax'
  path: string
  maxAge: number
} {
  return {
    httpOnly: true,
    // Only forced off in dev, where the app typically runs over plain http://localhost.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (normalized.length % 4)) % 4
  const binary = atob(normalized + '='.repeat(padLength))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** Mints a fresh, signed session cookie value. `iat` defaults to now; the
 *  middleware's refresh path passes nothing and gets a re-stamped `now`. */
export async function mintSessionCookie(iat: number = Date.now()): Promise<string> {
  const { sessionSecret } = uiAuthConfig()
  const payload: SessionPayload = { v: SESSION_VERSION, iat }
  const payloadB64 = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)))
  const key = await importHmacKey(sessionSecret)
  const mac = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payloadB64))
  return `${payloadB64}.${base64UrlEncode(new Uint8Array(mac))}`
}

/**
 * Verifies a session cookie value. TOTAL over its input, same discipline as
 * the engine's `verifyReplyMessageId` (`src/mail/reply-token.ts`): any
 * malformed, forged, wrong-version, or expired cookie value returns `null`
 * rather than throwing — an untrusted cookie must never crash the request
 * that carries it, it just fails closed into "not logged in".
 */
export async function verifySessionCookie(
  cookieValue: string | undefined,
): Promise<VerifiedSession | null> {
  if (!cookieValue) return null

  const parts = cookieValue.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, macB64] = parts
  if (!payloadB64 || !macB64) return null

  try {
    const { sessionSecret } = uiAuthConfig()
    const key = await importHmacKey(sessionSecret)
    const macBytes = base64UrlDecode(macB64)
    const valid = await crypto.subtle.verify('HMAC', key, macBytes, textEncoder.encode(payloadB64))
    if (!valid) return null

    const payload = JSON.parse(textDecoder.decode(base64UrlDecode(payloadB64))) as unknown
    if (
      typeof payload !== 'object' ||
      payload === null ||
      (payload as { v?: unknown }).v !== SESSION_VERSION ||
      typeof (payload as { iat?: unknown }).iat !== 'number'
    ) {
      return null
    }

    const { iat } = payload as SessionPayload
    const age = Date.now() - iat
    if (age < 0 || age > SESSION_MAX_AGE_MS) return null

    return { payload: { v: SESSION_VERSION, iat }, shouldRefresh: age > SESSION_REFRESH_AGE_MS }
  } catch {
    // Malformed base64, malformed JSON, a WebCrypto error on garbage input —
    // all the same outcome: this is not a valid session.
    return null
  }
}
