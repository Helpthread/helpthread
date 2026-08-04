/**
 * Module release manifests: the small, canonical, ed25519-signed JSON
 * document that ties one module release's artifact bytes to the publisher
 * who built it (HT-116; see `docs/modules/README.md` for the surrounding
 * substrate this feeds into).
 *
 * ## Why a manifest, and why it is signed independently of the marketplace
 *
 * A module tarball is a proprietary paid artifact distributed through
 * marketplace.helpthread.app, but the marketplace is not trusted as the
 * root of that trust — it is a distribution channel, not an authority. The
 * publisher signs the manifest with an ed25519 key whose private half the
 * marketplace never holds; this module verifies that signature against a
 * public key pinned OUT OF BAND (the CLI's compiled-in `TRUST_STORE`, see
 * `../../../cli/src/trust-store.ts`). A fully compromised marketplace can
 * therefore serve a forged tarball, but it cannot forge a manifest that
 * verifies against the pinned key — the attacker would need the
 * publisher's private key, which the marketplace was never given.
 *
 * ## Canonicalization
 *
 * Ed25519 signs bytes, not JSON values, so both signer and verifier must
 * agree byte-for-byte on what "the manifest" means as a string.
 * {@link canonicalizeManifest} fixes that: object keys sorted lexicographically,
 * no insignificant whitespace, UTF-8. `JSON.stringify` on an object built by
 * inserting keys in sorted order already satisfies "no whitespace" and
 * "keys in that order" — there is no separate serialization step to get
 * subtly wrong.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto'

/** The one manifest schema version this module understands. A different literal is a parse error, not a silently-accepted unknown format. */
export const MANIFEST_SCHEMA = 'helpthread-module-manifest/1' as const

/** A signed module release manifest, schema version 1. Every field is required — there is no optional field, because an absent field is exactly the kind of thing a forged-but-truncated manifest would try to get away with. */
export interface ManifestV1 {
  schema: typeof MANIFEST_SCHEMA
  /** The module's catalog slug, e.g. `draft-assistant`. */
  module: string
  /** The release's semantic version, e.g. `0.3.0`. */
  semver: string
  /** Lowercase hex SHA-256 of the exact tarball bytes this manifest describes. */
  artifactSha256: string
  /** Exact byte length of the tarball this manifest describes. */
  artifactBytes: number
  /** The publisher's source-control revision the release was built from (e.g. a short git SHA) — provenance, not verified against anything at install time. */
  sourceRevision: string
  /** The minimum engine API version this release requires, semver-shaped. */
  minEngineApi: string
  /** ISO 8601 UTC instant the release was built. */
  builtAt: string
  /** Which entry of the verifier's trust store signed this manifest. */
  keyId: string
}

/** `ManifestV1`'s own keys — the single source of truth both {@link parseManifest} (what's required) and {@link canonicalizeManifest} (what's serialized) walk, so the two can never drift apart. */
const MANIFEST_KEYS = [
  'schema',
  'module',
  'semver',
  'artifactSha256',
  'artifactBytes',
  'sourceRevision',
  'minEngineApi',
  'builtAt',
  'keyId',
] as const satisfies readonly (keyof ManifestV1)[]

const STRING_KEYS = new Set<string>(MANIFEST_KEYS.filter((k) => k !== 'artifactBytes'))

/** Thrown by {@link parseManifest} — the message names the exact field and problem, since this is the first line of defense against a forged or corrupted release. */
export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestParseError'
  }
}

const ED25519_KEY_BYTES = 32
const ED25519_SIGNATURE_BYTES = 64
/** DER prefix that turns a raw 32-byte ed25519 public key into a well-formed SubjectPublicKeyInfo structure `node:crypto` will accept — the fixed ASN.1 SEQUENCE/AlgorithmIdentifier/BIT STRING header for `id-Ed25519` (RFC 8410 §4), with no parameters and a 0-padding bit on the BIT STRING. Every ed25519 raw key needs the exact same prefix; only the trailing 32 key bytes vary. */
const ED25519_SPKI_DER_PREFIX_HEX = '302a300506032b6570032100'

/**
 * Verify an ed25519 signature over `canonicalJson` (the exact string
 * {@link canonicalizeManifest} produced — this function does not
 * canonicalize for you, so callers must pass the same bytes that were
 * signed). Returns `false` — never throws — for a bad signature, a
 * malformed key, or non-canonical base64url input; a verifier's failure
 * mode should be uniform so a caller cannot accidentally treat "couldn't
 * even parse the signature" as a different, more forgiving case than
 * "parsed fine but didn't match."
 */
export function verifyManifestSignature(
  canonicalJson: string,
  signatureB64url: string,
  publicKeyRawB64url: string,
): boolean {
  let keyBytes: Buffer
  let sigBytes: Buffer
  try {
    keyBytes = decodeBase64UrlStrict(publicKeyRawB64url, ED25519_KEY_BYTES)
    sigBytes = decodeBase64UrlStrict(signatureB64url, ED25519_SIGNATURE_BYTES)
  } catch {
    return false
  }

  let publicKey: import('node:crypto').KeyObject
  try {
    const der = Buffer.concat([Buffer.from(ED25519_SPKI_DER_PREFIX_HEX, 'hex'), keyBytes])
    publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    return false
  }

  try {
    return cryptoVerify(null, Buffer.from(canonicalJson, 'utf8'), publicKey, sigBytes)
  } catch {
    return false
  }
}

/**
 * Deterministic JSON serialization of a manifest: keys sorted
 * lexicographically, no whitespace. This is the exact byte string the
 * publisher signs and this module verifies — see the module doc's
 * "Canonicalization" section for why that must be unambiguous.
 */
export function canonicalizeManifest(manifest: ManifestV1): string {
  const sorted: Record<string, unknown> = {}
  for (const key of [...MANIFEST_KEYS].sort()) {
    sorted[key] = manifest[key]
  }
  return JSON.stringify(sorted)
}

/**
 * Parse and validate a manifest JSON string into a {@link ManifestV1}.
 * Rejects: invalid JSON, a non-object top level, the wrong `schema`
 * literal, any missing key, any key with the wrong primitive type, and any
 * key not in {@link MANIFEST_KEYS} — an unknown extra field is refused
 * rather than silently ignored, because silently ignoring fields is exactly
 * how a forged manifest smuggles data past a lenient parser.
 */
export function parseManifest(json: string): ManifestV1 {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    throw new ManifestParseError(
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ManifestParseError('manifest must be a JSON object')
  }
  const obj = raw as Record<string, unknown>

  const knownKeys = new Set<string>(MANIFEST_KEYS)
  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) {
      throw new ManifestParseError(`manifest has an unknown field: '${key}'`)
    }
  }

  for (const key of MANIFEST_KEYS) {
    if (!(key in obj)) {
      throw new ManifestParseError(`manifest is missing required field: '${key}'`)
    }
    const value = obj[key]
    if (key === 'artifactBytes') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new ManifestParseError(
          `manifest field 'artifactBytes' must be a non-negative integer, got: ${JSON.stringify(value)}`,
        )
      }
    } else if (STRING_KEYS.has(key)) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new ManifestParseError(
          `manifest field '${key}' must be a non-empty string, got: ${JSON.stringify(value)}`,
        )
      }
    }
  }

  if (obj.schema !== MANIFEST_SCHEMA) {
    throw new ManifestParseError(
      `manifest field 'schema' must be '${MANIFEST_SCHEMA}', got: ${JSON.stringify(obj.schema)}`,
    )
  }

  return obj as unknown as ManifestV1
}

// --- signature verification -------------------------------------------------

/** Strict base64url alphabet — no `+`, `/`, or `=` padding, ever. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/**
 * Decode `input` as base64url, refusing anything Node's lenient decoder
 * would otherwise silently accept. `Buffer.from(x, 'base64url')` skips
 * characters outside the alphabet instead of erroring — so
 * `'!!!!' + validSignature` decodes to the SAME bytes as `validSignature`
 * and would verify. That is a real gap for a verifier whose whole job is
 * refusing forged input, so this checks three things before trusting the
 * result: the alphabet, the exact expected decoded length, and a re-encode
 * round trip (catches non-canonical encodings — e.g. a byte sequence that
 * happens to decode to the right length by luck through skipped garbage).
 */
export function decodeBase64UrlStrict(input: string, expectedByteLength: number): Buffer {
  if (!BASE64URL_RE.test(input)) {
    throw new Error('not valid base64url: contains characters outside [A-Za-z0-9_-]')
  }
  const decoded = Buffer.from(input, 'base64url')
  if (decoded.length !== expectedByteLength) {
    throw new Error(
      `base64url decodes to ${decoded.length} bytes, expected exactly ${expectedByteLength}`,
    )
  }
  if (decoded.toString('base64url') !== input) {
    throw new Error('base64url is not a canonical encoding of its decoded bytes')
  }
  return decoded
}
