/**
 * Passkey (WebAuthn) management API handlers (HT-75; specs/auth/passkeys.md
 * §5, §6, §9) — everything EXCEPT the login verify step, which dispatches
 * through the existing generic `POST /auth/verify` (`handleAuthVerify`,
 * `src/api/agents.ts`) via `WebAuthnAuthProvider` (`src/auth/
 * webauthn-provider.ts`). Per spec §4.2, options-minting is deliberately
 * OUTSIDE the `AuthProvider` seam — every handler here is provider-specific
 * HTTP surface, not something the seam needs to know about.
 *
 * Same shape as `src/api/agents.ts`: each handler is a pure function of an
 * already-authenticated, already-routed `Request` plus its dependencies.
 *
 * ## Step-up (spec §5)
 *
 * `registration/options` and `registration/verify` both require a valid,
 * unexpired `stepUpToken` naming the SAME acting Agent — minted by either
 * `step-up/password` or the `step-up/webauthn/*` pair. `options` CONSUMES
 * the token (single-use, DB-backed); `verify` re-validates signature+TTL+
 * agent-match but does NOT re-consume (spec §5.2 — a second consume would
 * always fail, which is not the property wanted there).
 *
 * ## Uniform failure shape
 *
 * Every ceremony/step-up/registration failure in this module is the SAME
 * generic `401 unauthorized` — no finer-grained code is ever returned here.
 * The one distinguishable exception the spec defines (`challenge_expired`,
 * §6.2) applies ONLY to the login path and is handled entirely in
 * `handleAuthVerify`/`webauthn-provider.ts`, not in this module.
 */

import type { AuthenticatorTransportFuture, RegistrationResponseJSON } from '@simplewebauthn/server'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { AuthProvider } from '../auth/provider.js'
import {
  uuidToBytes,
  verifyAuthenticationCeremony,
  type WebAuthnCeremonyDeps,
} from '../auth/webauthn-ceremony.js'
import { buildPasskeyAddedEmail } from '../auth/webauthn-notify-email.js'
import type { WebAuthnRpConfig } from '../auth/webauthn-rp.js'
import {
  DEFAULT_CHALLENGE_TOKEN_TTL_MS,
  DEFAULT_STEPUP_TOKEN_TTL_MS,
  mintChallengeToken,
  mintStepUpToken,
  verifyChallengeToken,
  verifyStepUpToken,
  type WebAuthnCeremony,
} from '../auth/webauthn-token.js'
import type { Db } from '../db/client.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender } from '../providers/index.js'
import type { AgentRecord, AgentStore } from '../store/agents.js'
import type { WebAuthnCredentialRecord, WebAuthnStore } from '../store/webauthn.js'
import { apiError, json, noContent } from './responses.js'
import { isUuid } from './uuid.js'

/** Dependencies every handler in this module needs. Built once per request by `src/api/index.ts`, from the `InboxApiDeps.webauthn` bag the composition root wires only when `config.uiBaseUrl` is set (spec §3 — "root.ts refuses to wire up WebAuthnAuthProvider when uiBaseUrl is unset", the identical rule for this whole feature). */
export interface WebAuthnApiDeps {
  db: Db
  store: WebAuthnStore
  agentStore: AgentStore
  /** The full provider registry — `step-up/password` re-dispatches to the registered `password` provider (spec §5.1) rather than re-implementing verification. */
  providers: AuthProvider[]
  keyring: Keyring
  rp: WebAuthnRpConfig
  /** Deployment display name shown in the OS passkey UI (spec §6.1's `rpName`). */
  rpName: string
  sender: EmailSender
  mailDomain: string
  supportAddress: string
}

function ceremonyDeps(deps: WebAuthnApiDeps): WebAuthnCeremonyDeps {
  return { db: deps.db, store: deps.store, keyring: deps.keyring, rp: deps.rp }
}

// --- shared helpers ----------------------------------------------------

async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

const UNAUTHORIZED = () => apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
const FORBIDDEN = () => apiError(403, 'forbidden', 'You may only manage your own passkeys.')
const NOT_FOUND = () => apiError(404, 'not_found', 'No such Agent or credential.')
const STEP_UP_REQUIRED = () =>
  apiError(401, 'unauthorized', 'Step-up verification is required and was not satisfied.')
const CEREMONY_FAILED = () => apiError(401, 'unauthorized', 'Passkey ceremony verification failed.')

/** Mint an `htw.` challenge token AND its `webauthn_challenges` DB row, in one call — every options-minting endpoint below does exactly this. Returns the raw challenge bytes too, ready for `generateRegistrationOptions`/`generateAuthenticationOptions`'s `challenge` param (module doc on webauthn-token.ts: passing a `Uint8Array`, not the base64url string, avoids a UTF8 double-encoding mismatch). */
async function mintAndStoreChallenge(
  deps: Pick<WebAuthnApiDeps, 'store' | 'keyring'>,
  ceremony: WebAuthnCeremony,
  agentId: string | null,
): Promise<{ challengeToken: string; challengeBytes: Uint8Array<ArrayBuffer> }> {
  const minted = mintChallengeToken(ceremony, agentId, deps.keyring)
  await deps.store.mintChallenge({
    nonce: minted.nonce,
    ceremony,
    agentId,
    expiresAt: new Date(Date.now() + DEFAULT_CHALLENGE_TOKEN_TTL_MS),
  })
  // A fresh `Uint8Array` (not a `Buffer`) — see webauthn-ceremony.ts's
  // identical note on why `@simplewebauthn/server`'s types need this.
  return {
    challengeToken: minted.token,
    challengeBytes: new Uint8Array(Buffer.from(minted.challengeB64, 'base64url')),
  }
}

/** Mint an `htsu.` step-up token AND its `webauthn_stepup_tokens` DB row (spec §5.1) — the shared success path for both step-up proof mechanisms. */
async function mintAndStoreStepUpToken(
  deps: Pick<WebAuthnApiDeps, 'store' | 'keyring'>,
  agentId: string,
): Promise<string> {
  const minted = mintStepUpToken(agentId, deps.keyring)
  await deps.store.mintStepUpToken({
    nonce: minted.nonce,
    agentId,
    expiresAt: new Date(Date.now() + DEFAULT_STEPUP_TOKEN_TTL_MS),
  })
  return minted.token
}

/** Re-validate (never re-consume — spec §5.2) a `stepUpToken` string against `agentId`. `null` on any failure (missing, malformed, expired, wrong-signature, or minted for a different Agent). */
function checkStepUpToken(raw: unknown, agentId: string, keyring: Keyring): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false
  const verified = verifyStepUpToken(raw, keyring)
  return verified !== null && verified.agentId === agentId
}

const MAX_CREDENTIAL_NAME_LENGTH = 200

/** `PATCH .../webauthn-credentials/{id}`'s `name` — required, non-blank, ≤200 chars. `null` on any violation. */
function validateCredentialName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_CREDENTIAL_NAME_LENGTH ? trimmed : null
}

/** `registration/verify`'s `name` — optional/lenient on the wire (spec §6.1, §9): an omitted, blank, or over-length value is replaced with a server-computed default, `"Passkey — {date}"`, before the INSERT ever runs — the write path (`webauthn_credentials.name NOT NULL`) is never at risk from a lenient caller. */
function normalizeRegistrationCredentialName(raw: unknown): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (trimmed.length === 0 || trimmed.length > MAX_CREDENTIAL_NAME_LENGTH) {
    return `Passkey — ${new Date().toISOString().slice(0, 10)}`
  }
  return trimmed
}

// --- wire shape ----------------------------------------------------------

interface CredentialJson {
  id: string
  name: string
  transports: string[]
  backupEligible: boolean
  backupState: boolean
  createdAt: string
  lastUsedAt: string | null
}

function toCredentialJson(credential: WebAuthnCredentialRecord): CredentialJson {
  return {
    id: credential.id,
    name: credential.name,
    transports: credential.transports,
    backupEligible: credential.backupEligible,
    backupState: credential.backupState,
    createdAt: credential.createdAt.toISOString(),
    lastUsedAt: credential.lastUsedAt === null ? null : credential.lastUsedAt.toISOString(),
  }
}

function excludeOrAllowList(
  credentials: WebAuthnCredentialRecord[],
): { id: string; transports?: AuthenticatorTransportFuture[] }[] {
  return credentials.map((credential) => ({
    id: credential.credentialId,
    transports: credential.transports as AuthenticatorTransportFuture[],
  }))
}

// --- POST /api/v1/auth/webauthn/authentication/options -------------------

/** `POST /api/v1/auth/webauthn/authentication/options` (spec §6.2, §9) — pre-session, no input. `allowCredentials` is deliberately OMITTED (required for conditional-UI discoverable-credential autofill). */
export async function handleAuthenticationOptions(
  deps: Pick<WebAuthnApiDeps, 'store' | 'keyring' | 'rp'>,
): Promise<Response> {
  const { challengeToken, challengeBytes } = await mintAndStoreChallenge(
    deps,
    'authentication',
    null,
  )
  const options = await generateAuthenticationOptions({
    rpID: deps.rp.rpId,
    challenge: challengeBytes,
    userVerification: 'required',
  })
  return json(200, { options, challengeToken })
}

// --- POST /api/v1/auth/step-up/password -----------------------------------

/** `POST /api/v1/auth/step-up/password` (spec §5.1) — session-required. Re-runs the registered `password` provider against the ACTING Agent's own (session-resolved) email — never client input. */
export async function handleStepUpPassword(
  actingAgent: AgentRecord | null,
  request: Request,
  deps: Pick<WebAuthnApiDeps, 'store' | 'keyring' | 'providers'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()

  const parsed = await parseJsonBody(request)
  const body = parsed.ok ? asRecord(parsed.value) : null
  const password = body?.password
  if (typeof password !== 'string') {
    return apiError(400, 'validation_failed', 'password is required.')
  }

  const passwordProvider = deps.providers.find((candidate) => candidate.key === 'password')
  if (passwordProvider === undefined) return STEP_UP_REQUIRED()

  const verified = await passwordProvider.authenticate({
    providerKey: 'password',
    email: actingAgent.email,
    password,
  })
  if (verified === null || verified.agentId !== actingAgent.id) return STEP_UP_REQUIRED()

  const stepUpToken = await mintAndStoreStepUpToken(deps, actingAgent.id)
  return json(200, { stepUpToken })
}

// --- POST /api/v1/auth/step-up/webauthn/options ----------------------------

/** `POST /api/v1/auth/step-up/webauthn/options` (spec §5.1) — session-required. Unlike login's `authentication/options`, `allowCredentials` IS populated (the ACTING Agent's own existing credentials) — the caller already knows who's asking. */
export async function handleStepUpWebAuthnOptions(
  actingAgent: AgentRecord | null,
  deps: Pick<WebAuthnApiDeps, 'store' | 'keyring' | 'rp'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()

  const existing = await deps.store.listCredentialsForAgent(actingAgent.id)
  const { challengeToken, challengeBytes } = await mintAndStoreChallenge(
    deps,
    'step-up',
    actingAgent.id,
  )
  const options = await generateAuthenticationOptions({
    rpID: deps.rp.rpId,
    allowCredentials: excludeOrAllowList(existing),
    challenge: challengeBytes,
    userVerification: 'required',
  })
  return json(200, { options, challengeToken })
}

// --- POST /api/v1/auth/step-up/webauthn/verify -----------------------------

/** `POST /api/v1/auth/step-up/webauthn/verify` (spec §5.1) — session-required. `{ response, challengeToken }`. Shares `verifyAuthenticationCeremony` with the login path (`webauthn-provider.ts`), `ceremony: 'step-up'`, and additionally requires the resolved credential's Agent to equal the acting Agent (spec: "proving a factor for a different, even genuinely valid, Agent does not step up this session"). */
export async function handleStepUpWebAuthnVerify(
  actingAgent: AgentRecord | null,
  request: Request,
  deps: WebAuthnApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()

  const parsed = await parseJsonBody(request)
  const body = parsed.ok ? asRecord(parsed.value) : null
  const challengeToken = body?.challengeToken
  const response = body?.response
  if (typeof challengeToken !== 'string' || typeof response !== 'object' || response === null) {
    return CEREMONY_FAILED()
  }

  const result = await verifyAuthenticationCeremony(ceremonyDeps(deps), {
    ceremony: 'step-up',
    responseJson: response,
    challengeToken,
    requireAgentId: actingAgent.id,
  })
  if (!result.ok) return CEREMONY_FAILED()

  const stepUpToken = await mintAndStoreStepUpToken(deps, actingAgent.id)
  return json(200, { stepUpToken })
}

// --- POST /api/v1/auth/webauthn/registration/options ------------------------

/** `POST /api/v1/auth/webauthn/registration/options` (spec §5.2, §6.1) — session-required, step-up-required. `{ stepUpToken }`: re-validated AND consumed here (the DB-backed single-use layer, spec §5.2). */
export async function handleRegistrationOptions(
  actingAgent: AgentRecord | null,
  request: Request,
  deps: WebAuthnApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()

  const parsed = await parseJsonBody(request)
  const body = parsed.ok ? asRecord(parsed.value) : null
  const stepUpTokenRaw = body?.stepUpToken

  if (typeof stepUpTokenRaw !== 'string' || stepUpTokenRaw.length === 0) return STEP_UP_REQUIRED()
  const verifiedStepUp = verifyStepUpToken(stepUpTokenRaw, deps.keyring)
  if (verifiedStepUp === null || verifiedStepUp.agentId !== actingAgent.id)
    return STEP_UP_REQUIRED()
  const consumed = await deps.store.consumeStepUpToken(verifiedStepUp.nonce)
  if (!consumed) return STEP_UP_REQUIRED()

  const existing = await deps.store.listCredentialsForAgent(actingAgent.id)
  const { challengeToken, challengeBytes } = await mintAndStoreChallenge(
    deps,
    'registration',
    actingAgent.id,
  )
  const options = await generateRegistrationOptions({
    rpName: deps.rpName,
    rpID: deps.rp.rpId,
    userName: actingAgent.email,
    userID: uuidToBytes(actingAgent.id),
    userDisplayName: actingAgent.name,
    challenge: challengeBytes,
    attestationType: 'none',
    excludeCredentials: excludeOrAllowList(existing),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  return json(200, { options, challengeToken })
}

// --- POST /api/v1/auth/webauthn/registration/verify -------------------------

/** `POST /api/v1/auth/webauthn/registration/verify` (spec §5.2, §6.1) — session-required, step-up-required. `{ response, challengeToken, stepUpToken, name? }`; re-validates (does NOT re-consume) `stepUpToken`. On success: sends the "new passkey added" notification (best-effort, spec §5.3); `409` if `credential_id` already claimed. */
export async function handleRegistrationVerify(
  actingAgent: AgentRecord | null,
  request: Request,
  deps: WebAuthnApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()

  const parsed = await parseJsonBody(request)
  const body = parsed.ok ? asRecord(parsed.value) : null
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  if (!checkStepUpToken(body.stepUpToken, actingAgent.id, deps.keyring)) return STEP_UP_REQUIRED()

  const challengeTokenRaw = body.challengeToken
  const responseRaw = body.response
  if (
    typeof challengeTokenRaw !== 'string' ||
    typeof responseRaw !== 'object' ||
    responseRaw === null
  ) {
    return CEREMONY_FAILED()
  }

  // Challenge token: application-level ceremony + agent-binding check
  // (spec §7's "registration's extra check"), THEN the DB-level single-use
  // consume.
  const verifiedChallenge = verifyChallengeToken(challengeTokenRaw, deps.keyring)
  if (
    verifiedChallenge === null ||
    verifiedChallenge.ceremony !== 'registration' ||
    verifiedChallenge.agentId !== actingAgent.id
  ) {
    return CEREMONY_FAILED()
  }
  // `actingAgent.id` is passed so the DB layer enforces the same binding the
  // app-level check above already applies — defense in depth, matching the
  // step-up path. Without it the binding would rest solely on that check.
  const consumed = await deps.store.consumeChallenge(
    verifiedChallenge.nonce,
    'registration',
    actingAgent.id,
  )
  if (!consumed) return CEREMONY_FAILED()

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
  try {
    verification = await verifyRegistrationResponse({
      response: responseRaw as RegistrationResponseJSON,
      expectedChallenge: verifiedChallenge.challengeB64,
      expectedOrigin: deps.rp.expectedOrigin,
      expectedRPID: deps.rp.rpId,
      requireUserVerification: true,
    })
  } catch {
    return CEREMONY_FAILED()
  }
  if (!verification.verified || verification.registrationInfo === undefined)
    return CEREMONY_FAILED()

  const { registrationInfo } = verification
  const name = normalizeRegistrationCredentialName(body.name)

  const inserted = await deps.store.insertCredential({
    agentId: actingAgent.id,
    credentialId: registrationInfo.credential.id,
    publicKey: registrationInfo.credential.publicKey,
    signCount: registrationInfo.credential.counter,
    transports: registrationInfo.credential.transports ?? [],
    backupEligible: registrationInfo.credentialDeviceType === 'multiDevice',
    backupState: registrationInfo.credentialBackedUp,
    name,
  })
  if (!inserted.ok) {
    return apiError(409, 'conflict', 'This passkey is already registered.')
  }

  try {
    await deps.sender.send(
      buildPasskeyAddedEmail({
        to: actingAgent.email,
        credentialName: inserted.credential.name,
        supportAddress: deps.supportAddress,
        mailDomain: deps.mailDomain,
      }),
    )
  } catch (err) {
    // Best-effort, non-blocking (spec §5.3) — the credential is already
    // durably created; a notification-send failure must not fail the
    // registration response.
    console.error('[webauthn] passkey-added notification send failed', err)
  }

  return json(201, { credential: toCredentialJson(inserted.credential) })
}

// --- GET /api/v1/agents/{id}/webauthn-credentials ---------------------------

async function resolveTargetAgent(
  id: string,
  actingAgent: AgentRecord | null,
  agentStore: AgentStore,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (actingAgent === null) return { ok: false, response: UNAUTHORIZED() }
  if (actingAgent.role !== 'admin' && actingAgent.id !== id) {
    return { ok: false, response: FORBIDDEN() }
  }
  if (!isUuid(id)) return { ok: false, response: NOT_FOUND() }
  const target = await agentStore.getAgent(id)
  if (target === null) return { ok: false, response: NOT_FOUND() }
  return { ok: true }
}

/** `GET /api/v1/agents/{id}/webauthn-credentials` (spec §9) — self, or admin. Never returns the public key or raw `credential_id` (spec §9, §10). */
export async function handleListCredentials(
  id: string,
  actingAgent: AgentRecord | null,
  deps: Pick<WebAuthnApiDeps, 'store' | 'agentStore'>,
): Promise<Response> {
  const resolved = await resolveTargetAgent(id, actingAgent, deps.agentStore)
  if (!resolved.ok) return resolved.response

  const credentials = await deps.store.listCredentialsForAgent(id)
  return json(200, { credentials: credentials.map(toCredentialJson) })
}

// --- PATCH /api/v1/agents/{id}/webauthn-credentials/{credentialId} ----------

/** `PATCH .../webauthn-credentials/{credentialId}` (spec §9, §5.4) — self, or admin. Rename only; NOT step-up-gated. */
export async function handlePatchCredential(
  id: string,
  credentialId: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: Pick<WebAuthnApiDeps, 'store' | 'agentStore'>,
): Promise<Response> {
  const resolved = await resolveTargetAgent(id, actingAgent, deps.agentStore)
  if (!resolved.ok) return resolved.response
  if (!isUuid(credentialId)) return NOT_FOUND()

  const parsed = await parseJsonBody(request)
  const body = parsed.ok ? asRecord(parsed.value) : null
  const name = body === null ? null : validateCredentialName(body.name)
  if (name === null) {
    return apiError(
      400,
      'validation_failed',
      `name is required and must be 1-${MAX_CREDENTIAL_NAME_LENGTH} characters.`,
    )
  }

  const updated = await deps.store.renameCredential(credentialId, id, name)
  if (updated === null) return NOT_FOUND()
  return json(200, { credential: toCredentialJson(updated) })
}

// --- DELETE /api/v1/agents/{id}/webauthn-credentials/{credentialId} --------

/** `DELETE .../webauthn-credentials/{credentialId}` (spec §9, §5.4, §9.1) — self, or admin. NOT step-up-gated (revoking shrinks an attacker's foothold, it doesn't create one). `409` on the defensive last-credential guard. */
export async function handleDeleteCredential(
  id: string,
  credentialId: string,
  actingAgent: AgentRecord | null,
  deps: Pick<WebAuthnApiDeps, 'store' | 'agentStore'>,
): Promise<Response> {
  const resolved = await resolveTargetAgent(id, actingAgent, deps.agentStore)
  if (!resolved.ok) return resolved.response
  if (!isUuid(credentialId)) return NOT_FOUND()

  const result = await deps.store.deleteCredential(credentialId, id)
  if (result === 'not_found') return NOT_FOUND()
  if (result === 'last_credential') {
    return apiError(
      409,
      'conflict',
      'Cannot revoke this Agent’s only remaining credential without a password identity.',
    )
  }
  return noContent()
}
