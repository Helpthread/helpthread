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
 *
 * ## Send idempotency + delivery leasing (HT-16)
 *
 * Migration 003 adds three outbound-only columns this module now exposes:
 * `idempotency_key`, `send_envelope`, and `claimed_until` (see the migration's
 * doc comment, `src/db/migrate.ts`, for the full schema-level rationale).
 * {@link appendThread} implements the "atomic get-or-insert" a caller-supplied
 * idempotency key needs: `INSERT ... ON CONFLICT (conversation_id,
 * idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING
 * *`, falling back to a `SELECT` of the pre-existing row when the insert is
 * skipped — both inside the SAME transaction that already takes the `FOR
 * UPDATE` lock on the conversation row, so a concurrent retry with the same
 * key is fully serialized against the original attempt rather than racing
 * it. {@link AppendResult}'s `created` flag tells the caller (`src/mail/
 * send.ts`) which case happened: `true` for a fresh insert (no key, or a key
 * never seen before), `false` when an existing row was found instead — at
 * which point `thread` carries that row's ALREADY-PERSISTED `messageId` and
 * `sendEnvelope`, which a retry must reuse verbatim rather than re-minting or
 * recomputing (see migration 003's doc comment on why the envelope is a
 * snapshot).
 *
 * {@link ConversationStore.claimThreadForDelivery} and
 * {@link ConversationStore.releaseThreadLease} are the lease pair a keyed
 * retry or the delivery worker (`src/mail/delivery-worker.ts`) uses to make
 * sure at most one in-flight attempt is ever sending a given outbound thread
 * at a time — see their own doc comments below.
 */

import type { Db, Queryable, SqlValue } from '../db/client.js'

/**
 * A snapshot of the mail headers an outbound reply was sent with:
 * recipients, subject, and the `References` chain. Persisted VERBATIM into
 * `threads.send_envelope` at insert and read back unchanged on every retry —
 * never recomputed from the conversation's current state (migration 003's
 * doc comment explains why: recomputing `references` could silently absorb
 * inbound mail that arrived between the original attempt and the retry).
 */
export interface SendEnvelope {
  to: string[]
  cc?: string[]
  subject: string
  references?: string[]
}

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
  /**
   * Caller-supplied dedup key for an OUTBOUND thread (HT-16;
   * `SendReplyInput.idempotencyKey`, `src/mail/send.ts`). Omitted (or
   * `undefined`) means "no dedup protection for this send" — see
   * {@link ConversationStore.appendThread}'s doc comment for what that
   * means at the storage layer. Never set for an inbound thread — migration
   * 003's CHECK constraint rejects that.
   */
  idempotencyKey?: string
  /**
   * A snapshot of this OUTBOUND thread's mail envelope, written once at
   * insert (see {@link SendEnvelope}'s doc comment for why it is a snapshot,
   * not a live derivation). Never set for an inbound thread.
   */
  sendEnvelope?: SendEnvelope
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
  /** Dedup key this OUTBOUND thread was sent with, or `null` if it was sent (or received) without one. See {@link NewThread.idempotencyKey}. */
  idempotencyKey: string | null
  /** This OUTBOUND thread's persisted envelope snapshot, or `null` for an inbound thread. See {@link SendEnvelope}. */
  sendEnvelope: SendEnvelope | null
  /**
   * The delivery lease: non-`null` while a `sendReply` retry or the
   * delivery worker is actively attempting this OUTBOUND thread, `null`
   * otherwise (never attempted, or the last attempt already released it).
   * See {@link ConversationStore.claimThreadForDelivery}.
   */
  claimedUntil: Date | null
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
  | { ok: true; threadId: string; created: boolean; thread: StoredThread }
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
   * reopened, open → inserted. A genuinely NEW row (`created: true`) also
   * bumps the conversation's `updated_at` (and reopens a closed one, per
   * the above); a REPLAY that found an existing row instead (`created:
   * false`) touches the conversation row not at all — nothing new
   * happened, so nothing about the conversation should look like it did.
   *
   * ## The `idempotencyKey` case: atomic get-or-insert
   *
   * When `thread.idempotencyKey` is set, this is NOT a plain insert: it is
   * `INSERT ... ON CONFLICT (conversation_id, idempotency_key) WHERE
   * idempotency_key IS NOT NULL DO NOTHING RETURNING *`, and on a conflict
   * (0 rows — this exact key already exists on this conversation) a
   * `SELECT` of that pre-existing row, all inside the same transaction that
   * takes the `FOR UPDATE` lock on the conversation row above. That lock is
   * what makes this safe under concurrency: two callers racing with the
   * SAME key on the SAME conversation are serialized by it, so the second
   * one's `INSERT ... ON CONFLICT` always sees the first one's already-committed
   * row rather than racing its own insert against it. `created` tells the
   * caller which happened; `thread` is the row either way — for a replay,
   * `thread.messageId` and `thread.sendEnvelope` are the ORIGINAL attempt's,
   * never regenerated (see the module doc and migration 003's doc comment).
   *
   * When `thread.idempotencyKey` is omitted, this behaves exactly as before
   * HT-16: a plain insert, `created` is always `true`. This is the "no key ⇒
   * no dedup protection" contract `src/mail/send.ts`'s module doc names
   * explicitly — deliberate, and covered by a permanent regression test.
   */
  appendThread(conversationId: string, thread: NewThread): Promise<AppendResult>

  /**
   * Claim `threadId` for delivery: an atomic `UPDATE ... SET claimed_until =
   * now() + leaseMs WHERE id = $1 AND (claimed_until IS NULL OR
   * claimed_until < now()) RETURNING *`, scoped to outbound rows. Ordinary
   * Postgres row-level locking on the `UPDATE` is what makes "at most one
   * claimant wins" hold even under true concurrency (two overlapping calls
   * for the same `threadId`, from two processes or two `Promise.all`-ed
   * calls in one) — no advisory lock or explicit transaction is needed
   * here, a single `UPDATE` is already atomic with respect to itself.
   *
   * Returns the freshly-claimed {@link StoredThread} (with the new
   * `claimedUntil`) on success, or `null` if the row is missing, not
   * outbound, or already claimed by someone else whose lease hasn't expired
   * — the caller (`src/mail/send.ts`'s retry path, or
   * `src/mail/delivery-worker.ts`'s sweep) must treat `null` as "someone
   * else has this; don't send," never retry the claim itself.
   */
  claimThreadForDelivery(threadId: string, leaseMs: number): Promise<StoredThread | null>

  /**
   * Release `threadId`'s delivery lease and record the outcome in one
   * write: `UPDATE ... SET delivery_status = status, claimed_until = NULL
   * WHERE id = $1 AND direction = 'outbound' RETURNING id`, scoped and
   * throwing-on-zero-rows exactly like {@link setThreadDeliveryStatus} (see
   * its doc comment for why a silent no-op would be worse than a throw).
   * Kept as a SEPARATE method from `setThreadDeliveryStatus` — not a
   * parameter that also clears the lease — so the ORIGINAL (pre-HT-16,
   * no-idempotency-key) `sendReply` flow keeps calling
   * `setThreadDeliveryStatus` completely unchanged, byte-identical to
   * before this feature existed.
   */
  releaseThreadLease(threadId: string, status: 'sent' | 'failed'): Promise<void>

  /**
   * List OUTBOUND threads eligible for a delivery-worker retry sweep
   * (`src/mail/delivery-worker.ts`): `delivery_status = 'failed'`, OR
   * `delivery_status = 'pending'` AND `created_at` older than
   * `options.staleAfterMs` (a `'pending'` row younger than that may simply
   * be a normal send still in flight — not yet a candidate); AND the lease
   * is free (`claimed_until IS NULL OR claimed_until < now()`); AND
   * `send_envelope IS NOT NULL` — a row with no stored envelope (only
   * possible for a `threads` row written before migration 003 shipped)
   * cannot be safely retried: rebuilding its `to`/`subject`/`references`
   * from the conversation's CURRENT state would be exactly the silent
   * mail-semantics drift migration 003's envelope snapshot exists to
   * prevent, so such a row is left for manual/administrative handling
   * instead of a worker guessing at it. Ordered oldest-`created_at`-first,
   * capped at `options.batchSize` — the worker's own batch limit, not an
   * over-fetch-by-one pagination trick (there is no pagination here; a
   * skipped row is simply picked up on the NEXT sweep).
   */
  listDeliverableThreads(options: {
    staleAfterMs: number
    batchSize: number
  }): Promise<StoredThread[]>

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

  /**
   * Set a conversation's `status` to `'open'` or `'closed'` — the write path
   * behind `PATCH /api/v1/conversations/{id}` (specs/api/agent-inbox-v1.md
   * §4b). A single `UPDATE ... RETURNING` statement, scoped to `status <>
   * 'deleted'` so a deleted conversation is NOT reopenable through this
   * method — the spec's explicit carve-out (§4b: "a deleted conversation is
   * not reopenable through this endpoint"). Returns the updated
   * {@link ConversationSummary} on success, or `null` when no row matched
   * (the id doesn't exist, or names a `deleted` conversation) — the same
   * "missing or deleted, indistinguishable" shape {@link getConversation}'s
   * `includeDeleted: false` uses, so the HTTP layer can map both to a single
   * generic `404` without an extra existence check.
   */
  setConversationStatus(
    conversationId: string,
    status: 'open' | 'closed',
  ): Promise<ConversationSummary | null>
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

/**
 * Raw `threads` row shape, before mapping to {@link StoredThread}. `send_envelope`
 * is typed `unknown` at this layer (not `SendEnvelope | null`) because it
 * arrives already-parsed from a `jsonb` column (PGlite, verified against the
 * installed 0.5.4, decodes `jsonb` to a plain JS value automatically — no
 * `JSON.parse` needed on read), but nothing here has actually validated its
 * shape; {@link toStoredThread} does the one authoritative cast, since this
 * codebase controls every writer of the column (see {@link insertThread}).
 */
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
  idempotency_key: string | null
  send_envelope: unknown
  claimed_until: Date | string | null
  created_at: Date | string
}

const THREAD_COLUMNS =
  'id, conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status, idempotency_key, send_envelope, claimed_until, created_at'

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
        const { threadId } = await insertThread(tx, conversation.id, input.firstMessage)
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
        // interleave into an inconsistent status). This same lock is what
        // makes the idempotency-key get-or-insert below safe under
        // concurrency — see the interface doc comment above.
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

        const { threadId, created, row: threadRow } = await insertThread(tx, conversationId, thread)

        // A REPLAY (an existing row was found, nothing new inserted) touches
        // the conversation not at all — no reopen, no updated_at bump. Only
        // a genuinely new row counts as new activity on the conversation.
        if (created) {
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
        }

        return { ok: true, threadId, created, thread: toStoredThread(threadRow) }
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

    async claimThreadForDelivery(threadId, leaseMs) {
      // A single UPDATE is already atomic with respect to itself under
      // Postgres row-level locking: two overlapping calls for the same
      // threadId serialize on the row, and the second one's WHERE clause is
      // re-evaluated against the FIRST call's committed result — so at most
      // one of them ever sees `claimed_until IS NULL OR claimed_until <
      // now()` as true and gets a row back. No explicit transaction needed.
      const rows = await db.query<ThreadRow>(
        `UPDATE threads
         SET claimed_until = now() + ($2::double precision * interval '1 millisecond')
         WHERE id = $1 AND direction = 'outbound' AND (claimed_until IS NULL OR claimed_until < now())
         RETURNING ${THREAD_COLUMNS}`,
        [threadId, leaseMs],
      )
      return rows.length === 0 ? null : toStoredThread(rows[0])
    },

    async releaseThreadLease(threadId, status) {
      // Same scoping and throw-on-zero-rows contract as setThreadDeliveryStatus
      // (see its doc comment) — kept as a separate method rather than a
      // parameter there so the pre-HT-16 no-idempotency-key send path keeps
      // calling setThreadDeliveryStatus completely unchanged.
      const updated = await db.query<{ id: string }>(
        "UPDATE threads SET delivery_status = $1, claimed_until = NULL WHERE id = $2 AND direction = 'outbound' RETURNING id",
        [status, threadId],
      )
      if (updated.length === 0) {
        throw new Error(
          `releaseThreadLease: no outbound thread with id ${threadId} (wrong id, an inbound thread, or the row was deleted)`,
        )
      }
    },

    async listDeliverableThreads(options) {
      const rows = await db.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS} FROM threads
         WHERE direction = 'outbound'
           AND send_envelope IS NOT NULL
           AND (
             delivery_status = 'failed'
             OR (
               delivery_status = 'pending'
               AND created_at < now() - ($1::double precision * interval '1 millisecond')
             )
           )
           AND (claimed_until IS NULL OR claimed_until < now())
         ORDER BY created_at
         LIMIT $2`,
        [options.staleAfterMs, options.batchSize],
      )
      return rows.map(toStoredThread)
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

    async setConversationStatus(conversationId, status) {
      const rows = await db.query<ConversationSummaryRow>(
        `UPDATE conversations
         SET status = $1, updated_at = now()
         WHERE id = $2 AND status <> 'deleted'
         RETURNING id, subject, customer_email, status, created_at, updated_at,
           (SELECT count(*)::int FROM threads WHERE conversation_id = $2) AS thread_count`,
        [status, conversationId],
      )
      const row = rows[0]
      return row === undefined ? null : toConversationSummary(row)
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
 *
 * ## The idempotency-key get-or-insert (HT-16)
 *
 * The INSERT always carries `ON CONFLICT (conversation_id, idempotency_key)
 * WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING <columns>` — this is
 * harmless and never triggers when `thread.idempotencyKey` is omitted (a
 * `NULL` key can never collide with the partial unique index; see migration
 * 003's doc comment), which is exactly why the no-key path needs no separate
 * code path here to stay byte-identical to pre-HT-16 behavior. When a key IS
 * given and the insert is skipped because that `(conversation_id,
 * idempotency_key)` pair already exists, the `RETURNING` clause comes back
 * empty and this function falls back to a `SELECT` of that pre-existing row.
 * The caller (`appendThread`) is what wraps this in the transaction holding
 * the conversation row's `FOR UPDATE` lock, which is what makes the
 * conflict-then-select sequence race-free — see that method's doc comment.
 */
async function insertThread(
  tx: Queryable,
  conversationId: string,
  thread: NewThread,
): Promise<{ threadId: string; created: boolean; row: ThreadRow }> {
  // Derive delivery_status from direction so the row always satisfies the
  // schema's direction↔status CHECK (migration 002): an outbound thread
  // defaults to 'pending' (its outbox starting state) unless the caller set a
  // status; an inbound thread is forced to NULL regardless of any status
  // passed, since delivery status is meaningless for received mail.
  const deliveryStatus =
    thread.direction === 'outbound' ? (thread.deliveryStatus ?? 'pending') : null
  const idempotencyKey = thread.idempotencyKey ?? null
  // jsonb columns take a caller-serialized string, per src/db/client.ts's
  // module doc — `SqlValue` deliberately has no "plain object" member, so
  // this is the one place a `SendEnvelope` is turned into JSON text.
  const sendEnvelopeJson =
    thread.sendEnvelope !== undefined ? JSON.stringify(thread.sendEnvelope) : null

  const rows =
    thread.id !== undefined
      ? await tx.query<ThreadRow>(
          `INSERT INTO threads (id, conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status, idempotency_key, send_envelope)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${THREAD_COLUMNS}`,
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
            idempotencyKey,
            sendEnvelopeJson,
          ],
        )
      : await tx.query<ThreadRow>(
          `INSERT INTO threads (conversation_id, direction, message_id, in_reply_to, from_address, body_text, body_html, delivery_status, idempotency_key, send_envelope)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING ${THREAD_COLUMNS}`,
          [
            conversationId,
            thread.direction,
            thread.messageId,
            thread.inReplyTo ?? null,
            thread.fromAddress,
            thread.bodyText ?? null,
            thread.bodyHtml ?? null,
            deliveryStatus,
            idempotencyKey,
            sendEnvelopeJson,
          ],
        )

  if (rows.length === 1) {
    return { threadId: rows[0].id, created: true, row: rows[0] }
  }

  // Conflict: DO NOTHING skipped the insert, which is only possible when
  // idempotencyKey is non-null (see the doc comment above) — fetch the row
  // that already holds this (conversationId, idempotencyKey) pair.
  const existing = await tx.query<ThreadRow>(
    `SELECT ${THREAD_COLUMNS} FROM threads WHERE conversation_id = $1 AND idempotency_key = $2`,
    [conversationId, idempotencyKey],
  )
  const existingRow = existing[0]
  if (existingRow === undefined) {
    // Structurally unreachable: ON CONFLICT only fires against a row that
    // satisfies this exact WHERE, inside the same transaction. Thrown rather
    // than silently returning a made-up result if it ever did happen.
    throw new Error(
      `insertThread: ON CONFLICT DO NOTHING skipped the insert but no existing row was found for conversation ${conversationId}, idempotency key ${idempotencyKey}`,
    )
  }
  return { threadId: existingRow.id, created: false, row: existingRow }
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
    idempotencyKey: row.idempotency_key,
    // Cast, not parsed: this codebase is the only writer of send_envelope
    // (insertThread, always via JSON.stringify of a SendEnvelope), and the
    // jsonb column already arrives decoded (see ThreadRow's doc comment).
    sendEnvelope: row.send_envelope as SendEnvelope | null,
    claimedUntil: row.claimed_until === null ? null : toDate(row.claimed_until),
    createdAt: toDate(row.created_at),
  }
}
