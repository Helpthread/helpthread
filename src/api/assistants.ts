/**
 * The Assistants admin API (HT-70; specs/plugins/substrate-v1.md §3):
 * `POST /api/v1/assistants` (returns the token ONCE), `GET /api/v1/assistants`,
 * `PATCH /api/v1/assistants/{id}` (name, status),
 * `POST /api/v1/assistants/{id}/rotate-token`.
 *
 * Same conventions as `src/api/agents.ts`: each handler is a pure function
 * of an already-authenticated, already-routed `Request` plus its
 * dependencies; `src/api/index.ts` resolves the acting Agent
 * (`resolveActingAgent`) and passes the result in — `null` means "no acting
 * Agent" and every handler here maps that to a generic `401`. Every
 * mutation is ADMIN-ONLY (no self-service carve-out — an Assistant is not
 * a human who can act on its own profile). `AssistantRecord` never carries
 * `tokenHash` (see `src/store/assistants.ts`'s module doc); `toAssistantJson`
 * is the one place this module decides what crosses the wire, and the
 * plaintext token is returned ONLY from the two mint-time endpoints
 * (create, rotate-token), never persisted, never logged, never returned
 * again after that single response.
 */

import { randomUUID } from 'node:crypto'
import { mintAssistantToken } from '../auth/assistant-token.js'
import type { AgentRecord } from '../store/agents.js'
import type { AssistantRecord, AssistantStatus, AssistantStore } from '../store/assistants.js'
import { apiError, json } from './responses.js'
import { isUuid } from './uuid.js'

/** Dependencies every handler in this module needs. */
export interface AssistantsApiDeps {
  store: AssistantStore
}

// --- validation --------------------------------------------------------------

const MIN_NAME_LENGTH = 1
const MAX_NAME_LENGTH = 200
const MIN_MODULE_LENGTH = 1
const MAX_MODULE_LENGTH = 100

/** Trim; 1-200 chars. `null` on any violation. Same rule `src/api/agents.ts`'s `validateName` uses for an Agent's name. */
function validateName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length >= MIN_NAME_LENGTH && trimmed.length <= MAX_NAME_LENGTH ? trimmed : null
}

/** Trim; 1-100 chars — the module slug is free text in v1 (no registry exists yet to validate it against; spec §1's additive-forward rule). `null` on any violation. */
function validateModule(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length >= MIN_MODULE_LENGTH && trimmed.length <= MAX_MODULE_LENGTH ? trimmed : null
}

/** Read and JSON-parse `request`'s body without ever throwing — mirrors `src/api/agents.ts`'s helper of the same name (kept local per this codebase's per-file convention). */
async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

/** `typeof value === 'object' && value !== null`, narrowed to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

// --- wire shape ----------------------------------------------------------

interface AssistantJson {
  id: string
  name: string
  module: string
  status: AssistantStatus
  createdByAgentId: string | null
  createdAt: string
  updatedAt: string
}

function toAssistantJson(assistant: AssistantRecord): AssistantJson {
  return {
    id: assistant.id,
    name: assistant.name,
    module: assistant.module,
    status: assistant.status,
    createdByAgentId: assistant.createdByAgentId,
    createdAt: assistant.createdAt.toISOString(),
    updatedAt: assistant.updatedAt.toISOString(),
  }
}

const UNAUTHORIZED = () => apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
const NOT_FOUND = () => apiError(404, 'not_found', 'No Assistant with that id.')
const ADMIN_REQUIRED = () => apiError(403, 'forbidden', 'Admin role required.')

// --- POST /api/v1/assistants --------------------------------------------

/**
 * `POST /api/v1/assistants` (spec §3) — admin only. Mints a fresh token via
 * the id/token knot (`src/auth/assistant-token.ts`'s module doc: generate
 * the id first, mint the token against it, then insert with that id
 * explicit) and returns the full token in the response body — the ONLY
 * time it is ever visible again.
 */
export async function handleCreateAssistant(
  actingAgent: AgentRecord | null,
  request: Request,
  deps: AssistantsApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return ADMIN_REQUIRED()

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  const name = validateName(body.name)
  const moduleSlug = validateModule(body.module)
  if (name === null || moduleSlug === null) {
    return apiError(400, 'validation_failed', 'name and module are required and must be valid.')
  }

  const assistantId = randomUUID()
  const minted = mintAssistantToken(assistantId)
  const assistant = await deps.store.create({
    id: assistantId,
    name,
    module: moduleSlug,
    tokenHash: minted.tokenHash,
    createdByAgentId: actingAgent.id,
  })

  return json(201, { assistant: toAssistantJson(assistant), token: minted.token })
}

// --- GET /api/v1/assistants -----------------------------------------------

/** `GET /api/v1/assistants` (spec §3) — admin only, unlike `GET /api/v1/agents` (which any active Agent may read): an Assistant's token-issuance surface is admin bookkeeping, not something every Agent's UI needs. */
export async function handleListAssistants(
  actingAgent: AgentRecord | null,
  deps: AssistantsApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return ADMIN_REQUIRED()

  const assistants = await deps.store.list()
  return json(200, { assistants: assistants.map(toAssistantJson) })
}

// --- PATCH /api/v1/assistants/{id} ----------------------------------------

/** `PATCH /api/v1/assistants/{id}` (spec §3) — admin only. Body: `name` and/or `status` (`'active'|'disabled'`); any other field is `400`. */
export async function handlePatchAssistant(
  id: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: AssistantsApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return ADMIN_REQUIRED()
  if (!isUuid(id)) return NOT_FOUND()

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  for (const key of Object.keys(body)) {
    if (key !== 'name' && key !== 'status') {
      return apiError(400, 'validation_failed', `Unknown field '${key}'.`)
    }
  }

  const patch: { name?: string; status?: AssistantStatus } = {}
  if ('name' in body) {
    const name = validateName(body.name)
    if (name === null) return apiError(400, 'validation_failed', 'name must be 1-200 characters.')
    patch.name = name
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'disabled') {
      return apiError(400, 'validation_failed', "status must be 'active' or 'disabled'.")
    }
    patch.status = body.status
  }

  const updated = await deps.store.patch(id, patch)
  if (updated === null) return NOT_FOUND()
  return json(200, { assistant: toAssistantJson(updated) })
}

// --- POST /api/v1/assistants/{id}/rotate-token -----------------------------

/** `POST /api/v1/assistants/{id}/rotate-token` (spec §3) — admin only. Mints a fresh secret for the SAME assistant id (the id, and therefore every past `author_assistant_id` FK, never changes) and returns the new token ONCE; the old token stops verifying immediately (its hash is overwritten, not retained). */
export async function handleRotateAssistantToken(
  id: string,
  actingAgent: AgentRecord | null,
  deps: AssistantsApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return ADMIN_REQUIRED()
  if (!isUuid(id)) return NOT_FOUND()

  const existing = await deps.store.get(id)
  if (existing === null) return NOT_FOUND()

  const minted = mintAssistantToken(id)
  await deps.store.updateTokenHash(id, minted.tokenHash)

  return json(200, { assistant: toAssistantJson(existing), token: minted.token })
}
