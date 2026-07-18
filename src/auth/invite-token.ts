/**
 * Signed invite tokens (HT-54; specs/auth/agents-and-auth.md §8, §9) — the
 * credential a `POST /api/v1/agents` (`sendInvite: true`) or `POST
 * /api/v1/agents/{id}/invite` call mints and emails as `/invite/{token}`.
 *
 * Mirrors `src/mail/gmail-connect.ts`'s `gmc.` connect-state token: the same
 * stateless, server-session-free HMAC pattern off the same {@link Keyring}
 * (full HMAC-SHA256, base64url, current+retired key rotation, constant-time
 * verification) — a natural fit for a serverless deployment with no session
 * store, reused here for a different domain. `hti.` is the domain
 * separator — distinct from reply tokens' `ht.`, view tokens' `v`, and
 * connect state's `gmc.` — so a signature minted for one purpose can never
 * verify as another (spec §8's explicit requirement).
 *
 * ## Token format
 *
 * ```
 * hti.{keyId}.{payload-b64url}.{sig-b64url}
 * ```
 *
 * Unlike the `gmc.`/`ht.` tokens (which sign a handful of dot-separated
 * scalar fields), this token's payload is a small JSON object
 * (`{ agentId, issuedAtMs, nonce }`) base64url-encoded as ONE segment —
 * simpler than adding a fourth scalar field to a dot-separated scheme, and
 * there is no risk of a `.`-containing value (an `agentId` is a uuid, never
 * containing `.`) colliding with the delimiter here since the payload is a
 * single opaque segment either way.
 *
 * `sig = base64url( HMAC-SHA256( secret, "hti.{keyId}.{payload-b64url}" ) )`
 * — the literal `hti.` prefix is part of the SIGNED bytes (not just the
 * wire format), which is what makes an `hti.` signature structurally unable
 * to verify against a `gmc.`/`ht.` token's secret-and-canonical-string pair
 * even where key material happened to be shared (it is not, in practice —
 * each token type is minted off the same `Keyring` object, but the
 * domain-separated canonical string is the actual guarantee, not an
 * assumption about key reuse).
 *
 * ## One-time-ness is NOT a token property
 *
 * Unlike a nonce-tracked single-use token, nothing here records "this token
 * was already used." Replay-safety comes from the atomic `invited` →
 * `active` status transition the accept endpoint performs
 * (`AgentStore.acceptInvite`, spec §6/§9): a second accept of the same
 * token finds the Agent no longer `invited` and affects zero rows,
 * regardless of whether the token itself still "verifies" cryptographically.
 * This module's job ends at "is this a genuine, unexpired invite for this
 * `agentId`" — the store is what makes it single-use in effect.
 *
 * ## Security properties (mirrors reply-token.ts / gmail-connect.ts)
 *
 * - {@link mintInviteToken} is STRICT — throws on a malformed keyring or a
 *   non-uuid-shaped `agentId` (a deploy-time/programmer bug, fail loud).
 * - {@link verifyInviteToken} is TOTAL over `token` (the untrusted input a
 *   customer-facing accept endpoint receives verbatim) — every rejection
 *   path returns `null`, never throws.
 * - TTL default 72 hours (spec says "short-lived"; pinned here per the
 *   HT-54 implementation brief — long enough that an invite sent on a
 *   Friday is still good Monday, short enough that a stale, unaccepted
 *   invite eventually stops being a live credential).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { assertValidKeyring, type Keyring, type SigningKey } from '../mail/reply-token.js'

/** Fixed literal prefix marking a token as one of this module's invite tokens — the domain separator (module doc). */
const TOKEN_PREFIX = 'hti'

/** Number of dot-separated segments in a well-formed token: `hti`, keyId, payload, sig. */
const SEGMENT_COUNT = 4

/** Random nonce size (bytes) minted into every invite payload — belt-and-suspenders alongside `issuedAtMs`; not relied on for one-time-ness (module doc). */
const NONCE_BYTES = 16

/** Default invite token TTL: 72 hours (module doc — pinned by the implementation brief; spec only says "short-lived"). */
export const DEFAULT_INVITE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000

/** The uuid-shape check for `agentId` at mint time — mirrors `src/api/uuid.ts`, duplicated locally so this module has no dependency on `src/api/**` (an auth seam should not depend on the HTTP layer). */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The payload signed and carried inside an invite token. */
interface InviteTokenPayload {
  agentId: string
  issuedAtMs: number
  nonce: string
}

/** The exact bytes signed: `hti.{keyId}.{payload-b64url}` — see the module doc on why the prefix is part of the signed string. */
function canonicalString(keyId: string, payloadB64: string): string {
  return `${TOKEN_PREFIX}.${keyId}.${payloadB64}`
}

function sign(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('base64url')
}

/**
 * Mint an invite token for `agentId`, signing with `keyring.current`.
 * STRICT: throws if `keyring` is malformed ({@link assertValidKeyring}) or
 * `agentId` is not a well-formed uuid — emitting a token for a bogus id
 * would be a programmer error, not something to silently tolerate.
 */
export function mintInviteToken(agentId: string, keyring: Keyring): string {
  assertValidKeyring(keyring)
  if (typeof agentId !== 'string' || !UUID_PATTERN.test(agentId)) {
    throw new Error(`mintInviteToken: agentId must be a uuid (got ${JSON.stringify(agentId)})`)
  }

  const { keyId, secret } = keyring.current
  const payload: InviteTokenPayload = {
    agentId,
    issuedAtMs: Date.now(),
    nonce: randomBytes(NONCE_BYTES).toString('base64url'),
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = sign(secret, canonicalString(keyId, payloadB64))
  return `${TOKEN_PREFIX}.${keyId}.${payloadB64}.${sig}`
}

/**
 * Verify a candidate invite token: well-formed, correctly signed by a known
 * (current or retired) key, and minted no more than `ttlMs` ago
 * (default {@link DEFAULT_INVITE_TOKEN_TTL_MS}). TOTAL over `token` — never
 * throws; every rejection is `null`. `keyring` is trusted deploy-time
 * configuration and still fails loudly if malformed ({@link
 * assertValidKeyring}) — mirrors `verifyReplyMessageId`/`verifyConnectState`,
 * whose doc comments explain why that does not weaken totality over the
 * untrusted argument.
 *
 * Signature verification happens BEFORE the payload is ever JSON-parsed:
 * tampering with `payloadB64` changes the signed bytes themselves, so a
 * forged/tampered payload always fails the signature check first — this
 * function never hands an attacker a "here's whether your JSON parsed"
 * oracle independent of the signature.
 */
export function verifyInviteToken(
  token: string,
  keyring: Keyring,
  ttlMs: number = DEFAULT_INVITE_TOKEN_TTL_MS,
): { agentId: string } | null {
  assertValidKeyring(keyring)

  if (typeof token !== 'string') return null
  const segments = token.split('.')
  if (segments.length !== SEGMENT_COUNT) return null
  const [prefix, keyId, payloadB64, sig] = segments
  if (prefix !== TOKEN_PREFIX) return null
  if (keyId.length === 0 || payloadB64.length === 0 || sig.length === 0) return null

  const canonical = canonicalString(keyId, payloadB64)
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

  return { agentId }
}

/** Keys in the ring (current first, then retired) whose keyId matches the token's. Same helper reply-token.ts/gmail-connect.ts each keep a local copy of. */
function candidateKeys(keyring: Keyring, keyId: string): SigningKey[] {
  const all = keyring.retired ? [keyring.current, ...keyring.retired] : [keyring.current]
  return all.filter((key) => key.keyId === keyId)
}

/** Constant-time signature check — same length-guarded pattern as reply-token.ts/gmail-connect.ts. */
function signatureMatches(secret: string, canonical: string, providedSig: string): boolean {
  const expected = Buffer.from(sign(secret, canonical))
  const provided = Buffer.from(providedSig)
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}
