/**
 * `createVercelDeployProvider` — the `DeployProvider` (`./provider.ts`)
 * implementation against Vercel's REST API, for the operator's OWN Vercel
 * account (HT-119; two adversarial design reviews, see CLAUDE.md's task
 * brief for this file).
 *
 * ## The token is team-admin-equivalent — the allowlist is what bounds it
 *
 * A Vercel access token scoped to a team can do almost anything that team
 * can do in the dashboard: create and delete projects, read and write env
 * vars (including other members' secrets), manage domains, invite/remove
 * members, on and on. There is no narrower Vercel token scope this adapter
 * could request instead — team tokens are simply that broad. So the
 * token's OWN scope contributes nothing to this module's threat model; the
 * only thing standing between "this adapter has a team-admin token" and
 * "this adapter can do team-admin things" is {@link ALLOWLIST}: an
 * exhaustive, closed list of the exact `(method, path shape)` pairs this
 * code will ever construct a request for. Every method below composes its
 * request through {@link vercelFetch}, which checks the allowlist BEFORE
 * building the request — there is no code path in this file that reaches
 * Vercel's API without passing through that check first. Adding a seventh
 * capability to this adapter later means adding a seventh allowlist entry,
 * deliberately, in a diff a reviewer can see — not merely writing a new
 * fetch call.
 *
 * ## Team-id binding
 *
 * A connection is bound to exactly one immutable `teamId` at construction
 * (`VercelAdapterConfig.teamId`). Every method also takes `teamId` on its
 * input (the `DeployProvider` contract) and throws if it doesn't match the
 * bound value — this is deliberately redundant with "just always use the
 * bound value and ignore the parameter," because a caller passing the
 * wrong team id is a bug worth surfacing loudly (a project silently
 * created in the wrong team is exactly the kind of mistake that's hard to
 * notice and expensive to unwind) rather than one this adapter silently
 * papers over by preferring its own config.
 *
 * ## Prebuilt output only (non-negotiable condition 4)
 *
 * This adapter never runs, requests, or accepts a build. `createDeployment`
 * hard-codes `projectSettings: { buildCommand: null, installCommand: null,
 * framework: null }` on every request — even though `uploadArtifact`
 * already rejects an artifact that TRIES to declare its own build
 * settings (see {@link assertPrebuiltArtifactOnly}), this is defense in
 * depth: the artifact check protects against a hostile artifact, this
 * flag protects against a Vercel-side default ever reintroducing a build
 * step this adapter didn't ask for. Treating module artifacts as hostile
 * input (module doc) means neither layer is allowed to be "the one that
 * would have caught it."
 *
 * ## Token never leaves this file in the open
 *
 * No method here returns the token, includes it in a thrown `Error`
 * message, or logs it. {@link redact} additionally scrubs it out of any
 * text this module derives from a Vercel response before that text is
 * ever used to build an error message — defense against a pathological
 * response (or a test double) that happens to echo request data back.
 *
 * ## Bounded responses, capped redirects
 *
 * {@link vercelFetch} enforces a byte cap on every response body (via
 * `Content-Length` when present, and a streaming cap regardless — a
 * missing or lying `Content-Length` header does not get a free pass) and
 * a request timeout. Redirects are never followed blindly: a 3xx response
 * is inspected, and only a same-host (`api.vercel.com`, or the configured
 * test host) redirect is followed, for at most one hop — a redirect to
 * any other host is refused outright, which is what stops a compromised
 * or MITM'd API endpoint from bouncing this adapter's Authorization header
 * to an attacker-controlled host.
 *
 * ## What this adapter deliberately does NOT do
 *
 * It does not check "did the engine create this project" — that
 * invariant (non-negotiable condition 1's second half) lives in the
 * caller's own persisted record of projects it created (module doc's
 * "Async by construction": the caller persists `projectId` immediately
 * after `createProject` returns), not in this stateless HTTP client. A
 * `DeployProvider` implementation has no database of its own to consult
 * and must not invent one — that would be a second, competing source of
 * truth for exactly the fact the install orchestration already owns.
 */

import { createHash } from 'node:crypto'
import type {
  CreateDeploymentInput,
  CreateDeploymentResult,
  CreateProjectInput,
  CreateProjectResult,
  DeleteProjectInput,
  DeployFile,
  DeploymentState,
  DeployProvider,
  GetDeploymentStateInput,
  GetDeploymentStateResult,
  SetEnvVarsInput,
  UploadArtifactInput,
  UploadArtifactResult,
} from './provider.js'

/** Thrown for every refusal in this file — team mismatch, allowlist miss, disallowed redirect, oversized response, malformed API response. Never carries the token (module doc). */
export class VercelAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VercelAdapterError'
  }
}

/** Thrown by {@link assertPrebuiltArtifactOnly} when an artifact declares its own build/install/cron configuration. Module artifacts are hostile input (module doc, non-negotiable condition 4) — this is the layer that treats them that way. */
export class HostileArtifactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostileArtifactError'
  }
}

const DEFAULT_API_BASE = 'https://api.vercel.com'

/** Response body cap — generous for any legitimate Vercel API JSON response, far below what a runaway or hostile response could try to hand back. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
/** Per-request timeout, matching the pattern already used elsewhere in this repo for outbound HTTP (e.g. `src/mail/gmail-connect.ts`). */
const DEFAULT_TIMEOUT_MS = 30_000

// --- allowlist ---------------------------------------------------------

type HttpMethod = 'GET' | 'POST' | 'DELETE'

interface AllowlistEntry {
  method: HttpMethod
  /** Matches the request URL's `pathname` only. Query strings (`teamId`, etc.) are never part of the allowlist — this adapter itself constructs every query string, so a check on the path shape alone is exhaustive. */
  pathPattern: RegExp
}

/**
 * The exhaustive, closed list of requests this adapter will ever make.
 * See the module doc's "The token is team-admin-equivalent" section for
 * why this — not the token's scope — is what bounds this adapter's blast
 * radius. Every entry corresponds to exactly one `DeployProvider` method
 * below; there is no entry here that isn't reachable from this file's own
 * code.
 *
 * UNVERIFIED AGAINST LIVE API: every path/version below (`/v10/projects`,
 * `/v2/files`, `/v13/deployments`, `/v10/projects/:id/env`, etc.) was
 * written from memory against Vercel's documented REST API shape, not
 * exercised against a real Vercel account. Before wiring this adapter to
 * production, confirm each path, its API version segment, and its
 * request/response shape against Vercel's current API reference (and a
 * live smoke test) — do not assume any of these are correct as written.
 */
const ALLOWLIST: readonly AllowlistEntry[] = [
  // createProject
  { method: 'POST', pathPattern: /^\/v10\/projects$/ },
  // uploadArtifact (one call per file)
  { method: 'POST', pathPattern: /^\/v2\/files$/ },
  // createDeployment
  { method: 'POST', pathPattern: /^\/v13\/deployments$/ },
  // getDeploymentState
  { method: 'GET', pathPattern: /^\/v13\/deployments\/[^/]+$/ },
  // setEnvVars (one call per var)
  { method: 'POST', pathPattern: /^\/v10\/projects\/[^/]+\/env$/ },
  // deleteProject
  { method: 'DELETE', pathPattern: /^\/v10\/projects\/[^/]+$/ },
]

function assertAllowlisted(method: HttpMethod, pathname: string): void {
  const allowed = ALLOWLIST.some(
    (entry) => entry.method === method && entry.pathPattern.test(pathname),
  )
  if (!allowed) {
    throw new VercelAdapterError(
      `vercel-adapter: refusing to call ${method} ${pathname} — not in the compiled-in allowlist`,
    )
  }
}

/** Rejects an id that could smuggle extra path segments or query syntax into a URL this adapter builds by string interpolation. Every `projectId`/`deploymentId` this module receives is additionally `encodeURIComponent`-encoded before being placed in a path, so this is defense in depth, not the only guard. */
function assertSafeId(id: string, label: string): void {
  if (id.length === 0 || id.includes('/') || id.includes('?') || id.includes('#')) {
    throw new VercelAdapterError(`vercel-adapter: refusing unsafe ${label}: '${id}'`)
  }
}

// --- hostile-artifact rejection (non-negotiable condition 4) -----------

/**
 * The exact set of `.vercel/output/config.json` keys a prebuilt Build
 * Output API v3 bundle may declare — an ALLOWLIST, not a denylist of
 * known-dangerous keys. Vercel's config.json schema is a vendor surface
 * this adapter does not control and that grows over time; a denylist would
 * have to be updated every time Vercel adds a field capable of doing
 * something beyond "serve these static files," and would silently admit
 * any such key until someone thought to ban it by name. An allowlist fails
 * safe instead: a key this adapter has never heard of — today's `crons`,
 * or whatever Vercel adds next — is refused by default, not admitted by
 * omission.
 *
 * - `version` — the Build Output API schema version this file is written
 *   against. Vercel requires it; it carries no behavior of its own.
 * - `routes` — path-level routing (rewrites/redirects/headers) a prebuilt
 *   static export commonly needs to serve correctly. It can redirect or
 *   rewrite a request path; it cannot invoke a build or schedule a
 *   function.
 */
const ALLOWED_BUILD_OUTPUT_CONFIG_KEYS: ReadonlySet<string> = new Set(['version', 'routes'])

function tryParseJsonObject(data: Uint8Array): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(data).toString('utf8'))
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined
}

/**
 * Refuse an artifact that could smuggle build/install directives, cron
 * entries, or unreviewed routing behavior into the operator's hosting
 * account — a module release is a prebuilt Vercel Build Output API v3
 * bundle (module doc), and never has a legitimate reason to declare either
 * of the two files this function inspects, by exact location:
 *
 * - `vercel.json`, at ANY path in the artifact (basename match, not just
 *   the root — Vercel's own tooling only reads the root one, but an
 *   artifact author could be probing for a parser more lenient than
 *   "root only"). This file exists to configure a BUILD; a prebuilt
 *   artifact has no build to configure, so its presence at all — content
 *   unexamined, even unparseable — is refused. Checking its keys instead
 *   of its existence would mean maintaining a list of every dangerous key
 *   Vercel's `vercel.json` schema has or will ever have; refusing the file
 *   outright needs no such list.
 * - The Build Output API's own `.vercel/output/config.json`, checked
 *   against {@link ALLOWED_BUILD_OUTPUT_CONFIG_KEYS}: any key outside that
 *   allowlist is refused, and a file that fails to parse as a JSON object
 *   is refused rather than silently passed through — a config file this
 *   adapter cannot understand is never treated as equivalent to an absent
 *   one.
 */
export function assertPrebuiltArtifactOnly(files: readonly DeployFile[]): void {
  for (const file of files) {
    const basename = file.path.split('/').pop() ?? file.path
    if (basename === 'vercel.json') {
      throw new HostileArtifactError(
        `refusing artifact: '${file.path}' — a prebuilt Build Output API artifact has no legitimate need for a 'vercel.json' at any location; this adapter deploys prebuilt output only and never invokes a build`,
      )
    }
    if (file.path !== '.vercel/output/config.json') continue

    const obj = tryParseJsonObject(file.data)
    if (!obj) {
      throw new HostileArtifactError(
        `refusing artifact: '${file.path}' is not valid JSON — a config file this adapter cannot parse is refused, not silently ignored`,
      )
    }
    for (const key of Object.keys(obj)) {
      if (!ALLOWED_BUILD_OUTPUT_CONFIG_KEYS.has(key)) {
        throw new HostileArtifactError(
          `refusing artifact: '${file.path}' declares '${key}', which is not on this adapter's config.json allowlist (${[...ALLOWED_BUILD_OUTPUT_CONFIG_KEYS].join(', ')}) — see this function's doc for why an allowlist, not a denylist`,
        )
      }
    }
  }
}

// --- config --------------------------------------------------------------

export interface VercelAdapterConfig {
  /** Team-admin-equivalent Vercel access token. Never returned, logged, or included in a thrown error by this module (module doc). */
  token: string
  /** The one immutable team id this connection is bound to. */
  teamId: string
  /** Injected `fetch` — REQUIRED, this module never falls back to the global. Production composition roots pass Node's global `fetch` explicitly; tests pass a mock that never touches the network (module brief: "tests must not need network"). */
  fetchImpl: typeof fetch
  /** Vercel API origin. Defaults to the real API. The ONLY reason to override this is pointing tests at a local mock — this is never operator-configurable in production, for the same reason the marketplace origin is compiled in (non-negotiable condition 6): a configurable API origin is SSRF/credential-exfiltration surface, since the token is sent as this origin's Authorization header on every call. */
  apiBase?: string
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}

// --- token redaction -----------------------------------------------------

/** Scrub every occurrence of `secret` out of `text`. Defense in depth for {@link vercelFetch}'s error construction — this module never deliberately places the token in response-derived text, but a response (or, in tests, a mock) that happens to echo request data back must not be allowed to smuggle it into a thrown error. */
function redact(text: string, secret: string): string {
  return secret.length > 0 ? text.split(secret).join('<redacted>') : text
}

// --- bounded, redirect-guarded fetch --------------------------------------

const ALLOWED_REDIRECT_HOSTS = new Set(['api.vercel.com'])

async function readBoundedText(response: Response, capBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > capBytes) {
    throw new VercelAdapterError(
      `vercel-adapter: refusing response — Content-Length ${contentLength} exceeds the ${capBytes}-byte cap`,
    )
  }
  if (!response.body) {
    return await response.text()
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > capBytes) {
        throw new VercelAdapterError(
          `vercel-adapter: refusing response — body exceeded the ${capBytes}-byte cap while streaming`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

/**
 * Perform one allowlisted, bounded, redirect-guarded call to Vercel's API.
 * `pathname` and `method` are checked against {@link ALLOWLIST} before
 * anything is sent. Never follows a redirect to a host other than
 * {@link ALLOWED_REDIRECT_HOSTS}, and never more than one hop.
 */
async function vercelFetch(
  config: VercelAdapterConfig,
  method: HttpMethod,
  pathname: string,
  options: {
    searchParams?: Record<string, string>
    body?: BodyInit
    headers?: Record<string, string>
  } = {},
): Promise<{ status: number; ok: boolean; text: string }> {
  assertAllowlisted(method, pathname)

  const base = config.apiBase ?? DEFAULT_API_BASE
  const url = new URL(pathname, base)
  url.searchParams.set('teamId', config.teamId)
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value)
  }

  const requestInit: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...options.headers,
    },
    body: options.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  }

  let response = await config.fetchImpl(url.toString(), requestInit)

  let redirectHops = 0
  while ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirectHops >= 1) {
      throw new VercelAdapterError('vercel-adapter: refusing more than one redirect hop')
    }
    const location = response.headers.get('location')
    if (!location) {
      throw new VercelAdapterError('vercel-adapter: redirect response is missing a Location header')
    }
    const target = new URL(location, url)
    if (!ALLOWED_REDIRECT_HOSTS.has(target.hostname)) {
      throw new VercelAdapterError(
        `vercel-adapter: refusing to follow a redirect to disallowed host '${target.hostname}'`,
      )
    }
    // A same-host redirect is NOT automatically a same-PATH redirect — a
    // compromised or MITM'd api.vercel.com could answer an allowlisted
    // `POST /v10/projects` with `302 Location: /v1/teams/<team>/members`,
    // and `requestInit` still carries the original team-admin Authorization
    // header. The host check above only rules out exfiltrating that header
    // to a foreign origin; it says nothing about which Vercel endpoint the
    // token ends up hitting. Re-running the allowlist against the redirect
    // TARGET's path (not the path this adapter originally constructed) is
    // what closes that gap — same discipline as the very first check in
    // this function, just re-applied at the new destination.
    assertAllowlisted(method, target.pathname)
    redirectHops += 1
    response = await config.fetchImpl(target.toString(), requestInit)
  }

  const text = await readBoundedText(response, MAX_RESPONSE_BYTES)
  return { status: response.status, ok: response.ok, text: redact(text, config.token) }
}

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new VercelAdapterError(
      `vercel-adapter: response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new VercelAdapterError('vercel-adapter: response was not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** Build a `VercelAdapterError` from a non-ok response. `text` has already been through {@link redact} by the time it reaches here (via {@link vercelFetch}). */
function apiError(action: string, status: number, text: string): VercelAdapterError {
  let detail = text
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } }
    if (typeof parsed.error?.message === 'string') detail = parsed.error.message
  } catch {
    // Not JSON, or not the expected shape — fall back to the raw (already
    // redacted, already size-capped) text.
  }
  return new VercelAdapterError(`vercel-adapter: ${action} failed with HTTP ${status}: ${detail}`)
}

function requireString(obj: Record<string, unknown>, key: string, context: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new VercelAdapterError(
      `vercel-adapter: ${context} response missing string field '${key}'`,
    )
  }
  return value
}

// --- deployment state mapping ---------------------------------------------

const READY_STATE_MAP: Record<string, DeploymentState> = {
  QUEUED: 'queued',
  INITIALIZING: 'building',
  BUILDING: 'building',
  READY: 'ready',
  ERROR: 'error',
  CANCELED: 'canceled',
}

function mapReadyState(raw: string): DeploymentState {
  const mapped = READY_STATE_MAP[raw]
  if (!mapped) {
    throw new VercelAdapterError(
      `vercel-adapter: unrecognized deployment readyState from Vercel: '${raw}'`,
    )
  }
  return mapped
}

// --- upload manifest (opaque uploadId encoding) ----------------------------

interface UploadManifestEntry {
  file: string
  sha: string
  size: number
}

function encodeUploadId(manifest: UploadManifestEntry[]): string {
  return Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64url')
}

function decodeUploadId(uploadId: string): UploadManifestEntry[] {
  let manifest: unknown
  try {
    manifest = JSON.parse(Buffer.from(uploadId, 'base64url').toString('utf8'))
  } catch {
    throw new VercelAdapterError('vercel-adapter: uploadId is not a value this adapter produced')
  }
  if (!Array.isArray(manifest)) {
    throw new VercelAdapterError('vercel-adapter: uploadId is not a value this adapter produced')
  }
  return manifest as UploadManifestEntry[]
}

// --- the provider ----------------------------------------------------------

/**
 * Build a `DeployProvider` bound to one Vercel team. See the module doc
 * for the allowlist, team-id-binding, prebuilt-only, and token-hygiene
 * discipline every method below follows.
 */
export function createVercelDeployProvider(config: VercelAdapterConfig): DeployProvider {
  function assertTeam(teamId: string): void {
    if (teamId !== config.teamId) {
      throw new VercelAdapterError(
        `vercel-adapter: refusing operation for team '${teamId}' — this connection is bound to a different team`,
      )
    }
  }

  return {
    async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
      assertTeam(input.teamId)
      const { status, ok, text } = await vercelFetch(config, 'POST', '/v10/projects', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: input.name }),
      })
      if (!ok) throw apiError('createProject', status, text)
      const body = parseJsonObject(text)
      return { projectId: requireString(body, 'id', 'createProject') }
    },

    async uploadArtifact(input: UploadArtifactInput): Promise<UploadArtifactResult> {
      assertTeam(input.teamId)
      assertSafeId(input.projectId, 'projectId')
      assertPrebuiltArtifactOnly(input.files)

      const manifest: UploadManifestEntry[] = []
      for (const file of input.files) {
        const sha = createHash('sha1').update(file.data).digest('hex')
        const { status, ok, text } = await vercelFetch(config, 'POST', '/v2/files', {
          headers: {
            'x-vercel-digest': sha,
            'Content-Type': 'application/octet-stream',
          },
          body: Buffer.from(file.data),
        })
        if (!ok) throw apiError(`uploadArtifact (file '${file.path}')`, status, text)
        manifest.push({ file: file.path, sha, size: file.data.byteLength })
      }

      return { uploadId: encodeUploadId(manifest) }
    },

    async createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
      assertTeam(input.teamId)
      assertSafeId(input.projectId, 'projectId')
      const manifest = decodeUploadId(input.uploadId)

      const { status, ok, text } = await vercelFetch(config, 'POST', '/v13/deployments', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: input.projectId,
          target: input.target,
          files: manifest,
          // Non-negotiable condition 4, belt and suspenders: never let a
          // build run, regardless of anything an artifact or a Vercel-side
          // project default might otherwise imply. See module doc.
          projectSettings: {
            buildCommand: null,
            installCommand: null,
            framework: null,
          },
        }),
      })
      if (!ok) throw apiError('createDeployment', status, text)
      const body = parseJsonObject(text)
      const deploymentId = requireString(body, 'id', 'createDeployment')
      const url = requireString(body, 'url', 'createDeployment')
      return { deploymentId, url: url.startsWith('http') ? url : `https://${url}` }
    },

    async getDeploymentState(input: GetDeploymentStateInput): Promise<GetDeploymentStateResult> {
      // Every sibling method asserts the caller's team matches this
      // connection's bound team (module doc's "Team-id binding") — this
      // one call was missing it, which is harmless only because
      // `vercelFetch` always pins `teamId` from `config` regardless of what
      // `input.teamId` says. Asserting here anyway closes the gap for the
      // day a query param stops being the only thing scoping this request,
      // and keeps "a caller passing the wrong team id is a bug worth
      // surfacing loudly" true for every method, not all-but-one.
      assertTeam(input.teamId)
      assertSafeId(input.deploymentId, 'deploymentId')
      const { status, ok, text } = await vercelFetch(
        config,
        'GET',
        `/v13/deployments/${encodeURIComponent(input.deploymentId)}`,
      )
      if (!ok) throw apiError('getDeploymentState', status, text)
      const body = parseJsonObject(text)
      const readyState = requireString(body, 'readyState', 'getDeploymentState')
      const result: GetDeploymentStateResult = { state: mapReadyState(readyState) }
      const url = body.url
      if (typeof url === 'string' && url.length > 0) {
        result.url = url.startsWith('http') ? url : `https://${url}`
      }
      return result
    },

    async setEnvVars(input: SetEnvVarsInput): Promise<void> {
      assertTeam(input.teamId)
      assertSafeId(input.projectId, 'projectId')
      for (const v of input.vars) {
        const { status, ok } = await vercelFetch(
          config,
          'POST',
          `/v10/projects/${encodeURIComponent(input.projectId)}/env`,
          {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              key: v.key,
              value: v.value,
              type: v.sensitive ? 'sensitive' : 'encrypted',
              target: ['production'],
            }),
          },
        )
        // `apiError` normally folds the response body into the thrown
        // message — fine for createProject/createDeployment/etc, whose
        // request bodies never carry a secret. But THIS request's body is
        // the Assistant token or webhook signing secret being submitted as
        // an env var value, and `redact()` only knows how to scrub the
        // connection's own Vercel token. A Vercel 400 that happens to echo
        // an invalid submitted value back (a plausible validation-error
        // shape) would otherwise carry that secret straight into
        // `apiError`'s message — which callers persist verbatim into
        // `module_install_events.detail` (permanent, jsonb) and into the
        // queue's dead-letter reason. Rather than teach `vercelFetch` an
        // ever-growing list of secrets to scrub (an allowlist of paths
        // whose bodies are safe to echo would be more fragile than this),
        // this call site simply never lets ANY response text reach the
        // thrown error: only the HTTP status and the var's KEY (never its
        // value) are safe to surface here.
        if (!ok) {
          throw new VercelAdapterError(
            `vercel-adapter: setEnvVars (key '${v.key}') failed with HTTP ${status}`,
          )
        }
      }
    },

    async deleteProject(input: DeleteProjectInput): Promise<void> {
      assertTeam(input.teamId)
      assertSafeId(input.projectId, 'projectId')
      const { status, ok, text } = await vercelFetch(
        config,
        'DELETE',
        `/v10/projects/${encodeURIComponent(input.projectId)}`,
      )
      if (!ok) throw apiError('deleteProject', status, text)
    },
  }
}
