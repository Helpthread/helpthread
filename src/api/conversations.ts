/**
 * The Agent Inbox API's handlers: the two HT-17 read paths —
 * `GET /api/v1/conversations` (the inbox list, specs/api/agent-inbox-v1.md
 * §3a) and `GET /api/v1/conversations/{id}` (one conversation with its
 * threads, §3b) — plus the two HT-18 write paths — `POST
 * /api/v1/conversations/{id}/replies` (the Agent replies, §4a) and `PATCH
 * /api/v1/conversations/{id}` (set status, §4b).
 *
 * Each handler is a pure function of an already-authenticated, already-
 * routed `Request` plus its dependencies — `src/api/index.ts` is what
 * authenticates and routes; nothing here re-checks either. Every handler
 * returns a `Response` built exclusively through `src/api/responses.ts`'s
 * helpers, so every reply (success or error) carries the mandatory
 * `Cache-Control: no-store` (spec §3) without each handler having to
 * remember it.
 */

import { deriveReplyHeaders } from '../mail/reply-headers.js'
import type { Keyring } from '../mail/reply-token.js'
import { type SelfEchoGuardDeps, sendReply } from '../mail/send.js'
import type { BlobStore, EmailSender } from '../providers/index.js'
import type { AgentRecord, AgentStore } from '../store/agents.js'
import type { StoredThreadAttachment, ThreadAttachmentStore } from '../store/attachments.js'
import {
  type ConversationFolder,
  type ConversationStatus,
  type ConversationStore,
  derivePreview,
  type StoredThread,
} from '../store/conversations.js'
import { decodeCursor, encodeCursor } from './cursor.js'
import { apiError, json, noContent } from './responses.js'
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

/**
 * The wire shape of one attachment on a `ThreadView` (specs/api/agent-inbox-v1.md
 * §2, HT-46): attachment METADATA plus a time-limited signed URL — never a
 * stable/public path (`BlobStore.getSignedUrl`'s contract, `src/providers/blob.ts`).
 */
interface AttachmentViewJson {
  id: string
  filename: string | null
  contentType: string
  size: number
  url: string
}

/** The wire shape of one `ThreadView` (specs/api/agent-inbox-v1.md §2, amended HT-70 §7) — `StoredThread` with `Date` fields as ISO strings and `fromAddress` renamed to `from`. */
export interface ThreadViewJson {
  id: string
  direction: 'inbound' | 'outbound' | 'note'
  from: string
  bodyText: string | null
  bodyHtml: string | null
  deliveryStatus: 'pending' | 'sent' | 'failed' | null
  /** Open tracking (spec §4g, v1.1): first customer view of this outbound reply; null until then, always null for inbound/notes or with the feature off. */
  customerViewedAt: string | null
  /** HT-46: `[]` unless this thread has stored attachment references AND the deployment wired `attachments` deps (see {@link handleGetConversation}) — absent-by-default, like `openTracking`. */
  attachments: AttachmentViewJson[]
  createdAt: string
  /** HT-70 (agent-inbox-v1.md §7): who authored this thread — `'customer'` (inbound mail), `'agent'` (human), or `'assistant'` (an AI-authored draft). */
  authorKind: 'customer' | 'agent' | 'assistant'
  /** HT-70 (agent-inbox-v1.md §7): a draft's lifecycle state, or `null` for every non-draft thread. */
  draftStatus: 'awaiting_review' | 'approved' | 'discarded' | null
}

/** The wire shape of one `ConversationSummary` (specs/api/agent-inbox-v1.md §2) — `Date` fields as ISO strings. */
interface ConversationSummaryJson {
  id: string
  number: number
  subject: string
  customerEmail: string
  status: ConversationStatus
  threadCount: number
  preview: string
  tags: string[]
  assigneeAgentId: string | null
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

  // `status` here is a FOLDER, not a raw status (spec §3a, v1.1): `open` =
  // active + pending; `closed`/`spam` = exactly that status. `active` and
  // `pending` are deliberately NOT accepted — folders are the reading grain.
  const statusParam = url.searchParams.get('status')
  let folder: ConversationFolder
  if (statusParam === null) {
    folder = 'open'
  } else if (statusParam === 'open' || statusParam === 'closed' || statusParam === 'spam') {
    folder = statusParam
  } else {
    return apiError(400, 'validation_failed', "status must be 'open', 'closed' or 'spam'.")
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
  const rows = await deps.store.listConversations({ folder, limit: limit + 1, cursor })
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
 * How long a minted attachment signed URL stays valid (`BlobStore.getSignedUrl`'s
 * `expiresInSeconds`, HT-46). One hour: long enough to cover an Agent opening
 * the conversation and viewing/downloading an attachment in one sitting,
 * short enough that a URL copied out of a stale API response doesn't stay a
 * standing credential. Not tuned against any measured usage — a reasonable
 * default, re-minted fresh on every `GET` since nothing here caches it.
 */
const ATTACHMENT_SIGNED_URL_EXPIRY_SECONDS = 3600

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
  deps: {
    store: ConversationStore
    /**
     * Attachment read-path deps (HT-46) — ABSENT BY DEFAULT, the same posture
     * `InboxApiDeps.openTracking` uses: a deployment that hasn't wired a
     * `ThreadAttachmentStore` + `BlobStore` here simply never surfaces
     * attachments, and every `ThreadView.attachments` is `[]`.
     */
    attachments?: { store: ThreadAttachmentStore; blobStore: BlobStore }
  },
): Promise<Response> {
  if (!isUuid(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const conversation = await deps.store.getConversation(id, { includeDeleted: false })
  // `includeDeleted: false` already makes the store return null for a deleted
  // conversation. The `=== 'deleted'` arm is defense-in-depth — it can't fire
  // at runtime today, but it guarantees the API never serves a deleted
  // conversation even if the store's contract later regressed, and it narrows
  // `status` to the `ConversationStatus` the response body commits to.
  if (conversation === null || conversation.status === 'deleted') {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const attachmentsByThreadId =
    deps.attachments !== undefined
      ? await attachmentViewsByThreadId(conversation.id, deps.attachments)
      : new Map<string, AttachmentViewJson[]>()

  const body: ConversationDetailJson = {
    id: conversation.id,
    number: conversation.number,
    subject: conversation.subject,
    customerEmail: conversation.customerEmail,
    status: conversation.status,
    // HT-70 (spec §7): an unresolved or discarded draft is not conversation
    // content until sent — excluded from the count here exactly as
    // ConversationStore.listConversations' own subqueries exclude it from
    // the list view's threadCount/preview. The FULL thread list below
    // (`threads:`) still includes every draft row — Agent/service callers
    // see them in the timeline (spec §7's last bullet); only the count and
    // the derived preview ignore them.
    threadCount: countResolvedThreads(conversation.threads),
    preview: previewFromThreads(conversation.threads),
    tags: conversation.tags,
    assigneeAgentId: conversation.assigneeAgentId,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    threads: conversation.threads.map((thread) =>
      toThreadViewJson(thread, attachmentsByThreadId.get(thread.id)),
    ),
  }

  return json(200, body)
}

/**
 * Fetch every attachment reference for `conversationId` in one round trip
 * (`ThreadAttachmentStore.listByConversationId`) and mint each one's signed
 * URL, grouped by the thread id it belongs to. Signing happens here, not in
 * the store, so `ThreadAttachmentStore` stays a plain persistence seam with
 * no `BlobStore` dependency of its own (mirroring how `ConversationStore`
 * never touches a provider either).
 */
async function attachmentViewsByThreadId(
  conversationId: string,
  attachments: { store: ThreadAttachmentStore; blobStore: BlobStore },
): Promise<Map<string, AttachmentViewJson[]>> {
  const rows = await attachments.store.listByConversationId(conversationId)
  // Mint every row's signed URL concurrently (independent BlobStore calls,
  // no shared state) rather than one at a time — a conversation with many
  // attachments would otherwise pay one signing round trip per attachment,
  // serially, on every GET.
  const entries = await Promise.all(
    rows.map(
      async (row) =>
        [row.threadId, await toAttachmentViewJson(row, attachments.blobStore)] as const,
    ),
  )
  const byThreadId = new Map<string, AttachmentViewJson[]>()
  for (const [threadId, view] of entries) {
    const existing = byThreadId.get(threadId)
    if (existing === undefined) {
      byThreadId.set(threadId, [view])
    } else {
      existing.push(view)
    }
  }
  return byThreadId
}

async function toAttachmentViewJson(
  row: StoredThreadAttachment,
  blobStore: BlobStore,
): Promise<AttachmentViewJson> {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    url: await blobStore.getSignedUrl(row.blobKey, ATTACHMENT_SIGNED_URL_EXPIRY_SECONDS),
  }
}

/** HT-70 (spec §7): true for a draft that is not yet conversation content — unresolved or discarded. An `'approved'` or non-draft (`null`) thread is real content. */
function isUnresolvedOrDiscardedDraft(thread: StoredThread): boolean {
  return thread.draftStatus === 'awaiting_review' || thread.draftStatus === 'discarded'
}

/**
 * Derive a detail response's `preview` from the threads it already carries —
 * the SAME rule the store applies for list summaries (`derivePreview`, spec
 * §2): the most recent thread with a non-null `bodyText`. Threads arrive
 * oldest-first, so this walks from the end. HT-70 (spec §7): skips any
 * unresolved or discarded draft — the same exclusion
 * `ConversationStore.listConversations`' `LATEST_BODY_TEXT_SUBQUERY`
 * applies at the store layer for the list view.
 */
function previewFromThreads(threads: StoredThread[]): string {
  for (let i = threads.length - 1; i >= 0; i--) {
    const thread = threads[i]
    if (isUnresolvedOrDiscardedDraft(thread)) continue
    if (thread.bodyText !== null) {
      return derivePreview(thread.bodyText)
    }
  }
  return ''
}

/** HT-70 (spec §7): the detail response's `threadCount`, excluding unresolved/discarded drafts — mirrors `ConversationStore.listConversations`' `THREAD_COUNT_SUBQUERY` exclusion at the store layer. */
function countResolvedThreads(threads: StoredThread[]): number {
  return threads.filter((thread) => !isUnresolvedOrDiscardedDraft(thread)).length
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
 * reply to a `closed` or `spam` conversation reopens it to `active`, via
 * `sendReply` → `ConversationStore.appendThread`'s existing policy); `404 not_found` if
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
    openTracking?: { publicBaseUrl: string }
    selfEchoGuard?: SelfEchoGuardDeps
    /** HT-70 (spec §3's author-identity forward-carry): the acting Agent's id from `X-Helpthread-Agent-Id`, or `null` when absent/unknown — `src/api/index.ts` resolves this before dispatch. Never an error when absent (spec §9 decision 4). */
    authorAgentId?: string | null
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
  // HT-70 review fix (Opus): a reply's idempotency key is stored RAW — unlike
  // a draft's, which the engine itself prefixes (`ConversationStore.appendDraft`
  // stores it as `` `draft:${key}` ``, src/store/conversations.ts). Without
  // this check, a caller-supplied reply key literally spelled e.g. `draft:abc`
  // would land in the SAME `(conversation_id, idempotency_key)` row a draft's
  // engine-owned `draft:abc` key would use — the two sub-namespaces are
  // disjoint only because BOTH halves hold: the engine never lets a draft key
  // escape its `draft:` prefix, AND a reply key is refused if it tries to
  // enter that prefix itself. Retro-prefixing reply keys instead was rejected
  // (a stored-raw key in production would lose idempotency continuity for
  // every reply already in flight).
  if (idempotencyKey.startsWith('draft:')) {
    return apiError(
      400,
      'validation_failed',
      "Idempotency-Key must not start with the reserved prefix 'draft:'.",
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
      authorAgentId: deps.authorAgentId ?? null,
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
 * Handle `PATCH /api/v1/conversations/{id}` — set a conversation's status
 * (spec §4b, v1.1). Body: `{ status: 'active' | 'pending' | 'closed' |
 * 'spam' }` — `'deleted'` is deliberately not a settable value here (`400`,
 * not `404`, since the body itself is malformed regardless of whether
 * `{id}` exists).
 *
 * Outcomes: `200` with the updated `ConversationSummary` on success; `404
 * not_found` if `{id}` is missing or names a `deleted` conversation (a
 * deleted conversation is not reachable through this endpoint — spec §4b);
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
    return apiError(
      400,
      'validation_failed',
      "status must be 'active', 'pending', 'closed' or 'spam'.",
    )
  }

  const updated = await deps.store.setConversationStatus(id, status)
  if (updated === null) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  return json(200, toConversationSummaryJson(updated))
}

/**
 * Handle `DELETE /api/v1/conversations/{id}` — soft delete (spec §4d, v1.1).
 *
 * `204` with an empty body on success. `404 not_found` when `{id}` is
 * missing, already deleted, or not UUID-shaped — all three identical, per
 * §5's no-existence-leak rule (deleting twice reports the second call as a
 * plain miss). From this point every endpoint treats the conversation as
 * nonexistent — including a keyed replay of a previously-successful reply
 * (§4a's replay-vs-delete rule); the store's existing deleted-handling
 * covers all of them, so this handler is just the flag flip plus the
 * spec's response mapping.
 */
export async function handleDeleteConversation(
  id: string,
  deps: { store: ConversationStore },
): Promise<Response> {
  if (!isUuid(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const deleted = await deps.store.deleteConversation(id)
  if (!deleted) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  return noContent()
}

/**
 * Who is authoring a note (HT-70; specs/plugins/substrate-v1.md §3, §6) —
 * an Agent (identity from the acting-agent header, possibly unknown) or an
 * authenticated Assistant (identity from its token — spec §6 makes this
 * endpoint "now legal for assistants"). `src/api/index.ts` builds this from
 * whichever credential authenticated the request before dispatching here.
 */
export type NoteAuthor =
  | { kind: 'agent'; agentId: string | null }
  | { kind: 'assistant'; assistantId: string }

/**
 * Handle `POST /api/v1/conversations/{id}/notes` — append an internal note
 * (spec §4c, v1.1; HT-70 spec §6 opens this endpoint to Assistants too).
 * Body: `{ text: string }`, 1–5000 chars, plain text only in v1. A note is
 * Agent/Assistant-only context: it is NEVER emailed — this handler never
 * touches `sendReply`, mints no token, creates no outbox row (the boundary
 * spec §4c calls a bug if crossed; the tests assert the sender is never
 * invoked). It bumps `updatedAt` (a note is activity) but never changes
 * `status` — noting a closed conversation does not reopen it
 * (`appendThread`'s note-aware policy).
 *
 * HT-70 (spec §3): every caller's identity is now recorded —
 * `deps.author.kind === 'assistant'` writes `author_kind: 'assistant'` +
 * `author_assistant_id`; an Agent/service caller writes `author_agent_id`
 * (possibly `null`, when no acting-agent header was presented — never an
 * error, spec §9 decision 4). This is the ONE handler HT-70 makes start
 * recording author identity for every caller — pre-HT-70 it recorded none.
 *
 * Outcomes: `201` with the created `ThreadView` (`direction: 'note'`,
 * `from` = the support address, `deliveryStatus: null`);
 * `400 validation_failed` on a bad body; `404 not_found` for a missing or
 * deleted conversation.
 */
export async function handlePostNote(
  id: string,
  request: Request,
  deps: { store: ConversationStore; supportAddress: string; author: NoteAuthor },
): Promise<Response> {
  if (!isUuid(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const parsedBody = await parseJsonBody(request)
  if (!parsedBody.ok) {
    return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  }

  const note = parseNoteBody(parsedBody.value)
  if (note === null) {
    return apiError(
      400,
      'validation_failed',
      `text is required and must be ${MIN_REPLY_TEXT_LENGTH}-${MAX_REPLY_TEXT_LENGTH} characters.`,
    )
  }

  const result = await deps.store.appendThread(id, {
    direction: 'note',
    messageId: null,
    fromAddress: deps.supportAddress,
    bodyText: note.text,
    ...(deps.author.kind === 'assistant'
      ? { authorKind: 'assistant' as const, authorAssistantId: deps.author.assistantId }
      : { authorAgentId: deps.author.agentId }),
  })
  if (!result.ok) {
    // not-found and deleted are one generic 404 (spec §5's no-existence-leak).
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  return json(201, toThreadViewJson(result.thread))
}

/** Maximum length of one tag, after trimming (spec §4e, v1.1). */
const MAX_TAG_LENGTH = 40

/**
 * Handle `PUT /api/v1/conversations/{id}/tags` — replace the tag set (spec
 * §4e, v1.1). Body: `{ tags: string[] }`, replace-set semantics (`[]`
 * clears). Normalization happens HERE, before the store sees anything:
 * each entry trimmed, then lowercased, then the array de-duplicated
 * preserving first-occurrence order. Validation is on the TRIMMED value —
 * 1–{@link MAX_TAG_LENGTH} chars; a non-array `tags`, a non-string entry,
 * an empty-after-trim entry, or an over-length entry is
 * `400 validation_failed`. `200` with the updated summary; missing or
 * deleted conversation → `404 not_found`.
 */
export async function handlePutTags(
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

  const tags = parseTagsBody(parsedBody.value)
  if (tags === null) {
    return apiError(
      400,
      'validation_failed',
      `tags must be an array of strings, each 1-${MAX_TAG_LENGTH} characters after trimming.`,
    )
  }

  const updated = await deps.store.setConversationTags(id, tags)
  if (updated === null) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  return json(200, toConversationSummaryJson(updated))
}

/**
 * Handle `PUT /api/v1/conversations/{id}/assignee` — assign or release
 * (spec §4f, v1.1; graduated to a real Agent identity by HT-54,
 * specs/auth/agents-and-auth.md §3.3/§10 — **breaking**: the body was
 * `{ assignee: 'me' | null }`, now `{ assigneeAgentId: uuid | null }`; the
 * old shape is simply a `400` now, since `assignee` is not a recognized
 * property). This is now the one existing inbox endpoint that requires the
 * acting-Agent header (spec §8) — any ACTIVE Agent may assign any Agent
 * (spec §5's role model; no admin gate here).
 *
 * A non-null `assigneeAgentId` that isn't uuid-shaped, or doesn't name an
 * existing Agent, is `400 validation_failed` (a generic message — no
 * existence oracle beyond what any Agent can already see via `GET
 * /api/v1/agents`, per the brief's acceptance of that as fine here).
 * `200` with the updated summary; missing or deleted conversation → `404`.
 */
export async function handlePutAssignee(
  id: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: { store: ConversationStore; agentStore: AgentStore },
): Promise<Response> {
  if (actingAgent === null) {
    return apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
  }
  if (!isUuid(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const parsedBody = await parseJsonBody(request)
  if (!parsedBody.ok) {
    return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  }

  const assigneeAgentId = parseAssigneeBody(parsedBody.value)
  if (assigneeAgentId === undefined) {
    return apiError(400, 'validation_failed', 'assigneeAgentId must be a uuid string or null.')
  }
  if (assigneeAgentId !== null) {
    if (!isUuid(assigneeAgentId)) {
      return apiError(400, 'validation_failed', 'assigneeAgentId must be a valid uuid.')
    }
    const assigneeExists = await deps.agentStore.getAgent(assigneeAgentId)
    if (assigneeExists === null) {
      return apiError(400, 'validation_failed', 'assigneeAgentId does not name an existing Agent.')
    }
  }

  const updated = await deps.store.setConversationAssignee(id, assigneeAgentId)
  if (updated === 'invalid_agent') {
    // The Agent existed at the check above but was deleted before the write
    // landed — same caller-facing outcome as never having existed.
    return apiError(400, 'validation_failed', 'assigneeAgentId does not name an existing Agent.')
  }
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
 * Validate a parsed PATCH body against spec §4b (v1.1): `status` must be one
 * of the four {@link ConversationStatus} values — notably `'deleted'` is NOT
 * settable here. Returns `null` on any violation — never throws.
 */
function parsePatchStatusBody(raw: unknown): ConversationStatus | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { status } = raw as Record<string, unknown>
  return status === 'active' || status === 'pending' || status === 'closed' || status === 'spam'
    ? status
    : null
}

/**
 * Validate a POST-notes body against spec §4c: `text` must be a string of
 * `[MIN_REPLY_TEXT_LENGTH, MAX_REPLY_TEXT_LENGTH]` chars; notes are plain
 * text in v1, so there is no `html` (unknown properties are ignored, the
 * same posture as the reply body). Returns `null` on any violation — never
 * throws.
 */
function parseNoteBody(raw: unknown): { text: string } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { text } = raw as Record<string, unknown>
  if (
    typeof text !== 'string' ||
    text.length < MIN_REPLY_TEXT_LENGTH ||
    text.length > MAX_REPLY_TEXT_LENGTH
  ) {
    return null
  }
  return { text }
}

/**
 * Validate and NORMALIZE a PUT-tags body against spec §4e: `tags` must be an
 * array of strings; each entry is trimmed then lowercased and must be
 * 1-{@link MAX_TAG_LENGTH} chars after trimming; the result is de-duplicated
 * preserving first-occurrence order. Returns the normalized array, or `null`
 * on any violation — never throws.
 */
function parseTagsBody(raw: unknown): string[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { tags } = raw as Record<string, unknown>
  if (!Array.isArray(tags)) return null

  const normalized: string[] = []
  for (const entry of tags) {
    if (typeof entry !== 'string') return null
    const tag = entry.trim().toLowerCase()
    if (tag.length < 1 || tag.length > MAX_TAG_LENGTH) return null
    if (!normalized.includes(tag)) normalized.push(tag)
  }
  return normalized
}

/**
 * Validate a PUT-assignee body against spec §4f/§10 (HT-54's breaking body
 * shape): the `assigneeAgentId` property must be PRESENT and either a
 * string (uuid-shape checked by the caller, which also confirms the Agent
 * exists) or `null`. Returns the value, or `undefined` on any violation
 * (unambiguous precisely because `undefined` — a missing property, or the
 * OLD `{ assignee: 'me' }` shape, which has no `assigneeAgentId` key at
 * all — is itself a violation) — never throws.
 */
function parseAssigneeBody(raw: unknown): string | null | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  if (!('assigneeAgentId' in raw)) return undefined
  const { assigneeAgentId } = raw as Record<string, unknown>
  if (assigneeAgentId === null) return null
  return typeof assigneeAgentId === 'string' ? assigneeAgentId : undefined
}

function toConversationSummaryJson(row: {
  id: string
  number: number
  subject: string
  customerEmail: string
  status: ConversationStatus
  threadCount: number
  preview: string
  tags: string[]
  assigneeAgentId: string | null
  createdAt: Date
  updatedAt: Date
}): ConversationSummaryJson {
  return {
    id: row.id,
    number: row.number,
    subject: row.subject,
    customerEmail: row.customerEmail,
    status: row.status,
    threadCount: row.threadCount,
    preview: row.preview,
    tags: row.tags,
    assigneeAgentId: row.assigneeAgentId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Map one `StoredThread` to its wire shape. `attachments` defaults to `[]` —
 * every caller EXCEPT {@link handleGetConversation} passes none, because a
 * thread this API just created (a reply or a note) cannot yet have any
 * (HT-46: attachments are inbound-only, and only `handleGetConversation`'s
 * deps carry the `ThreadAttachmentStore`/`BlobStore` needed to look them up).
 *
 * Exported (HT-70): `src/api/drafts.ts`'s handlers build the SAME
 * `ThreadView` shape for a draft row (a draft IS a thread, per the
 * substrate spec's "keeping it in `threads`" decision) — one mapper, not a
 * second copy that could drift on the `authorKind`/`draftStatus` fields.
 */
export function toThreadViewJson(
  thread: StoredThread,
  attachments: AttachmentViewJson[] = [],
): ThreadViewJson {
  return {
    id: thread.id,
    direction: thread.direction,
    from: thread.fromAddress,
    bodyText: thread.bodyText,
    bodyHtml: thread.bodyHtml,
    deliveryStatus: thread.deliveryStatus,
    customerViewedAt:
      thread.customerViewedAt === null ? null : thread.customerViewedAt.toISOString(),
    attachments,
    createdAt: thread.createdAt.toISOString(),
    authorKind: thread.authorKind,
    draftStatus: thread.draftStatus,
  }
}
