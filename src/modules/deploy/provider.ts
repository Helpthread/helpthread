/**
 * `DeployProvider` — the vendor-neutral seam between "install this verified
 * module artifact" and "however that actually happens on one operator's
 * hosting account" (HT-119).
 *
 * ## Why this interface exists, and why it takes no Vercel types
 *
 * Every field and method signature below is plain data: strings, byte
 * arrays, small records. Nothing here imports a Vercel SDK type, and
 * nothing in the install/orchestration logic that will consume this
 * interface (a later ticket) is allowed to reach past it into a
 * provider-specific shape. That is deliberate, not incidental: this repo
 * is the AGPL-3.0 core (CLAUDE.md), and "the operator's own engine deploys
 * to the operator's own hosting account" is a charter-level promise, not a
 * Vercel-specific one. A fork that wants to deploy modules to Cloudflare,
 * Fly, or a bare VM needs to be able to write one new file that implements
 * `DeployProvider` and wire it in — without touching a single line of the
 * install logic that calls it. `./vercel-adapter.ts` is the reference
 * implementation; `./local-manual.ts` is the second implementation that
 * exists specifically to prove this interface is genuinely vendor-neutral
 * (see that file's doc comment) and to give an operator with no hosting
 * account at all a working fallback.
 *
 * ## Shape of the six operations
 *
 * These mirror the natural lifecycle of getting a prebuilt module artifact
 * live on the operator's own infrastructure, in order:
 *
 * 1. {@link DeployProvider.createProject} — one hosting "project" per
 *    installed module, scoped to the operator's account.
 * 2. {@link DeployProvider.uploadArtifact} — hand the provider the
 *    artifact's already-verified, already-extracted files.
 * 3. {@link DeployProvider.createDeployment} — turn an upload into a live
 *    (or candidate) deployment.
 * 4. {@link DeployProvider.getDeploymentState} — poll until the deployment
 *    is ready (or has failed) — see "Async by construction" below.
 * 5. {@link DeployProvider.setEnvVars} — supply the module's declared
 *    config (`module.config.json`, `../artifact/module-config.ts`) before
 *    or after deployment, depending on the provider.
 * 6. {@link DeployProvider.deleteProject} — uninstall.
 *
 * ## Async by construction (non-negotiable condition 3)
 *
 * Every method here is a single, independent network round trip that
 * returns as soon as the remote side has durably recorded the request (or
 * thrown). None of these calls may ever be composed inside one database
 * transaction with a caller's own writes — a network call inside a DB
 * transaction holds locks for the duration of someone else's latency and
 * an unlucky timeout leaves the transaction's fate entangled with a
 * third-party API's. The intended caller pattern is: call one of these
 * methods, then IMMEDIATELY persist whatever id it returned (`projectId`,
 * `deploymentId`, …) in its own short, separate write — never "do the
 * network call and the DB write together." A remote resource created but
 * never recorded is a leak the operator has to notice and clean up by
 * hand; a resource recorded before it exists is merely a retry.
 */

/** Bytes for one file inside a deploy artifact, ready to hand to a provider. `path` is relative to the artifact root (e.g. `.vercel/output/static/index.html` for a Build Output API v3 bundle — see the module doc on why only prebuilt output is ever accepted). */
export interface DeployFile {
  path: string
  data: Uint8Array
}

/** One environment variable to set on a project. `sensitive` mirrors `module.config.json`'s `ModuleConfigEnvVar.sensitive` (`../artifact/module-config.ts`) — a provider implementation must never echo a `sensitive: true` value back in a log line or a returned object. */
export interface DeployEnvVar {
  key: string
  value: string
  sensitive: boolean
}

export interface CreateProjectInput {
  /** The connection's immutable team/account id (non-negotiable condition 1) — every `DeployProvider` method takes this and every implementation must refuse a value that does not match the connection it was constructed with. */
  teamId: string
  /** Operator-facing project name, e.g. `ht-module-draft-assistant`. */
  name: string
}

export interface CreateProjectResult {
  /** Provider-assigned project id. The caller persists this immediately (module doc's "Async by construction") — it is the sole handle every later call in this project's lifecycle needs. */
  projectId: string
}

export interface UploadArtifactInput {
  teamId: string
  projectId: string
  files: DeployFile[]
}

export interface UploadArtifactResult {
  /** Opaque handle {@link DeployProvider.createDeployment} needs to turn this upload into a deployment. Providers that deploy directly from the file list (no separate upload step, e.g. `./local-manual.ts`) may set this to any stable value — callers must treat it as opaque. */
  uploadId: string
}

export type DeploymentTarget = 'production' | 'preview'

export interface CreateDeploymentInput {
  teamId: string
  projectId: string
  uploadId: string
  target: DeploymentTarget
}

export interface CreateDeploymentResult {
  deploymentId: string
  /** The URL the deployment will be reachable at once ready. May not resolve yet — see {@link DeployProvider.getDeploymentState}. */
  url: string
}

/**
 * A deployment's lifecycle state. `'ready'` is the only state from which a
 * webhook endpoint may be cut over to (non-negotiable condition 5,
 * candidate-then-cutover) — and even then, only after the deployed module
 * has proven possession via a signed challenge; reaching `'ready'` here
 * proves the code is LIVE, not that it is the code the operator meant to
 * install.
 */
export type DeploymentState = 'queued' | 'building' | 'ready' | 'error' | 'canceled'

export interface GetDeploymentStateInput {
  teamId: string
  deploymentId: string
}

export interface GetDeploymentStateResult {
  state: DeploymentState
  /** Present once the deployment has a reachable URL — typically from `'ready'` onward, but a provider may populate it earlier. */
  url?: string
}

export interface SetEnvVarsInput {
  teamId: string
  projectId: string
  vars: DeployEnvVar[]
}

export interface DeleteProjectInput {
  teamId: string
  projectId: string
}

/**
 * The vendor-neutral deploy surface — see the module doc. Every method
 * takes `teamId` explicitly (rather than relying on a connection captured
 * once at construction) so a caller mistake — reusing one provider
 * instance across two operators, say — fails loudly at the call site
 * instead of silently deploying to the wrong account.
 */
export interface DeployProvider {
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>
  uploadArtifact(input: UploadArtifactInput): Promise<UploadArtifactResult>
  createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult>
  getDeploymentState(input: GetDeploymentStateInput): Promise<GetDeploymentStateResult>
  setEnvVars(input: SetEnvVarsInput): Promise<void>
  deleteProject(input: DeleteProjectInput): Promise<void>
}
