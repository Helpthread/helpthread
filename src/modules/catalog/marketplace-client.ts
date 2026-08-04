/**
 * The engine's own marketplace catalog client (HT-119) — fetches the
 * published module feed and downloads a verified module release artifact
 * from `marketplace.helpthread.app`, for the operator's own engine to
 * install into the operator's own Vercel account.
 *
 * This is the server-side twin of `cli/src/catalog.ts` / `cli/src/
 * verify-core.ts` (HT-116). The two are NOT the same file — `cli/` is a
 * separate workspace this module must not import from — but they exist to
 * enforce exactly the same policy, and that policy is not duplicated: this
 * module verifies artifacts using ONLY `src/modules/artifact`'s exported
 * functions (`parseManifest`, `canonicalizeManifest`,
 * `verifyManifestSignature`, `sha256Hex`), the same shared library the CLI
 * itself is built on. There is exactly one implementation of "is this
 * artifact real" in this codebase; this module and the CLI are two callers
 * of it, not two reimplementations.
 *
 * ## The origin is compiled in, not configurable
 *
 * {@link CATALOG_ORIGIN} is a literal, not read from an env var, a config
 * file, or a database row. A configurable catalog origin would let
 * WHATEVER controls that configuration point this engine's outbound,
 * license-key-bearing requests at an arbitrary host — turning a "which
 * marketplace do I use" setting into a privileged SSRF primitive with the
 * engine's own credentials attached. Pinning it in source, reviewed and
 * released the same way the rest of the engine is, closes that off
 * structurally. (This mirrors `cli/src/trust-store.ts`'s reasoning for why
 * the signing trust store must never be fetched from the network it then
 * verifies against — same shape of problem, same answer.)
 *
 * ## Every outbound call is SSRF-pinned, even to a compiled-in host
 *
 * A literal origin string still requires a DNS lookup to connect to, and
 * DNS is not trustworthy at connect time (`../../webhooks/ssrf.ts`'s module
 * doc: a hostname that resolves to a public IP when checked can resolve to
 * `127.0.0.1` moments later when connected to — DNS rebinding). Worse, the
 * signed download URL {@link requestDownloadUrl} returns is chosen by the
 * marketplace at request time, not compiled in at all — a compromised
 * marketplace could hand back a URL pointing anywhere. Every request this
 * module makes — to the compiled-in origin AND to whatever `downloadUrl`
 * the marketplace returns — goes through {@link resolveSafeAddress}'s
 * resolve-then-connect pinning, the exact posture `../../webhooks/
 * delivery.ts` already uses for webhook egress. This is the same defense
 * applied to a different privileged egress path, not a new one invented
 * for this module.
 *
 * ## Identity binding: a valid signature proves authenticity, not identity
 *
 * Every first-party module release shares the SAME publisher signing key
 * (`cli/src/trust-store.ts`'s `riq-2026` entry) — the key identifies
 * "signed by Resonant IQ," not "is the module and version you asked for."
 * A signature check alone therefore cannot catch a compromised or hostile
 * marketplace that serves a genuinely-signed manifest for a DIFFERENT
 * module (or a different, possibly vulnerable, older version) than the one
 * {@link downloadVerifiedArtifact} was asked to install — every check in
 * `verify-core.ts`'s style would pass, because the artifact really is
 * validly signed, just not the artifact that was requested. {@link
 * downloadVerifiedArtifact} closes this with an EXPLICIT extra check
 * (`identity-mismatch` below) comparing the verified manifest's own
 * `module` and `semver` fields against the slug/version the caller asked
 * for and the version the marketplace's download response says it served
 * — on top of, never instead of, the signature/digest/size checks.
 *
 * ## The license key never reaches a log, a thrown error, or a returned
 * object
 *
 * `requestDownloadUrl` is the one call that carries the license key (as a
 * Bearer token). On a non-2xx response this module takes ONLY a
 * pattern-checked machine error CODE from the response body — never the
 * server's own message text — for exactly the reason `cli/src/catalog.ts`'s
 * `requestDownloadUrl` documents: the marketplace fully controls its own
 * error body, and a compromised or hostile marketplace could echo the
 * license key back inside `error.message`, which would otherwise land in a
 * thrown `Error`'s message and from there in a log line or an operator-
 * facing error screen. The human-readable text this module produces on
 * failure is always generated locally from the status/code, never copied
 * from the server.
 */

import { request as httpsRequest } from 'node:https'
import { resolveSafeAddress, SsrfRefusedError } from '../../webhooks/ssrf.js'
import {
  canonicalizeManifest,
  ManifestParseError,
  type ManifestV1,
  parseManifest,
  sha256Hex,
  verifyManifestSignature,
} from '../artifact/index.js'

/**
 * The marketplace origin — compiled in, never configurable in v1. See the
 * module doc's "The origin is compiled in" section for why.
 */
export const CATALOG_ORIGIN = 'https://marketplace.helpthread.app' as const

/**
 * The engine's own compiled-in trust store — deliberately a SEPARATE
 * literal from `cli/src/trust-store.ts`'s (which lives in the `cli/`
 * workspace this module must not import from), but the SAME key material:
 * both pin Resonant IQ's 2026 module-signing key out of band, from the
 * publisher, never from anything network-reachable from
 * {@link CATALOG_ORIGIN}. See `cli/src/trust-store.ts`'s module doc for the
 * full "must never be read from the catalog" rationale, which applies here
 * verbatim. Rotation: add a new `keyId -> key` entry here (and to the CLI's
 * copy) and cut a new engine release; do not remove an old entry until
 * every artifact signed under it has aged out.
 */
export const TRUST_STORE: Readonly<Record<string, string>> = Object.freeze({
  'riq-2026': 'a2WwY2yYDuwNe8TxOv2dP0VfGLT9TrRfZlIXTNCXPZM',
})

// --- wire types (marketplace.helpthread.app's own shapes) ------------------

/** One published version of a catalog module, as `GET /api/v1/modules` returns it — the same shape `cli/src/catalog.ts`'s `CatalogModuleVersion` documents against the live endpoint. */
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

export interface CatalogFeed {
  generatedAt: string
  modules: CatalogModule[]
}

/** The marketplace's signed-download response: `{version, downloadUrl, expiresAt, checksumSha256}`. Only `downloadUrl` and `version` are consumed here — the artifact's integrity comes from the signed manifest, never from fields in this response. */
export interface DownloadResponse {
  downloadUrl: string
  /** The version the marketplace actually served — not always the one requested (entitlement can resolve to an older version). Used as part of the identity-binding check below when present. */
  version?: string
  expiresAt?: string
  checksumSha256?: string
}

// --- typed results -----------------------------------------------------

export interface CatalogFeedOk {
  ok: true
  feed: CatalogFeed
}

export interface CatalogFeedFailure {
  ok: false
  code: 'network-error' | 'http-error' | 'invalid-response'
  message: string
}

export type CatalogFeedResult = CatalogFeedOk | CatalogFeedFailure

export interface DownloadArtifactOk {
  ok: true
  manifest: ManifestV1
  tarballBytes: Buffer
}

export interface DownloadArtifactFailure {
  ok: false
  code:
    | 'network-error'
    | 'http-error'
    | 'module-not-found'
    | 'version-not-found'
    | 'served-version-mismatch'
    | 'size-cap-exceeded'
    | 'manifest-parse-error'
    | 'sha256-mismatch'
    | 'size-mismatch'
    | 'untrusted-key'
    | 'bad-signature'
    | 'identity-mismatch'
  message: string
}

export type DownloadArtifactResult = DownloadArtifactOk | DownloadArtifactFailure

// --- safe outbound transport (SSRF-pinned, size-capped) ---------------------

/** One HTTP response as this module's internal transport returns it — status plus the FULL body already buffered under the cap, never a stream a caller could read past it. */
interface SafeHttpResponse {
  status: number
  body: Buffer
}

/** The transport seam every outbound call in this module goes through — injectable so tests exercise feed-fetch/download/verify logic against canned responses with zero real sockets, DNS, or TLS (this ticket's brief: "injected fetch, no network"). */
export type SafeFetchFn = (
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  maxBytes: number,
) => Promise<SafeHttpResponse>

/**
 * Default {@link SafeFetchFn}: resolve-then-connect SSRF pinning
 * (`../../webhooks/ssrf.ts`, the same posture `../../webhooks/
 * delivery.ts`'s `sendWebhookRequest` already uses), `https:` only, and a
 * response body cap enforced by counting bytes AS THEY ARRIVE — never
 * trusted from `Content-Length`, which the remote end also controls and
 * which a malicious or compromised host could simply understate while
 * streaming far more. Exceeding the cap destroys the connection and
 * refuses immediately rather than buffering further.
 */
async function defaultSafeFetch(
  url: string,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  maxBytes: number,
): Promise<SafeHttpResponse> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') {
    throw new SsrfRefusedError(
      `marketplace request url must be https: — got '${parsed.protocol}//...'`,
    )
  }

  const pinned = await resolveSafeAddress(parsed.hostname)
  const bodyBuffer = init.body === undefined ? undefined : Buffer.from(init.body, 'utf8')

  return await new Promise<SafeHttpResponse>((resolve, reject) => {
    const req = httpsRequest(
      {
        method: init.method,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          ...init.headers,
          ...(bodyBuffer ? { 'Content-Length': bodyBuffer.length } : {}),
        },
        servername: parsed.hostname,
        // Resolve-then-connect pinning: hand back the already-validated
        // address regardless of what hostname Node's connector re-passes
        // in, exactly as `../../webhooks/delivery.ts`'s `sendWebhookRequest`
        // already does for webhook egress.
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === 'function') {
            ;(lookupOptions as unknown as (err: null, address: string, family: number) => void)(
              null,
              pinned.address,
              pinned.family,
            )
            return
          }
          if (lookupOptions.all) {
            callback(null, [{ address: pinned.address, family: pinned.family }])
            return
          }
          callback(null, pinned.address, pinned.family)
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > maxBytes) {
            res.destroy()
            reject(new Error(`marketplace response exceeds the ${maxBytes}-byte cap`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    if (bodyBuffer) req.write(bodyBuffer)
    req.end()
  })
}

// --- caps ----------------------------------------------------------------

/** Hard ceiling on the catalog feed response — generous for a JSON listing of every published module, refused rather than buffered further past this. */
export const MAX_FEED_RESPONSE_BYTES = 4 * 1024 * 1024
/** Hard ceiling on the `/api/v1/download` JSON response — a handful of short fields, never large. */
export const MAX_DOWNLOAD_RESPONSE_BYTES = 64 * 1024
/**
 * Hard ceiling on a downloaded artifact, enforced locally (never from
 * `Content-Length` — see {@link defaultSafeFetch}). Matches `cli/src/
 * catalog.ts`'s `MAX_ARTIFACT_BYTES` so the two callers agree on what a
 * plausible module artifact tops out at.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024

// --- feed ------------------------------------------------------------------

/**
 * GET `{CATALOG_ORIGIN}/api/v1/modules` and parse it as a {@link
 * CatalogFeed}. Returns a typed failure rather than throwing — network
 * errors, non-2xx responses, and a body that isn't the expected JSON shape
 * are all reported the same structured way this module reports every other
 * failure, never a partial/best-effort feed.
 */
export async function fetchFeed(deps: { fetch?: SafeFetchFn } = {}): Promise<CatalogFeedResult> {
  const fetchImpl = deps.fetch ?? defaultSafeFetch
  let res: SafeHttpResponse
  try {
    res = await fetchImpl(
      `${CATALOG_ORIGIN}/api/v1/modules`,
      { method: 'GET' },
      MAX_FEED_RESPONSE_BYTES,
    )
  } catch (err) {
    return {
      ok: false,
      code: 'network-error',
      message: `catalog feed request failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (res.status < 200 || res.status >= 300) {
    return {
      ok: false,
      code: 'http-error',
      message: `catalog feed request failed: HTTP ${res.status}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(res.body.toString('utf8'))
  } catch {
    return {
      ok: false,
      code: 'invalid-response',
      message: 'catalog feed response is not valid JSON',
    }
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { modules?: unknown }).modules)
  ) {
    return {
      ok: false,
      code: 'invalid-response',
      message: "catalog feed response is missing a 'modules' array",
    }
  }
  return { ok: true, feed: parsed as CatalogFeed }
}

// --- download + verify ------------------------------------------------------

/** Pattern for a machine-readable error code in a marketplace error body — see the module doc's "license key never reaches a thrown error" section for why ONLY this, never the body's message text, is trusted. */
const ERROR_CODE_RE = /^[a-z0-9_]{1,64}$/

/**
 * POST `{CATALOG_ORIGIN}/api/v1/download` with `licenseKey` as the Bearer
 * token, naming `slug`/`version`. On a non-2xx response, the thrown error's
 * message contains ONLY the HTTP status and, if present, a
 * pattern-checked short error CODE from the JSON body — never the body's
 * free-text message, which the marketplace fully controls and could use to
 * exfiltrate the license key back into a log or error screen (module doc).
 */
async function requestDownloadUrl(
  fetchImpl: SafeFetchFn,
  licenseKey: string,
  slug: string,
  version: string,
): Promise<{ ok: true; response: DownloadResponse } | { ok: false; message: string }> {
  let res: SafeHttpResponse
  try {
    res = await fetchImpl(
      `${CATALOG_ORIGIN}/api/v1/download`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${licenseKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: slug, version }),
      },
      MAX_DOWNLOAD_RESPONSE_BYTES,
    )
  } catch (err) {
    // Network-layer failures (DNS, TCP, TLS, the cap in `defaultSafeFetch`)
    // never carry server-supplied text — `err.message` here is either
    // Node's own transport error or this module's own cap message, neither
    // of which can contain the license key.
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
  if (res.status < 200 || res.status >= 300) {
    let detail = `HTTP ${res.status}`
    try {
      const body = JSON.parse(res.body.toString('utf8')) as { error?: { code?: string } }
      const code = body?.error?.code
      if (typeof code === 'string' && ERROR_CODE_RE.test(code)) {
        detail = `${detail} (${code})`
      }
    } catch {
      // Non-JSON error body — fall back to the bare status, still never
      // the raw body text.
    }
    return { ok: false, message: detail }
  }
  try {
    return { ok: true, response: JSON.parse(res.body.toString('utf8')) as DownloadResponse }
  } catch {
    return { ok: false, message: 'download response is not valid JSON' }
  }
}

/**
 * Fetch the feed entry for `{slug, version}`, request a signed download URL
 * (the license key as Bearer), download the tarball under a locally
 * enforced size cap, and verify it — digest, byte length, signature
 * against {@link TRUST_STORE}, AND that the verified manifest's own
 * `module`/`semver` match what was requested and what the marketplace's
 * download response says it served (module doc's "Identity binding"
 * section). Stops at the first failure and returns a typed result; never a
 * partial success.
 */
export async function downloadVerifiedArtifact(
  params: { slug: string; version: string },
  deps: {
    fetch?: SafeFetchFn
    getLicenseKey: () => Promise<string | null>
    /** Overrides {@link TRUST_STORE} — test-only seam, so a test can verify against a locally generated ed25519 keypair instead of the real `riq-2026` key (whose private half lives only with the publisher, never this repo — same reasoning as `cli/src/install.ts`'s own `trustStore` injection). */
    trustStore?: Readonly<Record<string, string>>
  },
): Promise<DownloadArtifactResult> {
  const fetchImpl = deps.fetch ?? defaultSafeFetch
  const trustStore = deps.trustStore ?? TRUST_STORE
  const { slug, version } = params

  const feedResult = await fetchFeed({ fetch: fetchImpl })
  if (!feedResult.ok) {
    return { ok: false, code: 'network-error', message: feedResult.message }
  }

  const catalogModule = feedResult.feed.modules.find((m) => m.slug === slug)
  if (!catalogModule) {
    return { ok: false, code: 'module-not-found', message: `no catalog module with slug '${slug}'` }
  }
  const catalogVersion = catalogModule.versions.find((v) => v.version === version)
  if (!catalogVersion) {
    return {
      ok: false,
      code: 'version-not-found',
      message: `module '${slug}' has no published version '${version}'`,
    }
  }

  const licenseKey = await deps.getLicenseKey()
  if (licenseKey === null) {
    return { ok: false, code: 'http-error', message: 'no marketplace license key is installed' }
  }

  const downloadResult = await requestDownloadUrl(fetchImpl, licenseKey, slug, version)
  if (!downloadResult.ok) {
    return {
      ok: false,
      code: 'http-error',
      message: `download request failed: ${downloadResult.message}`,
    }
  }
  const { downloadUrl, version: servedVersion } = downloadResult.response

  // Identity binding, part 1: if the marketplace says it served a
  // DIFFERENT version than what was requested, that is already a
  // contract violation for this explicit-version call (unlike the CLI's
  // "resolve latest" install path, this function was asked for one exact
  // version) — refuse before even looking at the artifact bytes.
  if (servedVersion !== undefined && servedVersion !== version) {
    return {
      ok: false,
      code: 'served-version-mismatch',
      message: `requested version '${version}' but the marketplace's download response reports serving '${servedVersion}'`,
    }
  }

  let tarballRes: SafeHttpResponse
  try {
    tarballRes = await fetchImpl(downloadUrl, { method: 'GET' }, MAX_ARTIFACT_BYTES)
  } catch (err) {
    return {
      ok: false,
      code: 'size-cap-exceeded',
      message: `artifact download failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (tarballRes.status < 200 || tarballRes.status >= 300) {
    return {
      ok: false,
      code: 'http-error',
      message: `artifact download failed: HTTP ${tarballRes.status}`,
    }
  }
  const tarballBytes = tarballRes.body

  // --- verify: digest, byte length, trusted signature (same policy as
  // `cli/src/verify-core.ts`'s `verifyArtifact`, reimplemented here against
  // the shared `src/modules/artifact` library rather than imported from the
  // `cli/` workspace — see the module doc's opening paragraph). ---

  let manifest: ManifestV1
  try {
    manifest = parseManifest(catalogVersion.manifest)
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
      message: `manifest was signed with keyId '${manifest.keyId}', which this engine does not trust`,
    }
  }

  const canonical = canonicalizeManifest(manifest)
  if (!verifyManifestSignature(canonical, catalogVersion.manifestSignature, trustedKey)) {
    return {
      ok: false,
      code: 'bad-signature',
      message: `manifest signature does not verify against the trusted key for '${manifest.keyId}'`,
    }
  }

  // Identity binding, part 2 — the check the module doc's "Identity
  // binding" section exists for: the signature above only proves this
  // manifest was signed by a trusted first-party key, NOT that it
  // describes the module/version this call asked for. Every first-party
  // release shares the same signing key, so a compromised marketplace
  // could serve a genuinely-signed manifest for a completely different
  // module (or a different, possibly-vulnerable version) and every check
  // above would still pass. Refuse unless the verified manifest's own
  // fields match both what was requested AND what the marketplace claimed
  // to serve.
  const expectedVersion = servedVersion ?? version
  if (manifest.module !== slug || manifest.semver !== expectedVersion) {
    return {
      ok: false,
      code: 'identity-mismatch',
      message:
        `manifest identity does not match the request: requested '${slug}@${expectedVersion}', ` +
        `manifest describes '${manifest.module}@${manifest.semver}'`,
    }
  }

  return { ok: true, manifest, tarballBytes }
}
