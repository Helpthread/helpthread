/**
 * Signed WebAuthn ceremony tokens (HT-75; specs/auth/passkeys.md §5, §7) —
 * the stateless HMAC half of the two-layer challenge/step-up discipline
 * those sections specify. Mirrors `src/auth/invite-token.ts`'s shape (a
 * single base64url JSON payload segment, current+retired key rotation,
 * constant-time verification) off the same {@link Keyring} — the same
 * pattern reused for a new domain, per this codebase's standing convention
 * (`invite-token.ts`'s own module doc makes the same move off
 * `gmail-connect.ts`'s `state` token).
 *
 * Two DISTINCT token types, two DISTINCT domain-separator prefixes, in one
 * file because both are pure HMAC mint/verify pairs over the same
 * `Keyring` with near-identical mechanics — keeping them together avoids
 * duplicating the shared `sign`/`candidateKeys`/`signatureMatches` helpers
 * a third time (they already exist once each in `invite-token.ts` and
 * `gmail-connect.ts`).
 *
 * ## `htw.` — the WebAuthn ceremony challenge token (spec §7)
 *
 * ```
 * htw.{keyId}.{payload-b64url}.{sig-b64url}
 * ```
 *
 * Payload: `{ ceremony, challengeB64, agentId, nonce, issuedAtMs }`.
 * `challengeB64` is the actual WebAuthn ceremony challenge (32 random
 * bytes) handed to `generateRegistrationOptions`/`generateAuthenticationOptions`
 * and checked byte-for-byte at verify time; `nonce` is a SEPARATE random
 * value that is the primary key of the `webauthn_challenges` DB row
 * (`src/store/webauthn.ts`) — the token proves freshness and carries the
 * challenge bytes back to the verify step, but the DB row is what actually
 * enforces single-use (spec §7: "a bare signature+TTL check can be
 * satisfied twice"). Default TTL 5 minutes (spec §7).
 *
 * ## `htsu.` — the step-up proof token (spec §5.1)
 *
 * ```
 * htsu.{keyId}.{payload-b64url}.{sig-b64url}
 * ```
 *
 * Payload: `{ agentId, issuedAtMs, nonce }` — proof that the ACTING Agent
 * recently demonstrated an existing factor (password or an existing
 * passkey). `nonce` is likewise the `webauthn_stepup_tokens` row's primary
 * key. Default TTL 5 minutes (spec §5.1).
 *
 * ## Security properties (mirrors invite-token.ts / gmail-connect.ts)
 *
 * - Both `mint*` functions are STRICT: throw on a malformed keyring
 *   ({@link assertValidKeyring}) — minting an unverifiable token is a bug.
 * - Both `verify*` functions are TOTAL over the token string: every
 *   rejection path returns `null`, never throws, since both are reachable
 *   with fully untrusted input (a webauthn ceremony verify endpoint, or a
 *   step-up-spending endpoint).
 * - Signature verification happens BEFORE the payload is ever JSON-parsed —
 *   same "no parse-oracle independent of the signature" property
 *   `invite-token.ts` documents.
 * - `htw.` and `htsu.` can never verify as each other, or as `hti.`
 *   (invite), `gmc.` (Gmail state), or `ht.` (reply tokens) — the literal
 *   prefix is part of the signed canonical string, not just the wire
 *   format (spec §7).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { assertValidKeyring, type Keyring, type SigningKey } from '../mail/reply-token.js'

/** The three WebAuthn ceremonies (spec §2.2, §7). */
export type WebAuthnCeremony = 'registration' | 'authentication' | 'step-up'

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

function sign(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('base64url')
}

/** Keys in the ring (current first, then retired) whose keyId matches the token's. Same helper `invite-token.ts`/`gmail-connect.ts` each keep a local copy of. */
function candidateKeys(keyring: Keyring, keyId: string): SigningKey[] {
  const all = keyring.retired ? [keyring.current, ...keyring.retired] : [keyring.current]
  return all.filter((key) => key.keyId === keyId)
}

/** Constant-time signature check — same length-guarded pattern as `invite-token.ts`/`gmail-connect.ts`. */
function signatureMatches(secret: string, canonical: string, providedSig: string): boolean {
  const expected = Buffer.from(sign(secret, canonical))
  const provided = Buffer.from(providedSig)
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

// --- htw. challenge token ----------------------------------------------

const CHALLENGE_PREFIX = 'htw'
const CHALLENGE_SEGMENT_COUNT = 4
const CHALLENGE_BYTES = 32
const CHALLENGE_NONCE_BYTES = 16

/** Default challenge-token TTL: 5 minutes (spec §7 — generous slack above the ceremony's own client-side 60s default timeout). */
export const DEFAULT_CHALLENGE_TOKEN_TTL_MS = 5 * 60 * 1000

interface ChallengeTokenPayload {
  ceremony: WebAuthnCeremony
  challengeB64: string
  agentId: string | null
  nonce: string
  issuedAtMs: number
}

function challengeCanonicalString(keyId: string, payloadB64: string): string {
  return `${CHALLENGE_PREFIX}.${keyId}.${payloadB64}`
}

/** What a freshly minted challenge token carries — everything both the caller (to build ceremony options) and the DB row (`webauthn_challenges`) need. */
export interface MintedChallengeToken {
  token: string
  nonce: string
  /** base64url WebAuthn challenge bytes — pass verbatim as `options.challenge`. */
  challengeB64: string
}

/**
 * Mint an `htw.` challenge token for `ceremony`. `agentId` is the acting
 * Agent for `registration`/`step-up` (bound at mint time from the session)
 * and `null` for `authentication` (pre-identification, spec §6.2). STRICT:
 * throws on a malformed keyring (module doc).
 */
export function mintChallengeToken(
  ceremony: WebAuthnCeremony,
  agentId: string | null,
  keyring: Keyring,
): MintedChallengeToken {
  assertValidKeyring(keyring)
  if (agentId !== null && (typeof agentId !== 'string' || !UUID_PATTERN.test(agentId))) {
    throw new Error(
      `mintChallengeToken: agentId must be a uuid or null (got ${JSON.stringify(agentId)})`,
    )
  }

  const { keyId, secret } = keyring.current
  const challengeB64 = randomBytes(CHALLENGE_BYTES).toString('base64url')
  const payload: ChallengeTokenPayload = {
    ceremony,
    challengeB64,
    agentId,
    nonce: randomBytes(CHALLENGE_NONCE_BYTES).toString('base64url'),
    issuedAtMs: Date.now(),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = sign(secret, challengeCanonicalString(keyId, payloadB64))
  return {
    token: `${CHALLENGE_PREFIX}.${keyId}.${payloadB64}.${sig}`,
    nonce: payload.nonce,
    challengeB64,
  }
}

/** A verified `htw.` token's payload. */
export interface VerifiedChallengeToken {
  ceremony: WebAuthnCeremony
  challengeB64: string
  agentId: string | null
  nonce: string
}

/**
 * Verify a candidate `htw.` token: well-formed, correctly signed by a known
 * (current or retired) key, minted no more than `ttlMs` ago (default
 * {@link DEFAULT_CHALLENGE_TOKEN_TTL_MS}). TOTAL over `token` — never
 * throws. This is signature+TTL only — it does NOT check single-use (the
 * `webauthn_challenges` DB consume, `src/store/webauthn.ts`, is that layer
 * — spec §7) and does NOT check that `ceremony` matches what the caller's
 * endpoint expects (the caller does that itself, per-endpoint — spec §7's
 * "application-level" check).
 */
export function verifyChallengeToken(
  token: string,
  keyring: Keyring,
  ttlMs: number = DEFAULT_CHALLENGE_TOKEN_TTL_MS,
): VerifiedChallengeToken | null {
  assertValidKeyring(keyring)

  if (typeof token !== 'string') return null
  const segments = token.split('.')
  if (segments.length !== CHALLENGE_SEGMENT_COUNT) return null
  const [prefix, keyId, payloadB64, sig] = segments
  if (prefix !== CHALLENGE_PREFIX) return null
  if (keyId.length === 0 || payloadB64.length === 0 || sig.length === 0) return null

  const canonical = challengeCanonicalString(keyId, payloadB64)
  let signatureOk = false
  for (const key of candidateKeys(keyring, keyId)) {
    if (signatureMatches(key.secret, canonical, sig)) {
      signatureOk = true
      break
    }
  }
  if (!signatureOk) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { ceremony, challengeB64, agentId, nonce, issuedAtMs } = parsed as Record<string, unknown>

  if (ceremony !== 'registration' && ceremony !== 'authentication' && ceremony !== 'step-up') {
    return null
  }
  if (typeof challengeB64 !== 'string' || challengeB64.length === 0) return null
  if (agentId !== null && (typeof agentId !== 'string' || !UUID_PATTERN.test(agentId))) return null
  if (typeof nonce !== 'string' || nonce.length === 0) return null

  const now = Date.now()
  if (typeof issuedAtMs !== 'number' || !Number.isFinite(issuedAtMs) || issuedAtMs < 0) return null
  if (issuedAtMs > now) return null
  if (now - issuedAtMs > ttlMs) return null

  return { ceremony, challengeB64, agentId, nonce }
}

// --- htsu. step-up token -------------------------------------------------

const STEPUP_PREFIX = 'htsu'
const STEPUP_SEGMENT_COUNT = 4
const STEPUP_NONCE_BYTES = 16

/** Default step-up-token TTL: 5 minutes (spec §5.1). */
export const DEFAULT_STEPUP_TOKEN_TTL_MS = 5 * 60 * 1000

interface StepUpTokenPayload {
  agentId: string
  issuedAtMs: number
  nonce: string
}

function stepUpCanonicalString(keyId: string, payloadB64: string): string {
  return `${STEPUP_PREFIX}.${keyId}.${payloadB64}`
}

/** What a freshly minted step-up token carries. */
export interface MintedStepUpToken {
  token: string
  nonce: string
}

/**
 * Mint an `htsu.` step-up token for `agentId` — proof this Agent just
 * demonstrated an existing factor (spec §5.1). STRICT: throws on a
 * malformed keyring or non-uuid `agentId` (module doc).
 */
export function mintStepUpToken(agentId: string, keyring: Keyring): MintedStepUpToken {
  assertValidKeyring(keyring)
  if (typeof agentId !== 'string' || !UUID_PATTERN.test(agentId)) {
    throw new Error(`mintStepUpToken: agentId must be a uuid (got ${JSON.stringify(agentId)})`)
  }

  const { keyId, secret } = keyring.current
  const payload: StepUpTokenPayload = {
    agentId,
    issuedAtMs: Date.now(),
    nonce: randomBytes(STEPUP_NONCE_BYTES).toString('base64url'),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = sign(secret, stepUpCanonicalString(keyId, payloadB64))
  return { token: `${STEPUP_PREFIX}.${keyId}.${payloadB64}.${sig}`, nonce: payload.nonce }
}

/** A verified `htsu.` token's payload. */
export interface VerifiedStepUpToken {
  agentId: string
  nonce: string
}

/**
 * Verify a candidate `htsu.` token: well-formed, correctly signed, minted
 * no more than `ttlMs` ago (default {@link DEFAULT_STEPUP_TOKEN_TTL_MS}).
 * TOTAL over `token` — never throws. Signature+TTL only, same
 * "single-use is the DB row's job, ceremony/agent binding is the caller's
 * job" split as {@link verifyChallengeToken} — see `src/store/webauthn.ts`
 * for the consume side and spec §5.2 for the "verify re-validates but does
 * not re-consume" discipline.
 */
export function verifyStepUpToken(
  token: string,
  keyring: Keyring,
  ttlMs: number = DEFAULT_STEPUP_TOKEN_TTL_MS,
): VerifiedStepUpToken | null {
  assertValidKeyring(keyring)

  if (typeof token !== 'string') return null
  const segments = token.split('.')
  if (segments.length !== STEPUP_SEGMENT_COUNT) return null
  const [prefix, keyId, payloadB64, sig] = segments
  if (prefix !== STEPUP_PREFIX) return null
  if (keyId.length === 0 || payloadB64.length === 0 || sig.length === 0) return null

  const canonical = stepUpCanonicalString(keyId, payloadB64)
  let signatureOk = false
  for (const key of candidateKeys(keyring, keyId)) {
    if (signatureMatches(key.secret, canonical, sig)) {
      signatureOk = true
      break
    }
  }
  if (!signatureOk) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { agentId, issuedAtMs, nonce } = parsed as Record<string, unknown>

  if (typeof agentId !== 'string' || !UUID_PATTERN.test(agentId)) return null
  if (typeof nonce !== 'string' || nonce.length === 0) return null

  const now = Date.now()
  if (typeof issuedAtMs !== 'number' || !Number.isFinite(issuedAtMs) || issuedAtMs < 0) return null
  if (issuedAtMs > now) return null
  if (now - issuedAtMs > ttlMs) return null

  return { agentId, nonce }
}
