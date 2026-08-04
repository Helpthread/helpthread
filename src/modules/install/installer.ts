/**
 * The queued installer (HT-119) — one `QueueMessageHandler<ModuleInstallJob>`
 * that drives ONE `module_installs` row through the lifecycle
 * `../../store/module-installs.ts` defines, composing every Foundation-phase
 * piece: `ModuleInstallStore`'s fenced state machine, `VercelConnectionStore`
 * for the operator's own credential, a `DeployProvider` for the actual
 * hosting calls, the marketplace catalog client for the verified artifact,
 * `AssistantStore` + `WebhookEndpointStore` for the credentials the deployed
 * module needs, and `./challenge.ts` for the possession proof that gates
 * activation.
 *
 * ## Why a `for (;;) { switch (install.state) }` loop, not one job per state
 *
 * Each state's handling below is one focused function: perform whatever
 * side effect that step needs (a network call, a mint, a challenge), then
 * attempt exactly one fenced `ModuleInstallStore.transition`. When a step
 * succeeds, the loop immediately falls through to the NEXT state in the
 * SAME invocation — there is no reason to round-trip through the queue
 * again just to re-read a row this worker already holds a valid lease on.
 * The loop stops (returns a `QueueHandlerResult`) at the first point that
 * genuinely needs to wait on something external: `build_pending` returns
 * `retry` until the deployment is `'ready'` (Vercel's own build time is not
 * this worker's to control), a lost fence returns `ack` (module doc below),
 * and every terminal state returns `ack` immediately. This keeps "resumable
 * and idempotent at every step" literal: a fresh `QueueMessage` delivered
 * after a crash re-enters this same loop from whatever state the LAST
 * successful transition left behind, and picks up exactly where it left
 * off — never re-doing a step whose transition already committed, never
 * skipping one that didn't.
 *
 * ## The claim comes first — a loser performs ZERO side effects
 *
 * A fence token that merely sits readable on the row is not a lease: N
 * concurrent deliveries of the same install can all read the SAME valid
 * token, all pass their own CAS precondition check (in sequence, one after
 * another), and all perform a real side effect — a mint, a hosting API
 * call — before any of them attempts to WRITE. Only the final database
 * write ever serialized; everything upstream of it did not. This handler
 * closes that by calling `../../store/module-installs.ts`'s
 * `ModuleInstallStore.claim` FIRST, before touching anything else — a
 * refused claim (`'lease_held'`: someone else's lease is still live) `ack`s
 * immediately, having made no network call, no mint, no provider call, not
 * merely having lost a race afterward. A refused claim with `'not_found'`
 * dead-letters (the row is gone, nothing left to do, ever). See that
 * store's own module doc, "claim", for the lease mechanics.
 *
 * ## A stale worker loses, it does not retry the same step
 *
 * Every transition attempt goes through {@link tryTransition}, which turns
 * a refused `ModuleInstallStore.transition` into the loop's exit: `reason:
 * 'not_found'` dead-letters (the row is gone, nothing left to do, ever);
 * `'state_mismatch'` or `'lease_stale'` (a *fenced* worker was preempted by
 * a newer one — a reclaim after a lapsed lease, or, in principle, an
 * overlapping delivery of the same message) simply `ack`s: this worker's
 * OWN work up to its last successful transition is still durably recorded,
 * and whichever worker now holds the fence is responsible for continuing.
 * Retrying here would either duplicate the side effect this worker already
 * performed (if it raced ahead of the winner) or fight the winner for the
 * row (if it fell behind) — neither is ever correct, so this worker simply
 * stops. See `../../store/module-installs.ts`'s own module doc for why
 * `transition` is CAS-fenced in the first place. {@link failInstall}
 * applies the SAME discipline to the terminal-failure path: it attempts
 * its fenced transition FIRST and only revokes credentials / disables a
 * recorded webhook endpoint when that transition actually won — a stale
 * worker taking a failure branch must never be able to disable the
 * Assistant of an install that is advancing fine under the worker that
 * actually holds the fence.
 *
 * ## What "async by construction" means for THIS file specifically
 *
 * No step below ever opens a `Db.transaction` around a network call —
 * every persisted write here is a SEPARATE `ModuleInstallStore.transition`
 * call, issued only AFTER the network call it records has already
 * returned. Two remote-resource-creation steps (`project_created`,
 * `deployment_created`) are consequently vulnerable to the "crash between
 * call and persist" orphan case the ticket brief names explicitly — this
 * file's answer to each is documented at its own step function, because
 * `../deploy/provider.ts` (owned by a sibling change, not this file) has
 * no `getProjectByName`/`getDeploymentByX` lookup a true reconciliation
 * could use. See {@link stepProjectCreated}'s doc for the deterministic-
 * name mitigation this file uses instead, and {@link
 * stepDeploymentCreated}'s doc for why a duplicate DEPLOYMENT (as opposed
 * to a duplicate PROJECT) is an accepted, bounded cost rather than a
 * safety violation.
 *
 * ## Credentials: minted in memory, persisted to `assistants` only AFTER
 * winning the fence
 *
 * {@link stepCredentialsIssued} mints the Assistant this module's runtime
 * will authenticate as, and a webhook signing secret, ENTIRELY IN MEMORY —
 * it writes NOTHING to `assistants` before attempting its fenced
 * transition. This ordering is load-bearing, not stylistic: writing the
 * Assistant row before the CAS is what let two concurrent deliveries mint
 * T1/T2 and each unconditionally overwrite `assistants.token_hash` with
 * their own, independent of which one (if either) actually won the
 * transition — an install could reach `'active'` with an audit trail
 * recording T1 while `assistants` recognizes only T2, a green install that
 * is silently dead. Only after `tryTransition` reports a win does
 * {@link ensureAssistantMatchesCredentials} touch the `assistants` table,
 * and it always writes the hash of the token that transition ACTUALLY
 * recorded (recovered from the ciphertext, never from a variable a losing
 * attempt might have re-minted) — so the row `assistants` ends up holding
 * is, by construction, the same one the winning `credentials_issued` event
 * describes. The plaintext token/secret are carried forward (across
 * possibly many queue deliveries, until they are baked into the
 * deployment's env vars and later into the real `webhook_endpoints` row)
 * as envelope-encrypted bytes on the `credentials_issued` audit event's
 * `detail` column — the one column `../../store/module-installs.ts`'s own
 * doc names as the place for exactly this ("a challenge nonce" is its own
 * example of ephemeral, step-scoped material belonging there). Re-entering
 * the `credentials_issued` state after a crash between "transition
 * committed" and "assistants row written" re-runs
 * {@link ensureAssistantMatchesCredentials} from the recorded ciphertext —
 * this is what makes that write idempotent-and-recoverable rather than a
 * second crash-window this file merely moved instead of closing. See
 * {@link deterministicAssistantId}'s doc for why re-running it is a
 * ROTATE, never a duplicate `create`.
 *
 * ## Candidate-then-cutover, concretely
 *
 * `../deploy/provider.ts` has no "promote"/"alias" call — `createDeployment`
 * is the only way this file can make a deployment reachable at all, so
 * traffic to the deployment's OWN url exists from the moment `build_pending`
 * resolves to `'ready'`. What this file actually controls — and what non-
 * negotiable condition 5 is actually protecting, per its own text ("a
 * mistyped or hostile URL silently receives another customer's conversation
 * events") — is whether that URL is ever REGISTERED to receive real
 * conversation events at all. No `webhook_endpoints` row is created until
 * {@link stepBootstrapPending}'s challenge succeeds; before that point
 * `../../webhooks/outbox-drain.ts` has nothing to fan events out to at this
 * URL, full stop. On an update of an already-`active` install, the OLD
 * `webhook_endpoints` row (pointed at the previous deployment) is left
 * untouched and continues serving real deliveries until the NEW row is
 * created — recorded via `previous_active_deployment_id` — so a failed
 * verification never interrupts live delivery to the version already
 * proven to work.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  hashAssistantSecret,
  mintAssistantToken,
  parseAssistantToken,
} from '../../auth/assistant-token.js'
import type {
  QueueHandlerResult,
  QueueMessage,
  QueueMessageHandler,
} from '../../providers/queue.js'
import type { AssistantStore } from '../../store/assistants.js'
import type {
  ModuleInstallRecord,
  ModuleInstallState,
  ModuleInstallStore,
  TransitionResult,
} from '../../store/module-installs.js'
import { decrypt, encrypt } from '../../store/token-crypto.js'
import type { VercelConnectionStore } from '../../store/vercel-connection.js'
import type { WebhookEndpointStore } from '../../store/webhook-endpoints.js'
import { type ModuleConfigV1, parseModuleConfig, safeExtract } from '../artifact/index.js'
import type { DeployFile, DeployProvider } from '../deploy/provider.js'
import { type VerifyEndpointPossessionDeps, verifyEndpointPossession } from './challenge.js'

// --- job payload -------------------------------------------------------

/** The payload every install job carries. One job drives one `module_installs` row through as much of its lifecycle as it can in one invocation (module doc). */
export interface ModuleInstallJob {
  installId: string
  /**
   * Operator-typed values for this module's `operator-managed`
   * `module.config.json` env vars (`../artifact/module-config.ts`), keyed
   * by var name — supplied by whatever admin flow enqueued this job
   * (out of this ticket's boundary), never re-derived here. Engine-managed
   * vars are never read from this map (module doc's "Config" rule) —
   * supplying one here on a FRESH install is simply ignored; supplying one
   * on an UPDATE is treated as drift and refuses the job (see
   * {@link stepCheckConfigDrift}).
   */
  operatorEnvVars: Record<string, string>
  /**
   * `true` when this job represents re-processing an install that has
   * already reached `'active'` at least once (a config/version refresh),
   * rather than a first-time install. See {@link stepCheckConfigDrift}.
   */
  isUpdate?: boolean
  /**
   * How many `build_pending` polls have already been performed for this
   * install, carried forward on the RE-ENQUEUED job payload (never on
   * `QueueMessage.attempts` — see {@link BUILD_POLL_MAX_ATTEMPTS}'s doc for
   * why this handler tracks its own poll budget instead of trusting the
   * queue's shared, cross-step attempts counter). Omitted/`0` on the first
   * delivery that ever reaches `build_pending`.
   */
  buildPollAttempts?: number
}

// --- dependencies --------------------------------------------------------

/**
 * The verified release manifest's identity fields — everything
 * {@link stepArtifactUploaded}'s check needs, independent of the
 * marketplace client's full `ManifestV1` shape (`../catalog/
 * marketplace-client.ts`). `downloadVerifiedArtifact` already proves the
 * manifest is validly signed by a TRUSTED first-party key and that its
 * OWN `module`/`semver` fields match what was requested — but every
 * first-party release shares that same signing key, so a compromised (or
 * merely careless) marketplace can serve a DIFFERENT, also validly-signed
 * release for the SAME module/version request and every check upstream of
 * this one would still pass. `artifactDigest`/`manifestKeyId` are the
 * OPERATOR-APPROVED identity recorded on the `module_installs` row at
 * request time (migration 030) — comparing against those, not merely
 * trusting "some first-party signature verified", is what actually pins
 * "the artifact this install approved" rather than "an artifact this
 * engine trusts the publisher of".
 */
export interface ArtifactManifestIdentity {
  artifactSha256: string
  keyId: string
}

/** One verified, downloaded module artifact — the shape this file needs from the catalog client, independent of the marketplace's own wire types (`../catalog/marketplace-client.ts`'s `DownloadArtifactOk`). */
export interface DownloadedArtifact {
  tarballBytes: Buffer
  /** See {@link ArtifactManifestIdentity} — this is what {@link stepArtifactUploaded} checks against `install.artifactDigest`/`install.manifestKeyId` before ever extracting or deploying the tarball. */
  manifest: ArtifactManifestIdentity
}

/** The catalog seam this file depends on — narrowed to exactly what it calls, so a test double never has to fake the marketplace client's full HTTP/SSRF/signature-verification surface (module brief: "fakes for... catalog"). Production wires this to `../catalog/marketplace-client.ts`'s `downloadVerifiedArtifact`. */
export interface InstallCatalogClient {
  downloadArtifact(params: {
    slug: string
    version: string
  }): Promise<
    { ok: true; artifact: DownloadedArtifact } | { ok: false; permanent: boolean; message: string }
  >
}

/** Extracts an already-downloaded artifact into deployable files plus its parsed `module.config.json` — the one filesystem-touching step in this file, isolated behind a seam so tests never need a real `.tar.gz` (module brief: "fakes for deploy provider + catalog + queue"). Production's default (`defaultExtractArtifact`, below) is a thin wrapper over `../artifact/extract.ts`'s `safeExtract`. */
export type ExtractArtifactFn = (
  tarballBytes: Buffer,
) => Promise<{ files: DeployFile[]; moduleConfig: ModuleConfigV1 }>

/** Dependencies {@link createModuleInstallHandler} needs. */
export interface ModuleInstallerDeps {
  installs: ModuleInstallStore
  connections: VercelConnectionStore
  assistants: AssistantStore
  webhookEndpoints: WebhookEndpointStore
  catalog: InstallCatalogClient
  /** Build a `DeployProvider` bound to one connection's team + decrypted token. Production wires this to `../deploy/vercel-adapter.ts`'s `createVercelDeployProvider`; tests supply a fake. Called once per invocation, never cached across installs — see `../deploy/vercel-adapter.ts`'s own team-binding discipline, which this respects by never reusing a provider instance across a different `teamId`. */
  createDeployProvider(input: { teamId: string; token: string }): DeployProvider
  /** Overrides artifact extraction — see {@link ExtractArtifactFn}. Defaults to {@link defaultExtractArtifact}. */
  extractArtifact?: ExtractArtifactFn
  /** Overrides token minting — tests only; production always uses `../../auth/assistant-token.ts`'s real `mintAssistantToken`. */
  mintAssistantToken?: typeof mintAssistantToken
  /** Overrides the possession-challenge transport/nonce — tests only (module brief: fakes, no real network). */
  challenge?: VerifyEndpointPossessionDeps
  /**
   * Re-enqueue a follow-up install job at a `delaySeconds` delay — the ONLY
   * caller is {@link stepPollBuild}'s not-yet-ready branch (/
   * {@link BUILD_POLL_MAX_ATTEMPTS}'s doc). Production wires this to the
   * composition root's own `QueueProvider.enqueue`, bound to whatever topic
   * this handler is registered under; tests supply a fake recording calls.
   * Deliberately narrower than the full `QueueProvider` interface — this
   * handler has no business enqueueing anything OTHER than a follow-up poll
   * of the SAME install.
   */
  enqueueInstallJob(job: ModuleInstallJob, delaySeconds: number): Promise<void>
  /** 32-byte key encrypting the transiently-carried plaintext credentials on the `credentials_issued` audit event (module doc's "Credentials" section) — decoded once at the composition root via `../../store/token-crypto.ts`'s `decodeEncryptionKey`, same convention as every other store in this codebase that calls `encrypt`/`decrypt` directly. */
  encryptionKey: Buffer
}

// --- constants -------------------------------------------------------------

/**
 * `QueueMessage.attempts` ceiling at which a step that has been failing
 * transiently is instead treated as a PERMANENT failure and the install is
 * moved to a terminal state (module doc: "bounded retries with backoff and
 * a terminal state"). Matches `../../webhooks/delivery.ts`'s
 * `WEBHOOK_DELIVERY_MAX_ATTEMPTS` — no reason for this pipeline's ceiling to
 * disagree with the one other bounded-retry consumer in this codebase
 * already settled on.
 */
export const INSTALL_MAX_ATTEMPTS = 5

/**
 * Poll ceiling for `build_pending` specifically — a stuck Vercel build
 * should eventually stop being retried even though each individual poll is
 * cheap and harmless, and a real build can legitimately take many polls to
 * finish (this file needs a budget far larger than {@link
 * INSTALL_MAX_ATTEMPTS}'s 5).
 *
 * ## Why this is NOT compared against `QueueMessage.attempts` ()
 *
 * `queue_jobs.attempts` (`../../providers/adapters/postgres-queue/index.ts`,
 * READ IT) is ONE counter shared by the entire install's lifetime on that
 * row — every claim of the SAME row bumps it, whether this is the row's
 * first delivery ever or its fortieth `build_pending` poll — and that
 * adapter dead-letters any `retry` outcome the moment `attempts` reaches
 * its OWN ceiling (`DEFAULT_MAX_ATTEMPTS = 5`, a call-level knob, not a
 * per-topic one). A `build_pending` step that returned `{ kind: 'retry' }`
 * on every not-yet-ready poll would therefore be killed by the adapter at
 * attempt 5 — long before this constant's 40 — leaving the row permanently
 * stuck at `build_pending` with credentials already minted and a real
 * project/deployment already created in the operator's Vercel account.
 * {@link stepPollBuild} instead tracks its OWN poll count on
 * {@link ModuleInstallJob.buildPollAttempts}, carried forward on a freshly
 * RE-ENQUEUED job payload (`ModuleInstallerDeps.enqueueInstallJob`) rather
 * than read off `message.attempts` — every such re-enqueue starts a BRAND
 * NEW `queue_jobs` row at `attempts = 0`, so this handler's own poll budget
 * is entirely decoupled from, and never bounded by, the shared queue's
 * dead-letter ceiling.
 */
export const BUILD_POLL_MAX_ATTEMPTS = 40

/**
 * `ModuleInstallStore.claim`'s lease TTL, in seconds — the module doc's
 * "the claim comes first" section. This is a CRASH backstop, not a pacing
 * mechanism: every clean exit from the handler explicitly `release`s the
 * lease (see the handler's `finally`), so a legitimate redelivery arriving
 * well inside this window (`build_pending`'s 15-second poll, in
 * particular) is never blocked by it. Five minutes comfortably covers one
 * invocation's real Vercel API round trips with room to spare, while still
 * bounding how long a SIGKILLed worker's abandoned lease can block a
 * genuine reclaim.
 */
export const INSTALL_CLAIM_TTL_SECONDS = 300

function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 900)
}

// --- deterministic assistant id --------------------------------------------

/**
 * A stable, deterministic uuid-shaped id for the ONE Assistant this install
 * ever mints, derived from `installId` alone (never randomly generated).
 * This is what makes {@link stepCredentialsIssued} safely re-runnable after
 * a crash: a retry recomputes the SAME id, finds the row {@link
 * AssistantStore.get} already returns, and ROTATES its token rather than
 * calling {@link AssistantStore.create} a second time (which would either
 * throw on the primary key or, worse, silently succeed with caller-supplied
 * `gen_random_uuid()` and leave an orphaned first attempt with no install
 * ever pointing back at it). SHA-256, not a real uuid v5 — this file has no
 * need for RFC 4122 compliance, only for the output to satisfy
 * `../../auth/assistant-token.ts`'s `UUID_PATTERN` shape, which it does by
 * construction (32 hex chars, grouped 8-4-4-4-12).
 */
export function deterministicAssistantId(installId: string): string {
  const hex = createHash('sha256').update(`ht-module-install-assistant:${installId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// --- credential envelope (carried on the credentials_issued event) --------

interface CredentialEnvelope {
  assistantToken: string
  webhookSecret: string
}

function encodeCredentialCiphertext(envelope: CredentialEnvelope, key: Buffer): string {
  return Buffer.from(encrypt(JSON.stringify(envelope), key)).toString('base64')
}

function decodeCredentialCiphertext(ciphertextBase64: string, key: Buffer): CredentialEnvelope {
  const plaintext = decrypt(Buffer.from(ciphertextBase64, 'base64'), key)
  return JSON.parse(plaintext) as CredentialEnvelope
}

/**
 * Recover the plaintext credentials {@link stepCredentialsIssued} minted for
 * `installId`, by reading them back off that install's own audit trail —
 * see the module doc's "Credentials" section for why this is where they
 * live instead of a dedicated column. Throws if no `credentials_issued`
 * event exists (a caller bug: every step after `planned` requires this to
 * have already run).
 */
async function loadIssuedCredentials(
  installs: ModuleInstallStore,
  installId: string,
  encryptionKey: Buffer,
): Promise<{ assistantId: string; assistantToken: string; webhookSecret: string }> {
  const events = await installs.listEvents(installId)
  const event = [...events].reverse().find((e) => e.toState === 'credentials_issued')
  if (event === undefined) {
    throw new Error(
      `installer: install ${installId} has no 'credentials_issued' event to recover credentials from`,
    )
  }
  const detail = event.detail as { assistantId: string; credentialCiphertext: string }
  const envelope = decodeCredentialCiphertext(detail.credentialCiphertext, encryptionKey)
  return {
    assistantId: detail.assistantId,
    assistantToken: envelope.assistantToken,
    webhookSecret: envelope.webhookSecret,
  }
}

/**
 * The set of `module.config.json` env var NAMES this install declared
 * `engine-managed` (never their values) — recorded on the
 * `artifact_uploaded` event specifically so {@link stepCheckConfigDrift}
 * can refuse an update that tries to override one, without needing to
 * re-download and re-parse the artifact just to answer that question.
 */
async function loadEngineManagedVarNames(
  installs: ModuleInstallStore,
  installId: string,
): Promise<Set<string> | null> {
  const events = await installs.listEvents(installId)
  const event = [...events].reverse().find((e) => e.toState === 'artifact_uploaded')
  if (event === undefined) return null
  const detail = event.detail as { engineManagedVarNames?: string[] }
  return new Set(detail.engineManagedVarNames ?? [])
}

// --- well-known engine-managed env vars ------------------------------------

/** Env var name a module reads its Assistant bearer token from — see `../../auth/assistant-token.ts`. */
export const ENV_ASSISTANT_TOKEN = 'HELPTHREAD_ASSISTANT_TOKEN'
/** Env var name a module reads its webhook signing secret from — the SAME value later stored (re-encrypted) on the real `webhook_endpoints` row once `../install/challenge.ts` verifies possession of it. */
export const ENV_WEBHOOK_SECRET = 'HELPTHREAD_WEBHOOK_SECRET'

const WELL_KNOWN_ENGINE_VARS: ReadonlySet<string> = new Set([
  ENV_ASSISTANT_TOKEN,
  ENV_WEBHOOK_SECRET,
])

// --- default artifact extraction -------------------------------------------

/**
 * Default {@link ExtractArtifactFn}: extract `tarballBytes` into a fresh
 * temp directory via `../artifact/extract.ts`'s `safeExtract` (the shared,
 * hostile-input-hardened extractor — see that module's doc; this file does
 * not re-implement any of its containment/decompression-bomb checks), read
 * every written file back into memory as a {@link DeployFile}, parse
 * `module.config.json` (required — an artifact without one cannot declare
 * its env vars, and is refused), then remove the temp directory. The
 * files are handed to `DeployProvider.uploadArtifact` as plain bytes —
 * this function never inspects or trusts file CONTENTS beyond what
 * `safeExtract` and `module-config.ts`'s validator already enforce; that is
 * `../deploy/vercel-adapter.ts`'s job (`assertPrebuiltArtifactOnly`).
 */
export async function defaultExtractArtifact(
  tarballBytes: Buffer,
): Promise<{ files: DeployFile[]; moduleConfig: ModuleConfigV1 }> {
  const { mkdtemp, readFile, rm, stat } = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')

  const dir = await mkdtemp(path.join(os.tmpdir(), 'ht-module-install-'))
  try {
    const written = await safeExtract(tarballBytes, dir)
    const files: DeployFile[] = []
    for (const fullPath of written) {
      const info = await stat(fullPath)
      if (!info.isFile()) continue
      const data = await readFile(fullPath)
      const relPath = path.relative(dir, fullPath).split(path.sep).join('/')
      files.push({ path: relPath, data: new Uint8Array(data) })
    }

    const configFile = files.find((f) => f.path === 'module.config.json')
    if (configFile === undefined) {
      throw new Error("installer: artifact does not contain a 'module.config.json' at its root")
    }
    const moduleConfig = parseModuleConfig(Buffer.from(configFile.data).toString('utf8'))

    return { files, moduleConfig }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// --- transition helper -------------------------------------------------

/** Either the successfully-updated record, or a `QueueHandlerResult` the caller should return immediately without doing anything further — module doc's "a stale worker loses" section. */
type TransitionOutcome = { install: ModuleInstallRecord } | { stop: QueueHandlerResult }

async function tryTransition(
  installs: ModuleInstallStore,
  installId: string,
  fromState: ModuleInstallState,
  toState: ModuleInstallState,
  fenceToken: string,
  options?: Parameters<ModuleInstallStore['transition']>[4],
): Promise<TransitionOutcome> {
  const result: TransitionResult = await installs.transition(
    installId,
    fromState,
    toState,
    fenceToken,
    options,
  )
  if (result.ok) return { install: result.install }
  if (result.error.reason === 'not_found') {
    return {
      stop: { kind: 'deadLetter', reason: `module install ${installId} no longer exists` },
    }
  }
  // 'state_mismatch' | 'lease_stale' — a newer worker already owns this
  // install (module doc). This worker's own prior work is already durably
  // committed; it has nothing more to do.
  return { stop: { kind: 'ack' } }
}

/** Revoke the Assistant this install minted, if any — module doc's "revokes credentials it minted for an install that never went active." Never throws: a failure permanently is failing anyway, and a missing/already-disabled Assistant is not itself an error. */
async function revokeIssuedCredentials(
  deps: ModuleInstallerDeps,
  installId: string,
): Promise<void> {
  const assistantId = deterministicAssistantId(installId)
  try {
    await deps.assistants.patch(assistantId, { status: 'disabled' })
  } catch {
    // Best-effort — the install is already headed to a terminal failure
    // state regardless of whether this cleanup step itself succeeds.
  }
}

/** Disable the webhook endpoint {@link stepBootstrapPending} recorded for `installId`, if any — the requirement that a failed install never leaves a live endpoint receiving real customer events. Reads the `webhookEndpointId` off the `endpoint_verified` audit event (the one place it is ever recorded); a no-op if that event doesn't exist (the install never got that far). Never throws — same best-effort posture as {@link revokeIssuedCredentials}. */
async function disableRecordedEndpoint(
  deps: ModuleInstallerDeps,
  installId: string,
): Promise<void> {
  const events = await deps.installs.listEvents(installId)
  const event = [...events].reverse().find((e) => e.toState === 'endpoint_verified')
  const webhookEndpointId = (event?.detail as { webhookEndpointId?: string } | undefined)
    ?.webhookEndpointId
  if (webhookEndpointId === undefined) return
  try {
    await deps.webhookEndpoints.patch(webhookEndpointId, { status: 'disabled' })
  } catch {
    // Best-effort — see revokeIssuedCredentials's same reasoning.
  }
}

/**
 * Move `install` to a terminal failure state, recording `reason` — the
 * shared tail of every PERMANENT failure branch below.
 *
 * ## Fence FIRST, side effects only on a win ()
 *
 * The fenced `transition` is attempted BEFORE any credential/endpoint
 * cleanup, and that cleanup runs ONLY when the transition actually won.
 * The reverse order — revoke, then attempt the transition — let a STALE
 * worker (one whose view of `install` predates a newer worker completing
 * the install for real) disable the Assistant of a healthy, `active`
 * install: the stale worker's revoke would run unconditionally, and only
 * afterward would its transition attempt discover it had lost the race,
 * by which point the damage was already done and the audit trail shows no
 * failure event to explain it. Whether or not the transition wins, this
 * function still reports `deadLetter` for the CURRENT delivery — either
 * this worker recorded the failure for real, or a newer worker has
 * already moved the row past this worker's stale view of it, and either
 * way there is nothing further for THIS invocation to do (module doc's "a
 * stale worker loses" section).
 *
 * ## Releases its OWN lease on a win ()
 *
 * A winning `transition` re-mints `lease_token` (every CAS does), but this
 * function is called from deep inside a step — its caller returns
 * `deadLetter` immediately afterward without ever assigning the loop's
 * `install` variable to the transition's NEW record. The handler's `finally`
 * therefore releases using the STALE, PRE-transition `leaseToken`, which
 * matches nothing (module doc's "claim" section: a fenceToken mismatch is
 * silently ignored, exactly like a losing CAS) — a terminal row would keep
 * `lease_expires_at` set for the full TTL even though nothing is ever going
 * to reclaim it. Releasing HERE, with the token the winning transition
 * actually just minted, closes that gap directly; the outer `finally`'s
 * later attempt with the old token is then a harmless, already-covered
 * no-op.
 */
async function failInstall(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
  toState: 'build_failed' | 'verification_failed' | 'cleanup_required',
  reason: string,
): Promise<QueueHandlerResult> {
  const result = await deps.installs.transition(
    install.id,
    install.state,
    toState,
    install.leaseToken,
    {
      detail: { reason },
    },
  )
  if (result.ok) {
    await revokeIssuedCredentials(deps, install.id)
    await disableRecordedEndpoint(deps, install.id)
    await deps.installs.release(install.id, result.install.leaseToken).catch(() => {})
  }
  return { kind: 'deadLetter', reason }
}

/**
 * Ensure `assistants` holds a row for `assistantId` whose `token_hash`
 * matches `assistantToken` — called ONLY after a `credentials_issued`
 * transition has already committed (module doc's "Credentials" section).
 * `assistantToken` is always recovered from the WINNING transition's own
 * recorded ciphertext, never from a caller-local variable a losing
 * concurrent mint could have produced, so the hash this writes is, by
 * construction, the one the audit trail actually describes. Idempotent
 * and safe to re-run on every re-entry into the `credentials_issued`
 * state (a crash between the transition committing and this write
 * completing, or an ordinary re-run of an already-provisioned install) —
 * {@link deterministicAssistantId}'s doc explains why a repeat mint here
 * is always a ROTATE onto the same row, never a duplicate `create`.
 */
async function ensureAssistantMatchesCredentials(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
  assistantId: string,
  assistantToken: string,
): Promise<void> {
  const parsed = parseAssistantToken(assistantToken)
  if (parsed === null) {
    throw new Error(
      `installer: recorded credential ciphertext for install ${install.id} does not decode to a valid Assistant token`,
    )
  }
  const tokenHash = hashAssistantSecret(parsed.secret)
  const existing = await deps.assistants.get(assistantId)
  if (existing === null) {
    await deps.assistants.create({
      id: assistantId,
      name: `module:${install.moduleSlug}`,
      module: install.moduleSlug,
      tokenHash,
    })
    return
  }
  await deps.assistants.updateTokenHash(assistantId, tokenHash)
  if (existing.status !== 'active') {
    await deps.assistants.patch(assistantId, { status: 'active' })
  }
}

/**
 * Ensure the webhook endpoint {@link stepBootstrapPending} recorded for
 * `install` is `'active'` — called on EVERY entry into the
 * `endpoint_verified` state, BEFORE this state's own CAS to `active`
 * (mirroring {@link ensureAssistantMatchesCredentials}'s
 * reconcile-before-the-next-transition shape for `credentials_issued`).
 * Reads the id off the `endpoint_verified` event's own recorded detail —
 * never a local variable a possibly-crashed earlier attempt might have
 * held — so a fresh delivery re-entering this state after ANY crash (in
 * particular, between `stepBootstrapPending`'s CAS committing and this
 * promote running) reconciles exactly the same way a first-time pass
 * does. `WebhookEndpointStore.patch` is a plain idempotent `UPDATE`, so
 * repeating it on an already-`active` row is a no-op. Throws (a bug, not a
 * transient failure) if no `endpoint_verified` event is recorded — the
 * caller is only ever reached from that state, which cannot happen without
 * one.
 */
async function ensureEndpointActive(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
): Promise<void> {
  const events = await deps.installs.listEvents(install.id)
  const event = [...events].reverse().find((e) => e.toState === 'endpoint_verified')
  const webhookEndpointId = (event?.detail as { webhookEndpointId?: string } | undefined)
    ?.webhookEndpointId
  if (webhookEndpointId === undefined) {
    throw new Error(
      `installer: install ${install.id} reached endpoint_verified with no webhookEndpointId recorded — this is a bug, not a transient failure`,
    )
  }
  await deps.webhookEndpoints.patch(webhookEndpointId, { status: 'active' })
}

// --- step: planned -> credentials_issued ------------------------------

/**
 * Mint the Assistant this module's runtime authenticates as, and a fresh
 * webhook signing secret, then persist an ENCRYPTED envelope of both
 * (module doc's "Credentials" section) on this transition's audit event.
 *
 * Safe to re-run: {@link deterministicAssistantId} means a retry after a
 * crash (transition never persisted, so `install.state` is still
 * `'planned'`) finds the SAME Assistant row via `AssistantStore.get` and
 * rotates its token rather than attempting a second `create` — no orphaned
 * Assistant is ever left behind by a retried mint, only a superseded
 * token hash on the one canonical row.
 */
async function stepCredentialsIssued(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
): Promise<TransitionOutcome> {
  // Mint ENTIRELY in memory — nothing is written to `assistants` yet. See
  // the module doc's "Credentials" section for why this ordering is the
  // fix, not a stylistic preference.
  const assistantId = deterministicAssistantId(install.id)
  const mint = deps.mintAssistantToken ?? mintAssistantToken
  const minted = mint(assistantId)
  const webhookSecret = randomBytes(32).toString('base64url')
  const credentialCiphertext = encodeCredentialCiphertext(
    { assistantToken: minted.token, webhookSecret },
    deps.encryptionKey,
  )

  // The winning transition is the ENTIRE job of this function — the
  // handler's `credentials_issued` case (immediately next in the SAME
  // loop, whether that's this invocation continuing or a fresh delivery
  // re-entering after a crash) is what reconciles `assistants` against
  // whatever this transition actually recorded. Keeping that reconcile in
  // exactly one place means "just won" and "re-entering after a crash"
  // are the SAME code path, not two that can drift apart.
  return tryTransition(
    deps.installs,
    install.id,
    'planned',
    'credentials_issued',
    install.leaseToken,
    {
      detail: { assistantId, credentialCiphertext },
    },
  )
}

// --- step: credentials_issued -> project_created -----------------------

/** Matches the error text a real (or faked) hosting API returns for "this name is already taken" — deliberately loose (message-substring, not a typed error from `../deploy/provider.ts`, which has no typed conflict signal) since this is the ONE signal available to distinguish "already created by an earlier attempt" from any other failure. See {@link stepProjectCreated}'s doc for why this is the best available answer, not a complete one. */
const PROJECT_NAME_CONFLICT_RE = /already (exists|in use|taken)/i

/**
 * Create the hosting project for this install and persist its id
 * IMMEDIATELY (module doc's "Async by construction").
 *
 * ## The orphan-project case, honestly
 *
 * `../deploy/provider.ts` has no `getProjectByName`/list call — so if THIS
 * worker crashes after `provider.createProject` returns but before the
 * `transition` below persists `remoteProjectId`, a retry has no way to
 * look the already-created project back up by id. What it CAN do: always
 * request the SAME deterministic name for a given install
 * ({@link projectNameFor}). Vercel project names are unique per team, so a
 * genuine retry-after-crash gets a LOUD, named conflict back from the API
 * instead of silently succeeding with a second, orphaned project — this
 * function treats that conflict as a PERMANENT failure
 * (`cleanup_required`, not `build_failed`, since fixing it requires an
 * operator to look at the Vercel dashboard, not a code retry) rather than
 * pretending it can safely proceed with a project id it does not actually
 * have. This is the module doc's documented gap: real reconciliation needs
 * a lookup this interface does not offer; a deterministic name turns a
 * silent duplicate into a loud, operator-visible one instead.
 */
async function stepProjectCreated(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
  provider: DeployProvider,
  teamId: string,
  attempts: number,
): Promise<TransitionOutcome | { retry: QueueHandlerResult }> {
  const name = projectNameFor(install)
  try {
    const result = await provider.createProject({ teamId, name })
    const outcome = await tryTransition(
      deps.installs,
      install.id,
      'credentials_issued',
      'project_created',
      install.leaseToken,
      { detail: { remoteProjectId: result.projectId }, remoteProjectId: result.projectId },
    )
    return outcome
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (PROJECT_NAME_CONFLICT_RE.test(message)) {
      return {
        retry: await failInstall(
          deps,
          install,
          'cleanup_required',
          `project '${name}' already exists on the hosting account from an earlier attempt — ` +
            `an operator must delete it (or reconcile it by hand) before this install can retry: ${message}`,
        ),
      }
    }
    if (attempts >= INSTALL_MAX_ATTEMPTS) {
      return {
        retry: await failInstall(
          deps,
          install,
          'build_failed',
          `creating hosting project '${name}' failed after ${attempts} attempts: ${message}`,
        ),
      }
    }
    return { retry: { kind: 'retry', backoffSeconds: backoffSeconds(attempts) } }
  }
}

function projectNameFor(install: ModuleInstallRecord): string {
  return `ht-module-${install.moduleSlug}-${install.id.slice(0, 8)}`
}

// --- step: project_created -> artifact_uploaded -------------------------

/**
 * Download + verify the module artifact, extract it, validate its
 * `module.config.json`, build the FULL env var set (engine-managed values
 * this file minted + operator-managed values from the job payload — module
 * brief's "Config" rule), push them to the hosting project, then upload the
 * artifact's files. Content-addressed uploads
 * (`../deploy/vercel-adapter.ts`'s `uploadArtifact`, keyed by each file's
 * own digest) are naturally idempotent, so — unlike {@link
 * stepProjectCreated} and {@link stepDeploymentCreated} — a crash-and-retry
 * of this step is not a new orphan-resource risk: re-uploading the same
 * bytes is a no-op on the remote side.
 */
async function stepArtifactUploaded(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
  provider: DeployProvider,
  teamId: string,
  job: ModuleInstallJob,
  attempts: number,
): Promise<TransitionOutcome | { retry: QueueHandlerResult }> {
  const remoteProjectId = install.remoteProjectId
  if (remoteProjectId === null) {
    return {
      retry: await failInstall(
        deps,
        install,
        'build_failed',
        'installer: reached artifact_uploaded step with no remoteProjectId recorded — this is a bug, not a transient failure',
      ),
    }
  }

  const download = await deps.catalog.downloadArtifact({
    slug: install.moduleSlug,
    version: install.desiredReleaseVersion,
  })
  if (!download.ok) {
    if (download.permanent || attempts >= INSTALL_MAX_ATTEMPTS) {
      return {
        retry: await failInstall(
          deps,
          install,
          'build_failed',
          `artifact download failed: ${download.message}`,
        ),
      }
    }
    return { retry: { kind: 'retry', backoffSeconds: backoffSeconds(attempts) } }
  }

  // the catalog seam already proves the manifest is validly signed
  // by a TRUSTED first-party key — but every first-party release shares
  // that key, so a compromised/careless marketplace could still substitute
  // a DIFFERENT, also-validly-signed release for this exact module/version
  // request. Refuse PERMANENTLY unless the manifest's own identity matches
  // what THIS install approved (`ArtifactManifestIdentity`'s doc). This
  // check runs before extraction/upload — an identity mismatch never
  // touches the filesystem or the hosting provider.
  if (
    download.artifact.manifest.artifactSha256 !== install.artifactDigest ||
    download.artifact.manifest.keyId !== install.manifestKeyId
  ) {
    return {
      retry: await failInstall(
        deps,
        install,
        'build_failed',
        `artifact identity mismatch: catalog served a manifest for sha256=${download.artifact.manifest.artifactSha256} keyId=${download.artifact.manifest.keyId}, ` +
          `but this install approved sha256=${install.artifactDigest} keyId=${install.manifestKeyId} — refusing a validly-signed but SUBSTITUTED release`,
      ),
    }
  }

  let files: DeployFile[]
  let moduleConfig: ModuleConfigV1
  try {
    const extract = deps.extractArtifact ?? defaultExtractArtifact
    ;({ files, moduleConfig } = await extract(download.artifact.tarballBytes))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      retry: await failInstall(
        deps,
        install,
        'build_failed',
        `artifact extraction failed: ${message}`,
      ),
    }
  }

  const credentials = await loadIssuedCredentials(deps.installs, install.id, deps.encryptionKey)

  const engineManagedValues: Record<string, string> = {
    [ENV_ASSISTANT_TOKEN]: credentials.assistantToken,
    [ENV_WEBHOOK_SECRET]: credentials.webhookSecret,
  }

  const vars: { key: string; value: string; sensitive: boolean }[] = []
  const engineManagedVarNames: string[] = []
  for (const envVar of moduleConfig.env) {
    if (envVar.owner === 'engine-managed') {
      engineManagedVarNames.push(envVar.name)
      const value = engineManagedValues[envVar.name]
      if (value === undefined) {
        return {
          retry: await failInstall(
            deps,
            install,
            'build_failed',
            `module.config.json declares engine-managed var '${envVar.name}', which this engine does not know how to supply (recognized: ${[...WELL_KNOWN_ENGINE_VARS].join(', ')})`,
          ),
        }
      }
      vars.push({ key: envVar.name, value, sensitive: envVar.sensitive })
    } else {
      const value = job.operatorEnvVars[envVar.name]
      if (value === undefined) {
        if (envVar.required) {
          return {
            retry: await failInstall(
              deps,
              install,
              'build_failed',
              `module.config.json requires operator-managed var '${envVar.name}', which was not supplied`,
            ),
          }
        }
        continue
      }
      vars.push({ key: envVar.name, value, sensitive: envVar.sensitive })
    }
  }

  try {
    await provider.setEnvVars({ teamId, projectId: remoteProjectId, vars })
    const uploadResult = await provider.uploadArtifact({
      teamId,
      projectId: remoteProjectId,
      files,
    })
    return tryTransition(
      deps.installs,
      install.id,
      'project_created',
      'artifact_uploaded',
      install.leaseToken,
      { detail: { uploadId: uploadResult.uploadId, engineManagedVarNames } },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (attempts >= INSTALL_MAX_ATTEMPTS) {
      return {
        retry: await failInstall(
          deps,
          install,
          'build_failed',
          `configuring/uploading the artifact failed: ${message}`,
        ),
      }
    }
    return { retry: { kind: 'retry', backoffSeconds: backoffSeconds(attempts) } }
  }
}

// --- step: artifact_uploaded -> deployment_created -----------------------

/**
 * Create the deployment and persist its id immediately.
 *
 * ## Why a duplicate DEPLOYMENT (unlike a duplicate PROJECT) is an accepted
 * cost, not a safety violation
 *
 * The same "crash between call and persist" gap {@link stepProjectCreated}
 * documents applies here too, and `../deploy/provider.ts` has no
 * lookup-by-id call to reconcile with either. But a duplicate deployment
 * does not create a duplicate SECURITY boundary the way a duplicate
 * project could: nothing is EVER registered to receive real events
 * (module doc's "Candidate-then-cutover" section) until {@link
 * stepBootstrapPending}'s challenge succeeds against ONE specific
 * deployment id — the one THIS invocation's `remoteDeploymentId` ends up
 * recording. A retry that produces a second, never-referenced deployment
 * is wasted build minutes an operator can clean up later, not a leak. This
 * file therefore retries a transient `createDeployment` failure exactly
 * like any other step, rather than treating an ambiguous outcome here as
 * loudly as {@link stepProjectCreated} does.
 */
async function stepDeploymentCreated(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
  provider: DeployProvider,
  teamId: string,
  attempts: number,
): Promise<TransitionOutcome | { retry: QueueHandlerResult }> {
  const events = await deps.installs.listEvents(install.id)
  const uploadedEvent = [...events].reverse().find((e) => e.toState === 'artifact_uploaded')
  const uploadId = (uploadedEvent?.detail as { uploadId?: string } | undefined)?.uploadId
  const remoteProjectId = install.remoteProjectId
  if (remoteProjectId === null || uploadId === undefined) {
    return {
      retry: await failInstall(
        deps,
        install,
        'build_failed',
        'installer: reached deployment_created step with no remoteProjectId/uploadId recorded — this is a bug, not a transient failure',
      ),
    }
  }

  try {
    const result = await provider.createDeployment({
      teamId,
      projectId: remoteProjectId,
      uploadId,
      target: install.environment,
    })
    return tryTransition(
      deps.installs,
      install.id,
      'artifact_uploaded',
      'deployment_created',
      install.leaseToken,
      {
        detail: { remoteDeploymentId: result.deploymentId, deploymentUrl: result.url },
        remoteDeploymentId: result.deploymentId,
      },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (attempts >= INSTALL_MAX_ATTEMPTS) {
      return {
        retry: await failInstall(
          deps,
          install,
          'build_failed',
          `creating the deployment failed: ${message}`,
        ),
      }
    }
    return { retry: { kind: 'retry', backoffSeconds: backoffSeconds(attempts) } }
  }
}

async function loadDeploymentUrl(installs: ModuleInstallStore, installId: string): Promise<string> {
  const events = await installs.listEvents(installId)
  const event = [...events].reverse().find((e) => e.toState === 'deployment_created')
  const url = (event?.detail as { deploymentUrl?: string } | undefined)?.deploymentUrl
  if (url === undefined) {
    throw new Error(`installer: install ${installId} has no recorded deployment url`)
  }
  return url
}

// --- step: build_pending (poll) -----------------------------------------

/**
 * Poll the deployment's build state. Transitions to `'bootstrap_pending'`
 * once `'ready'`, and PERMANENTLY fails (revoking minted credentials) on
 * `'error'`/`'canceled'` — a failed build is never transient, so this does
 * not wait for {@link INSTALL_MAX_ATTEMPTS} the way network-flake retries
 * elsewhere in this file do.
 *
 * ## Not-yet-ready: re-enqueue a fresh job, never a bare `retry` ()
 *
 * While still `'queued'`/`'building'`, this function does NOT return
 * `{ kind: 'retry' }` — see {@link BUILD_POLL_MAX_ATTEMPTS}'s doc for why
 * that would let the shared queue adapter's own attempts-based dead-letter
 * ceiling (5, by default) kill this row long before a legitimately slow
 * build finishes. Instead it calls `deps.enqueueInstallJob` with the poll
 * count incremented on the job payload, then returns a plain `ack` for
 * THIS delivery — a brand new `queue_jobs` row starts the next poll at
 * `attempts = 0`, entirely decoupled from this handler's own budget. This
 * also makes the poll interval genuinely fixed at 15s: `enqueueInstallJob`
 * schedules its `delaySeconds` directly, never passing through the
 * adapter's `backoffSeconds` hint (which multiplies by `2 ^ (attempts -
 * 1)`) at all.
 */
async function stepPollBuild(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
  provider: DeployProvider,
  teamId: string,
  job: ModuleInstallJob,
): Promise<TransitionOutcome | { retry: QueueHandlerResult }> {
  const remoteDeploymentId = install.remoteDeploymentId
  if (remoteDeploymentId === null) {
    return {
      retry: await failInstall(
        deps,
        install,
        'build_failed',
        'installer: reached build_pending with no remoteDeploymentId recorded — this is a bug, not a transient failure',
      ),
    }
  }

  const state = await provider.getDeploymentState({
    teamId,
    deploymentId: remoteDeploymentId,
  })

  if (state.state === 'ready') {
    return tryTransition(
      deps.installs,
      install.id,
      'build_pending',
      'bootstrap_pending',
      install.leaseToken,
      { detail: { deploymentState: state.state } },
    )
  }
  if (state.state === 'error' || state.state === 'canceled') {
    return {
      retry: await failInstall(
        deps,
        install,
        'build_failed',
        `deployment ${remoteDeploymentId} reached terminal build state '${state.state}'`,
      ),
    }
  }

  const pollAttempts = (job.buildPollAttempts ?? 0) + 1
  if (pollAttempts >= BUILD_POLL_MAX_ATTEMPTS) {
    return {
      retry: await failInstall(
        deps,
        install,
        'build_failed',
        `deployment ${remoteDeploymentId} did not become ready after ${pollAttempts} polls (still '${state.state}')`,
      ),
    }
  }
  // Fixed, modest 15s poll interval — genuinely fixed now (see this
  // function's own doc), never compounded by the queue adapter's
  // exponential backoff multiplier.
  await deps.enqueueInstallJob({ ...job, buildPollAttempts: pollAttempts }, 15)
  return { retry: { kind: 'ack' } }
}

// --- step: bootstrap_pending -> endpoint_verified ------------------------

/**
 * Send the possession challenge (`./challenge.ts`) to the deployment's URL.
 * On success, create the REAL `webhook_endpoints` row, DISABLED — the
 * module doc's cutover point — using the SAME secret the module was
 * already given as an env var, so its signing key matches on the very
 * first real delivery. refuses PERMANENTLY if that create coalesced
 * onto an existing row holding a DIFFERENT secret (a genuine url
 * collision across owners, never a same-install retry). On failure,
 * permanently fail the install (a challenge failure is never transient:
 * the URL either answers correctly or it doesn't) WITHOUT touching any
 * previously-active endpoint (module doc's "Candidate-then-cutover,
 * concretely").
 *
 * ## Promoting the endpoint to `active` deliberately does NOT happen here
 *
 * Promoting inline — right after winning this function's own CAS to
 * `endpoint_verified` — would make the endpoint's final state depend on
 * this function completing atomically end to end. It cannot: a crash or a
 * thrown DB error between that CAS committing and the promote leaves the
 * row `disabled` forever while `install.state` already reads
 * `endpoint_verified`, and no later code path would touch the endpoint
 * again. The result is an install that reaches `active`, receives nothing,
 * and has no failure state to surface it.
 *
 * So the promote lives in the handler's `endpoint_verified` case — an
 * idempotent reconcile-before-the-next-CAS step, re-read off
 * the `endpoint_verified` event's own recorded `webhookEndpointId` on EVERY
 * entry into that state (the same shape {@link ensureAssistantMatchesCredentials}
 * uses for `credentials_issued`), so a crash anywhere in this sequence is
 * recovered by the next delivery rather than requiring this exact function
 * to complete atomically end to end.
 */
async function stepBootstrapPending(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
): Promise<TransitionOutcome | { retry: QueueHandlerResult }> {
  const deploymentUrl = await loadDeploymentUrl(deps.installs, install.id)
  const credentials = await loadIssuedCredentials(deps.installs, install.id, deps.encryptionKey)

  const result = await verifyEndpointPossession(
    { challengeUrl: deploymentUrl, secret: credentials.webhookSecret },
    deps.challenge,
  )

  if (!result.ok) {
    return {
      retry: await failInstall(
        deps,
        install,
        'verification_failed',
        `endpoint possession challenge failed (${result.reason}): ${result.message}`,
      ),
    }
  }

  // create the row DISABLED — it must never receive a real delivery
  // before this install has actually won its own fenced transition below.
  // `WebhookEndpointStore.create`'s `url` uniqueness (migration 031)
  // additionally coalesces a second create for the SAME url (a genuine
  // two-worker race, or this exact step re-running after a crash) onto
  // the SAME row rather than duplicating it — see that store's module
  // doc's "create is idempotent on url" section.
  const endpoint = await deps.webhookEndpoints.create({
    url: deploymentUrl,
    secret: credentials.webhookSecret,
    events: [],
    module: install.moduleSlug,
    status: 'disabled',
  })

  // `create`'s url-coalescing (above) returns the EXISTING row's own
  // secret on a conflict — never the caller's freshly-supplied one, per
  // that store's own doc. If this install's own secret doesn't match what
  // came back, the coalesced row belongs to a DIFFERENT owner (an
  // operator-registered endpoint at the same url, or a re-provisioned
  // install after rotation): every future delivery would be signed with a
  // key this module doesn't hold and silently fail verification on the
  // receiving end. This can never happen on a same-install crash-retry
  // (recovering the identical ciphertext each time), only on a genuine
  // URL collision across owners — which needs an operator to resolve, not
  // a code retry.
  if (endpoint.secret !== credentials.webhookSecret) {
    return {
      retry: await failInstall(
        deps,
        install,
        'cleanup_required',
        `webhook endpoint url ${deploymentUrl} is already registered under a DIFFERENT secret ` +
          `than this install's own — an operator must reconcile the url collision before this install can retry`,
      ),
    }
  }

  return tryTransition(
    deps.installs,
    install.id,
    'bootstrap_pending',
    'endpoint_verified',
    install.leaseToken,
    { detail: { webhookEndpointId: endpoint.id } },
  )
}

// --- step: active update — config-drift refusal --------------------------

/**
 * The ONLY handling this file gives an `isUpdate` job (module doc's
 * "Candidate-then-cutover" section explains why a running module is never
 * touched beyond this check — condition 7: "feed/license failures may
 * affect NEW installs only — never disable, degrade, or reconfigure a
 * RUNNING module"). Refuses outright, WITHOUT any remote call, if
 * `job.operatorEnvVars` supplies a key this install already recorded as
 * `engine-managed` at `artifact_uploaded` time — the schema-level statement
 * of "v1 rejects drift rather than silently reconciling" the ticket brief
 * asks for. A clean update (no drift) is acked as a no-op: this ticket's
 * owned files give `ModuleInstallStore` no way to change
 * `desiredReleaseVersion`/`artifactDigest` on an existing row (see that
 * store's interface), so re-running the FULL provisioning pipeline for a
 * version bump is a later ticket's work, not simulated here.
 */
async function stepCheckConfigDrift(
  deps: ModuleInstallerDeps,
  install: ModuleInstallRecord,
  job: ModuleInstallJob,
): Promise<QueueHandlerResult> {
  const engineManagedVarNames = await loadEngineManagedVarNames(deps.installs, install.id)
  if (engineManagedVarNames !== null) {
    for (const key of Object.keys(job.operatorEnvVars)) {
      if (engineManagedVarNames.has(key)) {
        return {
          kind: 'deadLetter',
          reason:
            `refusing update: '${key}' is an engine-managed var for install ${install.id} — ` +
            'v1 refuses a drifted engine-managed value rather than silently reconciling it',
        }
      }
    }
  }
  return { kind: 'ack' }
}

// --- the handler -----------------------------------------------------------

/**
 * Build the `QueueMessageHandler<ModuleInstallJob>` that drives one install
 * through as much of its lifecycle as it can in this invocation. See the
 * module doc for the loop shape, the claim-first discipline, the
 * fence-loss behavior, and the candidate-then-cutover discipline.
 */
export function createModuleInstallHandler(
  deps: ModuleInstallerDeps,
): QueueMessageHandler<ModuleInstallJob> {
  return async (message: QueueMessage<ModuleInstallJob>): Promise<QueueHandlerResult> => {
    const job = message.payload

    // (root cause): claim BEFORE doing anything else. A refused
    // claim means this delivery performs ZERO further work — no
    // connection lookup, no provider call, no mint — not merely that a
    // later write loses a race (module doc's "The claim comes first").
    const claimed = await deps.installs.claim(job.installId, INSTALL_CLAIM_TTL_SECONDS)
    if (!claimed.ok) {
      if (claimed.reason === 'not_found') {
        return { kind: 'deadLetter', reason: `module install ${job.installId} does not exist` }
      }
      // 'lease_held' — another delivery genuinely holds the lease right
      // now. This is an ordinary outcome for an at-least-once queue (a
      // concurrent redelivery) MOST of the time, but a live lease only
      // asserts someone else currently holds it — it says nothing about
      // whether that holder is still alive (). A worker that crashed
      // between winning a CAS and completing its next write leaves the
      // lease held for the full `INSTALL_CLAIM_TTL_SECONDS`; `ack`ing here
      // would DELETE this job forever, permanently stranding the install
      // (never redelivered, no sweeper exists to re-drive it). `retry`
      // only asserts "try again later," which is safe whether the holder
      // is a live concurrent worker (the retry harmlessly finds the row
      // already advanced) or a dead one (the retry eventually lands after
      // the lease naturally expires). Backed off like every other
      // transient-retry path in this file so a genuinely busy lease
      // doesn't spin hot.
      return { kind: 'retry', backoffSeconds: backoffSeconds(message.attempts) }
    }
    let install = claimed.install

    // resolved LAZILY, only by the states that actually need a
    // provider, and cached for the rest of this invocation — see
    // `resolveProvider`'s own doc comment just below.
    let resolvedProvider: { provider: DeployProvider; teamId: string } | null = null
    async function resolveProvider(): Promise<
      { provider: DeployProvider; teamId: string } | { stop: QueueHandlerResult }
    > {
      if (resolvedProvider !== null) return resolvedProvider
      const connection = await deps.connections.get(install.vercelConnectionId)
      if (connection === null || connection.revokedAt !== null) {
        return {
          stop: await failInstall(
            deps,
            install,
            'build_failed',
            `install ${install.id} references a missing or revoked Vercel connection (${install.vercelConnectionId})`,
          ),
        }
      }
      const token = await deps.connections.getToken(connection.id)
      const provider = deps.createDeployProvider({ teamId: connection.teamId, token })
      resolvedProvider = { provider, teamId: connection.teamId }
      return resolvedProvider
    }

    try {
      for (;;) {
        switch (install.state) {
          case 'planned': {
            const outcome = await stepCredentialsIssued(deps, install)
            if ('stop' in outcome) return outcome.stop
            install = outcome.install
            continue
          }

          case 'credentials_issued': {
            // Re-entering this state (whether right after `planned`
            // above, or on a fresh delivery re-claiming after a crash)
            // always reconciles `assistants` against what THIS state's
            // own audit event recorded — see `ensureAssistantMatchesCredentials`'s
            // doc for why this is idempotent and never a duplicate write.
            const recovered = await loadIssuedCredentials(
              deps.installs,
              install.id,
              deps.encryptionKey,
            )
            await ensureAssistantMatchesCredentials(
              deps,
              install,
              recovered.assistantId,
              recovered.assistantToken,
            )

            const resolved = await resolveProvider()
            if ('stop' in resolved) return resolved.stop
            const outcome = await stepProjectCreated(
              deps,
              install,
              resolved.provider,
              resolved.teamId,
              message.attempts,
            )
            if ('retry' in outcome) return outcome.retry
            if ('stop' in outcome) return outcome.stop
            install = outcome.install
            continue
          }

          case 'project_created': {
            const resolved = await resolveProvider()
            if ('stop' in resolved) return resolved.stop
            const outcome = await stepArtifactUploaded(
              deps,
              install,
              resolved.provider,
              resolved.teamId,
              job,
              message.attempts,
            )
            if ('retry' in outcome) return outcome.retry
            if ('stop' in outcome) return outcome.stop
            install = outcome.install
            continue
          }

          case 'artifact_uploaded': {
            const resolved = await resolveProvider()
            if ('stop' in resolved) return resolved.stop
            const outcome = await stepDeploymentCreated(
              deps,
              install,
              resolved.provider,
              resolved.teamId,
              message.attempts,
            )
            if ('retry' in outcome) return outcome.retry
            if ('stop' in outcome) return outcome.stop
            install = outcome.install
            continue
          }

          case 'deployment_created': {
            const outcome = await tryTransition(
              deps.installs,
              install.id,
              'deployment_created',
              'build_pending',
              install.leaseToken,
            )
            if ('stop' in outcome) return outcome.stop
            install = outcome.install
            continue
          }

          case 'build_pending': {
            const resolved = await resolveProvider()
            if ('stop' in resolved) return resolved.stop
            const outcome = await stepPollBuild(
              deps,
              install,
              resolved.provider,
              resolved.teamId,
              job,
            )
            if ('retry' in outcome) return outcome.retry
            if ('stop' in outcome) return outcome.stop
            install = outcome.install
            continue
          }

          case 'bootstrap_pending': {
            const outcome = await stepBootstrapPending(deps, install)
            if ('retry' in outcome) return outcome.retry
            if ('stop' in outcome) return outcome.stop
            install = outcome.install
            continue
          }

          case 'endpoint_verified': {
            // reconcile the endpoint to active BEFORE the CAS
            // below, on every entry into this state — see
            // `ensureEndpointActive`'s own doc.
            await ensureEndpointActive(deps, install)
            const outcome = await tryTransition(
              deps.installs,
              install.id,
              'endpoint_verified',
              'active',
              install.leaseToken,
            )
            if ('stop' in outcome) return outcome.stop
            install = outcome.install
            continue
          }

          case 'active':
            // / non-negotiable condition 7: NO provider or
            // connection lookup ever happens for an already-`active`
            // install — a revoked/rotated Vercel connection, or a stray
            // redelivery, must never disable, degrade, or reconfigure a
            // RUNNING module. `stepCheckConfigDrift` itself makes no
            // remote call either (its own doc comment).
            if (job.isUpdate) {
              return await stepCheckConfigDrift(deps, install, job)
            }
            // Already fully installed and this is not an update request —
            // an at-least-once redelivery of a job whose prior attempt
            // already finished. Nothing to do.
            return { kind: 'ack' }

          // 'build_failed' | 'verification_failed' | 'rollback_pending' |
          // 'cleanup_required' | 'abandoned' — every terminal (or awaiting-
          // operator) state. Re-driving any of these is a deliberate,
          // separate operator action (a later ticket's retry/rollback API),
          // never an automatic side effect of a stray redelivery. Also
          // never resolves a provider — same condition-7 reasoning as
          // `active` above.
          default:
            return { kind: 'ack' }
        }
      }
    } finally {
      // Release promptly on every exit (module doc's "claim" section) —
      // `lease_expires_at` is a crash backstop, not the pacing mechanism.
      // Fenced on `install.leaseToken`, so a caller whose OWN claim
      // already lost a race never clears a NEWER claim's lease.
      await deps.installs.release(install.id, install.leaseToken).catch(() => {})
    }
  }
}
