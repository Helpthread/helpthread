/**
 * `ConversationStore` — persistence for conversations and their threads.
 *
 * A conversation has many threads; a thread is exactly ONE message
 * (inbound customer mail, or outbound agent/assistant mail). This is the
 * layer the inbound threading decision (`src/mail/thread.ts`,
 * `decideThreading`) lands on: a `{ kind: 'new' }` decision becomes a
 * {@link createConversation} call, a `{ kind: 'append', conversationId,
 * threadId }` decision becomes an {@link appendThread} call. The
 * `conversationId`/`threadId` pair minted here for a NEW conversation's
 * first outbound reply is exactly what later gets signed into that
 * reply's outbound `Message-ID` via `mintReplyMessageId`
 * (`src/mail/reply-token.ts`) — this module is the source of the ids that
 * token embeds, not the other way around.
 *
 * **Threading decisions still live in `src/mail/thread.ts`.** This module
 * does not decide *which* conversation a message belongs to — it only
 * persists the decision it's handed, and enforces what happens at the
 * storage layer when that target conversation is closed, deleted, or
 * missing. Keeping that line sharp matters: `decideThreading` is a pure
 * function with no I/O (specs/mail/threading.md §3) precisely so it stays
 * fixture-testable in isolation; this module is where the I/O — and the
 * storage-side policy below — actually happens.
 *
 * ## Resolving specs/mail/threading.md §5's open questions
 *
 * §5 left three related questions open pending an implementation to
 * resolve them. This module is that implementation, and the behavior
 * below is the resolution:
 *
 * - **A valid token to a CLOSED conversation** → {@link appendThread}
 *   inserts the thread AND reopens the conversation (`status` back to
 *   `'open'`). This is the Help Scout-like behavior the charter holds
 *   itself to (CHARTER.md §1): a customer replying to a resolved ticket
 *   should not silently fall on the floor or spawn a confusing duplicate —
 *   it reopens the same conversation, matching what an agent would expect
 *   to see.
 * - **A valid token to a DELETED conversation** → {@link appendThread}
 *   inserts NOTHING and returns `{ ok: false, reason: 'deleted' }`. Unlike
 *   the closed case, a deleted conversation is not a live target to reopen
 *   — the caller (the mail-ingestion pipeline, not yet built) is expected
 *   to fall back to starting a fresh conversation for the message rather
 *   than resurrecting a deleted one, so the token's orphaned target is
 *   never silently dropped (CHARTER.md invariant #1: never lose or corrupt
 *   customer mail) but also never writes into a conversation an operator
 *   intentionally removed.
 * - **A valid token whose conversation doesn't exist at all** (never
 *   observed in practice — a token only exists if `createConversation`
 *   minted the ids it carries — but not something this layer can assume
 *   away, since inputs here are only as trustworthy as whatever called
 *   in) → {@link appendThread} returns `{ ok: false, reason: 'not-found' }`,
 *   the same "don't crash, don't silently drop, tell the caller" shape as
 *   the deleted case.
 *
 * All three are enforced inside a single transaction per {@link appendThread}
 * call — see its doc comment for the concurrency reasoning.
 */

import type { Db, Queryable, SqlValue } from '../db/client.js'

/** One message to be persisted as a new thread — inbound customer mail, or outbound agent/assistant mail. */
export interface NewThread {
  /**
   * Caller-supplied thread id (a v4 UUID), for outbound threads whose id
   * must be known BEFORE the row is inserted — the outbound `Message-ID`
   * embeds a signed token over `{conversationId, threadId}`
   * (specs/mail/sending.md §2's "id/token knot"), so `mintReplyMessageId`
   * must run before this insert, not after it. When omitted, the database's
   * `gen_random_uuid()` default generates the id (the inbound path, which
   * has no such circularity).
   */
  id?: string
  direction: 'inbound' | 'outbound'
  /**
   * The RFC `Message-ID` of this message, verbatim. For an inbound
   * message this is whatever the sending client wrote (or `null` if
   * absent). For an outbound message this is the reply token minted by
   * `mintReplyMessageId` (`src/mail/reply-token.ts`) — the value that,
   * signed, is what makes a future reply to this thread threadable at
   * all.
   */
  messageId: string | null
  /** The `In-Reply-To` header of this message, verbatim, if present. */
  inReplyTo?: string | null
  fromAddress: string
  bodyText?: string | null
  bodyHtml?: string | null
  /**
   * Outbox status for an OUTBOUND thread: `'pending'` immediately after
   * mint-and-persist, `'sent'`/`'failed'` once the send attempt resolves
   * (specs/mail/sending.md §3). Inbound threads leave this `null` (or
   * omitted) — delivery status is not a meaningful concept for mail we
   * received, and the column stays `NULL` for those rows.
   */
  deliveryStatus?: 'pending' | 'sent' | 'failed' | null
}

/** Input to {@link ConversationStore.createConversation}: a new conversation plus its first thread. */
export interface NewConversation {
  subject: string
  customerEmail: string
  firstMessage: NewThread
}

/** A thread as read back from storage — camelCase, timestamps as `Date`. */
export interface StoredThread {
  id: string
  conversationId: string
  direction: 'inbound' | 'outbound'
  messageId: string | null
  inReplyTo: string | null
  fromAddress: string
  bodyText: string | null
  bodyHtml: string | null
  /** Outbox status — `null` for inbound threads, `'pending'|'sent'|'failed'` for outbound ones. See {@link NewThread.deliveryStatus}. */
  deliveryStatus: 'pending' | 'sent' | 'failed' | null
  createdAt: Date
}

/** A conversation as read back from storage — camelCase, timestamps as `Date`. */
export interface StoredConversation {
  id: string
  subject: string
  customerEmail: string
  status: 'open' | 'closed' | 'deleted'
  createdAt: Date
  updatedAt: Date
}

/**
 * The outcome of {@link ConversationStore.appendThread}. Modeled as an
 * explicit discriminated result rather than throw/catch — a reply landing
 * on a deleted or nonexistent conversation is an expected, not exceptional,
 * outcome of running arbitrary inbound mail through the threading decision
 * (see the module doc's resolution of specs/mail/threading.md §5), and
 * callers should handle it as ordinary control flow.
 */
export type AppendResult =
  | { ok: true; threadId: string }
  | { ok: false; reason: 'not-found' | 'deleted' }

/** Persistence operations for conversations and their threads. See the module doc for the storage-layer policy this implements. */
export interface ConversationStore {
  /**
   * Insert a new conversation and its first thread in ONE transaction:
   * atomic, so if the thread insert fails (e.g. a constraint violation) NO
   * conversation row survives — there is no such thing as a conversation
   * with zero threads as a persisted state.
   */
  createConversation(input: NewConversation): Promise<{ conversationId: string; threadId: string }>

  /**
   * Append `thread` to the conversation `conversationId`, applying the
   * closed/deleted/missing policy documented at the top of this module.
   * See that doc for the full behavior; summarized: missing → `not-found`,
   * deleted → `deleted` (nothing inserted), closed → inserted AND
   * reopened, open → inserted. Any successful insert also bumps the
   * conversation's `updated_at`.
   */
  appendThread(conversationId: string, thread: NewThread): Promise<AppendResult>

  /**
   * Read one conversation with all of its threads, ordered oldest-first
   * (`created_at, id` — the `id` tiebreak makes ordering stable even for
   * threads inserted within the same timestamp tick). Returns `null` if no
   * conversation exists with that id.
   *
   * `options.includeDeleted` defaults to `true` (the row is returned whatever
   * its status). Pass `false` on a public read path (the Agent Inbox API):
   * a `deleted` conversation then returns `null` — decided by the
   * conversation lookup itself, BEFORE any threads are loaded — so a deleted
   * id is indistinguishable from a nonexistent one not just in the response
   * body but in the work done (no thread-count-dependent latency signal;
   * specs/api/agent-inbox-v1.md §5 "no existence leak").
   */
  getConversation(
    conversationId: string,
    options?: { includeDeleted?: boolean },
  ): Promise<(StoredConversation & { threads: StoredThread[] }) | null>

  /**
   * Update an outbound thread's outbox status in place (specs/mail/sending.md
   * §3's persist→send→mark ordering — this is the "mark" step). Callers
   * (`src/mail/send.ts`) invoke this AFTER the send attempt resolves, moving
   * a thread from `'pending'` to `'sent'` or `'failed'`. Not transactional
   * with anything else — this is a single-row status flip by primary key,
   * and the row was already durably persisted before the send was attempted.
   */
  setThreadDeliveryStatus(threadId: string, status: 'pending' | 'sent' | 'failed'): Promise<void>

  /**
   * List conversation summaries for the agent inbox — the read path behind
   * `GET /api/v1/conversations` (specs/api/agent-inbox-v1.md §3a). Ordered
   * `updated_at DESC, id DESC` (most-recently-active first, `id` as a
   * stable tiebreak for rows updated in the same instant — the same
   * stable-tiebreak pattern {@link getConversation} uses for threads). A
   * `deleted` conversation is NEVER returned, regardless of
   * `options.status` — see {@link ListConversationsOptions.status}.
   *
   * Returns exactly `options.limit` rows (or fewer, at the end of the
   * result set) — this method does no over-fetching of its own. Detecting
   * "is there a next page" by asking for `limit + 1` is the HTTP layer's
   * job (`src/api/conversations.ts`), which knows about `nextCursor`; this
   * store method only knows how to fetch a page.
   */
  listConversations(options: ListConversationsOptions): Promise<ConversationSummary[]>
}

/**
 * Correlated subquery for a conversation's thread count, cast to `::int` so
 * PGlite/`pg` hand back a plain JS `number` rather than a `bigint`-shaped
 * string (Postgres's `count()` aggregate returns `bigint` by default,
 * which node-postgres-family drivers serialize as a string specifically to
 * avoid silently truncating a value bigger than `Number.MAX_SAFE_INTEGER`;
 * a per-conversation thread count will never approach that, so the `::int`
 * cast is safe and keeps the mapped {@link ConversationSummary} shape a
 * plain `number` like every other count in this codebase, e.g. the
 * `count(*)::int` precedent in `conversations.test.ts`).
 */
const THREAD_COUNT_SUBQUERY =
  '(SELECT count(*) FROM threads t WHERE t.conversation_id = c.id)::int AS thread_count'

/**
 * A conversation summary as read back for the inbox list — the same
 * conversation fields as {@link StoredConversation} minus the internal
 * `deleted` status (never surfaced, per spec §3a) plus `threadCount`, a
 * count that would otherwise cost every list consumer a second round trip.
 * This is the store-layer shape `src/api/conversations.ts`'s list handler
 * serializes to the wire `ConversationSummary` (specs/api/agent-inbox-v1.md
 * §2) with `Date` → ISO string.
 */
export interface ConversationSummary {
  id: string
  subject: string
  customerEmail: string
  status: 'open' | 'closed'
  threadCount: number
  createdAt: Date
  updatedAt: Date
}

/**
 * A keyset pagination cursor: the `(updatedAt, id)` of the last row a
 * previous page returned. Paired with {@link ListConversationsOptions.status}
 * and the ordering `listConversations` commits to (`updated_at DESC, id
 * DESC`), this lets the next page ask for rows strictly AFTER this position
 * without an OFFSET — correct even if conversations are inserted/updated
 * between page fetches, which an offset-based scheme would skip or
 * duplicate under (specs/api/agent-inbox-v1.md §3a).
 */
export interface ConversationListCursor {
  updatedAt: Date
  id: string
}

/** Input to {@link ConversationStore.listConversations}. */
export interface ListConversationsOptions {
  /**
   * When given, filter to exactly this status. When omitted, return every
   * conversation EXCEPT `deleted` — there is no filter value that returns
   * deleted rows; they are never surfaced by this call (spec §3a).
   */
  status?: 'open' | 'closed'
  /** Exact row count to fetch — callers (the HTTP layer) decide over-fetch-by-one for pagination detection themselves. */
  limit: number
  /** Keyset cursor: return rows ordered strictly after this position. Omit for the first page. */
  cursor?: ConversationListCursor
}

/** Raw `conversations` row shape, before mapping to {@link StoredConversation}. */
interface ConversationRow {
  id: string
  subject: string
  customer_email: string
  status: string
  created_at: Date | string
  updated_at: Date | string
}

/**
 * Raw row shape for {@link createConversationStore}'s `listConversations`
 * query — a conversation row plus its correlated `thread_count`. Cast to
 * `::int` in the query itself (see `THREAD_COUNT_SUBQUERY`), and PGlite
 * (verified against the installed 0.5.4) returns Postgres `int4` as a plain
 * JS `number`, matching the existing `count(*)::int` precedent in
 * `conversations.test.ts`.
 */
interface ConversationSummaryRow extends ConversationRow {
  thread_count: number
}

/** Raw `threads` row shape, before mapping to {@link StoredThread}. */
interface ThreadRow {
  id: string
  conversation_id: string
  direction: string
  message_id: string | null
  in_reply_to: string | null
  from_address: string
  body_text: string | null
  body_html: string | null
  delivery_status: string | null
  created_at: Date | string
}

const THREAD_COLUMNS =
  'id, conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status, created_at'

/**
 * Create a {@link ConversationStore} backed by `db`. Every operation opens
 * its own transaction (or, for the read-only {@link ConversationStore.getConversation},
 * plain queries) against `db` — this factory holds no state of its own.
 */
export function createConversationStore(db: Db): ConversationStore {
  return {
    async createConversation(input) {
      return db.transaction(async (tx) => {
        const [conversation] = await tx.query<{ id: string }>(
          'INSERT INTO conversations (subject, customer_email) VALUES ($1, $2) RETURNING id',
          [input.subject, input.customerEmail],
        )
        const threadId = await insertThread(tx, conversation.id, input.firstMessage)
        return { conversationId: conversation.id, threadId }
      })
    },

    async appendThread(conversationId, thread) {
      return db.transaction(async (tx) => {
        // FOR UPDATE: lock the conversation row for the life of this
        // transaction so a concurrent appendThread/delete against the same
        // conversation can't race between this status check and the insert
        // below (e.g. two replies arriving for the same closed conversation
        // at once should both observe-and-reopen deterministically, not
        // interleave into an inconsistent status).
        const rows = await tx.query<{ status: string }>(
          'SELECT status FROM conversations WHERE id = $1 FOR UPDATE',
          [conversationId],
        )
        const row = rows[0]
        if (row === undefined) {
          return { ok: false, reason: 'not-found' }
        }
        if (row.status === 'deleted') {
          return { ok: false, reason: 'deleted' }
        }

        const threadId = await insertThread(tx, conversationId, thread)

        if (row.status === 'closed') {
          await tx.query(
            "UPDATE conversations SET status = 'open', updated_at = now() WHERE id = $1",
            [conversationId],
          )
        } else {
          await tx.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [
            conversationId,
          ])
        }

        return { ok: true, threadId }
      })
    },

    async getConversation(conversationId, options) {
      const includeDeleted = options?.includeDeleted ?? true
      // When excluding deleted, filter in the CONVERSATION lookup so a deleted
      // row short-circuits to null here, before the threads query runs — no
      // work is done proportional to a deleted conversation's size.
      const conversationRows = await db.query<ConversationRow>(
        includeDeleted
          ? 'SELECT id, subject, customer_email, status, created_at, updated_at FROM conversations WHERE id = $1'
          : "SELECT id, subject, customer_email, status, created_at, updated_at FROM conversations WHERE id = $1 AND status <> 'deleted'",
        [conversationId],
      )
      const conversationRow = conversationRows[0]
      if (conversationRow === undefined) {
        return null
      }

      const threadRows = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM threads WHERE conversation_id = $1 ORDER BY created_at, id`,
        [conversationId],
      )

      return {
        ...toStoredConversation(conversationRow),
        threads: threadRows.map(toStoredThread),
      }
    },

    async setThreadDeliveryStatus(threadId, status) {
      // Scope to outbound rows and confirm exactly one was updated. Without
      // `direction = 'outbound'` an inbound thread id could be marked
      // 'sent'/'failed' (violating the direction↔status invariant the schema
      // now enforces); without `RETURNING`, a wrong id or a row deleted
      // between send and mark would no-op silently and let a caller believe a
      // send was recorded when it wasn't. Both surface loudly instead.
      const updated = await db.query<{ id: string }>(
        "UPDATE threads SET delivery_status = $1 WHERE id = $2 AND direction = 'outbound' RETURNING id",
        [status, threadId],
      )
      if (updated.length === 0) {
        throw new Error(
          `setThreadDeliveryStatus: no outbound thread with id ${threadId} (wrong id, an inbound thread, or the row was deleted)`,
        )
      }
    },

    async listConversations(options) {
      // Built up as parameterized fragments — never string-interpolated
      // values, only structure (which fragment appears) is decided in JS.
      // See src/db/client.ts's module doc: parameterization is not optional.
      const conditions: string[] = []
      const params: SqlValue[] = []

      if (options.status !== undefined) {
        params.push(options.status)
        conditions.push(`c.status = $${params.length}`)
      } else {
        // No explicit filter: every status EXCEPT deleted. A `'deleted'`
        // conversation is never returned by any call to this method,
        // filtered or not (spec §3a) — this is the "not filtered" branch of
        // that rule, not an oversight.
        conditions.push("c.status <> 'deleted'")
      }

      if (options.cursor !== undefined) {
        // Postgres row-value comparison: `(a, b) < (x, y)` compares `a` to
        // `x` first and only consults `b`/`y` on a tie — exactly the
        // "updated_at DESC, id DESC" ordering this method commits to, in
        // one expression rather than a hand-rolled `a < x OR (a = x AND b <
        // y)`. Verified against PGlite's bundled Postgres 18, which
        // supports row-value comparison natively (a long-standing core
        // Postgres feature, not a version-specific behavior).
        params.push(options.cursor.updatedAt, options.cursor.id)
        conditions.push(`(c.updated_at, c.id) < ($${params.length - 1}, $${params.length})`)
      }

      params.push(options.limit)
      const limitParam = params.length

      const rows = await db.query<ConversationSummaryRow>(
        `SELECT c.id, c.subject, c.customer_email, c.status, c.created_at, c.updated_at, ${THREAD_COUNT_SUBQUERY}
         FROM conversations c
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT $${limitParam}`,
        params,
      )

      return rows.map(toConversationSummary)
    },
  }
}

/**
 * Shared insert used by both `createConversation`'s first thread and
 * `appendThread`.
 *
 * When `thread.id` is supplied (the outbound-send path, specs/mail/sending.md
 * §2), the `id` column is set explicitly to that caller-generated UUID. When
 * omitted (the inbound path), the `id` column is left out of the INSERT
 * entirely so the schema's `gen_random_uuid()` default fires — passing an
 * explicit `id` in every case would either require the caller to always
 * generate one (defeating the point of a DB default) or special-case a
 * `null`/`undefined` id column value, which is not what "no id supplied"
 * means here.
 */
async function insertThread(
  tx: Queryable,
  conversationId: string,
  thread: NewThread,
): Promise<string> {
  // Derive delivery_status from direction so the row always satisfies the
  // schema's direction↔status CHECK (migration 002): an outbound thread
  // defaults to 'pending' (its outbox starting state) unless the caller set a
  // status; an inbound thread is forced to NULL regardless of any status
  // passed, since delivery status is meaningless for received mail.
  const deliveryStatus =
    thread.direction === 'outbound' ? (thread.deliveryStatus ?? 'pending') : null

  if (thread.id !== undefined) {
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO threads (id, conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        thread.id,
        conversationId,
        thread.direction,
        thread.messageId,
        thread.inReplyTo ?? null,
        thread.fromAddress,
        thread.bodyText ?? null,
        thread.bodyHtml ?? null,
        deliveryStatus,
      ],
    )
    return row.id
  }

  const [row] = await tx.query<{ id: string }>(
    `INSERT INTO threads (conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      conversationId,
      thread.direction,
      thread.messageId,
      thread.inReplyTo ?? null,
      thread.fromAddress,
      thread.bodyText ?? null,
      thread.bodyHtml ?? null,
      deliveryStatus,
    ],
  )
  return row.id
}

/**
 * Coerce a `timestamptz` column value into a `Date`. PGlite (verified
 * against the installed 0.5.4) already parses `timestamptz` results into
 * genuine `Date` instances, so `value instanceof Date` is the common case
 * in practice — but this stays defensive against a future `Db`
 * implementation (e.g. a Supabase/`pg` connection configured with a
 * different type-parser setup) that hands back an ISO-8601 string instead,
 * since `Db`/`Queryable` promise no more than "SQL in, rows out" about
 * value types.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toStoredConversation(row: ConversationRow): StoredConversation {
  return {
    id: row.id,
    subject: row.subject,
    customerEmail: row.customer_email,
    status: row.status as StoredConversation['status'],
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

/**
 * Map a {@link ConversationSummaryRow} to the wire-adjacent
 * {@link ConversationSummary} shape. The `status` cast is safe on the same
 * grounds as {@link toStoredConversation}'s: `listConversations`'s own WHERE
 * clause (see above) never lets a `'deleted'` row reach this mapper, so the
 * narrower `'open' | 'closed'` union always holds in practice even though
 * the column itself is untyped `text` at the SQL level.
 */
function toConversationSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    id: row.id,
    subject: row.subject,
    customerEmail: row.customer_email,
    status: row.status as ConversationSummary['status'],
    threadCount: row.thread_count,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

function toStoredThread(row: ThreadRow): StoredThread {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction as StoredThread['direction'],
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    fromAddress: row.from_address,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    deliveryStatus: row.delivery_status as StoredThread['deliveryStatus'],
    createdAt: toDate(row.created_at),
  }
}
