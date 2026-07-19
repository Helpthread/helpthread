/**
 * Saved replies & macros (HT-76; specs/api/agent-inbox-v1.md's
 * saved-replies-and-macros amendment). The engine stores DEFINITIONS
 * ONLY — applying a macro (posting its body as a reply, then composing
 * the existing status/tags/assignee endpoints) is entirely a CLIENT-side
 * composition of endpoints this deployment already exposes
 * (`POST .../replies`, `PATCH .../status`, `PUT .../tags`,
 * `PUT .../assignee`); this module adds zero new mail or status semantics.
 *
 * Same conventions as `src/api/agents.ts`: each handler is a pure function
 * of an already-authenticated, already-routed `Request` plus its
 * dependencies; every response goes through `src/api/responses.ts`.
 *
 * ## Role gates (spec's pin — v1)
 *
 * - `GET .../saved-replies` — any ACTIVE acting Agent (the reply composer
 *   needs the list to render its picker for every Agent, not just admins).
 * - `POST`/`PATCH`/`DELETE` — admin only, v1. A future increment may relax
 *   authoring to any Agent; that is explicitly not this ticket's call to
 *   make, so it stays admin-only until asked for.
 */

import type { AgentRecord } from '../store/agents.js'
import type { MailboxStore } from '../store/mailboxes.js'
import type {
  NewSavedReply,
  SavedReplyActions,
  SavedReplyPatch,
  SavedReplyRecord,
  SavedReplyStore,
} from '../store/saved-replies.js'
import { apiError, json, noContent } from './responses.js'
import { isUuid } from './uuid.js'

/** Dependencies every handler in this module needs. */
export interface SavedRepliesApiDeps {
  store: SavedReplyStore
  mailboxStore: MailboxStore
}

const MAX_NAME_LENGTH = 200
const MIN_BODY_TEXT_LENGTH = 1
const MAX_BODY_TEXT_LENGTH = 5000
const MAX_TAG_LENGTH = 40

const UNAUTHORIZED = () => apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
const FORBIDDEN = () => apiError(403, 'forbidden', 'Admin role required.')
const NOT_FOUND = () => apiError(404, 'not_found', 'No saved reply with that id.')
const MAILBOX_NOT_FOUND = () => apiError(404, 'not_found', 'No mailbox with that id.')

// --- validation --------------------------------------------------------------

function validateName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length >= 1 && trimmed.length <= MAX_NAME_LENGTH ? trimmed : null
}

function validateBodyText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return raw.length >= MIN_BODY_TEXT_LENGTH && raw.length <= MAX_BODY_TEXT_LENGTH ? raw : null
}

/** `undefined`/`null` → `{ ok: true, value: null }` (no HTML body); a non-string is invalid. */
function validateBodyHtml(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  return typeof raw === 'string' ? { ok: true, value: raw } : { ok: false }
}

/** `undefined` → `0` (the schema default); anything else must be a plain integer. */
function validateSortOrder(raw: unknown): number | null {
  if (raw === undefined) return 0
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null
}

/** Validate `actions` against the v1 shape (brief): `{ setStatus?: 'closed'|'pending'; addTags?: string[]; assignToSelf?: boolean }`. `undefined` → `{}`. `null` on any violation — an unknown key included. */
function validateActions(raw: unknown): SavedReplyActions | null {
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { setStatus, addTags, assignToSelf, ...rest } = raw as Record<string, unknown>
  if (Object.keys(rest).length > 0) return null

  const actions: SavedReplyActions = {}
  if (setStatus !== undefined) {
    if (setStatus !== 'closed' && setStatus !== 'pending') return null
    actions.setStatus = setStatus
  }
  if (addTags !== undefined) {
    if (!Array.isArray(addTags)) return null
    const tags: string[] = []
    for (const entry of addTags) {
      if (typeof entry !== 'string') return null
      const tag = entry.trim().toLowerCase()
      if (tag.length < 1 || tag.length > MAX_TAG_LENGTH) return null
      if (!tags.includes(tag)) tags.push(tag)
    }
    actions.addTags = tags
  }
  if (assignToSelf !== undefined) {
    if (typeof assignToSelf !== 'boolean') return null
    actions.assignToSelf = assignToSelf
  }
  return actions
}

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

// --- wire shape ----------------------------------------------------------------

interface SavedReplyJson {
  id: string
  mailboxId: string
  name: string
  bodyText: string
  bodyHtml: string | null
  actions: SavedReplyActions
  sortOrder: number
  createdAt: string
  updatedAt: string
}

function toSavedReplyJson(row: SavedReplyRecord): SavedReplyJson {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    name: row.name,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    actions: row.actions,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function mailboxExists(mailboxId: string, deps: SavedRepliesApiDeps): Promise<boolean> {
  if (!isUuid(mailboxId)) return false
  return (await deps.mailboxStore.getMailboxById(mailboxId)) !== null
}

// --- GET /api/v1/mailboxes/{id}/saved-replies ---------------------------------

/** `GET /api/v1/mailboxes/{id}/saved-replies` — any ACTIVE acting Agent. */
export async function handleListSavedReplies(
  mailboxId: string,
  actingAgent: AgentRecord | null,
  deps: SavedRepliesApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (!(await mailboxExists(mailboxId, deps))) return MAILBOX_NOT_FOUND()

  const replies = await deps.store.listByMailbox(mailboxId)
  return json(200, { savedReplies: replies.map(toSavedReplyJson) })
}

// --- POST /api/v1/mailboxes/{id}/saved-replies --------------------------------

/** `POST /api/v1/mailboxes/{id}/saved-replies` — admin only, v1. `name`/`bodyText` required; `bodyHtml`/`actions`/`sortOrder` optional. */
export async function handleCreateSavedReply(
  mailboxId: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: SavedRepliesApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return FORBIDDEN()
  if (!(await mailboxExists(mailboxId, deps))) return MAILBOX_NOT_FOUND()

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  const name = validateName(body.name)
  const bodyText = validateBodyText(body.bodyText)
  const bodyHtml = validateBodyHtml(body.bodyHtml)
  const sortOrder = validateSortOrder(body.sortOrder)
  const actions = validateActions(body.actions)
  if (
    name === null ||
    bodyText === null ||
    !bodyHtml.ok ||
    sortOrder === null ||
    actions === null
  ) {
    return apiError(
      400,
      'validation_failed',
      'name (1-200 chars) and bodyText (1-5000 chars) are required; bodyHtml, sortOrder, and actions, if present, must be valid.',
    )
  }

  const input: NewSavedReply = {
    mailboxId,
    name,
    bodyText,
    bodyHtml: bodyHtml.value,
    actions,
    sortOrder,
  }
  const created = await deps.store.createSavedReply(input)
  return json(201, toSavedReplyJson(created))
}

// --- PATCH /api/v1/mailboxes/{id}/saved-replies/{replyId} ---------------------

const PATCHABLE_FIELDS = ['name', 'bodyText', 'bodyHtml', 'actions', 'sortOrder']

/** `PATCH /api/v1/mailboxes/{id}/saved-replies/{replyId}` — admin only, v1. Only the fields present are changed. */
export async function handlePatchSavedReply(
  mailboxId: string,
  replyId: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: SavedRepliesApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return FORBIDDEN()
  if (!isUuid(mailboxId) || !isUuid(replyId)) return NOT_FOUND()

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  for (const key of Object.keys(body)) {
    if (!PATCHABLE_FIELDS.includes(key)) {
      return apiError(400, 'validation_failed', `Unknown field '${key}'.`)
    }
  }

  const patch: SavedReplyPatch = {}
  if ('name' in body) {
    const name = validateName(body.name)
    if (name === null) return apiError(400, 'validation_failed', 'name must be 1-200 characters.')
    patch.name = name
  }
  if ('bodyText' in body) {
    const bodyText = validateBodyText(body.bodyText)
    if (bodyText === null) {
      return apiError(400, 'validation_failed', 'bodyText must be 1-5000 characters.')
    }
    patch.bodyText = bodyText
  }
  if ('bodyHtml' in body) {
    const bodyHtml = validateBodyHtml(body.bodyHtml)
    if (!bodyHtml.ok)
      return apiError(400, 'validation_failed', 'bodyHtml must be a string or null.')
    patch.bodyHtml = bodyHtml.value
  }
  if ('sortOrder' in body) {
    const sortOrder = validateSortOrder(body.sortOrder)
    if (sortOrder === null)
      return apiError(400, 'validation_failed', 'sortOrder must be an integer.')
    patch.sortOrder = sortOrder
  }
  if ('actions' in body) {
    const actions = validateActions(body.actions)
    if (actions === null) return apiError(400, 'validation_failed', 'actions is invalid.')
    patch.actions = actions
  }

  // Scope to `mailboxId` BEFORE updating: a saved reply belongs to exactly
  // one mailbox (schema FK), so a `replyId` that names a row under a
  // DIFFERENT mailbox is the same "no such row reachable through this path"
  // 404 as an unknown id — never a cross-mailbox edit.
  const existing = await deps.store.getSavedReply(replyId)
  if (existing === null || existing.mailboxId !== mailboxId) return NOT_FOUND()

  const updated = await deps.store.updateSavedReply(replyId, patch)
  if (updated === null) return NOT_FOUND()
  return json(200, toSavedReplyJson(updated))
}

// --- DELETE /api/v1/mailboxes/{id}/saved-replies/{replyId} --------------------

/** `DELETE /api/v1/mailboxes/{id}/saved-replies/{replyId}` — admin only, v1. Hard delete. */
export async function handleDeleteSavedReply(
  mailboxId: string,
  replyId: string,
  actingAgent: AgentRecord | null,
  deps: SavedRepliesApiDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return FORBIDDEN()
  if (!isUuid(mailboxId) || !isUuid(replyId)) return NOT_FOUND()

  const existing = await deps.store.getSavedReply(replyId)
  if (existing === null || existing.mailboxId !== mailboxId) return NOT_FOUND()

  const deleted = await deps.store.deleteSavedReply(replyId)
  if (!deleted) return NOT_FOUND()
  return noContent()
}
