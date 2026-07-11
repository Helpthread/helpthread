/**
 * The Agent Inbox API's handlers: the two HT-17 read paths —
 * `GET /api/v1/conversations` (the inbox list, specs/api/agent-inbox-v1.md
 * §3a) and `GET /api/v1/conversations/{id}` (one conversation with its
 * threads, §3b) — plus the two HT-18 write paths — `POST
 * /api/v1/conversations/{id}/replies` (the Agent replies, §4a) and `PATCH
 * /api/v1/conversations/{id}` (close/reopen, §4b).
 *
 * Each handler is a pure function of an already-authenticated, already-
 * routed `Request` plus its dependencies — `src/api/index.ts` is what
 * authenticates and routes; nothing here re-checks either. Every handler
 * returns a `Response` built exclusively through `src/api/responses.ts`'s
 * helpers, so every reply (success or error) carries the mandatory
 * `Cache-Control: no-store` (spec §3) without each handler having to
 * remember it.
 */

import type { Keyring } from '../mail/reply-token.js'
import { sendReply } from '../mail/send.js'
import type { EmailSender } from '../providers/index.js'
import type { ConversationStore, StoredThread } from '../store/conversations.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { apiError, json } from './responses.js'
import { isUuid } from './uuid.js'

/** Default page size when the caller omits `limit` (spec §3a). */
const DEFAULT_LIMIT = 25
/** Hard cap on `limit` — values above this are clamped, not rejected (spec §3a). */
const MAX_LIMIT = 50
/** Floor on `limit` — a caller-supplied `0` or negative value clamps up to this, not rejected. */
const MIN_LIMIT = 1

/** Minimum length of a reply's `text` field, server-enforced (spec §4a). */
const MIN_REPLY_TEXT_LENGTH = 1
/** Maximum length of a reply's `text` field, server-enforced (spec §4a). */
const MAX_REPLY_TEXT_LENGTH = 5000

/**
 * Maximum length (after trimming) of the `Idempotency-Key` header, server-
 * enforced (spec §4a). The key is stored in a DB column and used as half of
 * a unique index (`(conversation_id, idempotency_key)`, migration 003) — an
 * unbounded caller-supplied string is an unnecessary storage/index-bloat
 * surface for a value that only ever needs to be a short opaque token.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255

/** The wire shape of one `ThreadView` (specs/api/agent-inbox-v1.md §2) — `StoredThread` with `Date` fields as ISO strings and `fromAddress` renamed to `from`. */
interface ThreadViewJson {
  id: string
  direction: 'inbound' | 'outbound'
  from: string
  bodyText: string | null
  bodyHtml: string | null
  deliveryStatus: 'pending' | 'sent' | 'failed' | null
  createdAt: string
}

/** The wire shape of one `ConversationSummary` (specs/api/agent-inbox-v1.md §2) — `Date` fields as ISO strings. */
interface ConversationSummaryJson {
  id: string
  subject: string
  customerEmail: string
  status: 'open' | 'closed'
  threadCount: number
  createdAt: string
  updatedAt: string
}

/** The wire shape of a `ConversationDetail` (specs/api/agent-inbox-v1.md §2): a summary plus its threads, oldest-first. */
interface ConversationDetailJson extends ConversationSummaryJson {
  threads: ThreadViewJson[]
}

/** `GET /api/v1/conversations`'s response body (specs/api/agent-inbox-v1.md §3a). */
interface ConversationListResponseJson {
  conversations: ConversationSummaryJson[]
  nextCursor: string | null
}

/**
 * Handle `GET /api/v1/conversations` — parse and validate `status`,
 * `limit`, and `cursor`, fetch one page from the store, and shape the
 * `ConversationListResponse` (spec §3a).
 *
 * Validation failures are all `400 validation_failed`: an invalid `status`
 * value, a non-numeric `limit`, or an undecodable `cursor`. `limit` itself
 * is never rejected for being out of range — it is clamped to
 * `[MIN_LIMIT, MAX_LIMIT]` per spec, which is deliberately more permissive
 * than the numeric-parse check.
 */
export async function handleListConversations(
  request: Request,
  deps: { store: ConversationStore },
): Promise<Response> {
  const url = new URL(request.url)

  const statusParam = url.searchParams.get('status')
  let status: 'open' | 'closed' | undefined
  if (statusParam === null) {
    status = 'open'
  } else if (statusParam === 'open' || statusParam === 'closed') {
    status = statusParam
  } else {
    return apiError(400, 'validation_failed', "status must be 'open' or 'closed'.")
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
  let cursor: { updatedAt: Date; id: string } | undefined
  if (cursorParam !== null) {
    const decoded = decodeCursor(cursorParam)
    if (decoded === null) {
      return apiError(400, 'validation_failed', 'cursor is invalid or expired.')
    }
    cursor = decoded
  }

  // Fetch one extra row: if it comes back, there IS a next page, and its
  // presence is detected by count alone — its own data is discarded (spec
  // §3a's over-fetch-by-one pagination-detection trick).
  const rows = await deps.store.listConversations({ status, limit: limit + 1, cursor })
  const hasNextPage = rows.length > limit
  const page = rows.slice(0, limit)

  const body: ConversationListResponseJson = {
    conversations: page.map(toConversationSummaryJson),
    nextCursor:
      hasNextPage && page.length > 0
        ? encodeCursor({
            updatedAt: page[page.length - 1].updatedAt,
            id: page[page.length - 1].id,
          })
        : null,
  }

  return json(200, body)
}

/**
 * Handle `GET /api/v1/conversations/{id}` — fetch the conversation and
 * shape it as a `ConversationDetail` (spec §3b). `id` is whatever the
 * router extracted from the path; it is passed straight to
 * `store.getConversation` as a parameterized query value (`src/store/
 * conversations.ts`), never interpolated into SQL — an `id` that isn't a
 * well-formed UUID simply matches no row and falls into the same `404` as
 * any other miss, rather than needing its own validation branch.
 *
 * A `deleted` conversation is deliberately indistinguishable from a
 * nonexistent one — and from a syntactically-invalid id: all return the
 * identical generic `404 not_found` (spec §3b, §5's "no existence leak").
 * The `id` is shape-checked as a UUID first because it is compared against a
 * `uuid` column, which would otherwise THROW on a non-UUID rather than miss
 * (see uuid.ts); and the store is asked to exclude deleted rows at the
 * lookup so no threads are loaded for one (no latency side-channel, §5).
 */
export async function handleGetConversation(
  id: string,
  deps: { store: ConversationStore },
): Promise<Response> {
  if (!isUuid(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const conversation = await deps.store.getConversation(id, { includeDeleted: false })
  // `includeDeleted: false` already makes the store return null for a deleted
  // conversation. The `=== 'deleted'` arm is defense-in-depth — it can't fire
  // at runtime today, but it guarantees the API never serves a deleted
  // conversation even if the store's contract later regressed, and it narrows
  // `status` to the `'open' | 'closed'` the response body commits to.
  if (conversation === null || conversation.status === 'deleted') {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const body: ConversationDetailJson = {
    id: conversation.id,
    subject: conversation.subject,
    customerEmail: conversation.customerEmail,
    status: conversation.status,
    threadCount: conversation.threads.length,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    threads: conversation.threads.map(toThreadViewJson),
  }

  return json(200, body)
}

/**
 * Handle `POST /api/v1/conversations/{id}/replies` — the Agent replies to a
 * conversation (spec §4a). The client supplies only `{ text, html? }`; every
 * mail header (`to`, `from`, `subject`, `In-Reply-To`, `References`) is
 * derived server-side from the conversation (see {@link deriveReplyHeaders})
 * so the client can never set recipients or threading headers.
 *
 * ## `Idempotency-Key` is REQUIRED (HT-16, a deliberate breaking change)
 *
 * Every call MUST carry a non-empty `Idempotency-Key` header — its absence
 * is `400 validation_failed`, checked before the body is even parsed. This
 * endpoint is dogfood-only today (CHARTER.md's "dogfooded first"), so
 * tightening its contract has no external consumer to break. The header is
 * TRIMMED before every other check or use: leading/trailing whitespace never
 * makes two callers' "same" key look different, and the TRIMMED value is
 * what is checked for emptiness, checked against
 * {@link MAX_IDEMPOTENCY_KEY_LENGTH} (255 chars — `400 validation_failed` if
 * exceeded), stored, and passed to `sendReply`. A replay of the SAME
 * (trimmed) key on the SAME conversation is treated as the SAME logical
 * send — never re-diffed against the body — and returns the ORIGINAL
 * outcome (`sendReply`'s own replay handling, `src/mail/send.ts`): `201`
 * with the original `ThreadView` if that attempt already succeeded, without
 * touching the sender again.
 *
 * Outcomes (spec §4a): `201` with the created `ThreadView` on success (a
 * reply to a `closed` conversation reopens it, via `sendReply` →
 * `ConversationStore.appendThread`'s existing policy); `404 not_found` if
 * the conversation is missing or `deleted` (checked BEFORE minting/sending,
 * and again as a race check on `sendReply`'s own result — see below);
 * `400 validation_failed` on a missing `Idempotency-Key` header or a body
 * that violates the limits; `409 retry_in_progress` if another attempt with
 * the SAME key is already in flight and holds the delivery lease (HT-16;
 * `sendReply`'s `retry-in-progress` result) — nothing was sent by THIS
 * request; `502 send_failed` if the provider rejects the message —
 * `sendReply` returns a `send-failed` result (it does not throw), the
 * outbound thread is left `failed` OR, if even that mark failed, stuck
 * `pending` (`persistedStatus`), and nothing was delivered — so the response
 * says only that the reply could not be delivered, never a specific
 * persisted state and never a raw provider error (spec §4a, §5's
 * user-safe-message rule).
 */
export async function handleReply(
  id: string,
  request: Request,
  deps: {
    store: ConversationStore
    sender: EmailSender
    keyring: Keyring
    mailDomain: string
    supportAddress: string
  },
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

  const replyBody = parseReplyBody(parsedBody.value)
  if (replyBody === null) {
    return apiError(
      400,
      'validation_failed',
      `text is required and must be ${MIN_REPLY_TEXT_LENGTH}-${MAX_REPLY_TEXT_LENGTH} characters; html, if present, must be a string.`,
    )
  }

  // Fetched BEFORE sendReply purely to derive the reply's headers (subject,
  // In-Reply-To, References) from the conversation's current state — this is
  // NOT the authoritative existence/deleted check for the write itself.
  // `sendReply` (via `ConversationStore.appendThread`) re-checks under a row
  // lock at write time and is what `result.ok === false` reflects below, so a
  // conversation deleted in the gap between this read and that write is still
  // caught, just as a `404` rather than a silent write.
  const conversation = await deps.store.getConversation(id, { includeDeleted: false })
  if (conversation === null || conversation.status === 'deleted') {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const { subject, inReplyTo, references } = deriveReplyHeaders(conversation)

  const result = await sendReply(
    {
      // Use the CANONICAL id from the fetched row, not the raw path segment:
      // the id is minted verbatim into the outbound Message-ID token, and a
      // non-canonical (e.g. upper-cased) path id would put a non-canonical
      // conversationId in the token even though the stored row is lowercase.
      conversationId: conversation.id,
      from: deps.supportAddress,
      to: [conversation.customerEmail],
      subject,
      text: replyBody.text,
      html: replyBody.html,
      inReplyTo,
      references,
      idempotencyKey,
    },
    {
      store: deps.store,
      sender: deps.sender,
      keyring: deps.keyring,
      mailDomain: deps.mailDomain,
    },
  )

  if (!result.ok) {
    if (result.reason === 'send-failed') {
      // The provider rejected the message — nothing was delivered (§4a). Safe
      // to surface distinctly from an internal error; the raw provider error
      // is never exposed (§5). NOT a "saved for retry" promise — the reply may
      // be persisted 'failed' OR stuck 'pending' (result.persistedStatus), so
      // this message claims only what is always true: it wasn't delivered.
      return apiError(502, 'send_failed', 'The reply could not be delivered.')
    }
    if (result.reason === 'retry-in-progress') {
      // Another attempt with the SAME Idempotency-Key already holds the
      // delivery lease (HT-16) — nothing was sent by THIS request. The
      // in-flight attempt is expected to resolve the row on its own; the
      // caller should retry the SAME key again later, not mint a new one.
      return apiError(
        409,
        'retry_in_progress',
        'A delivery attempt for this Idempotency-Key is already in progress.',
      )
    }
    // conversation-not-found / conversation-deleted — a race: the conversation
    // went missing/deleted between the header-fetch above and appendThread's
    // own check. Nothing was sent — mirrors §3b's generic not-found.
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const updated = await deps.store.getConversation(conversation.id, { includeDeleted: false })
  const thread = updated?.threads.find((t) => t.id === result.threadId)
  if (updated == null || thread === undefined) {
    // Should be unreachable: sendReply just reported a successful append of
    // exactly this thread id. Treated as an internal error, not a routine
    // 404, if the invariant ever breaks.
    return apiError(500, 'server_error', 'Internal server error.')
  }

  return json(201, toThreadViewJson(thread))
}

/**
 * Handle `PATCH /api/v1/conversations/{id}` — close or reopen a conversation
 * (spec §4b). Body: `{ status: 'open' | 'closed' }` — `'deleted'` is
 * deliberately not a settable value here (`400`, not `404`, since the body
 * itself is malformed regardless of whether `{id}` exists).
 *
 * Outcomes: `200` with the updated `ConversationSummary` on success; `404
 * not_found` if `{id}` is missing or names a `deleted` conversation (a
 * deleted conversation is not reopenable through this endpoint — spec §4b);
 * `400 validation_failed` on any other `status` value.
 */
export async function handlePatchConversation(
  id: string,
  request: Request,
  deps: { store: ConversationStore },
): Promise<Response> {
  if (!isUuid(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const parsedBody = await parseJsonBody(request)
  if (!parsedBody.ok) {
    return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  }

  const status = parsePatchStatusBody(parsedBody.value)
  if (status === null) {
    return apiError(400, 'validation_failed', "status must be 'open' or 'closed'.")
  }

  const updated = await deps.store.setConversationStatus(id, status)
  if (updated === null) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  return json(200, toConversationSummaryJson(updated))
}

/**
 * Read and JSON-parse `request`'s body without ever throwing — a malformed
 * or empty body is `400 validation_failed`, never an uncontrolled `500`
 * (`request.json()` throws a `SyntaxError` on empty/invalid input, which
 * this catches). Returns the parsed value (still unvalidated against any
 * particular shape — that's each handler's own body-shape parser's job).
 */
async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

/** Validated shape of `POST .../replies`'s request body (spec §4a). */
interface ReplyRequestBody {
  text: string
  html?: string
}

/**
 * Validate a parsed reply body against spec §4a: `text` must be a string of
 * `[MIN_REPLY_TEXT_LENGTH, MAX_REPLY_TEXT_LENGTH]` chars; `html`, if
 * present, must be a string. Returns `null` on any violation — never throws.
 */
function parseReplyBody(raw: unknown): ReplyRequestBody | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { text, html } = raw as Record<string, unknown>

  if (
    typeof text !== 'string' ||
    text.length < MIN_REPLY_TEXT_LENGTH ||
    text.length > MAX_REPLY_TEXT_LENGTH
  ) {
    return null
  }
  if (html !== undefined && typeof html !== 'string') return null

  return html === undefined ? { text } : { text, html }
}

/**
 * Validate a parsed PATCH body against spec §4b: `status` must be exactly
 * `'open'` or `'closed'` — notably `'deleted'` is NOT settable here. Returns
 * `null` on any violation — never throws.
 */
function parsePatchStatusBody(raw: unknown): 'open' | 'closed' | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { status } = raw as Record<string, unknown>
  return status === 'open' || status === 'closed' ? status : null
}

/**
 * Derive a reply's mail headers from the conversation being replied to
 * (spec §4a):
 *
 * - `subject`: the conversation's subject, `Re: `-prefixed unless it already
 *   starts with `re:` (case-insensitive) — never double-prefixed.
 * - `inReplyTo`: the `messageId` of the most-recent INBOUND thread that has
 *   one. Threads are stored oldest-first, so this walks from the end
 *   looking for the first (i.e. most recent) inbound thread with a
 *   non-null `messageId`. `undefined` if there is none (e.g. every inbound
 *   message arrived without a `Message-ID`).
 * - `references`: every thread's `messageId`, in chronological order, that
 *   is non-null. `undefined` (the key omitted entirely, per spec §4a) when
 *   NO thread has one — never an empty array in that case.
 */
function deriveReplyHeaders(conversation: { subject: string; threads: StoredThread[] }): {
  subject: string
  inReplyTo: string | undefined
  references: string[] | undefined
} {
  const subject = /^re:/i.test(conversation.subject)
    ? conversation.subject
    : `Re: ${conversation.subject}`

  let inReplyTo: string | undefined
  for (let i = conversation.threads.length - 1; i >= 0; i--) {
    const thread = conversation.threads[i]
    if (thread.direction === 'inbound' && thread.messageId !== null) {
      inReplyTo = thread.messageId
      break
    }
  }

  const referencesList = conversation.threads
    .map((t) => t.messageId)
    .filter((messageId): messageId is string => messageId !== null)
  const references = referencesList.length > 0 ? referencesList : undefined

  return { subject, inReplyTo, references }
}

function toConversationSummaryJson(row: {
  id: string
  subject: string
  customerEmail: string
  status: 'open' | 'closed'
  threadCount: number
  createdAt: Date
  updatedAt: Date
}): ConversationSummaryJson {
  return {
    id: row.id,
    subject: row.subject,
    customerEmail: row.customerEmail,
    status: row.status,
    threadCount: row.threadCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function toThreadViewJson(thread: StoredThread): ThreadViewJson {
  return {
    id: thread.id,
    direction: thread.direction,
    from: thread.fromAddress,
    bodyText: thread.bodyText,
    bodyHtml: thread.bodyHtml,
    deliveryStatus: thread.deliveryStatus,
    createdAt: thread.createdAt.toISOString(),
  }
}
