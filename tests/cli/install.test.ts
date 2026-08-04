/**
 * Orchestration tests for `runInstall` (HT-116). Uses a fake `fetchImpl`
 * (no network) and a locally generated ed25519 test keypair injected via
 * `deps.trustStore` — the real `riq-2026` private key lives only with the
 * publisher and is never available to this repo, so a full success-path
 * test necessarily signs its own fixture manifest. Filesystem access is
 * real (a temp directory per test), which is not "network" and keeps the
 * test honest about actually extracting files.
 */
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CatalogResponse, FetchLike } from '../../cli/src/catalog.js'
import { InstallError, runInstall } from '../../cli/src/install.js'
import { canonicalizeManifest, sha256Hex } from '../../src/modules/artifact/index.js'
import { buildTarGz, regularFile } from '../modules/artifact/tar-helpers.js'

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

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buf.byteLength)
  copy.set(buf)
  return copy.buffer
}

function fakeFetch(
  handlers: Record<
    string,
    (init?: Parameters<FetchLike>[1]) => {
      ok: boolean
      status: number
      json?: unknown
      arrayBuffer?: ArrayBuffer
    }
  >,
): FetchLike {
  return async (url, init) => {
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected fetch to ${url}`)
    const result = handler(init)
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.json,
      arrayBuffer: async () => result.arrayBuffer ?? new ArrayBuffer(0),
    }
  }
}

let workDir: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht116-install-'))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('runInstall: full success path (fake catalog + locally-signed fixture artifact)', () => {
  it('downloads, verifies, extracts, and prints the env summary', async () => {
    const keypair = makeTestKeypair()
    const tarball = buildTarGz([
      regularFile(
        'module.config.json',
        JSON.stringify({
          schemaVersion: 1,
          module: 'fixture-module',
          env: [
            {
              name: 'OPERATOR_KEY',
              required: true,
              sensitive: true,
              owner: 'operator-managed',
              description: 'A key the operator supplies.',
            },
            {
              name: 'ENGINE_TOKEN',
              required: true,
              sensitive: true,
              owner: 'engine-managed',
              description: 'A token the engine mints.',
            },
          ],
        }),
      ),
      regularFile('index.js', 'console.log("hi")'),
    ])
    const sha256 = sha256Hex(tarball)
    const manifest = canonicalizeManifest({
      schema: 'helpthread-module-manifest/1',
      module: 'fixture-module',
      semver: '1.0.0',
      artifactSha256: sha256,
      artifactBytes: tarball.length,
      sourceRevision: 'abc1234',
      minEngineApi: '1.0.0',
      builtAt: '2026-08-04T00:00:00.000Z',
      keyId: keypair.keyId,
    })
    const signature = keypair.sign(manifest)

    const catalog: CatalogResponse = {
      generatedAt: '2026-08-04T00:00:00.000Z',
      modules: [
        {
          slug: 'fixture-module',
          name: 'Fixture Module',
          summary: 'test',
          cluster: 'test',
          latestVersion: '1.0.0',
          changelogUrl: 'https://example.test/changelog',
          priceUsd: 0,
          billingInterval: 'year',
          docsUrl: 'https://example.test/docs',
          versions: [
            {
              version: '1.0.0',
              checksumSha256: sha256,
              publishedAt: '2026-08-04T00:00:00.000Z',
              manifest,
              manifestSignature: signature,
              manifestKeyId: keypair.keyId,
              minEngineApi: '1.0.0',
              yanked: false,
            },
          ],
        },
      ],
    }

    const fetchImpl = fakeFetch({
      'https://catalog.example/api/v1/modules': () => ({ ok: true, status: 200, json: catalog }),
      'https://catalog.example/api/v1/download': () => ({
        ok: true,
        status: 200,
        json: { downloadUrl: 'https://signed.example/fixture-module-1.0.0.tar.gz' },
      }),
      'https://signed.example/fixture-module-1.0.0.tar.gz': () => ({
        ok: true,
        status: 200,
        arrayBuffer: toArrayBuffer(tarball),
      }),
    })

    const logs: string[] = []
    const destDir = path.join(workDir, 'fixture-module')

    await runInstall(
      {
        help: false,
        moduleSlug: 'fixture-module',
        catalogOrigin: 'https://catalog.example',
        version: undefined,
        dir: destDir,
        force: false,
      },
      {
        fetchImpl,
        getLicenseKey: async () => 'unused-because-env-var-set',
        log: (line) => logs.push(line),
        trustStore: { [keypair.keyId]: keypair.publicKeyB64url },
      },
    )

    expect(fs.existsSync(path.join(destDir, 'module.config.json'))).toBe(true)
    expect(fs.existsSync(path.join(destDir, 'index.js'))).toBe(true)
    const printed = logs.join('\n')
    expect(printed).toContain('You supply these:')
    expect(printed).toContain('OPERATOR_KEY')
    expect(printed).toContain('ENGINE_TOKEN')
    expect(printed).toContain('vercel deploy --prebuilt')
  })
})

describe('runInstall: failure paths', () => {
  const emptyCatalog: CatalogResponse = { generatedAt: 'x', modules: [] }

  it('fails cleanly when the module is not found in the catalog', async () => {
    const fetchImpl = fakeFetch({
      'https://catalog.example/api/v1/modules': () => ({
        ok: true,
        status: 200,
        json: emptyCatalog,
      }),
    })
    await expect(
      runInstall(
        {
          help: false,
          moduleSlug: 'nonexistent',
          catalogOrigin: 'https://catalog.example',
          version: undefined,
          dir: path.join(workDir, 'nonexistent'),
          force: false,
        },
        { fetchImpl, getLicenseKey: async () => 'k', log: () => {} },
      ),
    ).rejects.toThrow(InstallError)
  })

  it('fails cleanly and never logs the license key when the download is unauthorized', async () => {
    const catalog: CatalogResponse = {
      generatedAt: 'x',
      modules: [
        {
          slug: 'fixture-module',
          name: 'Fixture',
          summary: 'x',
          cluster: 'x',
          latestVersion: '1.0.0',
          changelogUrl: 'x',
          priceUsd: 0,
          billingInterval: 'year',
          docsUrl: 'x',
          versions: [
            {
              version: '1.0.0',
              checksumSha256: 'x',
              publishedAt: 'x',
              manifest: '{}',
              manifestSignature: 'x',
              manifestKeyId: 'riq-2026',
              minEngineApi: '1.0.0',
              yanked: false,
            },
          ],
        },
      ],
    }
    const fetchImpl = fakeFetch({
      'https://catalog.example/api/v1/modules': () => ({ ok: true, status: 200, json: catalog }),
      'https://catalog.example/api/v1/download': () => ({
        ok: false,
        status: 401,
        json: { error: { code: 'unauthorized', message: 'Missing or invalid license key.' } },
      }),
    })
    const logs: string[] = []
    await expect(
      runInstall(
        {
          help: false,
          moduleSlug: 'fixture-module',
          catalogOrigin: 'https://catalog.example',
          version: undefined,
          dir: path.join(workDir, 'fixture-module'),
          force: false,
        },
        {
          fetchImpl,
          getLicenseKey: async () => 'super-secret-license-key',
          log: (l) => logs.push(l),
        },
      ),
    ).rejects.toThrow(/download request failed/)
    expect(logs.join('\n')).not.toContain('super-secret-license-key')
  })

  it('refuses to extract into a non-empty destination without --force', async () => {
    const destDir = path.join(workDir, 'occupied')
    fs.mkdirSync(destDir)
    fs.writeFileSync(path.join(destDir, 'existing.txt'), 'already here')

    const keypair = makeTestKeypair()
    const tarball = buildTarGz([
      regularFile('module.config.json', '{"schemaVersion":1,"module":"m","env":[]}'),
    ])
    const sha256 = sha256Hex(tarball)
    const manifest = canonicalizeManifest({
      schema: 'helpthread-module-manifest/1',
      module: 'fixture-module',
      semver: '1.0.0',
      artifactSha256: sha256,
      artifactBytes: tarball.length,
      sourceRevision: 'abc1234',
      minEngineApi: '1.0.0',
      builtAt: '2026-08-04T00:00:00.000Z',
      keyId: keypair.keyId,
    })
    const signature = keypair.sign(manifest)
    const catalog: CatalogResponse = {
      generatedAt: 'x',
      modules: [
        {
          slug: 'fixture-module',
          name: 'Fixture',
          summary: 'x',
          cluster: 'x',
          latestVersion: '1.0.0',
          changelogUrl: 'x',
          priceUsd: 0,
          billingInterval: 'year',
          docsUrl: 'x',
          versions: [
            {
              version: '1.0.0',
              checksumSha256: sha256,
              publishedAt: 'x',
              manifest,
              manifestSignature: signature,
              manifestKeyId: keypair.keyId,
              minEngineApi: '1.0.0',
              yanked: false,
            },
          ],
        },
      ],
    }
    const fetchImpl = fakeFetch({
      'https://catalog.example/api/v1/modules': () => ({ ok: true, status: 200, json: catalog }),
      'https://catalog.example/api/v1/download': () => ({
        ok: true,
        status: 200,
        json: { downloadUrl: 'https://signed.example/x.tar.gz' },
      }),
      'https://signed.example/x.tar.gz': () => ({
        ok: true,
        status: 200,
        arrayBuffer: toArrayBuffer(tarball),
      }),
    })

    await expect(
      runInstall(
        {
          help: false,
          moduleSlug: 'fixture-module',
          catalogOrigin: 'https://catalog.example',
          version: undefined,
          dir: destDir,
          force: false,
        },
        {
          fetchImpl,
          getLicenseKey: async () => 'k',
          log: () => {},
          trustStore: { [keypair.keyId]: keypair.publicKeyB64url },
        },
      ),
    ).rejects.toThrow(/already exists and is not empty/)
    // The pre-existing file must survive an aborted install.
    expect(fs.existsSync(path.join(destDir, 'existing.txt'))).toBe(true)
  })
})

describe('runInstall: the marketplace decides which version you get', () => {
  /**
   * Entitlement, not the requested version, determines what is served: a
   * lapsed license receives the version its snapshot names. The CLI must
   * verify the bytes against THAT version's manifest. Verifying the
   * requested version's manifest instead fails the digest check and blames
   * the artifact ("tarball does not match its manifest") for what is an
   * ordinary licensing outcome — alarming, and wrong.
   */
  it('verifies against the SERVED version when it differs from the one requested', async () => {
    const keypair = makeTestKeypair()

    // Two real, separately-signed releases. Only the OLD one's bytes are
    // ever served — as a lapsed license would receive.
    const oldTarball = buildTarGz([
      regularFile(
        'module.config.json',
        JSON.stringify({
          schemaVersion: 1,
          module: 'fixture-module',
          env: [
            {
              name: 'OPERATOR_KEY',
              required: true,
              sensitive: true,
              owner: 'operator-managed',
              description: 'supplied by you',
            },
          ],
        }),
      ),
      regularFile('index.js', 'console.log("old")'),
    ])
    const newTarball = buildTarGz([regularFile('index.js', 'console.log("new")')])

    const manifestFor = (tarball: Buffer, semver: string): string =>
      canonicalizeManifest({
        schema: 'helpthread-module-manifest/1',
        module: 'fixture-module',
        semver,
        artifactSha256: sha256Hex(tarball),
        artifactBytes: tarball.length,
        sourceRevision: 'abc1234',
        minEngineApi: '1.0.0',
        builtAt: '2026-08-04T00:00:00.000Z',
        keyId: keypair.keyId,
      })

    const oldManifest = manifestFor(oldTarball, '1.0.0')
    const newManifest = manifestFor(newTarball, '2.0.0')

    const versionEntry = (semver: string, tarball: Buffer, manifest: string) => ({
      version: semver,
      checksumSha256: sha256Hex(tarball),
      publishedAt: '2026-08-04T00:00:00.000Z',
      manifest,
      manifestSignature: keypair.sign(manifest),
      manifestKeyId: keypair.keyId,
      minEngineApi: '1.0.0',
      yanked: false,
    })

    const catalog: CatalogResponse = {
      generatedAt: '2026-08-04T00:00:00.000Z',
      modules: [
        {
          slug: 'fixture-module',
          name: 'Fixture Module',
          summary: 'test',
          cluster: 'test',
          latestVersion: '2.0.0',
          changelogUrl: 'https://example.test/changelog',
          priceUsd: 0,
          billingInterval: 'year',
          docsUrl: 'https://example.test/docs',
          versions: [
            versionEntry('2.0.0', newTarball, newManifest),
            versionEntry('1.0.0', oldTarball, oldManifest),
          ],
        },
      ],
    }

    const fetchImpl = fakeFetch({
      'https://catalog.example/api/v1/modules': () => ({ ok: true, status: 200, json: catalog }),
      // Asked for latest (2.0.0); entitlement serves 1.0.0.
      'https://catalog.example/api/v1/download': () => ({
        ok: true,
        status: 200,
        json: { downloadUrl: 'https://signed.example/old.tar.gz', version: '1.0.0' },
      }),
      'https://signed.example/old.tar.gz': () => ({
        ok: true,
        status: 200,
        arrayBuffer: toArrayBuffer(oldTarball),
      }),
    })

    const logs: string[] = []
    const destDir = path.join(workDir, 'served-version')

    await runInstall(
      {
        help: false,
        moduleSlug: 'fixture-module',
        catalogOrigin: 'https://catalog.example',
        version: undefined,
        dir: destDir,
        force: false,
      },
      {
        fetchImpl,
        getLicenseKey: async () => 'unused',
        log: (line) => logs.push(line),
        trustStore: { [keypair.keyId]: keypair.publicKeyB64url },
      },
    )

    // It installed, rather than failing a digest check against 2.0.0's manifest.
    expect(fs.readFileSync(path.join(destDir, 'index.js'), 'utf8')).toContain('old')
    const printed = logs.join('\n')
    expect(printed).toContain('entitles you to 1.0.0')
  })
})
