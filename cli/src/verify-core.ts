/**
 * Pure, offline artifact verification (HT-116) — shared by `verify` (fully
 * offline, given a tarball/manifest/signature triple) and `install` (after
 * downloading the tarball and manifest from the marketplace, before
 * extraction). No filesystem or network access happens in this module; it
 * takes bytes/strings in and returns a result, which is what makes it
 * testable without touching disk.
 */
import {
  canonicalizeManifest,
  ManifestParseError,
  type ManifestV1,
  parseManifest,
  sha256Hex,
  verifyManifestSignature,
} from '../../src/modules/artifact/index.js'

export interface VerifyOk {
  ok: true
  manifest: ManifestV1
}

export interface VerifyFailure {
  ok: false
  /** Short machine-checkable reason code, for tests and for `install` to branch on. */
  code:
    | 'manifest-parse-error'
    | 'sha256-mismatch'
    | 'size-mismatch'
    | 'untrusted-key'
    | 'bad-signature'
  /** Human-readable explanation naming exactly which check failed — this is what gets printed to the operator. */
  message: string
}

export type VerifyResult = VerifyOk | VerifyFailure

/**
 * Verify `tarballBytes` against `manifestJson` and `signatureB64url`,
 * using `trustStore` (keyId -> raw base64url ed25519 public key) as the
 * sole source of trusted keys. Checks, in order, and stops at the first
 * failure: the manifest parses; the tarball's SHA-256 matches
 * `manifest.artifactSha256`; the tarball's byte length matches
 * `manifest.artifactBytes`; `manifest.keyId` is a key this caller trusts;
 * the signature verifies against that key over the canonicalized manifest.
 */
export function verifyArtifact(
  tarballBytes: Buffer,
  manifestJson: string,
  signatureB64url: string,
  trustStore: Readonly<Record<string, string>>,
): VerifyResult {
  let manifest: ManifestV1
  try {
    manifest = parseManifest(manifestJson)
  } catch (err) {
    const message = err instanceof ManifestParseError ? err.message : String(err)
    return { ok: false, code: 'manifest-parse-error', message: `manifest is invalid: ${message}` }
  }

  const actualSha256 = sha256Hex(tarballBytes)
  if (actualSha256 !== manifest.artifactSha256) {
    return {
      ok: false,
      code: 'sha256-mismatch',
      message: `tarball SHA-256 does not match the manifest: expected ${manifest.artifactSha256}, got ${actualSha256}`,
    }
  }

  if (tarballBytes.length !== manifest.artifactBytes) {
    return {
      ok: false,
      code: 'size-mismatch',
      message: `tarball size does not match the manifest: expected ${manifest.artifactBytes} bytes, got ${tarballBytes.length} bytes`,
    }
  }

  const trustedKey = trustStore[manifest.keyId]
  if (!trustedKey) {
    return {
      ok: false,
      code: 'untrusted-key',
      message: `manifest was signed with keyId '${manifest.keyId}', which this CLI does not trust`,
    }
  }

  const canonical = canonicalizeManifest(manifest)
  if (!verifyManifestSignature(canonical, signatureB64url, trustedKey)) {
    return {
      ok: false,
      code: 'bad-signature',
      message: `manifest signature does not verify against the trusted key for '${manifest.keyId}'`,
    }
  }

  return { ok: true, manifest }
}
