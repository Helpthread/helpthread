import { describe, expect, it } from 'vitest'
import {
  CatalogError,
  type CatalogResponse,
  compareSemver,
  type FetchLike,
  fetchCatalog,
  fetchTarball,
  findModule,
  requestDownloadUrl,
  resolveVersion,
} from '../../cli/src/catalog.js'

function fakeFetch(
  handler: (
    url: string,
    init?: Parameters<FetchLike>[1],
  ) => {
    ok: boolean
    status: number
    json?: unknown
    arrayBuffer?: ArrayBuffer
  },
): FetchLike {
  return async (url, init) => {
    const result = handler(url, init)
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.json,
      arrayBuffer: async () => result.arrayBuffer ?? new ArrayBuffer(0),
    }
  }
}

const SAMPLE_CATALOG: CatalogResponse = {
  generatedAt: '2026-08-04T00:00:00.000Z',
  modules: [
    {
      slug: 'draft-assistant',
      name: 'Draft Assistant',
      summary: 'AI-drafted replies.',
      cluster: 'AI & automation',
      latestVersion: '0.3.0',
      changelogUrl: 'https://example.test/changelog',
      priceUsd: 249,
      billingInterval: 'year',
      docsUrl: 'https://example.test/docs',
      versions: [
        {
          version: '0.3.0',
          checksumSha256: 'aaaa',
          publishedAt: '2026-08-04T01:25:02.506Z',
          manifest: '{"module":"draft-assistant"}',
          manifestSignature: 'sig-0.3.0',
          manifestKeyId: 'riq-2026',
          minEngineApi: '1.0.0',
          yanked: false,
        },
        {
          version: '0.2.5',
          checksumSha256: 'bbbb',
          publishedAt: '2026-08-01T00:00:00.000Z',
          manifest: '{"module":"draft-assistant"}',
          manifestSignature: 'sig-0.2.5',
          manifestKeyId: 'riq-2026',
          minEngineApi: '1.0.0',
          yanked: true,
        },
        {
          version: '0.2.0',
          checksumSha256: 'cccc',
          publishedAt: '2026-07-15T00:00:00.000Z',
          manifest: '{"module":"draft-assistant"}',
          manifestSignature: 'sig-0.2.0',
          manifestKeyId: 'riq-2026',
          minEngineApi: '1.0.0',
          yanked: false,
        },
      ],
    },
  ],
}

describe('fetchCatalog', () => {
  it('GETs /api/v1/modules and returns the parsed body', async () => {
    let calledUrl: string | undefined
    const fetchImpl = fakeFetch((url) => {
      calledUrl = url
      return { ok: true, status: 200, json: SAMPLE_CATALOG }
    })
    const result = await fetchCatalog('https://marketplace.example', fetchImpl)
    expect(calledUrl).toBe('https://marketplace.example/api/v1/modules')
    expect(result).toEqual(SAMPLE_CATALOG)
  })

  it('throws CatalogError on a non-ok response', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 500 }))
    await expect(fetchCatalog('https://marketplace.example', fetchImpl)).rejects.toThrow(
      CatalogError,
    )
  })
})

describe('findModule', () => {
  it('finds an existing module by slug', () => {
    expect(findModule(SAMPLE_CATALOG, 'draft-assistant')?.name).toBe('Draft Assistant')
  })

  it('returns undefined for an unknown slug', () => {
    expect(findModule(SAMPLE_CATALOG, 'nonexistent')).toBeUndefined()
  })
})

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareSemver('0.3.0', '0.2.5')).toBeGreaterThan(0)
    expect(compareSemver('0.2.5', '0.2.10')).toBeLessThan(0)
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0)
  })
})

describe('resolveVersion', () => {
  const mod = SAMPLE_CATALOG.modules[0]

  it('picks the highest-semver non-yanked version when unpinned', () => {
    // 0.3.0 is highest overall but 0.2.5 (also non-latest) is yanked;
    // the correct pick is the highest NON-YANKED, which is 0.3.0 here
    // since 0.3.0 itself is not yanked.
    expect(resolveVersion(mod).version).toBe('0.3.0')
  })

  it('skips a yanked latest version and falls back to the highest non-yanked one', () => {
    const modWithYankedLatest = {
      ...mod,
      versions: mod.versions.map((v) => (v.version === '0.3.0' ? { ...v, yanked: true } : v)),
    }
    expect(resolveVersion(modWithYankedLatest).version).toBe('0.2.0')
  })

  it('pins to an explicit --version even if it is yanked', () => {
    expect(resolveVersion(mod, '0.2.5').version).toBe('0.2.5')
    expect(resolveVersion(mod, '0.2.5').yanked).toBe(true)
  })

  it('throws for a version that does not exist', () => {
    expect(() => resolveVersion(mod, '9.9.9')).toThrow(CatalogError)
  })

  it('throws when every version is yanked and none is pinned', () => {
    const allYanked = { ...mod, versions: mod.versions.map((v) => ({ ...v, yanked: true })) }
    expect(() => resolveVersion(allYanked)).toThrow(/no non-yanked published version/)
  })
})

describe('requestDownloadUrl', () => {
  it('sends the license key as a Bearer token and the module/version as JSON', async () => {
    let capturedInit: Parameters<FetchLike>[1] | undefined
    let capturedUrl: string | undefined
    const fetchImpl = fakeFetch((url, init) => {
      capturedUrl = url
      capturedInit = init
      return { ok: true, status: 200, json: { downloadUrl: 'https://signed.example/x' } }
    })
    const result = await requestDownloadUrl(
      'https://marketplace.example',
      fetchImpl,
      'sk_live_secret',
      'draft-assistant',
      '0.3.0',
    )
    expect(capturedUrl).toBe('https://marketplace.example/api/v1/download')
    expect(capturedInit?.method).toBe('POST')
    expect(capturedInit?.headers?.Authorization).toBe('Bearer sk_live_secret')
    expect(JSON.parse(capturedInit?.body ?? '{}')).toEqual({
      module: 'draft-assistant',
      version: '0.3.0',
    })
    expect(result).toEqual({ downloadUrl: 'https://signed.example/x' })
  })

  it('surfaces the marketplace error message without leaking the license key', async () => {
    const fetchImpl = fakeFetch(() => ({
      ok: false,
      status: 401,
      json: { error: { code: 'unauthorized', message: 'Missing or invalid license key.' } },
    }))
    await expect(
      requestDownloadUrl(
        'https://marketplace.example',
        fetchImpl,
        'sk_super_secret_value',
        'draft-assistant',
        '0.3.0',
      ),
    ).rejects.toThrow(/unauthorized: Missing or invalid license key\./)
    try {
      await requestDownloadUrl(
        'https://marketplace.example',
        fetchImpl,
        'sk_super_secret_value',
        'draft-assistant',
        '0.3.0',
      )
    } catch (err) {
      expect(String(err)).not.toContain('sk_super_secret_value')
    }
  })
})

describe('fetchTarball', () => {
  it('returns the response bytes as a Buffer', async () => {
    const bytes = new TextEncoder().encode('hello tarball').buffer
    const fetchImpl = fakeFetch(() => ({ ok: true, status: 200, arrayBuffer: bytes }))
    const buf = await fetchTarball('https://signed.example/x', fetchImpl)
    expect(buf.toString('utf8')).toBe('hello tarball')
  })

  it('throws CatalogError on a non-ok response', async () => {
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 403 }))
    await expect(fetchTarball('https://signed.example/x', fetchImpl)).rejects.toThrow(CatalogError)
  })
})
