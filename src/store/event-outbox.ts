/**
 * `EventOutboxStore` — persistence for `event_outbox` (migration 023,
 * `src/db/migrate.ts`; HT-68, specs/plugins/substrate-v1.md §4 — "module"
 * below always means an out-of-process Helpthread extension, never the
 * legal "plugin exception" phrase CHARTER.md §7 uses).
 *
 * ## Append is transaction-scoped, like `insertThreadAttachmentsInTx`
 *
 * {@link appendOutboxEventInTx} is deliberately NOT a method on {@link
 * EventOutboxStore} — like `insertThreadAttachmentsInTx`
 * (`src/store/attachments.ts`) and `markStoredInTx`
 * (`src/store/inbound-deliveries.ts`), it takes an externally-supplied
 * `Queryable` so a future caller (wave 2/3's emission call sites) can write
 * the event row in the SAME transaction as the state change it describes —
 * spec §4's transactional-outbox rule: "an event never fires for a change
 * that rolled back, and no committed change silently drops its event."
 * There is no `db`-convenience overload here (unlike `MailboxTokenStore
 * .upsertTokens`'s optional `tx?`): an outbox append with NO caller
 * transaction would defeat the entire point of this table, so the
 * parameter is required, not optional.
 *
 * ## Claim/drain mirrors `queue_jobs`' `FOR UPDATE SKIP LOCKED` idiom
 *
 * {@link EventOutboxStore.claimBatch} is the drain step's read side (spec
 * §4: "a drain step... turns outbox rows into `QueueProvider` deliveries").
 * It mirrors `createPostgresQueue`'s `drainOnce` claim query
 * (`src/providers/adapters/postgres-queue/index.ts`, migration 013):
 * `UPDATE ... WHERE event_id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT
 * $n) RETURNING *`, leasing the claimed batch via `locked_until` so two
 * overlapping drain invocations never claim the same rows — the second
 * simply skips whatever the first has already locked. Once a row is hand-
 * ed to `queue_jobs` (keyed by `dedupe_key = eventId`, so a crash between
 * claiming here and enqueuing there is harmless — a re-claimed row simply
 * re-enqueues into a dedupe no-op, per migration 013's own precedent), all
 * further retry/backoff/dead-letter bookkeeping lives in `queue_jobs`, not
 * here (see migration 023's doc comment for why this table stays
 * deliberately thinner than `queue_jobs` itself). {@link
 * EventOutboxStore.markDispatched} is the terminal write: `dispatched_at`
 * set, `locked_until` cleared, never revisited by a later claim.
 */

import type { Db, Queryable } from '../db/client.js'

/** One event to append, before its `eventId`/timestamps exist — the shape every wave-2/3 emission call site will build (spec §4's vocabulary table). */
export interface NewOutboxEvent {
  /** One of spec §4's closed event-type list (e.g. `'conversation.message_received'`) — this store does not validate against that list; the caller is the only writer of event types. */
  type: string
  conversationId: string
  /** Thin, typed facts only — never message bodies, subjects, or addresses (spec §4: "webhook payloads free of message content and PII by construction"). Persisted verbatim as `jsonb`. */
  data: Record<string, unknown>
}

/** One `event_outbox` row as read back from storage — camelCase, timestamps as `Date`. This is also the shape the envelope (spec §4's JSON body) is built from at delivery time (wave 3). */
export interface StoredOutboxEvent {
  eventId: string
  type: string
  occurredAt: Date
  conversationId: string
  data: Record<string, unknown>
  dispatchedAt: Date | null
  createdAt: Date
}

/** Persistence for `event_outbox`. See the module doc for the transaction-scoped append and the claim/drain idiom. */
export interface EventOutboxStore {
  /**
   * Claim up to `options.batchSize` undispatched, unleased rows for the
   * drain step, oldest-`occurred_at`-first, leasing each for `options.
   * leaseMs` (module doc's `FOR UPDATE SKIP LOCKED` idiom — safe under two
   * overlapping drain invocations).
   */
  claimBatch(options: { batchSize: number; leaseMs: number }): Promise<StoredOutboxEvent[]>

  /**
   * Mark `eventId` dispatched (handed off to the queue) and clear its
   * lease — the terminal write a claimed row never needs claiming again
   * after. A no-op (zero rows affected) if `eventId` doesn't exist or was
   * already dispatched; not an error, since a redundant mark-dispatched
   * (e.g. a retried drain step) should never fail the caller.
   */
  markDispatched(eventId: string): Promise<void>
}

/** Raw `event_outbox` row shape, before mapping to {@link StoredOutboxEvent}. */
interface OutboxEventRow {
  event_id: string
  type: string
  occurred_at: Date | string
  conversation_id: string
  data: unknown
  dispatched_at: Date | string | null
  created_at: Date | string
}

const OUTBOX_EVENT_COLUMNS =
  'event_id, type, occurred_at, conversation_id, data, dispatched_at, created_at'

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toStoredOutboxEvent(row: OutboxEventRow): StoredOutboxEvent {
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: toDate(row.occurred_at),
    conversationId: row.conversation_id,
    // Cast, not parsed — this codebase is the only writer (always
    // JSON.stringify'd below), and jsonb arrives already decoded (same
    // reasoning as conversations.ts's send_envelope).
    data: row.data as Record<string, unknown>,
    dispatchedAt: row.dispatched_at === null ? null : toDate(row.dispatched_at),
    createdAt: toDate(row.created_at),
  }
}

/**
 * Transaction-scoped: insert one `event_outbox` row against the
 * caller-supplied `tx` — see the module doc's "Append is transaction-
 * scoped" section for why this is a standalone function, not a store
 * method, and REQUIRES a transaction handle rather than accepting a plain
 * `Db`.
 */
export async function appendOutboxEventInTx(
  tx: Queryable,
  event: NewOutboxEvent,
): Promise<StoredOutboxEvent> {
  const [row] = await tx.query<OutboxEventRow>(
    `INSERT INTO event_outbox (type, conversation_id, data)
     VALUES ($1, $2, $3::jsonb)
     RETURNING ${OUTBOX_EVENT_COLUMNS}`,
    [event.type, event.conversationId, JSON.stringify(event.data)],
  )
  return toStoredOutboxEvent(row)
}

/** Create an {@link EventOutboxStore} backed by `db`. */
export function createEventOutboxStore(db: Db): EventOutboxStore {
  return {
    async claimBatch(options) {
      // The subquery's `ORDER BY occurred_at` picks WHICH rows are claimed
      // (the oldest-eligible batch) — it does NOT guarantee the outer
      // UPDATE...RETURNING emits them in that order (Postgres makes no such
      // promise for RETURNING). Sort the mapped results here so the
      // interface's "oldest-occurred_at-first" contract holds regardless.
      const rows = await db.query<OutboxEventRow>(
        `UPDATE event_outbox
         SET locked_until = now() + ($1::double precision * interval '1 millisecond')
         WHERE event_id IN (
           SELECT event_id FROM event_outbox
           WHERE dispatched_at IS NULL
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY occurred_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         RETURNING ${OUTBOX_EVENT_COLUMNS}`,
        [options.leaseMs, options.batchSize],
      )
      return rows
        .map(toStoredOutboxEvent)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    },

    async markDispatched(eventId) {
      await db.query(
        `UPDATE event_outbox SET dispatched_at = now(), locked_until = NULL
         WHERE event_id = $1 AND dispatched_at IS NULL`,
        [eventId],
      )
    },
  }
}
