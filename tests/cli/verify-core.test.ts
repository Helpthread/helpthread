import { describe, expect, it } from 'vitest'
import { TRUST_STORE } from '../../cli/src/trust-store.js'
import { verifyArtifact } from '../../cli/src/verify-core.js'

// Same real, live draft-assistant 0.3.0 vectors as
// tests/modules/artifact/vectors.test.ts — exercised here through the
// CLI's own verifyArtifact wrapper (checksum + size + trust-store lookup +
// signature), not just the raw manifest verifier.
const MANIFEST_JSON =
  '{"artifactBytes":88107,"artifactSha256":"4472204cdea7864076f0c4b4f2d5c5ab47fc6e3b74d0b06856da0fa0f169bb3a","builtAt":"2026-08-04T01:24:51.266Z","keyId":"riq-2026","minEngineApi":"1.0.0","module":"draft-assistant","schema":"helpthread-module-manifest/1","semver":"0.3.0","sourceRevision":"23230a9"}'
const SIGNATURE =
  'Wrq9vMcf1cAKl0OzqSH6FYTC70ke-4HLUqCmN9mevUU4T6uSh2fbvBNsY79YM79hcnloKXoFqMfqV7nys1QeDg'

/** A buffer of the given length whose content is not the real artifact's — used to exercise the sha256 check without needing the real bytes. */
function wrongContentBuffer(length: number): Buffer {
  return Buffer.alloc(length, 0x00)
}

describe('verifyArtifact (trust-store wired through cli/src/trust-store.ts)', () => {
  it('rejects a tarball whose bytes do not hash to artifactSha256, even at the right length', () => {
    const result = verifyArtifact(wrongContentBuffer(88_107), MANIFEST_JSON, SIGNATURE, TRUST_STORE)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('sha256-mismatch')
    }
  })

  it('rejects a tarball whose byte length does not match artifactBytes, isolated from the sha256 check', () => {
    // Manifest hand-edited so artifactSha256 matches an empty buffer's
    // real hash, but artifactBytes claims 5 — isolates the size check
    // from the sha256 check (which would otherwise fail first).
    const wrongLengthManifest = MANIFEST_JSON.replace(
      '"artifactBytes":88107',
      '"artifactBytes":5',
    ).replace(
      '"artifactSha256":"4472204cdea7864076f0c4b4f2d5c5ab47fc6e3b74d0b06856da0fa0f169bb3a"',
      '"artifactSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
    )
    const result = verifyArtifact(Buffer.alloc(0), wrongLengthManifest, SIGNATURE, TRUST_STORE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('size-mismatch')
  })

  it('rejects an unparseable manifest', () => {
    const result = verifyArtifact(wrongContentBuffer(10), '{not json', SIGNATURE, TRUST_STORE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('manifest-parse-error')
  })

  it('rejects a manifest signed by a keyId this trust store does not have', () => {
    // sha256/size edited to match a real 10-zero-byte buffer, so this
    // isolates the trust-store lookup from the checksum check (which
    // would otherwise fail first and mask what's being tested).
    const untrustedKeyManifest = MANIFEST_JSON.replace(
      '"keyId":"riq-2026"',
      '"keyId":"some-other-key"',
    )
      .replace('"artifactBytes":88107', '"artifactBytes":10')
      .replace(
        '"artifactSha256":"4472204cdea7864076f0c4b4f2d5c5ab47fc6e3b74d0b06856da0fa0f169bb3a"',
        '"artifactSha256":"01d448afd928065458cf670b60f5a594d735af0172c8d67f22a81680132681ca"',
      )
    const result = verifyArtifact(
      wrongContentBuffer(10),
      untrustedKeyManifest,
      SIGNATURE,
      TRUST_STORE,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('untrusted-key')
  })

  it('rejects a bad signature against an otherwise-valid manifest for a real length/hash match', () => {
    // sha256Hex of an empty buffer, with a manifest hand-edited to match
    // it, isolates the signature check from the checksum check.
    const emptyBufferManifest = MANIFEST_JSON.replace(
      '"artifactBytes":88107',
      '"artifactBytes":0',
    ).replace(
      '"artifactSha256":"4472204cdea7864076f0c4b4f2d5c5ab47fc6e3b74d0b06856da0fa0f169bb3a"',
      '"artifactSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"',
    )
    const result = verifyArtifact(Buffer.alloc(0), emptyBufferManifest, SIGNATURE, TRUST_STORE)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('bad-signature')
  })
})
