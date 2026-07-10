/**
 * Signed reply tokens — the cryptographic core of outbound-anchored email
 * threading (specs/mail/threading.md §2; charter §2 "threading authority
 * lives on the outbound side", invariant #3 "threading correctness outranks
 * feature velocity").
 *
 * The engine controls threading by embedding a signed token in every
 * OUTBOUND `Message-ID` and verifying it when a reply comes back. Inbound
 * `References`/`In-Reply-To` values written by arbitrary mail clients are
 * never trusted on their own; the only authority is a token this module
 * minted and can re-verify offline. This file is exactly that mint + verify
 * pair — pure functions, no DB, no I/O.
 *
 * ## Token format
 *
 * Carried as the local part of an outbound `Message-ID`:
 *
 * ```
 * <ht.{keyId}.{conversationId}.{threadId}.{sig}@{mailDomain}>
 * ```
 *
 * - `sig = base64url( HMAC-SHA256( secret, canonicalString ) )` — the FULL
 *   32-byte HMAC, base64url-encoded, unpadded. Not truncated: full length is
 *   the safest choice and the extra bytes are trivial inside a Message-ID.
 * - `canonicalString = `${keyId}.${conversationId}.${threadId}`` — the exact
 *   bytes that are signed. `mailDomain` is NOT signed (it isn't part of the
 *   threading identity; a message that reaches us is threaded by its token
 *   regardless of the domain it claims).
 *
 * `.` is the field delimiter, so the three id fields are constrained at mint
 * time to `[A-Za-z0-9_-]` (no dot, no `@`, no `<`/`>`). base64url uses that
 * same charset, so a well-formed local part always splits into exactly five
 * dot-separated segments — unambiguous by construction.
 *
 * ## Spec properties this satisfies (threading.md §2)
 *
 * - (a) Unguessable without the secret — HMAC-SHA256.
 * - (b) Verifiable offline — pure computation, no lookup table of issued
 *   tokens.
 * - (c) Carries conversation + thread identity — recovered directly from a
 *   verified token.
 * - (d) Rotation-tolerant — a `keyId` names the signing key; see below.
 *
 * ## Key rotation model
 *
 * A {@link Keyring} has one `current` key and zero or more `retired` keys.
 * Minting ALWAYS uses `current`. Verification accepts `current` OR any
 * `retired` key — so rotating the secret (retire the old key, promote a new
 * `current`) never invalidates tokens already in customers' mailboxes.
 * Dropping a key from the ring entirely stops its tokens from verifying.
 *
 * ## Security invariants
 *
 * - {@link verifyReplyMessageId} is TOTAL over the `messageId` — the untrusted
 *   input: for ANY `messageId` string, given a valid keyring, it returns a
 *   payload or `null`, never throws. A hostile inbound header must never crash
 *   the ingest path (charter invariant #1: never lose or corrupt customer
 *   mail). A malformed KEYRING is different — that is trusted configuration, a
 *   deploy-time bug, and is rejected loudly by {@link assertValidKeyring}.
 * - Secrets are validated: HMAC's security is only as good as its key, so an
 *   empty/short secret is rejected ({@link MIN_SECRET_LENGTH}), and keyIds must
 *   be unique so a retired secret can't be revived under a live keyId.
 * - Signature comparison is constant-time ({@link https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b | crypto.timingSafeEqual}),
 *   with an explicit length guard first (timingSafeEqual throws on
 *   unequal-length buffers — that is treated as "invalid", not an error).
 * - {@link mintReplyMessageId} is STRICT: minting a malformed token is a bug,
 *   so it throws on invalid input rather than emitting something unverifiable.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * The threading identity carried by a verified token: which signing key
 * produced it, and the conversation/thread lineage it belongs to.
 */
export interface ReplyTokenPayload {
  keyId: string
  conversationId: string
  threadId: string
}

/**
 * A single HMAC signing key. `secret` is a high-entropy string (the caller's
 * responsibility); `keyId` names it inside a token so verification can pick
 * the right secret without trial-decrypting.
 */
export interface SigningKey {
  keyId: string
  secret: string
}

/**
 * The set of keys in play. `current` both mints and verifies; `retired` keys
 * only ever verify (never mint), which is what makes secret rotation
 * non-breaking for tokens already in the wild. See the rotation model in the
 * module doc.
 */
export interface Keyring {
  current: SigningKey
  retired?: SigningKey[]
}

/** Fixed literal prefix marking a Message-ID local part as one of our tokens. */
const TOKEN_PREFIX = 'ht'

/** Number of dot-separated segments in a well-formed local part: `ht`, keyId, conversationId, threadId, sig. */
const SEGMENT_COUNT = 5

/**
 * Charset for the three id fields and the keyId at mint time. Excludes the
 * `.` delimiter and the `@`/`<`/`>` structural characters of a Message-ID.
 * Matches the base64url alphabet, so no field can be confused for a delimiter.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * A single DNS label inside the mail domain: 1–63 chars, alphanumeric, with
 * internal (not leading/trailing) hyphens. The full domain is one or more of
 * these joined by dots — so `..`, `a..b`, `-x.test`, and `x-.test` are all
 * rejected. The domain is not signed; this only keeps the minted Message-ID
 * syntactically sane so mail infrastructure doesn't reject or rewrite it.
 */
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

/**
 * Minimum secret length (characters). HMAC-SHA256's security rests entirely on
 * the key: an empty or short secret makes forgery trivial. Secrets should be
 * high-entropy random strings (e.g. `openssl rand -base64 32`); this is a floor,
 * not a guarantee of entropy.
 */
const MIN_SECRET_LENGTH = 32

/**
 * The exact bytes signed by the HMAC: `keyId.conversationId.threadId`.
 * Deterministic, so the same payload + key always yields the same signature.
 */
function canonicalString(keyId: string, conversationId: string, threadId: string): string {
  return `${keyId}.${conversationId}.${threadId}`
}

/**
 * Compute the token signature: the full 32-byte HMAC-SHA256 over the
 * canonical string, base64url-encoded without padding. Node's `'base64url'`
 * digest encoding is URL-safe (`-`/`_`) and unpadded by definition.
 */
function sign(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('base64url')
}

/**
 * Mint the outbound `Message-ID` (WITH angle brackets) carrying a signed
 * reply token, signing with `keyring.current`.
 *
 * STRICT by design: `conversationId`, `threadId`, and the current key's
 * `keyId` must each be a non-empty string of `[A-Za-z0-9_-]` (no `.`/`@`/
 * angle brackets), and `mailDomain` must be a plausible domain. Any violation
 * throws — emitting a token that can't later verify would be a threading bug,
 * so we fail loud at the source. See specs/mail/threading.md §2.
 *
 * @returns e.g. `<ht.k1.c42.t7.<base64url-sig>@mail.example.test>`
 * @throws {Error} on any invalid input field.
 */
export function mintReplyMessageId(
  payload: Omit<ReplyTokenPayload, 'keyId'> & { mailDomain: string },
  keyring: Keyring,
): string {
  assertValidKeyring(keyring)
  const { conversationId, threadId, mailDomain } = payload
  const { keyId, secret } = keyring.current

  assertIdField('conversationId', conversationId)
  assertIdField('threadId', threadId)
  assertValidDomain('mailDomain', mailDomain)

  const sig = sign(secret, canonicalString(keyId, conversationId, threadId))
  return `<${TOKEN_PREFIX}.${keyId}.${conversationId}.${threadId}.${sig}@${mailDomain}>`
}

/**
 * Verify a candidate `Message-ID` and, if it is one of our tokens with a
 * signature that checks out against a known key, return its payload.
 *
 * TOTAL and never throws — every rejection path returns `null`:
 * not our format (a Gmail Message-ID, an empty string, `<>`), missing/extra
 * angle brackets, missing `@domain`, wrong segment count, an id with an
 * injected `.`, an unknown/removed `keyId`, or any tampered field (the HMAC
 * won't match). A tampered-but-well-shaped token is indistinguishable from a
 * forgery and is rejected the same way.
 *
 * Verification tries `keyring.current` and every `keyring.retired[]` key
 * whose `keyId` matches the token, using a constant-time comparison with a
 * length guard (see module doc).
 *
 * @returns the recovered {@link ReplyTokenPayload}, or `null` for anything
 *   that isn't a valid token signed by a known key.
 */
export function verifyReplyMessageId(
  messageId: string,
  keyring: Keyring,
): ReplyTokenPayload | null {
  // Trusted config: a malformed keyring is a deploy bug, so fail loud here.
  // This does NOT weaken totality over the messageId, which is the untrusted
  // input — see the doc note.
  assertValidKeyring(keyring)

  const parsed = parseToken(messageId)
  if (parsed === null) return null

  const { keyId, conversationId, threadId, sig } = parsed
  const canonical = canonicalString(keyId, conversationId, threadId)

  for (const key of candidateKeys(keyring, keyId)) {
    if (signatureMatches(key.secret, canonical, sig)) {
      return { keyId, conversationId, threadId }
    }
  }
  return null
}

/**
 * Structurally test whether `messageId` is shaped like one of our tokens —
 * the right `<ht.{keyId}.{conversationId}.{threadId}.{sig}@{domain}>` five-
 * segment form — WITHOUT verifying the signature.
 *
 * This is what lets the threading decision (specs/mail/threading.md §3 rule
 * 3) distinguish two very different kinds of "not a valid token":
 * - shaped-but-invalid: a token of ours that failed verification (forged or
 *   tampered) — a security-relevant event worth counting.
 * - not shaped at all: not our token to begin with (e.g. a Gmail
 *   Message-ID) — inert, not evidence of anything.
 *
 * Implemented by reusing the same structural parser {@link verifyReplyMessageId}
 * verifies against, so the two functions can never disagree on what counts as
 * "shaped like ours". TOTAL: never throws, for any string input.
 */
export function isReplyTokenShaped(messageId: string): boolean {
  return parseToken(messageId) !== null
}

/** A token's segments after structural parsing, before signature verification. */
interface ParsedToken {
  keyId: string
  conversationId: string
  threadId: string
  sig: string
}

/**
 * Structurally parse a candidate `Message-ID` into token segments, or return
 * `null` if it is not shaped like one of our tokens. Does NOT verify the
 * signature — that's the caller's job. Total: never throws.
 *
 * Steps: require surrounding `<`…`>`; strip them; require exactly one `@`
 * separating a non-empty local part from a non-empty domain; split the local
 * part on `.` into exactly five segments; require the first to be the literal
 * `ht`; require the four remaining fields to be non-empty (no injected empty
 * segment). The domain is discarded — it isn't signed.
 */
function parseToken(messageId: string): ParsedToken | null {
  if (
    typeof messageId !== 'string' ||
    messageId.length < 2 ||
    messageId[0] !== '<' ||
    messageId[messageId.length - 1] !== '>'
  ) {
    return null
  }

  const inner = messageId.slice(1, -1)
  const atParts = inner.split('@')
  if (atParts.length !== 2) return null
  const [local, domain] = atParts
  if (local.length === 0 || domain.length === 0) return null

  const segments = local.split('.')
  if (segments.length !== SEGMENT_COUNT) return null

  const [prefix, keyId, conversationId, threadId, sig] = segments
  if (prefix !== TOKEN_PREFIX) return null
  if (
    keyId.length === 0 ||
    conversationId.length === 0 ||
    threadId.length === 0 ||
    sig.length === 0
  ) {
    return null
  }

  return { keyId, conversationId, threadId, sig }
}

/** Keys in the ring (current first, then retired) whose keyId matches the token's. */
function candidateKeys(keyring: Keyring, keyId: string): SigningKey[] {
  const all = keyring.retired ? [keyring.current, ...keyring.retired] : [keyring.current]
  return all.filter((key) => key.keyId === keyId)
}

/**
 * Constant-time check that `providedSig` is the base64url HMAC of `canonical`
 * under `secret`. Compares the base64url STRINGS byte-for-byte: a length
 * mismatch (guarded before {@link timingSafeEqual}, which throws on unequal
 * lengths) counts as "no match", and a non-canonical re-encoding of a valid
 * HMAC is likewise rejected rather than accepted.
 */
function signatureMatches(secret: string, canonical: string, providedSig: string): boolean {
  const expected = Buffer.from(sign(secret, canonical))
  const provided = Buffer.from(providedSig)
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

/** Throw a clear, field-named error if `value` isn't a non-empty id-charset string. */
function assertIdField(field: string, value: unknown): void {
  // Explicit string check first: RegExp.test() coerces its argument, so a
  // non-string (undefined, a number) would otherwise be silently stringified
  // and could pass — minting a token with a bogus identifier.
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(
      `mintReplyMessageId: ${field} must be a string matching ${ID_PATTERN} (got ${JSON.stringify(value)})`,
    )
  }
}

/** Throw unless `value` is a syntactically valid mail domain (dot-joined DNS labels). */
function assertValidDomain(field: string, value: unknown): void {
  const ok =
    typeof value === 'string' &&
    value.length <= 253 &&
    value.split('.').every((label) => DOMAIN_LABEL.test(label))
  if (!ok) {
    throw new Error(
      `mintReplyMessageId: ${field} must be a valid mail domain (got ${JSON.stringify(value)})`,
    )
  }
}

/**
 * Validate a {@link Keyring} — this is trusted configuration, so a malformed
 * ring is a deploy-time bug that must fail loudly (it is NOT hostile input).
 * Enforces: every secret is a string of at least {@link MIN_SECRET_LENGTH}
 * chars; every keyId is a valid id string; and — critically — all keyIds are
 * UNIQUE. Uniqueness makes rotation safe by construction: a new key must use a
 * new keyId, so a retired/leaked secret can never be revived under a keyId that
 * a current token would match. Revoke a compromised key by dropping it from the
 * ring entirely.
 *
 * @throws {Error} on any malformed or unsafe keyring.
 */
export function assertValidKeyring(keyring: Keyring): void {
  if (keyring?.current == null) {
    throw new Error('reply-token: keyring.current is required')
  }
  if (keyring.retired !== undefined && !Array.isArray(keyring.retired)) {
    throw new Error('reply-token: keyring.retired must be an array when present')
  }
  const keys = keyring.retired ? [keyring.current, ...keyring.retired] : [keyring.current]
  const seen = new Set<string>()
  for (const key of keys) {
    if (typeof key?.keyId !== 'string' || !ID_PATTERN.test(key.keyId)) {
      throw new Error(`reply-token: invalid keyId ${JSON.stringify(key?.keyId)}`)
    }
    if (typeof key.secret !== 'string' || key.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `reply-token: secret for keyId ${JSON.stringify(key.keyId)} must be a string of at least ${MIN_SECRET_LENGTH} chars`,
      )
    }
    if (seen.has(key.keyId)) {
      throw new Error(`reply-token: duplicate keyId ${JSON.stringify(key.keyId)} in keyring`)
    }
    seen.add(key.keyId)
  }
}
