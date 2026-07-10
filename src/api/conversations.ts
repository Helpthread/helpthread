/**
 * The two read handlers of the Agent Inbox API — `GET /api/v1/conversations`
 * (the inbox list, specs/api/agent-inbox-v1.md §3a) and
 * `GET /api/v1/conversations/{id}` (one conversation with its threads, §3b).
 *
 * Each handler is a pure function of an already-authenticated, already-
 * routed `Request` plus its store dependency — `src/api/index.ts` is what
 * authenticates and routes; nothing here re-checks either. Both return a
 * `Response` built exclusively through `src/api/responses.ts`'s helpers, so
 * every reply (success or error) carries the mandatory `Cache-Control:
 * no-store` (spec §3) without each handler having to remember it.
 */

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
