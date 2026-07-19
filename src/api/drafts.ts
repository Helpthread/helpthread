/**
 * The drafts API (HT-70; specs/plugins/substrate-v1.md §6):
 * `POST /api/v1/conversations/{id}/drafts` (assistant-auth),
 * `GET /api/v1/drafts?status=awaiting_review`,
 * `POST /api/v1/drafts/{threadId}/approve`,
 * `POST /api/v1/drafts/{threadId}/discard` (Agent/service-auth).
 *
 * Same conventions as `src/api/conversations.ts`: each handler is a pure
 * function of an already-authenticated, already-routed `Request` plus its
 * dependencies. Which credential class is required per route is enforced
 * ONE level up, in `src/api/index.ts`'s capability gate (spec §3's "capability
 * enforcement lives at one point") — this module does not re-check whether
 * the caller is an Assistant or a service/Agent caller itself, except where
 * the SAME route is reachable by more than one credential and the two need
 * different handling (`handleCreateDraft` requires the resolved
 * `AssistantRecord` its caller already authenticated).
 */

import { approveDraft } from '../mail/approve-draft.js'
import type { Keyring } from '../mail/reply-token.js'
import type { SelfEchoGuardDeps } from '../mail/send.js'
import type { EmailSender } from '../providers/index.js'
import type { AgentRecord } from '../store/agents.js'
import type { AssistantRecord } from '../store/assistants.js'
import type { ConversationStore, ListAwaitingDraftsCursor } from '../store/conversations.js'
import { toThreadViewJson } from './conversations.js'
import { decodeDraftCursor, encodeDraftCursor } from './cursor.js'
import { apiError, json } from './responses.js'
import { isUuid } from './uuid.js'

/** Dependencies every handler in this module may need. */
export interface DraftsHandlerDeps {
  store: ConversationStore
  sender: EmailSender
  keyring: Keyring
  mailDomain: string
  supportAddress: string
  openTracking?: { publicBaseUrl: string }
  selfEchoGuard?: SelfEchoGuardDeps
}

/** Mirrors `src/api/conversations.ts`'s `MAX_IDEMPOTENCY_KEY_LENGTH` — kept local per this codebase's per-file convention (that constant is not exported). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255
/** Same body-length bounds `src/api/conversations.ts` uses for a reply/note's `text` (spec §4a/§4c) — a draft's `bodyText` is the same kind of value. */
const MIN_BODY_LENGTH = 1
const MAX_BODY_LENGTH = 5000

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 50
const MIN_LIMIT = 1

const UNAUTHORIZED = () => apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
const NOT_FOUND = () => apiError(404, 'not_found', 'No draft with that id.')

/** Read and JSON-parse `request`'s body without ever throwing — mirrors `src/api/conversations.ts`'s helper of the same name. */
async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

// --- POST /api/v1/conversations/{id}/drafts (assistant-auth) ---------------

/** Validated shape of `POST .../drafts`'s request body (spec §6). */
interface DraftRequestBody {
  bodyText: string
  bodyHtml?: string
}

function parseDraftBody(raw: unknown): DraftRequestBody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { bodyText, bodyHtml } = raw as Record<string, unknown>
  if (
    typeof bodyText !== 'string' ||
    bodyText.length < MIN_BODY_LENGTH ||
    bodyText.length > MAX_BODY_LENGTH
  ) {
    return null
  }
  if (bodyHtml !== undefined && typeof bodyHtml !== 'string') return null
  return bodyHtml === undefined ? { bodyText } : { bodyText, bodyHtml }
}

/**
 * `POST /api/v1/conversations/{id}/drafts` (spec §6) — assistant-auth only;
 * `assistant` is the ALREADY-AUTHENTICATED caller (`src/api/index.ts`
 * resolves this via `authenticateAssistantRequest` before dispatch, and
 * refuses any other credential at the capability gate). `Idempotency-Key`
 * is REQUIRED, stored prefixed `` `draft:${key}` `` by
 * `ConversationStore.appendDraft` — sharing the `(conversation_id,
 * idempotency_key)` namespace with replies. That prefix alone is NOT what
 * keeps the two sub-namespaces disjoint (a reply key is stored raw, so a
 * caller-supplied reply key literally spelled `draft:abc` would otherwise
 * collide with an engine-owned draft key of the same name) — the actual
 * guarantee is the PAIR: this engine-owned `draft:` prefix, plus
 * `handleReply` (`src/api/conversations.ts`) rejecting any caller-supplied
 * reply `Idempotency-Key` that itself starts with `draft:`. `201` with the
 * created `ThreadView` on success;
 * `404 not_found` for a missing or soft-deleted conversation
 * (indistinguishable, per §4d); `400 validation_failed` on a missing/
 * over-length `Idempotency-Key` or an invalid body.
 */
export async function handleCreateDraft(
  id: string,
  assistant: AssistantRecord,
  request: Request,
  deps: Pick<DraftsHandlerDeps, 'store' | 'supportAddress'>,
): Promise<Response> {
  if (!isUuid(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const rawIdempotencyKey = request.headers.get('Idempotency-Key')
  const idempotencyKey = rawIdempotencyKey?.trim() ?? ''
  if (idempotencyKey === '') {
    return apiError(400, 'validation_failed', 'Idempotency-Key header is required.')
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return apiError(
      400,
      'validation_failed',
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    )
  }

  const parsedBody = await parseJsonBody(request)
  if (!parsedBody.ok) {
    return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  }
  const draft = parseDraftBody(parsedBody.value)
  if (draft === null) {
    return apiError(
      400,
      'validation_failed',
      `bodyText is required and must be ${MIN_BODY_LENGTH}-${MAX_BODY_LENGTH} characters; bodyHtml, if present, must be a string.`,
    )
  }

  const result = await deps.store.appendDraft(id, {
    assistantId: assistant.id,
    bodyText: draft.bodyText,
    ...(draft.bodyHtml !== undefined ? { bodyHtml: draft.bodyHtml } : {}),
    // The eventual outbound "From" — the deployment's support address, the
    // SAME one every Agent reply uses (src/api/conversations.ts's
    // handleReply). An assistant has no mailbox identity of its own to
    // offer here, and approval never derives/overwrites this column, so it
    // must be right at draft-creation time.
    fromAddress: deps.supportAddress,
    idempotencyKey,
  })
  if (!result.ok) {
    // not-found and deleted are one generic 404 (spec §4d's no-existence-leak).
    return NOT_FOUND()
  }

  return json(201, toThreadViewJson(result.thread))
}

// --- GET /api/v1/drafts?status=awaiting_review (Agent/service-auth) --------

/**
 * `GET /api/v1/drafts?status=awaiting_review` (spec §6) — the cross-
 * conversation review queue, newest first, keyset-paginated. `status` is
 * REQUIRED and its only legal value is `'awaiting_review'` (there is no
 * other queue this endpoint serves — resolved drafts surface through
 * conversation detail, not here).
 */
export async function handleListDrafts(
  request: Request,
  deps: Pick<DraftsHandlerDeps, 'store'>,
): Promise<Response> {
  const url = new URL(request.url)

  const status = url.searchParams.get('status')
  if (status !== 'awaiting_review') {
    return apiError(400, 'validation_failed', "status must be 'awaiting_review'.")
  }

  const limitParam = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (limitParam !== null) {
    const parsed = Number(limitParam)
    if (!Number.isFinite(parsed)) {
      return apiError(400, 'validation_failed', 'limit must be a number.')
    }
    limit = Math.trunc(parsed)
  }
  limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, limit))

  const cursorParam = url.searchParams.get('cursor')
  let cursor: ListAwaitingDraftsCursor | undefined
  if (cursorParam !== null) {
    const decoded = decodeDraftCursor(cursorParam)
    if (decoded === null) {
      return apiError(400, 'validation_failed', 'cursor is invalid or expired.')
    }
    cursor = decoded
  }

  // Over-fetch-by-one for pagination detection — same trick
  // handleListConversations uses (src/api/conversations.ts).
  const rows = await deps.store.listAwaitingDrafts({ limit: limit + 1, cursor })
  const hasNextPage = rows.length > limit
  const page = rows.slice(0, limit)

  return json(200, {
    drafts: page.map((thread) => toThreadViewJson(thread)),
    nextCursor:
      hasNextPage && page.length > 0
        ? encodeDraftCursor({
            createdAt: page[page.length - 1].createdAt,
            id: page[page.length - 1].id,
          })
        : null,
  })
}

// --- POST /api/v1/drafts/{threadId}/approve ---------------------------------

/** Validated shape of the OPTIONAL "approve with edits" body (spec §6) — parsed leniently: an absent or empty body means "no edit", never a `400`. */
function parseApproveEditBody(
  raw: unknown,
): { ok: true; edit: { bodyText?: string; bodyHtml?: string } | undefined } | { ok: false } {
  if (typeof raw !== 'object' || raw === null) return { ok: false }
  const { bodyText, bodyHtml } = raw as Record<string, unknown>
  if (bodyText !== undefined && typeof bodyText !== 'string') return { ok: false }
  if (bodyHtml !== undefined && typeof bodyHtml !== 'string') return { ok: false }
  if (bodyText === undefined && bodyHtml === undefined) return { ok: true, edit: undefined }
  return {
    ok: true,
    edit: {
      ...(bodyText !== undefined ? { bodyText } : {}),
      ...(bodyHtml !== undefined ? { bodyHtml } : {}),
    },
  }
}

/**
 * Read `request`'s body as an OPTIONAL "approve with edits" override. An
 * entirely empty body (the common case — approving unedited) is legal and
 * means "no edit", NOT a JSON-parse error — unlike every other body-bearing
 * endpoint in this API, whose body is required. `{}` is likewise "no edit"
 * (present keys are what signal an override, not body presence alone —
 * see `parseApproveEditBody`).
 */
async function readApproveEditBody(
  request: Request,
): Promise<
  { ok: true; edit: { bodyText?: string; bodyHtml?: string } | undefined } | { ok: false }
> {
  const text = await request.text()
  if (text.trim() === '') return { ok: true, edit: undefined }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  return parseApproveEditBody(parsed)
}

/**
 * `POST /api/v1/drafts/{threadId}/approve` (spec §6) — Agent/service-auth;
 * `actingAgent` MUST be present (`401` if not — the row's
 * `approved_by_agent_id` audit column requires a real Agent identity, spec:
 * "a draft never leaves the system without an approving Agent identity on
 * the row"). Optional body `{ bodyText?, bodyHtml? }` is "approve with
 * edits". Refused `404` (indistinguishable-from-nonexistent, §4d) for a
 * missing/soft-deleted conversation or a `threadId` that doesn't name an
 * `awaiting_review` draft; refused `409 conflict` on a `spam` conversation.
 * On send failure, `502 send_failed`; on a delivery-lease race,
 * `409 retry_in_progress` — same shapes `handleReply` uses for the
 * equivalent outcomes.
 */
export async function handleApproveDraft(
  threadId: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: DraftsHandlerDeps,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (!isUuid(threadId)) return NOT_FOUND()

  const conversation = await deps.store.getConversationByThreadId(threadId, {
    includeDeleted: false,
  })
  if (conversation === null) return NOT_FOUND()

  const draftThread = conversation.threads.find((t) => t.id === threadId)
  if (draftThread === undefined || draftThread.draftStatus !== 'awaiting_review') {
    return NOT_FOUND()
  }
  if (conversation.status === 'spam') {
    return apiError(409, 'conflict', 'Cannot approve a draft on a spam conversation.')
  }

  const parsedEdit = await readApproveEditBody(request)
  if (!parsedEdit.ok) {
    return apiError(
      400,
      'validation_failed',
      'Request body, if present, must be a JSON object with optional bodyText/bodyHtml strings.',
    )
  }

  const result = await approveDraft(
    {
      conversation,
      draftThreadId: threadId,
      resolvedByAgentId: actingAgent.id,
      edit: parsedEdit.edit,
    },
    {
      store: deps.store,
      sender: deps.sender,
      keyring: deps.keyring,
      mailDomain: deps.mailDomain,
      ...(deps.openTracking !== undefined ? { openTracking: deps.openTracking } : {}),
      ...(deps.selfEchoGuard !== undefined ? { selfEchoGuard: deps.selfEchoGuard } : {}),
    },
  )

  if (!result.ok) {
    if (result.reason === 'send-failed') {
      return apiError(502, 'send_failed', 'The draft could not be delivered.')
    }
    if (result.reason === 'retry-in-progress') {
      return apiError(
        409,
        'retry_in_progress',
        'A delivery attempt for this draft is already in progress.',
      )
    }
    // 'not-a-draft' — a race between the snapshot above and the write.
    return NOT_FOUND()
  }

  const updated = await deps.store.getConversation(conversation.id, { includeDeleted: false })
  const thread = updated?.threads.find((t) => t.id === result.threadId)
  if (updated == null || thread === undefined) {
    // Should be unreachable — approveDraft just reported a successful
    // resolution of exactly this thread id. Mirrors handleReply's own
    // defensive fallback for the same shape of invariant.
    return apiError(500, 'server_error', 'Internal server error.')
  }

  return json(200, toThreadViewJson(thread))
}

// --- POST /api/v1/drafts/{threadId}/discard ---------------------------------

/**
 * `POST /api/v1/drafts/{threadId}/discard` (spec §6) — Agent/service-auth;
 * `actingAgent` MUST be present (`401` if not, same requirement as approve
 * — `resolveDraft`'s `resolvedByAgentId` is the resolution audit field
 * generally, not "approval" specifically). `200` with the updated
 * `ThreadView` (`draftStatus: 'discarded'`) on success; `404 not_found`
 * (indistinguishable-from-nonexistent) for a missing/soft-deleted
 * conversation or a `threadId` that doesn't name an `awaiting_review`
 * draft. No spam restriction (unlike approve) — discarding a draft on a
 * spam conversation is harmless.
 */
export async function handleDiscardDraft(
  threadId: string,
  actingAgent: AgentRecord | null,
  deps: Pick<DraftsHandlerDeps, 'store'>,
): Promise<Response> {
  if (actingAgent === null) return UNAUTHORIZED()
  if (!isUuid(threadId)) return NOT_FOUND()

  const conversation = await deps.store.getConversationByThreadId(threadId, {
    includeDeleted: false,
  })
  if (conversation === null) return NOT_FOUND()

  const draftThread = conversation.threads.find((t) => t.id === threadId)
  if (draftThread === undefined || draftThread.draftStatus !== 'awaiting_review') {
    return NOT_FOUND()
  }

  const resolved = await deps.store.resolveDraft({
    action: 'discard',
    threadId,
    resolvedByAgentId: actingAgent.id,
  })
  if (resolved === null) {
    // A race between the snapshot above and the write.
    return NOT_FOUND()
  }

  return json(200, toThreadViewJson(resolved))
}
