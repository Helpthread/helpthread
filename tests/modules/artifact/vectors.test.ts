/**
 * Golden conformance vectors for the manifest verifier (HT-116).
 *
 * These are literal bytes pulled from the REAL, live `draft-assistant`
 * 0.3.0 release published to marketplace.helpthread.app — not
 * hand-constructed fixtures. No network access happens in this file; the
 * point is to prove this independent verifier agrees, byte-for-byte, with
 * whatever produced these bytes (a separate implementation on the
 * marketplace side), using nothing but the values themselves.
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalizeManifest,
  decodeBase64UrlStrict,
  parseManifest,
  verifyManifestSignature,
} from '../../../src/modules/artifact/manifest.js'

/** Pinned publisher public key for `keyId: riq-2026` — raw 32 bytes, base64url. */
const RIQ_2026_PUBLIC_KEY = 'a2WwY2yYDuwNe8TxOv2dP0VfGLT9TrRfZlIXTNCXPZM'

/** Exact manifest bytes as published — this is `manifest` from the real GET /api/v1/modules response for draft-assistant@0.3.0, and matches the .manifest.json release asset byte-for-byte. */
const MANIFEST_JSON =
  '{"artifactBytes":88107,"artifactSha256":"4472204cdea7864076f0c4b4f2d5c5ab47fc6e3b74d0b06856da0fa0f169bb3a","builtAt":"2026-08-04T01:24:51.266Z","keyId":"riq-2026","minEngineApi":"1.0.0","module":"draft-assistant","schema":"helpthread-module-manifest/1","semver":"0.3.0","sourceRevision":"23230a9"}'

/** Exact signature as published (the .manifest.sig release asset), base64url. */
const SIGNATURE =
  'Wrq9vMcf1cAKl0OzqSH6FYTC70ke-4HLUqCmN9mevUU4T6uSh2fbvBNsY79YM79hcnloKXoFqMfqV7nys1QeDg'

/** A different, unrelated valid ed25519 public key (32 zero bytes re-keyed via a distinct value) — used to prove the verifier is actually checking the key, not just "some" signature shape. Generated once, not derived from anything secret. */
const UNRELATED_PUBLIC_KEY = 'H4PPwwrO5N47MpztD_ex1b6FOZhXKdhGH8yGuuI72rE'

describe('golden conformance vectors (real draft-assistant 0.3.0 release)', () => {
  it('verifies the real signature against the real pinned key', () => {
    expect(verifyManifestSignature(MANIFEST_JSON, SIGNATURE, RIQ_2026_PUBLIC_KEY)).toBe(true)
  })

  it('round-trips through parseManifest -> canonicalizeManifest byte-for-byte', () => {
    const parsed = parseManifest(MANIFEST_JSON)
    expect(canonicalizeManifest(parsed)).toBe(MANIFEST_JSON)
  })

  it('parses every field to the expected value', () => {
    const parsed = parseManifest(MANIFEST_JSON)
    expect(parsed).toEqual({
      schema: 'helpthread-module-manifest/1',
      module: 'draft-assistant',
      semver: '0.3.0',
      artifactSha256: '4472204cdea7864076f0c4b4f2d5c5ab47fc6e3b74d0b06856da0fa0f169bb3a',
      artifactBytes: 88107,
      sourceRevision: '23230a9',
      minEngineApi: '1.0.0',
      builtAt: '2026-08-04T01:24:51.266Z',
      keyId: 'riq-2026',
    })
  })

  it('rejects a manifest with one flipped byte', () => {
    // Flip the final character of sourceRevision from '9' to '8'.
    expect(MANIFEST_JSON.endsWith('"sourceRevision":"23230a9"}')).toBe(true)
    const flipped = `${MANIFEST_JSON.slice(0, -2)}8"}`
    expect(flipped).not.toBe(MANIFEST_JSON)
    expect(verifyManifestSignature(flipped, SIGNATURE, RIQ_2026_PUBLIC_KEY)).toBe(false)
  })

  it('rejects a signature corrupted with a strict-decode-breaking prefix', () => {
    // decodeBase64UrlStrict must refuse this outright (non-base64url chars),
    // not silently skip the garbage and verify against the tail.
    expect(verifyManifestSignature(MANIFEST_JSON, `!!!!${SIGNATURE}`, RIQ_2026_PUBLIC_KEY)).toBe(
      false,
    )
  })

  it('rejects the real signature against a different, unrelated valid ed25519 key', () => {
    expect(verifyManifestSignature(MANIFEST_JSON, SIGNATURE, UNRELATED_PUBLIC_KEY)).toBe(false)
  })

  it('rejects a manifest with an added unknown key', () => {
    const withExtra = MANIFEST_JSON.replace('{', '{"unexpected":"field",')
    expect(() => parseManifest(withExtra)).toThrow(/unknown field/)
  })

  it('decodeBase64UrlStrict independently confirms the key and signature decode to the expected lengths', () => {
    expect(decodeBase64UrlStrict(RIQ_2026_PUBLIC_KEY, 32).length).toBe(32)
    expect(decodeBase64UrlStrict(SIGNATURE, 64).length).toBe(64)
  })
})
