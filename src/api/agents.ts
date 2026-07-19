/**
 * The Agents & Authentication API handlers (HT-54; specs/auth/agents-and-auth.md
 * §6) — auth bootstrap (`/auth/providers`, `/setup`, `/auth/verify`,
 * `/auth/me`, `/auth/invite/accept`), Agent management (`/agents`,
 * `/agents/{id}`, `/agents/{id}/password`, `/agents/{id}/invite`), and
 * mailbox access (HT-54 follow-up, spec §3.4/§6: `/mailboxes`,
 * `/agents/{id}/mailboxes`).
 *
 * Same shape as `src/api/conversations.ts`: each handler is a pure function
 * of an already-authenticated (service Bearer), already-routed `Request`
 * plus its dependencies — `src/api/index.ts` authenticates and routes;
 * nothing here re-checks either. Every response goes through
 * `src/api/responses.ts`'s helpers.
 *
 * ## The acting-Agent header is a SEPARATE check from the service Bearer
 *
 * Per-endpoint, `src/api/index.ts` resolves the acting Agent
 * (`resolveActingAgent`, `src/api/acting-agent.ts`) and passes the result
 * (an {@link AgentRecord} or `null`) into the handlers below that need it.
 * `null` means "no acting Agent" — missing header, malformed value, or an
 * Agent that is missing/not `active` — and every handler that requires one
 * maps `null` to a generic `401 unauthorized`, exactly as spec §8 requires
 * (never a more specific message that would distinguish "no header" from
 * "disabled Agent" from "unknown id").
 *
 * ## Role gates
 *
 * - `GET /agents` (the roster) — any ACTIVE acting Agent, not admin-only:
 *   the inbox's assignee picker (any Agent may assign any Agent, spec §5's
 *   role model) needs the roster to render names, so admin-gating the list
 *   would make a non-admin's own assignee menu impossible. (Coordinator
 *   amendment, 2026-07-18 — the canonical spec text is being updated in the
 *   same PR; this comment states the AS-BUILT behavior.)
 * - `GET /agents/{id}` — admin, or self.
 * - Every mutation (`POST /agents`, `PATCH`, `DELETE`, `/password` on
 *   someone else, `/invite`) — admin-only, except a self `PATCH` (own
 *   name/timezone) and a self `/password` (own password), both spec-pinned
 *   exceptions.
 * - `GET /mailboxes`, `GET`/`PUT /agents/{id}/mailboxes` — admin-only, no
 *   self carve-out (spec §3.4/§6: mailbox grants are admin-only bookkeeping,
 *   not a self-service profile field).
 *
 * ## Error codes
 *
 * Two NEW slugs beyond the existing `unauthorized`/`not_found`/
 * `validation_failed`/`send_failed`/`server_error` set: `forbidden` (403, an
 * authenticated-but-not-permitted acting Agent) and `conflict` (409 — email
 * taken, last-admin violation, an invited Agent's status/password touched
 * outside its lifecycle, invites unavailable). Never `secret_hash`,
 * a password, or a token anywhere in a response body.
 */

import { buildInviteEmail } from '../auth/invite-email.js'
import { mintInviteToken, verifyInviteToken } from '../auth/invite-token.js'
import { hashPassword, MAX_PASSWORD_LENGTH } from '../auth/password-hash.js'
import type { AuthAttempt, AuthProvider } from '../auth/provider.js'
import type { Keyring } from '../mail/reply-token.js'
import type { OutboundEmail } from '../providers/email-sender.js'
import type { EmailSender } from '../providers/index.js'
import type { AgentRecord, AgentRole, AgentStore } from '../store/agents.js'
import type { MailboxRecord, MailboxStore } from '../store/mailboxes.js'
import { apiError, json, noContent } from './responses.js'
import { isUuid } from './uuid.js'

/**
 * The new `agents` field on `InboxApiDeps` (`src/api/index.ts`) — agents/auth
 * is CORE, not an optional/absent-by-default feature like `openTracking` or
 * `gmailPush`, so this is a REQUIRED part of `InboxApiDeps` (brief's
 * explicit pin). Deliberately narrow: `keyring`/`sender`/`mailDomain`/
 * `supportAddress` are already required top-level `InboxApiDeps` fields
 * (the invite path reuses them rather than duplicating config surface), so
 * this object carries only what's genuinely NEW.
 */
export interface AgentsApiDeps {
  store: AgentStore
  providers: AuthProvider[]
  /**
   * Mailbox access (HT-54 follow-up; spec §3.4/§6): REQUIRED, not
   * absent-by-default — `GET /api/v1/mailboxes` is the Permissions screen's
   * roster and has no meaningful "feature off" state on a deployment that
   * already has the `agents`/`agent_mailbox_access` tables (migration 018).
   */
  mailboxStore: MailboxStore
  /** The web UI's base URL (`HELPTHREAD_UI_BASE_URL`) — ABSENT when unset (spec §8's "a fresh deploy can't email before it can"): `sendInvite` still creates the Agent (`inviteSent: false`), and `/agents/{id}/invite` refuses with `409 conflict`. */
  uiBaseUrl?: string
}

/** Dependencies every handler in this module may need. Built once per request by `src/api/index.ts`, merging `InboxApiDeps.agents` with the top-level `keyring`/`sender`/`mailDomain`/`supportAddress` fields every request already carries. */
export interface AgentsHandlerDeps extends AgentsApiDeps {
  keyring: Keyring
  sender: EmailSender
  mailDomain: string
  supportAddress: string
}

// --- validation (spec's pinned rules) ---------------------------------------

const MAX_EMAIL_LENGTH = 254
const MIN_NAME_LENGTH = 1
const MAX_NAME_LENGTH = 200
const MIN_PASSWORD_LENGTH = 8
const MAX_TIMEZONE_LENGTH = 64

/** Trim + lowercase; require exactly one `@` with a nonempty local part and domain, ≤254 chars — no heroic regex (brief's pinned rule). `null` on any violation. */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null
  const at = trimmed.indexOf('@')
  if (at <= 0 || at === trimmed.length - 1) return null
  if (trimmed.indexOf('@', at + 1) !== -1) return null
  return trimmed
}

/** Trim; 1-200 chars. `null` on any violation. */
function validateName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length >= MIN_NAME_LENGTH && trimmed.length <= MAX_NAME_LENGTH ? trimmed : null
}

/** NOT trimmed (a user secret) — 8-256 chars. `null` on any violation. */
function validatePassword(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return raw.length >= MIN_PASSWORD_LENGTH && raw.length <= MAX_PASSWORD_LENGTH ? raw : null
}

function validateRole(raw: unknown): AgentRole | null {
  return raw === 'admin' || raw === 'agent' ? raw : null
}

/** ≤64 chars; validated by asking `Intl.DateTimeFormat` to accept it as a `timeZone` — the brief's pinned check, not a hand-rolled IANA-name allowlist. `null` on any violation. */
function validateTimezone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_TIMEZONE_LENGTH) return null
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: raw })
    return raw
  } catch {
    return null
  }
}

/**
 * `body.mailboxIds` (`PUT /api/v1/agents/{id}/mailboxes`, spec §3.4/§6) must
 * be an array of uuid-shaped strings — `null` on a non-array or any
 * non-uuid entry. Dedupes while preserving first-occurrence order (the
 * brief's pinned rule): the deduped array is both what gets stored
 * (`AgentStore.replaceAgentMailboxAccess` does not re-dedupe — see its own
 * doc) and what the 200 response echoes back as "the stored set."
 */
function validateMailboxIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const seen = new Set<string>()
  const ids: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isUuid(entry)) return null
    // Lowercase before dedupe AND storage: uuids are case-insensitive, and
    // Postgres normalizes the uuid column on insert — a mixed-case duplicate
    // that survived a case-sensitive dedupe here would collide with
    // `agent_mailbox_access`'s primary key inside the store's single INSERT.
    const normalized = entry.toLowerCase()
    if (!seen.has(normalized)) {
      seen.add(normalized)
      ids.push(normalized)
    }
  }
  return ids
}

/** Read and JSON-parse `request`'s body without ever throwing — mirrors `src/api/conversations.ts`'s helper of the same name (kept local per this codebase's per-file convention). */
async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

/** `typeof value === 'object' && value !== null`, narrowed to a plain record — the shared "is this a JSON object" gate every body-shape parser below starts with. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

// --- wire shape --------------------------------------------------------------

interface AgentJson {
  id: string
  email: string
  name: string
  role: AgentRole
  status: 'invited' | 'active' | 'disabled'
  timezone: string
  createdAt: string
  updatedAt: string
}

function toAgentJson(agent: AgentRecord): AgentJson {
  return {
    id: agent.id,
    email: agent.email,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    timezone: agent.timezone,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  }
}

/**
 * `GET /api/v1/mailboxes`' wire shape (spec §3.4/§6): `id`/`address`/`status`
 * ONLY — never `provider`, and certainly never a token or other OAuth
 * internal. `MailboxRecord` carries `provider` too, but this mapper is the
 * one place that decides what crosses the wire, matching `toAgentJson`'s
 * "never a secret" discipline for Agents.
 */
interface MailboxJson {
  id: string
  address: string
  status: MailboxRecord['status']
}

function toMailboxJson(mailbox: MailboxRecord): MailboxJson {
  return { id: mailbox.id, address: mailbox.address, status: mailbox.status }
}

const UNAUTHORIZED = () => apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
/** The login endpoint's own uniform failure — every `/auth/verify` miss is this exact response (spec §9's no-oracle rule), phrased for a sign-in, not for the acting-Agent header. */
const INVALID_CREDENTIALS = () => apiError(401, 'unauthorized', 'Invalid email or password.')
const NOT_FOUND = () => apiError(404, 'not_found', 'No Agent with that id.')

// --- GET /api/v1/auth/providers ---------------------------------------------

/** `GET /api/v1/auth/providers` (spec §6) — no acting-Agent header. */
export async function handleAuthProviders(
  deps: Pick<AgentsHandlerDeps, 'store' | 'providers'>,
): Promise<Response> {
  const count = await deps.store.countAgents()
  return json(200, {
    providers: deps.providers.map((provider) => provider.descriptor()),
    needsSetup: count === 0,
  })
}

// --- POST /api/v1/setup -----------------------------------------------------

/** `POST /api/v1/setup` (spec §6) — creates the first admin. No acting-Agent header (pre-session). */
export async function handleSetup(
  request: Request,
  deps: Pick<AgentsHandlerDeps, 'store'>,
): Promise<Response> {
  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  const name = validateName(body.name)
  const email = normalizeEmail(body.email)
  const password = validatePassword(body.password)
  if (name === null || email === null || password === null) {
    return apiError(
      400,
      'validation_failed',
      'name, email, and password are required and must be valid (password 8-256 characters).',
    )
  }

  const agent = await deps.store.createFirstAdmin({
    name,
    email,
    passwordHash: hashPassword(password),
  })
  if (agent === null) {
    return apiError(409, 'conflict', 'Setup has already been completed on this deployment.')
  }
  return json(201, { agent: toAgentJson(agent) })
}

// --- POST /api/v1/auth/verify -----------------------------------------------

/**
 * `POST /api/v1/auth/verify` (spec §6, §9) — dispatch to the named
 * provider. EVERY failure mode is the SAME generic `401` (unknown email,
 * wrong password, an unknown `providerKey`, a malformed body, an
 * `invited`/`disabled` Agent) — spec §9: "no oracle." No acting-Agent
 * header (pre-session).
 */
export async function handleAuthVerify(
  request: Request,
  deps: Pick<AgentsHandlerDeps, 'store' | 'providers'>,
): Promise<Response> {
  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return INVALID_CREDENTIALS()
  const body = asRecord(parsed.value)
  if (body === null) return INVALID_CREDENTIALS()

  const providerKey = body.providerKey
  if (typeof providerKey !== 'string') return INVALID_CREDENTIALS()

  const provider = deps.providers.find((candidate) => candidate.key === providerKey)
  if (provider === undefined) return INVALID_CREDENTIALS()

  const attempt: AuthAttempt = { ...body, providerKey }
  const verified = await provider.authenticate(attempt)
  if (verified === null) return INVALID_CREDENTIALS()

  const agent = await deps.store.getAgent(verified.agentId)
  if (agent === null) return INVALID_CREDENTIALS()

  return json(200, { agent: toAgentJson(agent) })
}

// --- GET /api/v1/auth/me ----------------------------------------------------

/** `GET /api/v1/auth/me` (spec §6) — acting-Agent header REQUIRED. */
export function handleAuthMe(actingAgent: AgentRecord | null): Response {
  if (actingAgent === null) return UNAUTHORIZED()
  return json(200, {
    id: actingAgent.id,
    email: actingAgent.email,
    name: actingAgent.name,
    role: actingAgent.role,
    timezone: actingAgent.timezone,
  })
}

// --- GET /api/v1/agents ------------------------------------------------------

/** `GET /api/v1/agents` (spec §6, as amended) — any ACTIVE acting Agent; the roster every assignee picker needs, not admin-gated. */
export async function handleListAgents(
  actingAgent: AgentRecord | null,
  deps: Pick<AgentsHandlerDeps, 'store'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  const agents = await deps.store.listAgents()
  return json(200, { agents: agents.map(toAgentJson) })
}

// --- POST /api/v1/agents -----------------------------------------------------

/** `POST /api/v1/agents` (spec §6, §8) — admin only. Exactly one of `sendInvite: true` or `password` (else `400`). Duplicate email → `409 conflict`. */
export async function handleCreateAgent(
  actingAgent: AgentRecord | null,
  request: Request,
  deps: AgentsHandlerDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return apiError(403, 'forbidden', 'Admin role required.')

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  const name = validateName(body.name)
  const email = normalizeEmail(body.email)
  const role = validateRole(body.role)
  if (name === null || email === null || role === null) {
    return apiError(
      400,
      'validation_failed',
      'name, email, and role are required and must be valid.',
    )
  }

  const sendInvite = body.sendInvite === true
  const hasPassword = typeof body.password === 'string'
  if (sendInvite === hasPassword) {
    return apiError(
      400,
      'validation_failed',
      'Exactly one of sendInvite (true) or password must be provided.',
    )
  }

  let passwordHash: string | undefined
  if (hasPassword) {
    const password = validatePassword(body.password)
    if (password === null) {
      return apiError(400, 'validation_failed', 'password must be 8-256 characters.')
    }
    passwordHash = hashPassword(password)
  }

  const result = await deps.store.createAgent({
    name,
    email,
    role,
    status: sendInvite ? 'invited' : 'active',
    ...(passwordHash !== undefined ? { passwordHash } : {}),
  })
  if (!result.ok) {
    return apiError(409, 'conflict', 'An Agent with that email already exists.')
  }

  const inviteSent = sendInvite ? await sendInviteEmail(result.agent, deps) : false

  return json(201, { agent: toAgentJson(result.agent), inviteSent })
}

/** Mint an invite token and send the invite email — shared by `handleCreateAgent` and `handleResendInvite`'s success path. Returns whether the send actually happened; NEVER throws (a send failure here is `inviteSent: false`, not a request failure — the Agent is already created). */
async function sendInviteEmail(agent: AgentRecord, deps: AgentsHandlerDeps): Promise<boolean> {
  if (deps.uiBaseUrl === undefined) return false
  const token = mintInviteToken(agent.id, deps.keyring)
  const email: OutboundEmail = buildInviteEmail({
    to: agent.email,
    token,
    uiBaseUrl: deps.uiBaseUrl,
    supportAddress: deps.supportAddress,
    mailDomain: deps.mailDomain,
  })
  try {
    await deps.sender.send(email)
    return true
  } catch (err) {
    console.error('[agents] invite send failed', err)
    return false
  }
}

// --- GET /api/v1/agents/{id} -------------------------------------------------

/** `GET /api/v1/agents/{id}` (spec §6) — admin, or self. */
export async function handleGetAgent(
  id: string,
  actingAgent: AgentRecord | null,
  deps: Pick<AgentsHandlerDeps, 'store'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin' && actingAgent.id !== id) {
    return apiError(403, 'forbidden', 'You may only view your own profile.')
  }
  if (!isUuid(id)) return NOT_FOUND()

  const agent = await deps.store.getAgent(id)
  if (agent === null) return NOT_FOUND()
  return json(200, { agent: toAgentJson(agent) })
}

// --- PATCH /api/v1/agents/{id} -----------------------------------------------

/** Fields an admin may PATCH on ANY Agent. */
const ADMIN_PATCH_FIELDS = ['name', 'timezone', 'role', 'status']
/** Fields a non-admin may PATCH on THEMSELF. */
const SELF_PATCH_FIELDS = ['name', 'timezone']

/**
 * `PATCH /api/v1/agents/{id}` (spec §6) — self (non-admin) may set only
 * `name`/`timezone` on themself; admin may set `name`/`timezone`/`role`/
 * `status` on anyone. `email` is never settable. `status` is a closed
 * lifecycle: only `active`↔`disabled` (never `invited` as source or
 * target) — naming `status` on a currently-`invited` Agent is `409
 * conflict`.
 */
export async function handlePatchAgent(
  id: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: Pick<AgentsHandlerDeps, 'store'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()

  const isAdmin = actingAgent.role === 'admin'
  const isSelf = actingAgent.id === id
  if (!isAdmin && !isSelf) {
    return apiError(403, 'forbidden', 'You may only edit your own profile.')
  }
  if (!isUuid(id)) return NOT_FOUND()

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  if ('email' in body) {
    return apiError(400, 'validation_failed', 'email cannot be changed (immutable in v1).')
  }

  const allowedFields = isAdmin ? ADMIN_PATCH_FIELDS : SELF_PATCH_FIELDS
  for (const key of Object.keys(body)) {
    if (!allowedFields.includes(key)) {
      return isAdmin
        ? apiError(400, 'validation_failed', `Unknown field '${key}'.`)
        : apiError(403, 'forbidden', 'You may only edit your name and timezone.')
    }
  }

  const patch: {
    name?: string
    timezone?: string
    role?: AgentRole
    status?: 'active' | 'disabled'
  } = {}
  if ('name' in body) {
    const name = validateName(body.name)
    if (name === null) return apiError(400, 'validation_failed', 'name must be 1-200 characters.')
    patch.name = name
  }
  if ('timezone' in body) {
    const timezone = validateTimezone(body.timezone)
    if (timezone === null) {
      return apiError(400, 'validation_failed', 'timezone must be a valid IANA time zone.')
    }
    patch.timezone = timezone
  }
  if ('role' in body) {
    const role = validateRole(body.role)
    if (role === null) return apiError(400, 'validation_failed', "role must be 'admin' or 'agent'.")
    patch.role = role
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'disabled') {
      return apiError(400, 'validation_failed', "status must be 'active' or 'disabled'.")
    }
    patch.status = body.status
  }

  if (patch.status !== undefined) {
    const current = await deps.store.getAgent(id)
    if (current === null) return NOT_FOUND()
    if (current.status === 'invited') {
      return apiError(
        409,
        'conflict',
        'An invited Agent cannot have its status changed via PATCH — it activates only by accepting its invite.',
      )
    }
  }

  const result = await deps.store.updateAgent(id, patch)
  if (!result.ok) {
    if (result.reason === 'not_found') return NOT_FOUND()
    return apiError(409, 'conflict', 'This would leave the deployment with no active admin.')
  }
  return json(200, { agent: toAgentJson(result.agent) })
}

// --- DELETE /api/v1/agents/{id} ----------------------------------------------

/** `DELETE /api/v1/agents/{id}` (spec §6) — admin only, hard delete. Last active admin → `409 conflict`. */
export async function handleDeleteAgent(
  id: string,
  actingAgent: AgentRecord | null,
  deps: Pick<AgentsHandlerDeps, 'store'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return apiError(403, 'forbidden', 'Admin role required.')
  if (!isUuid(id)) return NOT_FOUND()

  const result = await deps.store.deleteAgent(id)
  if (!result.ok) {
    if (result.reason === 'not_found') return NOT_FOUND()
    return apiError(409, 'conflict', 'This would leave the deployment with no active admin.')
  }
  return noContent()
}

// --- POST /api/v1/agents/{id}/password ---------------------------------------

/** `POST /api/v1/agents/{id}/password` (spec §6) — self, or admin reset. Refused (`409`) for an `invited` target. */
export async function handleSetAgentPassword(
  id: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: Pick<AgentsHandlerDeps, 'store'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (!isUuid(id)) return NOT_FOUND()

  const isAdmin = actingAgent.role === 'admin'
  const isSelf = actingAgent.id === id
  if (!isAdmin && !isSelf) {
    return apiError(403, 'forbidden', 'You may only change your own password.')
  }

  const target = await deps.store.getAgent(id)
  if (target === null) return NOT_FOUND()
  if (target.status === 'invited') {
    return apiError(
      409,
      'conflict',
      'Cannot set a password for an invited Agent — accept the invite instead.',
    )
  }

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  const password = body === null ? null : validatePassword(body.password)
  if (password === null) {
    return apiError(400, 'validation_failed', 'password must be 8-256 characters.')
  }

  await deps.store.setPassword(id, hashPassword(password))
  return noContent()
}

// --- POST /api/v1/agents/{id}/invite -----------------------------------------

/** `POST /api/v1/agents/{id}/invite` (spec §6, §8) — admin only, re-mint + re-send for an `invited` Agent. */
export async function handleResendInvite(
  id: string,
  actingAgent: AgentRecord | null,
  deps: AgentsHandlerDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return apiError(403, 'forbidden', 'Admin role required.')
  if (!isUuid(id)) return NOT_FOUND()

  const target = await deps.store.getAgent(id)
  if (target === null) return NOT_FOUND()
  if (target.status !== 'invited') {
    return apiError(409, 'conflict', 'This Agent is not awaiting an invite.')
  }
  if (deps.uiBaseUrl === undefined) {
    return apiError(409, 'conflict', 'Invites are not available on this deployment.')
  }

  const token = mintInviteToken(target.id, deps.keyring)
  const email = buildInviteEmail({
    to: target.email,
    token,
    uiBaseUrl: deps.uiBaseUrl,
    supportAddress: deps.supportAddress,
    mailDomain: deps.mailDomain,
  })
  try {
    await deps.sender.send(email)
  } catch (err) {
    console.error('[agents] invite resend failed', err)
    return apiError(502, 'send_failed', 'The invite email could not be sent.')
  }
  return noContent()
}

// --- POST /api/v1/auth/invite/accept -----------------------------------------

/** `POST /api/v1/auth/invite/accept` (spec §6, §9) — validate the token, set the password, flip `invited` → `active`, atomically. Expired/replayed/invalid are ALL the same generic `401`. No acting-Agent header (pre-session). */
export async function handleInviteAccept(
  request: Request,
  deps: Pick<AgentsHandlerDeps, 'store' | 'keyring'>,
): Promise<Response> {
  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(401, 'unauthorized', 'Invalid or expired invite.')
  const body = asRecord(parsed.value)
  if (body === null) return apiError(401, 'unauthorized', 'Invalid or expired invite.')

  if (typeof body.token !== 'string')
    return apiError(401, 'unauthorized', 'Invalid or expired invite.')
  const password = validatePassword(body.password)
  if (password === null) {
    return apiError(400, 'validation_failed', 'password must be 8-256 characters.')
  }

  const verified = verifyInviteToken(body.token, deps.keyring)
  if (verified === null) return apiError(401, 'unauthorized', 'Invalid or expired invite.')

  const agent = await deps.store.acceptInvite(verified.agentId, hashPassword(password))
  if (agent === null) return apiError(401, 'unauthorized', 'Invalid or expired invite.')

  return json(200, { agent: toAgentJson(agent) })
}

// --- Mailbox access (HT-54 follow-up; spec §3.4/§6) --------------------------
//
// All three admin-only, acting-Agent header required — the Permissions
// screen's whole read/write surface. No self-service exception (unlike
// `/agents/{id}` PATCH/password): mailbox grants are an admin-only
// bookkeeping concern, spec §6 pins all three as "admin-only" with no self
// carve-out.

// --- GET /api/v1/mailboxes ---------------------------------------------------

/** `GET /api/v1/mailboxes` (spec §3.4/§6) — admin only. The full roster regardless of status (a `MailboxStore.listMailboxes` unfiltered read) — the Permissions screen renders checkboxes for disconnected mailboxes too. */
export async function handleListMailboxes(
  actingAgent: AgentRecord | null,
  deps: Pick<AgentsHandlerDeps, 'mailboxStore'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return apiError(403, 'forbidden', 'Admin role required.')

  const mailboxes = await deps.mailboxStore.listMailboxes()
  return json(200, { mailboxes: mailboxes.map(toMailboxJson) })
}

// --- GET /api/v1/agents/{id}/mailboxes ---------------------------------------

/** `GET /api/v1/agents/{id}/mailboxes` (spec §3.4/§6) — admin only. Returns the target's raw grants AS STORED, even for an admin target (the UI decides how to render an admin's implicit-access case, not this endpoint). Unknown agent → `404`. */
export async function handleGetAgentMailboxes(
  id: string,
  actingAgent: AgentRecord | null,
  deps: Pick<AgentsHandlerDeps, 'store'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return apiError(403, 'forbidden', 'Admin role required.')
  if (!isUuid(id)) return NOT_FOUND()

  const mailboxIds = await deps.store.listAgentMailboxIds(id)
  if (mailboxIds === null) return NOT_FOUND()
  return json(200, { mailboxIds })
}

// --- PUT /api/v1/agents/{id}/mailboxes ---------------------------------------

/**
 * `PUT /api/v1/agents/{id}/mailboxes` (spec §3.4/§6) — admin only. Replaces
 * the target's mailbox grants with exactly `body.mailboxIds` (deduped by
 * {@link validateMailboxIds} before it ever reaches the store). Non-array/
 * non-uuid entries → `400 validation_failed`; an id naming no mailbox
 * (`AgentStore.replaceAgentMailboxAccess`'s FK-translated `'invalid_mailbox'`)
 * → `400 validation_failed`; unknown agent → `404`. Valid for any target
 * status (spec: "grants are lifecycle-agnostic bookkeeping") — no
 * invited/disabled check, unlike `/password`.
 */
export async function handlePutAgentMailboxes(
  id: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: Pick<AgentsHandlerDeps, 'store'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return apiError(403, 'forbidden', 'Admin role required.')
  if (!isUuid(id)) return NOT_FOUND()

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  const mailboxIds = validateMailboxIds(body.mailboxIds)
  if (mailboxIds === null) {
    return apiError(400, 'validation_failed', 'mailboxIds must be an array of uuid strings.')
  }

  const result = await deps.store.replaceAgentMailboxAccess(id, mailboxIds)
  if (result === 'not_found') return NOT_FOUND()
  if (result === 'invalid_mailbox') {
    return apiError(400, 'validation_failed', 'mailboxIds must name existing mailboxes.')
  }
  return json(200, { mailboxIds })
}
