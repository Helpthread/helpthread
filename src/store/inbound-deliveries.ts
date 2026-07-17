/**
 * `InboundDeliveryStore` — persistence for the inbound delivery ledger
 * (specs/mail/inbound-ingestion.md §4; migration 012, `src/db/migrate.ts`).
 *
 * One row per `(mailboxId, providerMessageId)` — simultaneously the
 * **idempotency record**, the **claim/lease**, and the **retry queue** (spec
 * §4's own three-way framing). This is the storage layer the ingest pipeline
 * (`src/mail/ingest.ts`) is built on, mirroring `src/store/conversations.ts`'s
 * style and doc-comment density, and mirroring the outbound get-or-insert
 * pattern (specs/mail/sending.md §3a) on the inbound side.
 *
 * ## The claim (spec §3 step 1)
 *
 * {@link InboundDeliveryStore.claim} is the atomic get-or-insert: `INSERT ...
 * ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING RETURNING *`,
 * falling back to a `SELECT` of the pre-existing row on conflict — the exact
 * shape `src/store/conversations.ts`'s `insertThread` uses for outbound
 * idempotency keys. `claimed: true` means the caller owns processing this
 * delivery (a fresh row, OR a `failed` row just reclaimed for a retry — see
 * below); `claimed: false` means a concurrent or prior delivery already owns
 * it, or it has reached a terminal state, and the caller must return THAT
 * row's outcome rather than double-process (spec §3 step 1, §8's "two
 * concurrent deliveries... exactly one conversation" acceptance case).
 *
 * ## `failed` rows are retryable — reclaimed, not just replayed
 *
 * Unlike a terminal `stored`/`suppressed`/`dead-letter` row (returned as-is,
 * `claimed: false`), a `failed` row IS meant to be retried: spec §4 says "the
 * per-message ingest is retryable as a unit." `claim` implements this by
 * atomically flipping a conflicting `failed` row back to `received` (`UPDATE
 * ... WHERE status = 'failed' ... RETURNING *`) — an ordinary Postgres
 * row-locked `UPDATE`, so two concurrent retries of the SAME failed row can
 * never both win, the same atomicity reasoning as
 * `ConversationStore.claimThreadForDelivery`'s single `UPDATE`. This is what
 * makes a second `ingestInboundMessage` call for a key that previously
 * failed actually reprocess it, rather than silently replaying the stale
 * `failed` outcome forever.
 *
 * `dead-letter` is deliberately NOT reclaimed by this path: it is a
 * terminal, manual-review state (spec §4, "a message that exhausts its retry
 * budget lands in dead-letter for manual review"), so ordinary re-delivery
 * must not auto-retry it — that would defeat dead-lettering's purpose of
 * bounding how many times a poison message is retried automatically.
 *
 * ## `received` rows are ALSO reclaimed, once their lease lapses (HT-45)
 *
 * A `received` row is normally another worker's claim genuinely still in
 * flight — spec §3 step 1's "do not double-process" — so `claim` must not
 * reclaim it unconditionally. But a hard crash (SIGKILL / OOM / redeploy)
 * between this method committing `'received'` and the ingest pipeline's
 * step-5 store transaction (or its catch-block `markFailed`) strands the row
 * at `'received'` forever: nothing ever marks it `failed`, so the `failed`-
 * row reclaim above never fires, and — with HT-41's cursor coupling
 * (`src/mail/gmail-reconcile.ts` step 6) — a stuck `received` row can block
 * the mailbox's reconcile cursor from ever advancing past it.
 *
 * `claimed_until` (migration 014) closes this the same way migration 003's
 * `threads.claimed_until` closes the outbound equivalent: every successful
 * claim (fresh insert, or a `failed`/`received` reclaim) stamps a lease
 * `leaseMs` into the future. A `received` row is reclaimable exactly when
 * `claimed_until IS NULL OR claimed_until < now()` — `NULL` covers both a
 * pre-migration stuck row (no lease was ever recorded for it) and, in
 * principle, any row somehow written without one; either way, "no known
 * lease" means "nothing is verifiably still working on this," so it is
 * immediately reclaimable rather than requiring a second wait. The reclaim
 * itself is a single row-locked `UPDATE ... WHERE status = 'received' AND
 * (claimed_until IS NULL OR claimed_until < now())`, so two concurrent
 * reclaim attempts on the same lapsed row can never both win — identical
 * atomicity to the `failed`-row reclaim and to
 * `ConversationStore.claimThreadForDelivery`.
 *
 * No separate periodic sweep function is added for this: unlike outbound's
 * `runDeliveryWorker` (which exists because nothing else re-visits a stuck
 * outbound thread), an inbound delivery is already re-visited by the
 * transport's own retry paths — a re-delivered push notification, or (given
 * the cursor-coupling above) `src/mail/gmail-reconcile.ts`'s history replay,
 * which keeps re-listing and re-`ingest`-ing the SAME stuck message on every
 * subsequent reconcile run for as long as the cursor cannot advance past it,
 * and which is guaranteed to run at least once a day regardless of new mail
 * (`src/mail/gmail-watch-maintenance.ts`'s unconditional daily sweep). Once
 * the lease has lapsed, the very next such call into `claim()` reclaims and
 * reprocesses the row — this ticket's "on re-delivery" trigger, not a new
 * "on a sweep" one. See this ticket's report for the full reasoning.
 *
 * The `received`-row reclaim also bumps `attempts` (unlike the `failed`-row
 * reclaim, which leaves it alone — that generation was already counted when
 * the prior `markFailed` ran). A lease lapsing IS evidence of a failed
 * attempt: the owner crashed, OOM'd, or otherwise never reached a recorded
 * outcome, which is exactly what a hard-crashing "poison" message does on
 * every retry. Without this, `attempts` stays frozen at whatever it was
 * before the crash and `src/mail/ingest.ts`'s `MAX_INGEST_ATTEMPTS` dead-letter
 * budget never engages for a message that always crashes rather than always
 * throws — the mailbox's reconcile cursor would stay wedged behind it
 * forever, the exact permanent-stuck symptom this ticket exists to fix, now
 * recurring instead of stranded. `ingestInboundMessage` reads the post-reclaim
 * `attempts` off the claim result and dead-letters immediately, before
 * spending another parse/store cycle on a message proven to keep crashing.
 *
 * ## The fence: `attempts` doubles as a claim generation (HT-45 review fix)
 *
 * A lease is advisory, not exclusive: nothing stops a slow-but-still-alive
 * owner from finishing its work and committing *after* another worker has
 * already reclaimed the lapsed lease out from under it. Committing that late
 * write unconditionally is exactly the corruption this reclaim otherwise
 * risks reintroducing — two live owners, two commits, two conversations for
 * one email (spec §8's "exactly one conversation," invariant #5). Every
 * successful claim (fresh insert, `failed`-reclaim, or `received`-reclaim)
 * returns the row's current `attempts` value; the caller carries that number
 * as its claim generation for as long as it processes the delivery. Every
 * outcome write below (`markStoredInTx`, `markSuppressed`, `markFailed`,
 * `markDeadLetter`) requires the caller to pass that SAME `attempts` value
 * back in, and fences its `UPDATE` on `status = 'received' AND attempts =
 * $claimedAttempts`. A reclaim always changes the row out from under a stale
 * generation — the `received`-reclaim bumps `attempts` (previous paragraph);
 * ANY subsequent `markFailed`/`markDeadLetter` bumps it too — so a stale
 * owner's fenced write always matches zero rows and is rejected, exactly the
 * same optimistic-concurrency shape `src/providers/adapters/postgres-queue/
 * index.ts` already uses (`attempts` as the claim generation, fencing every
 * outcome write). {@link LeaseLostError} is thrown when a fenced write
 * matches zero rows against a row that DOES still exist (as opposed to an
 * unknown `id`, still a caller bug) — `src/mail/ingest.ts` catches it and
 * reports the delivery as `in-progress` rather than forcing a `failed`/
 * `dead-letter` write that would itself just be fenced out (or, worse, land
 * on whatever generation now legitimately owns the row).
 *
 * ## The joint store-write + ledger transaction (spec §4)
 *
 * {@link markStoredInTx} is deliberately NOT a method on this interface: it
 * takes an externally-supplied `Queryable` (an already-open transaction)
 * rather than opening its own, so `src/mail/ingest.ts` can run it in the SAME
 * transaction as the `createConversationInTx`/`appendThreadInTx` call it
 * follows (`src/store/conversations.ts`) — this is what makes the store write
 * and the ledger's `received → stored` transition one atomic unit (spec §4;
 * see `src/mail/ingest.ts`'s `storeAndMarkDelivered` for the composition).
 * Every OTHER status transition below (`markSuppressed`/`markFailed`/
 * `markDeadLetter`) has no store write to coordinate with — suppression and
 * failure both create nothing — so each opens its own transaction, matching
 * `ConversationStore`'s standalone methods.
 *
 * ## `last_error` doubles as the suppression reason
 *
 * Migration 012 has no dedicated "suppression reason" column — only
 * `last_error` (nullable `text`). Rather than add a migration for one field
 * this ticket doesn't strictly need (CLAUDE.md: surgical changes, minimum
 * code), {@link InboundDeliveryStore.markSuppressed} reuses `last_error` to
 * carry the (non-error) suppression reason string. It is still exactly what
 * spec §5 asks for — "recorded in the ledger (suppressed, with the reason)"
 * — just sharing a column with the failure-path's error text rather than
 * owning a dedicated one.
 *
 * ## Pre-seeded suppression (HT-49 review fix): suppressing before a claim exists
 *
 * Every mark* method above requires a row already `claim()`-ed to `received`
 * — the ordinary "ingest ran, then decided to suppress" order. {@link
 * InboundDeliveryStore.preSuppressOwnSend} is the one exception: it creates
 * an ALREADY-`suppressed` row from scratch, before any `claim()` for that key
 * has ever happened. This exists for exactly one caller, `src/mail/send.ts`'s
 * self-echo guard (see that module's doc comment): some transports (Gmail
 * confirmed — HT-49 live evidence) deliver the sent copy of an outbound
 * reply back into the SAME mailbox it was sent from, where the reconcile
 * pipeline (`src/mail/gmail-reconcile.ts`) would otherwise ingest it as a
 * genuine new inbound message — and by the time that happens, the token this
 * fix added to `References` (threading.md §2a) makes that self-echo `append`
 * to the very conversation it belongs to, duplicating the agent's own reply
 * as a phantom customer message. Pre-seeding `(mailboxId,
 * providerMessageId)` — using the SAME provider id (`EmailSendResult.
 * providerMessageId`) the transport will later report for that exact message
 * during reconcile — means `claim()`'s ordinary "terminal row, do not
 * double-process" branch absorbs the echo with zero heuristics and zero
 * changes to `decideThreading`.
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
  'id, mailbox_id, provider_message_id, status, attempts, last_error, thread_id, claimed_until, created_at, updated_at'

/** Raw `inbound_deliveries` row shape, before mapping to {@link StoredInboundDelivery}. */
interface InboundDeliveryRow {
  id: string
  mailbox_id: string
  provider_message_id: string
  status: string
  attempts: number
  last_error: string | null
  thread_id: string | null
  claimed_until: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

/**
 * Transaction-scoped: mark `id` `stored`, recording the resulting
 * `threadId`. Deliberately NOT a method on {@link InboundDeliveryStore} — see
 * the module doc's "The joint store-write + ledger transaction" section.
 * `claimedAttempts` fences the write exactly as `InboundDeliveryStore`'s other
 * mark* methods do (module doc's "The fence" section): throws {@link
 * LeaseLostError} if the row's lease was reclaimed out from under this caller
 * first (the whole transaction — including the conversation/thread just
 * written — rolls back with it, per `Db.transaction`'s contract), or a plain
 * `Error` if no row exists with `id` at all.
 */
export async function markStoredInTx(
  tx: Queryable,
  id: string,
  threadId: string,
  claimedAttempts: number,
): Promise<StoredInboundDelivery> {
  const rows = await tx.query<InboundDeliveryRow>(
    `UPDATE inbound_deliveries SET status = 'stored', thread_id = $2, updated_at = now()
     WHERE id = $1 AND status = 'received' AND attempts = $3
     RETURNING ${DELIVERY_COLUMNS}`,
    [id, threadId, claimedAttempts],
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
    claimedUntil: toNullableDate(row.claimed_until),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}
