/**
 * Marketplace-specific adapter (HT-116) — the ONLY place `catalogOrigin`
 * and the license-key header live. Everything downstream of this module
 * (`verify-core.ts`, `src/modules/artifact/**`) knows nothing about
 * marketplace.helpthread.app; it only knows bytes, manifests, and
 * signatures. Keeping the marketplace-shaped types here means a second
 * catalog (a self-hosted one, a future v2 API) is a second file, not a
 * rewrite of the verifier.
 *
 * Every network call takes an injectable `fetch`-like function so callers
 * (and tests) never need a live network.
 */

export const DEFAULT_CATALOG_ORIGIN = 'https://marketplace.helpthread.app'

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
  /**
   * Optional streaming body. When present, {@link fetchTarball} reads it
   * incrementally so the size cap is enforced as bytes arrive, never
   * after the whole body is already in memory. Typed as `unknown` because
   * the two shapes real callers hand in are not related by a common TS
   * interface: Node's global `fetch` supplies a web `ReadableStream`
   * (which DOES support `for await`  at runtime via `Symbol.asyncIterator`,
   * despite `lib.dom.d.ts` not declaring it), while a test double may
   * supply a plain `AsyncIterable`. `fetchTarball` feature-detects at
   * runtime rather than the type system picking one shape and rejecting
   * the other. Real `fetch` always provides this; a test double may omit
   * it and fall back to `arrayBuffer()`.
   */
  body?: unknown
  headers?: { get(name: string): string | null }
}>

/** One published version of a catalog module, as `GET /api/v1/modules` returns it. */
export interface CatalogModuleVersion {
  version: string
  checksumSha256: string
  publishedAt: string
  /** The release manifest, JSON-encoded as a string (not a nested object) — this is exactly how the live endpoint returns it. */
  manifest: string
  manifestSignature: string
  manifestKeyId: string
  minEngineApi: string
  yanked?: boolean
}

/** One module in the catalog, as `GET /api/v1/modules` returns it. */
export interface CatalogModule {
  slug: string
  name: string
  summary: string
  cluster: string
  latestVersion: string
  changelogUrl: string
  priceUsd: number
  billingInterval: string
  docsUrl: string
  versions: CatalogModuleVersion[]
}

export interface CatalogResponse {
  generatedAt: string
  modules: CatalogModule[]
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogError'
  }
}

/**
 * Validate that `body` has the shape {@link CatalogResponse} requires
 * before any caller trusts it. A cast (`as CatalogResponse`) lets a
 * malformed or unexpected response body — an HTML error page, a truncated
 * JSON object, a future-shaped API — flow silently into `findModule` and
 * `resolveVersion`, which then fail with confusing errors far from the
 * actual cause. Failing here, at the boundary, names the real problem.
 */
function assertCatalogResponse(body: unknown): asserts body is CatalogResponse {
  if (
    typeof body !== 'object' ||
    body === null ||
    !Array.isArray((body as { modules?: unknown }).modules)
  ) {
    throw new CatalogError(
      "catalog response is malformed: expected an object with a 'modules' array",
    )
  }
  for (const mod of (body as { modules: unknown[] }).modules) {
    if (
      typeof mod !== 'object' ||
      mod === null ||
      typeof (mod as { slug?: unknown }).slug !== 'string' ||
      !Array.isArray((mod as { versions?: unknown }).versions)
    ) {
      throw new CatalogError(
        "catalog response is malformed: a module entry is missing a string 'slug' or array 'versions'",
      )
    }
  }
}

/** GET `{catalogOrigin}/api/v1/modules`. */
export async function fetchCatalog(
  catalogOrigin: string,
  fetchImpl: FetchLike,
): Promise<CatalogResponse> {
  const res = await fetchImpl(`${catalogOrigin}/api/v1/modules`)
  if (!res.ok) {
    throw new CatalogError(`catalog request failed: HTTP ${res.status}`)
  }
  const body = await res.json()
  assertCatalogResponse(body)
  return body
}

/** Find a module by slug, or `undefined`. */
export function findModule(catalog: CatalogResponse, slug: string): CatalogModule | undefined {
  return catalog.modules.find((m) => m.slug === slug)
}

/** Compare two `x.y.z` semver strings. Returns >0 if `a` is newer, <0 if older, 0 if equal. Non-numeric or malformed segments sort as 0, which is a reasonable fallback for a comparison that only needs to pick "latest" among well-formed catalog entries. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0)
  const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Resolve which version of `module` to install: `requestedVersion` if
 * given (must exist in the catalog; pinning is explicit operator intent,
 * so a yanked pin is honored, not silently refused — the caller decides
 * whether to warn), otherwise the highest-semver version with
 * `yanked !== true`.
 */
export function resolveVersion(
  module: CatalogModule,
  requestedVersion?: string,
): CatalogModuleVersion {
  if (requestedVersion) {
    const found = module.versions.find((v) => v.version === requestedVersion)
    if (!found) {
      throw new CatalogError(
        `module '${module.slug}' has no published version '${requestedVersion}'`,
      )
    }
    return found
  }

  const candidates = module.versions.filter((v) => v.yanked !== true)
  if (candidates.length === 0) {
    throw new CatalogError(`module '${module.slug}' has no non-yanked published version`)
  }
  return candidates.reduce((latest, v) =>
    compareSemver(v.version, latest.version) > 0 ? v : latest,
  )
}

/** The marketplace's signed-download response, confirmed against the service's own handler: `{version, downloadUrl, expiresAt, checksumSha256}`. Only `downloadUrl` and `version` are consumed here; the artifact's integrity comes from the signed manifest, never from fields in this response. */
export interface DownloadResponse {
  downloadUrl: string
  /**
   * The version the marketplace actually served, which is NOT always the
   * one requested: entitlement can resolve to an older version (a lapsed
   * license is served the version its snapshot names). Optional here so a
   * catalog that omits it degrades to the requested version rather than
   * failing — `install` treats it as authoritative when present, purely so
   * the message it prints is accurate. Verified against the real endpoint's
   * response shape (`{version, downloadUrl, expiresAt, checksumSha256}`).
   */
  version?: string
  expiresAt?: string
  checksumSha256?: string
}

/**
 * POST `{catalogOrigin}/api/v1/download` with the license key as a bearer
 * token, naming the module and version. Returns the signed download URL
 * on success. On a non-2xx response, throws using ONLY the status and a
 * pattern-checked error CODE from the body — never the server's own
 * message text; see the comment at that branch for why this request in
 * particular must not echo remote strings.
 */
export async function requestDownloadUrl(
  catalogOrigin: string,
  fetchImpl: FetchLike,
  licenseKey: string,
  moduleSlug: string,
  version: string,
): Promise<DownloadResponse> {
  const res = await fetchImpl(`${catalogOrigin}/api/v1/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${licenseKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ module: moduleSlug, version }),
  })
  if (!res.ok) {
    // Only the CODE is taken from the response, never the message. This is
    // the one request that carries the license key, and the server fully
    // controls its own error body — a compromised or hostile marketplace
    // could echo the key back inside `error.message`, which would then be
    // printed to the terminal and into any shell transcript or CI log. The
    // code is a short machine token from a known vocabulary; the
    // human-readable text is generated locally instead.
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: { code?: string } }
      const code = body?.error?.code
      if (typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code)) {
        detail = `${detail} (${code})`
      }
    } catch {
      // Non-JSON error body — fall back to the bare status.
    }
    throw new CatalogError(
      `download request failed: ${detail}. A 401 usually means the license key was rejected; a 410 means that release was yanked.`,
    )
  }
  const body = await res.json()
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { downloadUrl?: unknown }).downloadUrl !== 'string' ||
    (body as { downloadUrl: string }).downloadUrl.trim() === ''
  ) {
    // Without this check a missing/empty `downloadUrl` flows straight into
    // `fetchTarball`, which then requests the literal string "undefined" —
    // a failure whose real cause (a malformed marketplace response) is
    // nowhere near the resulting error message.
    throw new CatalogError(
      "download response is malformed: expected a non-empty string 'downloadUrl'",
    )
  }
  return body as DownloadResponse
}

/**
 * Hard ceiling on a downloaded artifact, enforced locally rather than
 * trusted from `Content-Length` (which the server also controls). Without
 * it, a hostile or compromised signed-URL host can exhaust memory with an
 * endless response body long before any digest or signature check runs —
 * verification cannot protect a process that already died reading the
 * input. 64 MiB is ~700x the current reference module and still far below
 * anything that threatens a laptop.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

/**
 * Runtime feature-detection for a fetch response body: accepts either a
 * plain `AsyncIterable<Uint8Array>` (what a test double supplies) or a
 * web `ReadableStream<Uint8Array>` (what Node's global `fetch` actually
 * returns) — both support `for await`, but only the former is declared
 * `AsyncIterable` in `lib.dom.d.ts`, so this narrows by checking for
 * `Symbol.asyncIterator` at runtime rather than by static type.
 */
function asAsyncIterable(body: unknown): AsyncIterable<Uint8Array> | null {
  if (body != null && typeof body === 'object' && Symbol.asyncIterator in body) {
    return body as AsyncIterable<Uint8Array>
  }
  return null
}

/**
 * GET the signed URL a successful `requestDownloadUrl` returned, and
 * return the raw tarball bytes, refusing anything over
 * {@link MAX_ARTIFACT_BYTES}.
 *
 * The cap is enforced against the running total as chunks arrive, not
 * against the fully-buffered result — a hostile or compromised signed-URL
 * host can otherwise exhaust memory with an oversized or endless body long
 * before a post-hoc length check ever runs. `Content-Length` is used only
 * as an early, best-effort reject (the server also controls that header,
 * so it is never trusted on its own); the byte-by-byte check as the body
 * streams in is the actual cap.
 */
export async function fetchTarball(url: string, fetchImpl: FetchLike): Promise<Buffer> {
  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new CatalogError(`tarball download failed: HTTP ${res.status}`)
  }

  const contentLengthHeader = res.headers?.get('content-length')
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10)
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
      throw new CatalogError(
        `refusing the download: declared Content-Length ${declared} bytes exceeds the ${MAX_ARTIFACT_BYTES}-byte ceiling for a module artifact.`,
      )
    }
  }

  const iterableBody = asAsyncIterable(res.body)
  if (iterableBody != null) {
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const chunk of iterableBody) {
      total += chunk.byteLength
      if (total > MAX_ARTIFACT_BYTES) {
        throw new CatalogError(
          `refusing the download: exceeded the ${MAX_ARTIFACT_BYTES}-byte ceiling for a module artifact before the body finished.`,
        )
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)))
  }

  // No streaming body available (e.g. a test double supplying only
  // `arrayBuffer()`) — fall back to buffer-then-check. Real `fetch`
  // always provides `body`, so this path is not the production case the
  // streaming cap above protects.
  const arrayBuffer = await res.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_ARTIFACT_BYTES) {
    throw new CatalogError(
      `refusing the download: ${arrayBuffer.byteLength} bytes exceeds the ${MAX_ARTIFACT_BYTES}-byte ceiling for a module artifact.`,
    )
  }
  return Buffer.from(arrayBuffer)
}
