/**
 * `InboundDeliveryStore` — persistence for the inbound delivery ledger
 * (specs/mail/inbound-ingestion.md §4; migration 012, `src/db/migrate.ts`).
 *
 * One row per `(mailboxId, providerMessageId)` — simultaneously the
 * **idempotency record**, the **claim/lease**, and the **retry queue**. This
 * is the storage layer `src/mail/ingest.ts` is built on, mirroring the
 * outbound get-or-insert pattern (sending.md §3a) on the inbound side.
 *
 * ## The claim (spec §3 step 1)
 *
 * {@link InboundDeliveryStore.claim} is the atomic get-or-insert: `INSERT ...
 * ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING RETURNING *`,
 * falling back to a `SELECT` on conflict — the exact shape
 * `src/store/conversations.ts`'s `insertThread` uses for outbound
 * idempotency keys. `claimed: true` means the caller owns processing (a
 * fresh row, or a `failed`/`received` row just reclaimed); `claimed: false`
 * means a concurrent or prior delivery owns it, or it is terminal, and the
 * caller must return THAT row's outcome rather than double-process.
 *
 * ## `failed` rows are reclaimed, not just replayed
 *
 * Unlike a terminal `stored`/`suppressed`/`dead-letter` row (returned as-is,
 * `claimed: false`), a `failed` row IS retried: spec §4's "the per-message
 * ingest is retryable as a unit." `claim` atomically flips a conflicting
 * `failed` row back to `received` (`UPDATE ... WHERE status = 'failed' ...
 * RETURNING *`) — a row-locked `UPDATE`, so two concurrent retries of the
 * same row can never both win, the same atomicity as
 * `ConversationStore.claimThreadForDelivery`. Without it, a second
 * `ingestInboundMessage` call for a previously-failed key would replay the
 * stale `failed` outcome forever.
 *
 * `dead-letter` is deliberately NOT reclaimed here: it is terminal and
 * manual-review, so ordinary re-delivery must not auto-retry it — that would
 * defeat dead-lettering's purpose of bounding automatic retries of a poison
 * message.
 *
 * ## `received` rows are ALSO reclaimed, once their lease lapses
 *
 * A `received` row is normally another worker's claim still in flight, so
 * `claim` must not reclaim it unconditionally. But a hard crash (SIGKILL /
 * OOM / redeploy) between this method committing `'received'` and the
 * pipeline's step-5 transaction (or its catch-block `markFailed`) strands the
 * row at `'received'` forever: nothing marks it `failed`, so the `failed`
 * reclaim never fires — and with the cursor coupling in
 * `src/mail/gmail-reconcile.ts` step 6, a stuck row blocks the mailbox's
 * reconcile cursor from ever advancing past it.
 *
 * `claimed_until` (migration 014) closes this the way migration 003's
 * `threads.claimed_until` closes the outbound equivalent: every successful
 * claim stamps a lease `leaseMs` into the future. A `received` row is
 * reclaimable exactly when `claimed_until IS NULL OR claimed_until < now()`
 * — `NULL` covers a pre-migration stuck row and any row somehow written
 * without a lease; either way "no known lease" means nothing is verifiably
 * still working on it. The reclaim is a single row-locked `UPDATE ... WHERE
 * status = 'received' AND (claimed_until IS NULL OR claimed_until < now())`,
 * so two concurrent reclaims can never both win.
 *
 * No separate periodic sweep is added. Unlike outbound's `runDeliveryWorker`
 * (which exists because nothing else re-visits a stuck outbound thread), an
 * inbound delivery is already re-visited by the transport's own retry paths:
 * a re-delivered push notification, or `src/mail/gmail-reconcile.ts`'s
 * history replay, which re-lists and re-`ingest`s the same stuck message on
 * every reconcile run for as long as the cursor cannot pass it — guaranteed
 * to run at least daily regardless of new mail
 * (`src/mail/gmail-watch-maintenance.ts`). Once the lease lapses, the next
 * such `claim()` reclaims and reprocesses the row.
 *
 * The `received` reclaim also bumps `attempts` — unlike the `failed` reclaim,
 * which leaves it alone, that generation having been counted by the prior
 * `markFailed`. A lapsed lease IS evidence of a failed attempt: the owner
 * crashed or never reached a recorded outcome, exactly what a hard-crashing
 * poison message does every time. Without the bump, `attempts` stays frozen
 * and `src/mail/ingest.ts`'s `MAX_INGEST_ATTEMPTS` budget never engages for a
 * message that always crashes rather than always throws — leaving the cursor
 * wedged behind it forever. `ingestInboundMessage` reads the post-reclaim
 * `attempts` off the claim result and dead-letters immediately, before
 * spending another parse/store cycle.
 *
 * ## The fence: `attempts` doubles as a claim generation
 *
 * A lease is advisory, not exclusive: nothing stops a slow-but-alive owner
 * from committing *after* another worker reclaimed the lapsed lease.
 * Committing that late write unconditionally is the corruption the reclaim
 * would otherwise reintroduce — two live owners, two commits, two
 * conversations for one email (invariant #5). Every successful claim returns
 * the row's current `attempts`; the caller carries it as its claim generation
 * for as long as it processes the delivery. Every outcome write
 * (`markStoredInTx`, `markSuppressed`, `markFailed`, `markDeadLetter`)
 * requires that same value back and fences its `UPDATE` on `status =
 * 'received' AND attempts = $claimedAttempts`. A reclaim always changes the
 * row out from under a stale generation — the `received` reclaim bumps
 * `attempts`, and any `markFailed`/`markDeadLetter` bumps it too — so a stale
 * owner's fenced write matches zero rows and is rejected, the same
 * optimistic-concurrency shape
 * `src/providers/adapters/postgres-queue/index.ts` uses.
 *
 * {@link LeaseLostError} is thrown when a fenced write matches zero rows
 * against a row that DOES still exist (an unknown `id` remains a caller bug).
 * `src/mail/ingest.ts` catches it and reports the delivery as `in-progress`
 * rather than forcing a `failed`/`dead-letter` write that would itself be
 * fenced out — or worse, land on whatever generation now legitimately owns
 * the row.
 *
 * ## The joint store-write + ledger transaction (spec §4)
 *
 * {@link markStoredInTx} is deliberately NOT a method on this interface: it
 * takes an externally-supplied `Queryable` (an already-open transaction)
 * rather than opening its own, so `src/mail/ingest.ts` can run it in the SAME
 * transaction as the `createConversationInTx`/`appendThreadInTx` call it
 * follows — this is what makes the store write and the ledger's `received →
 * stored` transition one atomic unit (see `ingest.ts`'s
 * `storeAndMarkDelivered`). Every other transition
 * (`markSuppressed`/`markFailed`/`markDeadLetter`) has no store write to
 * coordinate with — suppression and failure both create nothing — so each
 * opens its own transaction.
 *
 * ## `last_error` doubles as the suppression reason
 *
 * Migration 012 has no dedicated suppression-reason column, only `last_error`
 * (nullable `text`). Rather than add a migration for one field, {@link
 * InboundDeliveryStore.markSuppressed} reuses it to carry the (non-error)
 * suppression reason. Still exactly what spec §5 asks for — "recorded in the
 * ledger (suppressed, with the reason)" — just sharing a column.
 *
 * ## Pre-seeded suppression: suppressing before a claim exists
 *
 * Every mark* method requires a row already `claim()`-ed to `received`. {@link
 * InboundDeliveryStore.preSuppressOwnSend} is the one exception: it creates an
 * ALREADY-`suppressed` row from scratch, before any `claim()` for that key.
 * It exists for exactly one caller, `src/mail/send.ts`'s self-echo guard: some
 * transports (Gmail, confirmed live) deliver the sent copy of an outbound
 * reply back into the SAME mailbox, where `src/mail/gmail-reconcile.ts` would
 * otherwise ingest it as genuine inbound mail — and the token now carried in
 * `References` (threading.md §2a) would make that echo `append` to the very
 * conversation it belongs to, duplicating the Agent's reply as a phantom
 * customer message. Pre-seeding `(mailboxId, providerMessageId)` — using the
 * SAME `EmailSendResult.providerMessageId` the transport will later report
 * for that message during reconcile — means `claim()`'s ordinary "terminal
 * row, do not double-process" branch absorbs the echo with zero heuristics
 * and no change to `decideThreading`.
 */

import type { Db, Queryable } from '../db/client.js'

/** The delivery ledger's status lifecycle (migration 012's CHECK constraint, spelled identically). */
export type InboundDeliveryStatus = 'received' | 'stored' | 'suppressed' | 'failed' | 'dead-letter'

/** One `inbound_deliveries` row as read back from storage — camelCase, timestamps as `Date`. */
export interface StoredInboundDelivery {
  id: string
  mailboxId: string
  providerMessageId: string
  status: InboundDeliveryStatus
  /**
   * How many failed-or-abandoned processing attempts this delivery has
   * accumulated: `markFailed`/`markDeadLetter` each increment it, and so does
   * a `received`-row lease reclaim (HT-45 — see the module doc's "The fence"
   * section; a lapsed lease is itself evidence of an abandoned attempt). Also
   * doubles as the claim-generation fence every mark* write below requires.
   */
  attempts: number
  /** The last recorded error text, OR (for a `suppressed` row) the suppression reason — see the module doc's "`last_error` doubles as the suppression reason". `null` for a row that has never failed or been suppressed. */
  lastError: string | null
  /** The thread this delivery produced, once `stored` — `null` for every other status. */
  threadId: string | null
  /**
   * How many reply-token candidates on this message matched our Message-ID
   * pattern but FAILED signature verification (`decideThreading`'s
   * `forgedTokenCount`, threading.md §3 rule 3) — recorded at the `stored`
   * transition ONLY (migration 019's doc comment for why the other statuses
   * never write it), `0` otherwise. The queryable half of threading.md §5's
   * forged-token security signal (HT-44); aggregated by
   * `src/composition/health.ts`.
   */
  forgedTokenCount: number
  /** The lease deadline set by {@link InboundDeliveryStore.claim} (migration 014, HT-45) — see the module doc's "`received` rows are ALSO reclaimed" section. `null` for a row that has never been claimed with a lease (a pre-migration row, or a terminal row past its last claim). */
  claimedUntil: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The outcome of {@link InboundDeliveryStore.claim}. See the module doc's
 * "The claim", "`failed` rows are retryable", and "`received` rows are ALSO
 * reclaimed" sections for the full decision table this encodes.
 */
export type ClaimResult =
  | { claimed: true; delivery: StoredInboundDelivery }
  | { claimed: false; delivery: StoredInboundDelivery }

/** Persistence operations for the inbound delivery ledger. See the module doc for the storage-layer policy this implements. */
export interface InboundDeliveryStore {
  /**
   * Atomically claim `(mailboxId, providerMessageId)` for processing (spec §3
   * step 1), holding the claim for `leaseMs` (migration 014, HT-45). See the
   * module doc for the full claimed/not-claimed decision table, including
   * the `failed`-row reclaim and the `received`-row lease reclaim.
   */
  claim(mailboxId: string, providerMessageId: string, leaseMs: number): Promise<ClaimResult>

  /**
   * Record `id` as deliberately suppressed (spec §5, the loop guard) —
   * creates and appends nothing. `reason` is a short machine-readable tag
   * (e.g. `'own-message-loop'`), persisted into `last_error` (see the module
   * doc). `claimedAttempts` is the `attempts` value the caller's `claim` call
   * returned — the fence (module doc's "The fence" section): the write is
   * rejected with {@link LeaseLostError} if the row's lease was reclaimed out
   * from under this caller in the meantime. Throws a plain `Error` if no row
   * exists with `id` at all (a wrong id is a caller bug, not an expected
   * outcome — mirrors `ConversationStore.setThreadDeliveryStatus`'s
   * throw-on-zero-rows contract).
   */
  markSuppressed(
    id: string,
    reason: string,
    claimedAttempts: number,
  ): Promise<StoredInboundDelivery>

  /**
   * Record a failed processing attempt on `id`: `status = 'failed'`,
   * `attempts` incremented, `last_error` set to `error`. Retryable — the next
   * `claim` call for this row's `(mailboxId, providerMessageId)` reclaims it
   * (see the module doc). `claimedAttempts` fences the write exactly as
   * {@link markSuppressed} does; throws {@link LeaseLostError} if it was
   * reclaimed first, or a plain `Error` if no row exists with `id` at all.
   */
  markFailed(id: string, error: string, claimedAttempts: number): Promise<StoredInboundDelivery>

  /**
   * Record `id` as having exhausted its retry budget: `status =
   * 'dead-letter'`, `attempts` incremented, `last_error` set to `error`.
   * Terminal — NOT reclaimed by a later `claim` call (see the module doc).
   * `claimedAttempts` fences the write exactly as {@link markSuppressed} does;
   * throws {@link LeaseLostError} if it was reclaimed first, or a plain
   * `Error` if no row exists with `id` at all.
   */
  markDeadLetter(id: string, error: string, claimedAttempts: number): Promise<StoredInboundDelivery>

  /**
   * Pre-seed `(mailboxId, providerMessageId)` as ALREADY `suppressed`,
   * before any `claim()` for that key has happened — see the module doc's
   * "Pre-seeded suppression" section for why this exists and who calls it.
   *
   * A plain `INSERT ... ON CONFLICT (mailbox_id, provider_message_id) DO
   * NOTHING` — there is no row to `RETURNING`, and nothing for the caller to
   * act on either way. If a row ALREADY exists for this key — the race where
   * a reconcile run's `claim()` won first, ingesting the message before this
   * call could pre-seed the suppression (module doc) — this is a SILENT
   * no-op: whatever status that row already reached (`received`, `stored`,
   * or `suppressed` from a genuine concurrent path) is left completely
   * untouched. This method must NEVER overwrite an existing row: doing so
   * could silently flip an already-committed `stored` row (with its own
   * `thread_id` a conversation now depends on) to `suppressed`, corrupting a
   * message that merely happened to reuse this `providerMessageId` first.
   * Losing this race reproduces the pre-HT-49-fix failure (a phantom inbound
   * self-echo) rather than a NEW one — a known, accepted residual (see the
   * caller's doc comment), not silently hidden.
   */
  preSuppressOwnSend(mailboxId: string, providerMessageId: string, reason: string): Promise<void>
}

/**
 * Thrown by a fenced mark* write (`markStoredInTx`/`markSuppressed`/
 * `markFailed`/`markDeadLetter`) when the row exists but its `claimedAttempts`
 * fence no longer matches — the caller's lease was reclaimed by another
 * worker while it was still processing (module doc's "The fence" section).
 * Distinct from the plain `Error` those same methods throw for a genuinely
 * unknown `id`, so a caller (`src/mail/ingest.ts`) can tell "I lost the race,
 * do not touch this row again" apart from "this id was never valid."
 */
export class LeaseLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LeaseLostError'
  }
}

const DELIVERY_COLUMNS =
  'id, mailbox_id, provider_message_id, status, attempts, last_error, thread_id, forged_token_count, claimed_until, created_at, updated_at'

/** Raw `inbound_deliveries` row shape, before mapping to {@link StoredInboundDelivery}. */
interface InboundDeliveryRow {
  id: string
  mailbox_id: string
  provider_message_id: string
  status: string
  attempts: number
  last_error: string | null
  thread_id: string | null
  forged_token_count: number
  claimed_until: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

/**
 * Transaction-scoped: mark `id` `stored`, recording the resulting
 * `threadId` and the threading decision's `forgedTokenCount` (migration
 * 019 — see {@link StoredInboundDelivery.forgedTokenCount}). Deliberately
 * NOT a method on {@link InboundDeliveryStore} — see the module doc's "The
 * joint store-write + ledger transaction" section. `claimedAttempts` fences
 * the write exactly as `InboundDeliveryStore`'s other mark* methods do
 * (module doc's "The fence" section): throws {@link LeaseLostError} if the
 * row's lease was reclaimed out from under this caller first (the whole
 * transaction — including the conversation/thread just written — rolls back
 * with it, per `Db.transaction`'s contract), or a plain `Error` if no row
 * exists with `id` at all.
 */
export async function markStoredInTx(
  tx: Queryable,
  id: string,
  threadId: string,
  claimedAttempts: number,
  forgedTokenCount: number,
): Promise<StoredInboundDelivery> {
  const rows = await tx.query<InboundDeliveryRow>(
    `UPDATE inbound_deliveries SET status = 'stored', thread_id = $2, forged_token_count = $4, updated_at = now()
     WHERE id = $1 AND status = 'received' AND attempts = $3
     RETURNING ${DELIVERY_COLUMNS}`,
    [id, threadId, claimedAttempts, forgedTokenCount],
  )
  return oneOrFenced(tx, rows, 'markStoredInTx', id)
}

/** Create an {@link InboundDeliveryStore} backed by `db`. Every operation opens its own transaction against `db` — this factory holds no state of its own. */
export function createInboundDeliveryStore(db: Db): InboundDeliveryStore {
  return {
    async claim(mailboxId, providerMessageId, leaseMs) {
      return db.transaction(async (tx) => {
        const inserted = await tx.query<InboundDeliveryRow>(
          `INSERT INTO inbound_deliveries (mailbox_id, provider_message_id, claimed_until)
           VALUES ($1, $2, now() + ($3::double precision * interval '1 millisecond'))
           ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING
           RETURNING ${DELIVERY_COLUMNS}`,
          [mailboxId, providerMessageId, leaseMs],
        )
        if (inserted.length === 1) {
          return { claimed: true, delivery: toStoredInboundDelivery(inserted[0]) }
        }

        // Conflict: DO NOTHING skipped the insert — an existing row already
        // owns this key. Fetch it.
        const existingRows = await tx.query<InboundDeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM inbound_deliveries
           WHERE mailbox_id = $1 AND provider_message_id = $2`,
          [mailboxId, providerMessageId],
        )
        const existing = existingRows[0]
        if (existing === undefined) {
          // Structurally unreachable: ON CONFLICT only fires against a row
          // that satisfies this exact WHERE, inside the same transaction.
          // Thrown rather than silently returning a made-up result.
          throw new Error(
            `InboundDeliveryStore.claim: ON CONFLICT DO NOTHING skipped the insert but no existing row was found for mailbox ${mailboxId}, provider message ${providerMessageId}`,
          )
        }

        if (existing.status === 'failed') {
          // `failed` is retryable: atomically reclaim by flipping status back
          // to 'received' and stamping a fresh lease (module doc's "failed
          // rows are retryable"). A single row-locked UPDATE, so two
          // concurrent retries of this same row can never both win.
          const reclaimed = await tx.query<InboundDeliveryRow>(
            `UPDATE inbound_deliveries
             SET status = 'received', claimed_until = now() + ($2::double precision * interval '1 millisecond'), updated_at = now()
             WHERE id = $1 AND status = 'failed'
             RETURNING ${DELIVERY_COLUMNS}`,
            [existing.id, leaseMs],
          )
          if (reclaimed.length === 1) {
            return { claimed: true, delivery: toStoredInboundDelivery(reclaimed[0]) }
          }
          return { claimed: false, delivery: await reReadCurrent(tx, existing.id) }
        }

        if (existing.status === 'received') {
          // `received` is reclaimable ONLY once its lease has lapsed (module
          // doc's "received rows are ALSO reclaimed", HT-45) — otherwise it is
          // another worker's claim genuinely still in flight (spec §3 step
          // 1's "do not double-process"). The lease check rides the SAME
          // row-locked UPDATE as the status check, so a genuinely in-flight
          // claim (lease not yet expired) can never be reclaimed out from
          // under its owner, and two concurrent reclaim attempts on a lapsed
          // lease can never both win.
          //
          // `attempts` is bumped here too (module doc's "attempts" field and
          // "The fence" sections): a lapsed lease is itself evidence of an
          // abandoned attempt, this is what lets a crash-poison message
          // eventually reach `ingestInboundMessage`'s MAX_INGEST_ATTEMPTS
          // dead-letter check, and the new value becomes the next owner's
          // claim-generation fence.
          const reclaimed = await tx.query<InboundDeliveryRow>(
            `UPDATE inbound_deliveries
             SET claimed_until = now() + ($2::double precision * interval '1 millisecond'),
                 attempts = attempts + 1, updated_at = now()
             WHERE id = $1 AND status = 'received'
               AND (claimed_until IS NULL OR claimed_until < now())
             RETURNING ${DELIVERY_COLUMNS}`,
            [existing.id, leaseMs],
          )
          if (reclaimed.length === 1) {
            return { claimed: true, delivery: toStoredInboundDelivery(reclaimed[0]) }
          }
          return { claimed: false, delivery: await reReadCurrent(tx, existing.id) }
        }

        // Terminal (stored/suppressed/dead-letter) — the caller must not
        // double-process; return the existing outcome as-is (module doc).
        return { claimed: false, delivery: toStoredInboundDelivery(existing) }
      })
    },

    async markSuppressed(id, reason, claimedAttempts) {
      const rows = await db.query<InboundDeliveryRow>(
        `UPDATE inbound_deliveries SET status = 'suppressed', last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'received' AND attempts = $3
         RETURNING ${DELIVERY_COLUMNS}`,
        [id, reason, claimedAttempts],
      )
      return oneOrFenced(db, rows, 'markSuppressed', id)
    },

    async markFailed(id, error, claimedAttempts) {
      const rows = await db.query<InboundDeliveryRow>(
        `UPDATE inbound_deliveries SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'received' AND attempts = $3
         RETURNING ${DELIVERY_COLUMNS}`,
        [id, error, claimedAttempts],
      )
      return oneOrFenced(db, rows, 'markFailed', id)
    },

    async markDeadLetter(id, error, claimedAttempts) {
      const rows = await db.query<InboundDeliveryRow>(
        `UPDATE inbound_deliveries SET status = 'dead-letter', attempts = attempts + 1, last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'received' AND attempts = $3
         RETURNING ${DELIVERY_COLUMNS}`,
        [id, error, claimedAttempts],
      )
      return oneOrFenced(db, rows, 'markDeadLetter', id)
    },

    async preSuppressOwnSend(mailboxId, providerMessageId, reason) {
      // No RETURNING, no fence — see the interface doc comment. A conflict
      // means another path (an ordinary claim()) already owns this key;
      // this call must never touch that row.
      await db.query(
        `INSERT INTO inbound_deliveries (mailbox_id, provider_message_id, status, last_error)
         VALUES ($1, $2, 'suppressed', $3)
         ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING`,
        [mailboxId, providerMessageId, reason],
      )
    },
  }
}

/**
 * Shared result-resolver for every fenced mark* write (module doc's "The
 * fence" section). `rows` is that write's `RETURNING` result (0 or 1 rows,
 * since it fences on `id` and — for the fenced writes — `status`/`attempts`
 * too). Zero rows is ambiguous on its own: EITHER `id` never existed (a
 * caller bug — the ORIGINAL throw-on-zero-rows contract), OR the row exists
 * but the fence didn't match (this caller's claim generation was reclaimed by
 * another worker while it was still processing — {@link LeaseLostError}, NOT
 * a caller bug). Distinguishing the two costs one extra `SELECT`, paid only
 * on the zero-rows path.
 */
async function oneOrFenced(
  queryable: Queryable,
  rows: InboundDeliveryRow[],
  method: string,
  id: string,
): Promise<StoredInboundDelivery> {
  const row = rows[0]
  if (row !== undefined) {
    return toStoredInboundDelivery(row)
  }
  const stillExists = await queryable.query<{ id: string }>(
    'SELECT id FROM inbound_deliveries WHERE id = $1',
    [id],
  )
  if (stillExists.length === 0) {
    throw new Error(`InboundDeliveryStore.${method}: no delivery with id ${id}`)
  }
  throw new LeaseLostError(
    `InboundDeliveryStore.${method}: lease fence mismatch for delivery ${id} — its claim ` +
      "generation moved on (reclaimed by another worker after this caller's lease lapsed); " +
      'refusing to write',
  )
}

/** Coerce a `timestamptz` column value into a `Date` — see `conversations.ts`'s `toDate` for the same defensive reasoning (PGlite hands back real `Date`s; a future `Db` may not). */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/** Coerce a nullable `timestamptz` column value — same as {@link toDate}, but passing `null` through. */
function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value)
}

/**
 * Re-read `id`'s current row — used by both the `failed`- and `received`-row
 * reclaim branches of `claim` when their own reclaim `UPDATE` affects zero
 * rows: another concurrent claim reclaimed (or otherwise advanced) this row
 * between the initial `SELECT` and the reclaim attempt, so the stale
 * snapshot each branch started with is no longer accurate — report the
 * CURRENT state instead.
 */
async function reReadCurrent(tx: Queryable, id: string): Promise<StoredInboundDelivery> {
  const currentRows = await tx.query<InboundDeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM inbound_deliveries WHERE id = $1`,
    [id],
  )
  const current = currentRows[0]
  if (current === undefined) {
    throw new Error(
      `InboundDeliveryStore.claim: delivery ${id} vanished between the reclaim attempt and the re-read`,
    )
  }
  return toStoredInboundDelivery(current)
}

function toStoredInboundDelivery(row: InboundDeliveryRow): StoredInboundDelivery {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    providerMessageId: row.provider_message_id,
    status: row.status as InboundDeliveryStatus,
    attempts: row.attempts,
    lastError: row.last_error,
    threadId: row.thread_id,
    forgedTokenCount: row.forged_token_count,
    claimedUntil: toNullableDate(row.claimed_until),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}
