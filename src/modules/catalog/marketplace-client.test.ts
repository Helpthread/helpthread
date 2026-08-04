/**
 * Tests for `downloadVerifiedArtifact` / `fetchFeed` (HT-119) — all against
 * an injected `SafeFetchFn`, zero real sockets/DNS/TLS (this ticket's
 * brief). A local ed25519 test keypair stands in for the real `riq-2026`
 * signing key (whose private half lives only with the publisher, never
 * this repo) — the same approach `tests/cli/install.test.ts` uses for the
 * CLI's equivalent tests.
 */
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalizeManifest, sha256Hex } from '../artifact/index.js'
import {
  CATALOG_ORIGIN,
  type CatalogFeed,
  type CatalogModule,
  downloadVerifiedArtifact,
  fetchFeed,
  MAX_ARTIFACT_BYTES,
  type SafeFetchFn,
} from './marketplace-client.js'

function makeTestKeypair(): {
  keyId: string
  publicKeyB64url: string
  sign: (bytes: string) => string
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  const rawPublicKey = der.subarray(der.length - 32)
  return {
    keyId: 'test-key-2026',
    publicKeyB64url: rawPublicKey.toString('base64url'),
    sign: (bytes: string) =>
      cryptoSign(null, Buffer.from(bytes, 'utf8'), privateKey).toString('base64url'),
  }
}

interface ManifestFixtureOptions {
  keyId: string
  sign: (bytes: string) => string
  module: string
  semver: string
  artifactBytes: Buffer
}

function signedManifestFixture(opts: ManifestFixtureOptions): {
  manifestJson: string
  signature: string
} {
  const manifestJson = canonicalizeManifest({
    schema: 'helpthread-module-manifest/1',
    module: opts.module,
    semver: opts.semver,
    artifactSha256: sha256Hex(opts.artifactBytes),
    artifactBytes: opts.artifactBytes.length,
    sourceRevision: 'abc1234',
    minEngineApi: '1.0.0',
    builtAt: '2026-08-04T00:00:00.000Z',
    keyId: opts.keyId,
  })
  return { manifestJson, signature: opts.sign(manifestJson) }
}

/** Builds a routed fake `SafeFetchFn` — `handlers` maps an exact URL to a canned response. */
function fakeFetch(
  handlers: Record<
    string,
    (init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }) => {
      status: number
      body: string | Buffer
    }
  >,
): SafeFetchFn {
  return async (url, init) => {
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected fetch to ${url}`)
    const result = handler(init)
    const body = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, 'utf8')
    return { status: result.status, body }
  }
}

const ARTIFACT_BYTES = Buffer.from('fixture-tarball-bytes-not-a-real-tar-gz')
const FEED_URL = `${CATALOG_ORIGIN}/api/v1/modules`
const DOWNLOAD_URL = `${CATALOG_ORIGIN}/api/v1/download`
const SIGNED_URL = 'https://cdn.example.test/signed/fixture-module-1.0.0.tar.gz'

function feedWith(module: CatalogModule): CatalogFeed {
  return { generatedAt: '2026-08-04T00:00:00.000Z', modules: [module] }
}

function catalogModule(overrides: {
  slug: string
  version: string
  manifestJson: string
  signature: string
  keyId: string
}): CatalogModule {
  return {
    slug: overrides.slug,
    name: 'Fixture Module',
    summary: 'a test fixture',
    cluster: 'test',
    latestVersion: overrides.version,
    changelogUrl: 'https://example.test/changelog',
    priceUsd: 0,
    billingInterval: 'month',
    docsUrl: 'https://example.test/docs',
    versions: [
      {
        version: overrides.version,
        checksumSha256: sha256Hex(ARTIFACT_BYTES),
        publishedAt: '2026-08-04T00:00:00.000Z',
        manifest: overrides.manifestJson,
        manifestSignature: overrides.signature,
        manifestKeyId: overrides.keyId,
        minEngineApi: '1.0.0',
      },
    ],
  }
}

describe('fetchFeed', () => {
  it('parses a successful feed response', async () => {
    const feed = feedWith(
      catalogModule({
        slug: 'fixture-module',
        version: '1.0.0',
        manifestJson: '{}',
        signature: 'x',
        keyId: 'k',
      }),
    )
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feed) }),
    })

    const result = await fetchFeed({ fetch })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.feed.modules).toHaveLength(1)
  })

  it('returns a typed failure on a non-2xx response', async () => {
    const fetch = fakeFetch({ [FEED_URL]: () => ({ status: 503, body: 'unavailable' }) })
    const result = await fetchFeed({ fetch })
    expect(result).toEqual({ ok: false, code: 'http-error', message: expect.any(String) })
  })

  it('returns a typed failure on a malformed body', async () => {
    const fetch = fakeFetch({ [FEED_URL]: () => ({ status: 200, body: 'not json' }) })
    const result = await fetchFeed({ fetch })
    expect(result).toEqual({ ok: false, code: 'invalid-response', message: expect.any(String) })
  })
})

describe('downloadVerifiedArtifact', () => {
  function setup() {
    const keypair = makeTestKeypair()
    const { manifestJson, signature } = signedManifestFixture({
      keyId: keypair.keyId,
      sign: keypair.sign,
      module: 'fixture-module',
      semver: '1.0.0',
      artifactBytes: ARTIFACT_BYTES,
    })
    const module = catalogModule({
      slug: 'fixture-module',
      version: '1.0.0',
      manifestJson,
      signature,
      keyId: keypair.keyId,
    })
    const trustStore = { [keypair.keyId]: keypair.publicKeyB64url }
    return { keypair, manifestJson, signature, module, trustStore }
  }

  it('downloads and verifies a valid, correctly-identified artifact', async () => {
    const { module, trustStore } = setup()
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feedWith(module)) }),
      [DOWNLOAD_URL]: () => ({
        status: 200,
        body: JSON.stringify({ downloadUrl: SIGNED_URL, version: '1.0.0' }),
      }),
      [SIGNED_URL]: () => ({ status: 200, body: ARTIFACT_BYTES }),
    })

    const result = await downloadVerifiedArtifact(
      { slug: 'fixture-module', version: '1.0.0' },
      { fetch, getLicenseKey: async () => 'test-license-key', trustStore },
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.manifest.module).toBe('fixture-module')
      expect(result.tarballBytes.equals(ARTIFACT_BYTES)).toBe(true)
    }
  })

  // --- identity-binding refusal: a validly-signed artifact for a
  // DIFFERENT module/version than requested must be refused -------------

  it('refuses a validly-signed manifest for a different MODULE than requested', async () => {
    const keypair = makeTestKeypair()
    const { manifestJson, signature } = signedManifestFixture({
      keyId: keypair.keyId,
      sign: keypair.sign,
      module: 'a-completely-different-module', // <- mismatch
      semver: '1.0.0',
      artifactBytes: ARTIFACT_BYTES,
    })
    const module = catalogModule({
      slug: 'fixture-module', // the catalog still lists it under the requested slug
      version: '1.0.0',
      manifestJson,
      signature,
      keyId: keypair.keyId,
    })
    const trustStore = { [keypair.keyId]: keypair.publicKeyB64url }
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feedWith(module)) }),
      [DOWNLOAD_URL]: () => ({
        status: 200,
        body: JSON.stringify({ downloadUrl: SIGNED_URL, version: '1.0.0' }),
      }),
      [SIGNED_URL]: () => ({ status: 200, body: ARTIFACT_BYTES }),
    })

    const result = await downloadVerifiedArtifact(
      { slug: 'fixture-module', version: '1.0.0' },
      { fetch, getLicenseKey: async () => 'test-license-key', trustStore },
    )

    expect(result).toMatchObject({ ok: false, code: 'identity-mismatch' })
  })

  it('refuses a validly-signed manifest for a different VERSION than requested', async () => {
    const keypair = makeTestKeypair()
    const { manifestJson, signature } = signedManifestFixture({
      keyId: keypair.keyId,
      sign: keypair.sign,
      module: 'fixture-module',
      semver: '9.9.9', // <- mismatch
      artifactBytes: ARTIFACT_BYTES,
    })
    const module = catalogModule({
      slug: 'fixture-module',
      version: '1.0.0',
      manifestJson,
      signature,
      keyId: keypair.keyId,
    })
    const trustStore = { [keypair.keyId]: keypair.publicKeyB64url }
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feedWith(module)) }),
      [DOWNLOAD_URL]: () => ({
        status: 200,
        body: JSON.stringify({ downloadUrl: SIGNED_URL, version: '1.0.0' }),
      }),
      [SIGNED_URL]: () => ({ status: 200, body: ARTIFACT_BYTES }),
    })

    const result = await downloadVerifiedArtifact(
      { slug: 'fixture-module', version: '1.0.0' },
      { fetch, getLicenseKey: async () => 'test-license-key', trustStore },
    )

    expect(result).toMatchObject({ ok: false, code: 'identity-mismatch' })
  })

  // --- digest mismatch ----------------------------------------------------

  it('refuses when the downloaded bytes do not match the manifest digest', async () => {
    const { module, trustStore } = setup()
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feedWith(module)) }),
      [DOWNLOAD_URL]: () => ({
        status: 200,
        body: JSON.stringify({ downloadUrl: SIGNED_URL, version: '1.0.0' }),
      }),
      // Wrong bytes served at the signed URL — same length, different content.
      [SIGNED_URL]: () => ({ status: 200, body: Buffer.from('fixture-tarball-bytes-TAMPERED!') }),
    })

    const result = await downloadVerifiedArtifact(
      { slug: 'fixture-module', version: '1.0.0' },
      { fetch, getLicenseKey: async () => 'test-license-key', trustStore },
    )

    expect(result).toMatchObject({ ok: false, code: 'sha256-mismatch' })
  })

  // --- size cap ------------------------------------------------------------

  it('refuses a download that exceeds the local size cap, regardless of what the server claims', async () => {
    const { module, trustStore } = setup()
    const fetch: SafeFetchFn = async (url, _init, maxBytes) => {
      if (url === FEED_URL)
        return { status: 200, body: Buffer.from(JSON.stringify(feedWith(module))) }
      if (url === DOWNLOAD_URL) {
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ downloadUrl: SIGNED_URL, version: '1.0.0' })),
        }
      }
      if (url === SIGNED_URL) {
        // Prove the cap is asserted against `maxBytes` (the ONE local
        // constant `downloadVerifiedArtifact` passes for the artifact
        // fetch) rather than trusted from anything the server claims (no
        // `Content-Length` even appears in this fake transport) — mirrors
        // `defaultSafeFetch`'s streamed byte-count enforcement without
        // allocating a real 64 MiB buffer in the test.
        expect(maxBytes).toBe(MAX_ARTIFACT_BYTES)
        throw new Error(`marketplace response exceeds the ${maxBytes}-byte cap`)
      }
      throw new Error(`unexpected fetch to ${url}`)
    }

    const result = await downloadVerifiedArtifact(
      { slug: 'fixture-module', version: '1.0.0' },
      { fetch, getLicenseKey: async () => 'test-license-key', trustStore },
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('size-cap-exceeded')
      expect(result.message).not.toContain('test-license-key')
    }
  })

  // --- license key never reaches a log/thrown error/returned object ------

  it('never lets the server-supplied error MESSAGE (which could echo the license key) reach the thrown/returned error', async () => {
    const { module, trustStore } = setup()
    const licenseKey = 'super-secret-license-key-do-not-leak'
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feedWith(module)) }),
      [DOWNLOAD_URL]: () => ({
        status: 401,
        // A hostile/compromised marketplace echoes the bearer token back in
        // the free-text message — this must never surface in the result.
        body: JSON.stringify({
          error: { code: 'invalid_license', message: `rejected key: ${licenseKey}` },
        }),
      }),
    })

    const result = await downloadVerifiedArtifact(
      { slug: 'fixture-module', version: '1.0.0' },
      { fetch, getLicenseKey: async () => licenseKey, trustStore },
    )

    expect(result.ok).toBe(false)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(licenseKey)
    if (!result.ok) {
      // The pattern-checked code IS allowed through — just never the message.
      expect(result.message).toContain('invalid_license')
    }
  })

  it('ignores a malformed/non-pattern error code from the server rather than passing it through', async () => {
    const { module, trustStore } = setup()
    const licenseKey = 'another-secret-key'
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feedWith(module)) }),
      [DOWNLOAD_URL]: () => ({
        status: 401,
        // "code" itself is used as an exfiltration attempt: it does not
        // match the strict pattern, so it must be dropped entirely.
        body: JSON.stringify({ error: { code: `leak:${licenseKey}` } }),
      }),
    })

    const result = await downloadVerifiedArtifact(
      { slug: 'fixture-module', version: '1.0.0' },
      { fetch, getLicenseKey: async () => licenseKey, trustStore },
    )

    expect(JSON.stringify(result)).not.toContain(licenseKey)
  })

  // --- catalog lookup failures ---------------------------------------------

  it('returns module-not-found when the slug is not in the feed', async () => {
    const { module, trustStore } = setup()
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feedWith(module)) }),
    })
    const result = await downloadVerifiedArtifact(
      { slug: 'nonexistent-module', version: '1.0.0' },
      { fetch, getLicenseKey: async () => 'k', trustStore },
    )
    expect(result).toMatchObject({ ok: false, code: 'module-not-found' })
  })

  it('returns version-not-found when the slug exists but the version does not', async () => {
    const { module, trustStore } = setup()
    const fetch = fakeFetch({
      [FEED_URL]: () => ({ status: 200, body: JSON.stringify(feedWith(module)) }),
    })
    const result = await downloadVerifiedArtifact(
      { slug: 'fixture-module', version: '2.0.0' },
      { fetch, getLicenseKey: async () => 'k', trustStore },
    )
    expect(result).toMatchObject({ ok: false, code: 'version-not-found' })
  })
})
