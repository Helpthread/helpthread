/**
 * Password hashing for `agent_auth_identities.secret_hash` (HT-54;
 * specs/auth/agents-and-auth.md §9).
 *
 * scrypt (`node:crypto`, no new dependency), per-identity random salt, fixed
 * explicit cost parameters. CodeQL's `js/insufficient-password-hash` rejects
 * bare SHA-256 AND keyed HMAC (learned on HT-51, where a keyed-HMAC compare
 * against a single shared operator password still tripped it) — scrypt is
 * what actually satisfies the check. Unlike HT-51 (which held a slow KDF
 * over a `crypto.timingSafeEqual`-length-blind comparison against a
 * plaintext env value, so the KDF's slowness was almost cosmetic), there is
 * now a REAL hash at rest, so the memory-hard cost genuinely matters.
 *
 * ## Encoded format
 *
 * One self-describing string, so a future cost-parameter bump never breaks
 * verifying an already-stored hash:
 *
 * ```
 * scrypt$N=16384,r=8,p=1$<salt-b64url>$<hash-b64url>
 * ```
 *
 * `decode` is TOTAL — the same totality bar `verifyReplyMessageId`
 * (`src/mail/reply-token.ts`) holds an untrusted-input parser to: a
 * malformed or corrupted `secret_hash` value must make {@link verifyPassword}
 * return `false`, never throw. A stored hash is not attacker-controlled in
 * the way a Message-ID is, but treating it as untrusted costs nothing and
 * means a DB-level corruption degrades to "this password doesn't match"
 * rather than a 500.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt cost parameter — CPU/memory cost, a power of two. Fixed and explicit (spec §9), not derived from any env. */
const SCRYPT_N = 16384
/** scrypt block size. */
const SCRYPT_R = 8
/** scrypt parallelization factor. */
const SCRYPT_P = 1
/** Derived key length, in bytes. */
const KEY_LENGTH = 32
/** Random salt length, in bytes — per-identity, generated fresh on every {@link hashPassword} call. */
const SALT_LENGTH = 16

/** Fixed literal prefix marking an encoded hash as this module's scrypt format. */
const ENCODED_PREFIX = 'scrypt'

/** The exact shape {@link encode} produces and {@link decode} parses: `scrypt$N=..,r=..,p=..$<salt>$<hash>` — four `$`-separated segments. */
const PARAMS_PATTERN = /^N=(\d+),r=(\d+),p=(\d+)$/

interface DecodedHash {
  n: number
  r: number
  p: number
  salt: Buffer
  hash: Buffer
}

/** Build the one-string encoding for a salt+hash pair, embedding the cost parameters used to produce it. */
function encode(salt: Buffer, hash: Buffer): string {
  return `${ENCODED_PREFIX}$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

/**
 * Parse an encoded hash string back into its parts. TOTAL: any deviation
 * from the exact expected shape (wrong segment count, wrong prefix,
 * malformed params, empty salt/hash, non-base64url bytes) returns `null`
 * rather than throwing — see the module doc.
 */
function decode(encoded: string): DecodedHash | null {
  if (typeof encoded !== 'string') return null
  const segments = encoded.split('$')
  if (segments.length !== 4) return null
  const [prefix, params, saltB64, hashB64] = segments
  if (prefix !== ENCODED_PREFIX) return null
  if (saltB64.length === 0 || hashB64.length === 0) return null

  const match = PARAMS_PATTERN.exec(params)
  if (match === null) return null
  const n = Number(match[1])
  const r = Number(match[2])
  const p = Number(match[3])
  if (
    !Number.isFinite(n) ||
    !Number.isFinite(p) ||
    !Number.isFinite(r) ||
    n <= 0 ||
    r <= 0 ||
    p <= 0
  ) {
    return null
  }

  // Buffer.from(..., 'base64url') never throws on arbitrary input (it
  // silently drops characters outside the alphabet) — no try/catch needed,
  // but an empty result after decoding a non-empty string still means
  // "not a real hash", guarded below.
  const salt = Buffer.from(saltB64, 'base64url')
  const hash = Buffer.from(hashB64, 'base64url')
  if (salt.length === 0 || hash.length === 0) return null

  return { n, r, p, salt, hash }
}

/**
 * Hash `password` with a freshly-generated random salt, at the fixed cost
 * parameters above. Returns the one-string encoding to store verbatim in
 * `agent_auth_identities.secret_hash`.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return encode(salt, hash)
}

/**
 * Verify `password` against a previously-{@link hashPassword}-produced
 * `encoded` string, in constant time. TOTAL over `encoded` (the module
 * doc's totality note): a malformed or corrupted value returns `false`,
 * never throws. Re-derives the hash using the cost parameters and salt
 * EMBEDDED in `encoded` — not this module's current constants — so a future
 * bump to {@link SCRYPT_N}/etc. never invalidates hashes stored under the
 * old parameters.
 */
export function verifyPassword(password: string, encoded: string): boolean {
  const decoded = decode(encoded)
  if (decoded === null) return false

  let candidate: Buffer
  try {
    // A decoded params triple that scrypt itself rejects (e.g. a corrupted
    // N that isn't a power of two, or a memory requirement past Node's
    // default maxmem) is still "not our format" in effect — caught and
    // treated as a verification failure, not a crash, preserving totality
    // over a value this module does not fully control the shape of once
    // it's round-tripped through storage.
    candidate = scryptSync(password, decoded.salt, decoded.hash.length, {
      N: decoded.n,
      r: decoded.r,
      p: decoded.p,
    })
  } catch {
    return false
  }

  if (candidate.length !== decoded.hash.length) return false
  return timingSafeEqual(candidate, decoded.hash)
}

/**
 * A real hash of a random, never-reused string, computed ONCE at module
 * load. `PasswordAuthProvider` (`src/auth/password-provider.ts`) runs
 * {@link verifyPassword} against this for an unknown email so the scrypt
 * work — and therefore the wall-clock timing — is the same whether the
 * email exists or not (spec §9's no-account-enumeration requirement).
 */
export const DUMMY_HASH: string = hashPassword(randomBytes(32).toString('base64url'))
