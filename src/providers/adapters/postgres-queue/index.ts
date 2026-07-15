/**
 * `createPostgresQueue` — the production `QueueProvider` for the RIQ
 * dogfood deployment (HT-43): a durable queue built on `queue_jobs`
 * (migration 013, `src/db/migrate.ts` — see that migration's doc comment
 * for the full schema rationale), reusing the Supabase Postgres every
 * deployment already provisions rather than adding Vercel Queues (still
 * beta) as a second durable-work dependency. `enqueue` implements the
 * `QueueProvider` interface (`src/providers/queue.ts`); `drainOnce` is the
 * poll-drain side that interface deliberately doesn't model (its own module
 * doc: "there is no dequeue/poll method... this interface models [push
 * delivery] directly") — here, a Vercel Cron tick calls `drainOnce` to pull
 * and process one bounded batch, the shape a Postgres-backed queue actually
 * needs, since Postgres itself has no way to push.
 *
 * Per `src/providers/README.md`'s adapter-boundary rule, this module is
 * wired in only at the composition root (a later part of HT-43) — engine
 * code (`src/mail`, `src/api`, `src/store`) never imports it directly, only
 * the `QueueProvider` interface type.
 *
 * ## The enqueue-commits-before-ack invariant
 *
 * `src/api/gmail-webhook.ts` acks the inbound Pub/Sub push only after its
 * `deps.queue.enqueue(...)` call resolves. `enqueue` here is a single
 * durable `INSERT` — under `src/db/client.ts`'s `Queryable` contract a
 * single statement is its own implicitly-committed unit, so the returned
 * promise resolves once Postgres has durably committed the row, never
 * before. If the webhook process dies before `enqueue` resolves, nothing
 * was durably enqueued and the caller never observed success (so Pub/Sub
 * redelivers the push) — there is no window in which an ack could be sent
 * for a job that did not actually commit.
 *
 * ## Lease model: `run_after` + `locked_until` = "eligible" + "leased"
 *
 * A job is claimable when `dead_lettered_at IS NULL` (not terminal),
 * `run_after <= now()` (its delay/backoff has elapsed), AND
 * `locked_until IS NULL OR locked_until < now()` (unleased, or a prior
 * lease expired — e.g. a worker crashed mid-run). `drainOnce`'s claim is
 * one atomic `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED
 * LIMIT $batch) RETURNING *`: `FOR UPDATE SKIP LOCKED` means two concurrent
 * `drainOnce` calls (overlapping cron invocations, a retry racing a slow
 * run) never claim the same row — the second simply skips whatever the
 * first has already locked and claims the next eligible rows instead, the
 * Postgres-native substitute for a platform queue's visibility timeout.
 * The same statement bumps `attempts` — counted at CLAIM time, not outcome
 * time, so a handler that crashes or times out mid-run still counts
 * against the retry ceiling instead of retrying forever for free.
 *
 * ## Dedupe
 *
 * `enqueue`'s `INSERT ... ON CONFLICT (topic, dedupe_key) WHERE dedupe_key
 * IS NOT NULL AND dead_lettered_at IS NULL DO NOTHING` targets migration
 * 013's `queue_jobs_topic_dedupe_key` partial unique index — see that
 * migration's doc comment for the full reasoning. A duplicate enqueue
 * sharing `(topic, dedupeKey)` with a still-live job is silently
 * suppressed, matching `EnqueueOptions.dedupeKey`'s "SHOULD suppress
 * duplicate enqueues" contract. `dedupeKey` omitted binds `NULL`, which
 * never conflicts against a unique index (ordinary Postgres NULL
 * semantics) — every no-key enqueue always inserts.
 *
 * ## Backoff
 *
 * A `retry` outcome (explicit, or a caught throw — see below) reschedules
 * with exponential backoff: `min((result.backoffSeconds ??
 * baseBackoffSeconds) * 2 ^ (attempts - 1), maxBackoffSeconds)`. A
 * handler's own `backoffSeconds` hint (`QueueHandlerResult`) becomes the
 * exponential series' STARTING point instead of the adapter's configured
 * default, so a handler signaling "rate-limited, try again soon" with a
 * small hint still backs off further on each subsequent failure rather
 * than retrying at the same short delay forever.
 *
 * ## A throw is a retry with no hint
 *
 * Per `QueueMessageHandler`'s contract ("a handler that throws is treated
 * as equivalent to retry by adapters"), every handler invocation is
 * wrapped in try/catch. A caught throw becomes `{ kind: 'retry' }` with no
 * `backoffSeconds` (falls back to `baseBackoffSeconds`) and `last_error`
 * set to the caught error's message; an explicit `{ kind: 'retry' }`
 * return carries no message of its own, so `last_error` is left `null` in
 * that case.
 *
 * ## Dead-lettering: retried-out or explicit, but always retained
 *
 * A `deadLetter` result, OR a `retry` whose `attempts` has reached the
 * effective ceiling, sets `dead_lettered_at` and clears `locked_until` —
 * the row is NEVER deleted (invariant #1: never silently drop a job). This
 * mirrors `inbound_deliveries.status = 'dead-letter'` (migration 012): a
 * poison job is parked, visible via {@link PostgresQueue.getStats}'s
 * `deadLettered` count, and available for manual review. Migration 013's
 * `queue_jobs_ready_idx` excludes dead-lettered rows, so a dead-lettered
 * job is never re-claimed by a later `drainOnce`.
 *
 * ## The retry ceiling is a call-level knob, not the row's `max_attempts`
 *
 * `queue_jobs.max_attempts` (migration 013) exists in the schema and
 * defaults to 5 on every row, but neither `enqueue` nor the claim query
 * below ever write anything else to it. The dead-letter-vs-retry decision
 * instead compares a claimed row's `attempts` against `drainOnce`'s own
 * `maxAttempts` option (falling back to this factory's
 * `options.maxAttempts`, falling back to 5) — NOT against the row's
 * column. Flagged here as a deliberate judgment call, not an oversight:
 * this makes the ceiling an operational knob adjustable for one drain pass
 * without a backfill, and keeps "retry past maxAttempts dead-letters"
 * simply testable (call `drainOnce` with a small override rather than
 * grinding through 5 real retries), at the cost of `max_attempts` being
 * schema head-room rather than a live per-job override today. A future
 * ticket wiring a per-job ceiling through `EnqueueOptions` would make the
 * column authoritative and this option its fallback for jobs that didn't
 * specify one.
 *
 * ## `topic IN (...)`, not `topic = ANY($array)`
 *
 * The claim query restricts to topics with a registered handler via a
 * dynamically-sized `IN ($n, $n+1, ...)` list — one bind parameter per
 * topic, pushed onto `params` and referenced by `$${params.length}`, the
 * same style `src/store/conversations.ts`'s `listConversations` already
 * uses for its dynamic `WHERE`. `src/db/client.ts`'s `SqlValue` — the type
 * every bound parameter in this codebase must satisfy — is deliberately
 * narrow and does not include arrays; widening that shared seam for this
 * one call site was judged out of scope for this adapter. `IN (...)` is
 * semantically identical to `= ANY(array)` for a non-empty list, which the
 * caller always has here: `drainOnce` returns early when no handlers are
 * registered, before this query is ever built.
 */

import type { Db, SqlValue } from '../../../db/client.js'
import type {
  EnqueueOptions,
  QueueHandlerResult,
  QueueMessage,
  QueueMessageHandler,
  QueueProvider,
} from '../../queue.js'

/**
 * Tunable defaults for {@link createPostgresQueue}. Every field except the
 * backoff base/cap is also overridable per `drainOnce` call via
 * {@link DrainOnceOptions} — see the module doc's "retry ceiling" section
 * for why `maxAttempts` in particular is a runtime knob rather than a
 * column read back off the claimed row.
 */
export interface PostgresQueueOptions {
  /** Default claim-lease duration, milliseconds. Defaults to 60 000 (60s). */
  leaseMs?: number
  /** Default max jobs claimed per `drainOnce` call. Defaults to 20. */
  batchSize?: number
  /** Default retry ceiling compared against a claimed job's `attempts`. Defaults to 5. */
  maxAttempts?: number
  /** Base backoff, seconds, for a job's first retry (module doc's "Backoff" section). Defaults to 10. */
  baseBackoffSeconds?: number
  /** Backoff cap, seconds — exponential growth never schedules a retry further out than this. Defaults to 3600 (1h). */
  maxBackoffSeconds?: number
}

/** Dependencies {@link PostgresQueue.drainOnce} needs for one drain pass. */
export interface DrainDeps {
  /** Topic to handler. Only jobs whose topic has a registered handler here are claimed (module doc). */
  handlers: Record<string, QueueMessageHandler<unknown>>
}

/** Per-call overrides for {@link PostgresQueue.drainOnce}; each falls back to the factory's {@link PostgresQueueOptions}. */
export interface DrainOnceOptions {
  batchSize?: number
  leaseMs?: number
  maxAttempts?: number
}

/** Outcome tally for one {@link PostgresQueue.drainOnce} call. */
export interface DrainReport {
  /** Jobs claimed (leased) this pass — the batch actually obtained, which may be smaller than requested. */
  claimed: number
  /** Claimed jobs whose handler returned `{ kind: 'ack' }` — row deleted. */
  acked: number
  /** Claimed jobs rescheduled for a later attempt (explicit `retry`, or a caught throw) — row updated, not deleted. */
  retried: number
  /** Claimed jobs that reached a terminal failure this pass (explicit `deadLetter`, or `retry` past the ceiling) — row retained, never reprocessed. */
  deadLettered: number
}

/** Point-in-time queue health — see {@link PostgresQueue.getStats}. */
export interface QueueStats {
  /** Live (not dead-lettered) jobs eligible for claim right now: due (`run_after <= now()`) and unleased. */
  ready: number
  /** Age, in seconds, of the OLDEST ready job's `run_after` — how long the longest-waiting ready job has been eligible. `null` when nothing is ready. */
  oldestReadyAgeSeconds: number | null
  /** Jobs in the terminal dead-lettered state, retained for manual review. */
  deadLettered: number
}

/** The `QueueProvider` this module builds, plus the poll-drain method the interface deliberately doesn't model (module doc). */
export interface PostgresQueue extends QueueProvider {
  /** Claim and process one bounded batch of ready jobs. See the module doc for the full claim/apply-outcome contract. */
  drainOnce(deps: DrainDeps, opts?: DrainOnceOptions): Promise<DrainReport>
  /** Point-in-time queue health, for a smoke checklist or alerting. */
  getStats(): Promise<QueueStats>
}

const DEFAULT_LEASE_MS = 60_000
const DEFAULT_BATCH_SIZE = 20
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BASE_BACKOFF_SECONDS = 10
const DEFAULT_MAX_BACKOFF_SECONDS = 3600

const QUEUE_JOB_COLUMNS =
  'id, topic, payload, dedupe_key, attempts, max_attempts, run_after, locked_until, last_error, dead_lettered_at, created_at, updated_at'

/** Raw `queue_jobs` row shape (migration 013, `src/db/migrate.ts`), before mapping into a `QueueMessage`. */
interface QueueJobRow {
  id: string
  topic: string
  payload: unknown
  dedupe_key: string | null
  attempts: number
  max_attempts: number
  run_after: Date | string
  locked_until: Date | string | null
  last_error: string | null
  dead_lettered_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

/** Coerce a `timestamptz` column value into a `Date` — see `src/store/inbound-deliveries.ts`'s `toDate` for the same defensive reasoning (PGlite hands back real `Date`s; a future wire-protocol `Db` may not). */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

/**
 * Claim up to `batchSize` ready jobs whose topic is in `topics`, atomically
 * bumping `attempts` and setting a `leaseSeconds`-long lease (module doc's
 * "Lease model" section). Builds a dynamically-sized `topic IN (...)`
 * clause rather than binding a single array parameter — see the module
 * doc's closing section for why.
 */
async function claimBatch(
  db: Db,
  topics: string[],
  leaseSeconds: number,
  batchSize: number,
): Promise<QueueJobRow[]> {
  const params: SqlValue[] = [leaseSeconds, batchSize]
  const topicPlaceholders = topics.map((topic) => {
    params.push(topic)
    return `$${params.length}`
  })
  return db.query<QueueJobRow>(
    `UPDATE queue_jobs
     SET locked_until = now() + make_interval(secs => $1::float8), attempts = attempts + 1, updated_at = now()
     WHERE id IN (
       SELECT id FROM queue_jobs
       WHERE dead_lettered_at IS NULL
         AND run_after <= now()
         AND (locked_until IS NULL OR locked_until < now())
         AND topic IN (${topicPlaceholders.join(', ')})
       ORDER BY run_after
       FOR UPDATE SKIP LOCKED
       LIMIT $2::int
     )
     RETURNING ${QUEUE_JOB_COLUMNS}`,
    params,
  )
}

/** Mark `id` dead-lettered: terminal, retained, never reclaimed (module doc's "Dead-lettering" section). */
async function deadLetterJob(db: Db, id: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE queue_jobs
     SET dead_lettered_at = now(), locked_until = NULL, last_error = $2, updated_at = now()
     WHERE id = $1`,
    [id, reason],
  )
}

/** Build the Postgres-backed `QueueProvider` + drain adapter. See the module doc for the full contract. */
export function createPostgresQueue(db: Db, options?: PostgresQueueOptions): PostgresQueue {
  const defaultLeaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS
  const defaultBatchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const defaultMaxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseBackoffSeconds = options?.baseBackoffSeconds ?? DEFAULT_BASE_BACKOFF_SECONDS
  const maxBackoffSeconds = options?.maxBackoffSeconds ?? DEFAULT_MAX_BACKOFF_SECONDS

  return {
    async enqueue<T>(topic: string, payload: T, opts?: EnqueueOptions): Promise<void> {
      const delaySeconds = opts?.delaySeconds ?? 0
      const dedupeKey = opts?.dedupeKey ?? null
      await db.query(
        `INSERT INTO queue_jobs (topic, payload, dedupe_key, run_after)
         VALUES ($1, $2::jsonb, $3, now() + make_interval(secs => $4::float8))
         ON CONFLICT (topic, dedupe_key) WHERE dedupe_key IS NOT NULL AND dead_lettered_at IS NULL DO NOTHING`,
        [topic, JSON.stringify(payload), dedupeKey, delaySeconds],
      )
    },

    async drainOnce(deps: DrainDeps, opts?: DrainOnceOptions): Promise<DrainReport> {
      const topics = Object.keys(deps.handlers)
      const report: DrainReport = { claimed: 0, acked: 0, retried: 0, deadLettered: 0 }
      if (topics.length === 0) {
        // Nothing registered — nothing to claim. Also sidesteps building a
        // claim query with an empty `IN ()` list, which is a syntax error.
        return report
      }

      const leaseSeconds = (opts?.leaseMs ?? defaultLeaseMs) / 1000
      const batchSize = opts?.batchSize ?? defaultBatchSize
      const maxAttempts = opts?.maxAttempts ?? defaultMaxAttempts

      const claimed = await claimBatch(db, topics, leaseSeconds, batchSize)
      report.claimed = claimed.length

      for (const row of claimed) {
        const handler = deps.handlers[row.topic]
        if (handler === undefined) {
          // Structurally unreachable: claimBatch's `topic IN (...)` list is
          // built from exactly `Object.keys(deps.handlers)`, so every
          // claimed row's topic has a registered handler. Thrown rather
          // than silently skipping a claimed (leased) job.
          throw new Error(
            `createPostgresQueue: claimed job ${row.id} has topic '${row.topic}' with no registered handler`,
          )
        }

        const message: QueueMessage<unknown> = {
          id: row.id,
          topic: row.topic,
          payload: row.payload,
          attempts: row.attempts,
          enqueuedAt: toDate(row.created_at),
        }

        let result: QueueHandlerResult
        let caughtErrorMessage: string | null = null
        try {
          result = await handler(message)
        } catch (err) {
          // A throw is a retry with no hint (module doc).
          caughtErrorMessage = err instanceof Error ? err.message : String(err)
          result = { kind: 'retry' }
        }

        if (result.kind === 'ack') {
          await db.query('DELETE FROM queue_jobs WHERE id = $1', [row.id])
          report.acked++
          continue
        }

        if (result.kind === 'deadLetter') {
          await deadLetterJob(db, row.id, result.reason)
          report.deadLettered++
          continue
        }

        // result.kind === 'retry': dead-letter once the effective ceiling is
        // reached, otherwise reschedule with exponential backoff (module doc).
        if (row.attempts >= maxAttempts) {
          await deadLetterJob(
            db,
            row.id,
            caughtErrorMessage ?? `createPostgresQueue: exceeded maxAttempts (${maxAttempts})`,
          )
          report.deadLettered++
          continue
        }

        const base = result.backoffSeconds ?? baseBackoffSeconds
        const backoffSeconds = Math.min(
          base * 2 ** Math.max(0, row.attempts - 1),
          maxBackoffSeconds,
        )
        await db.query(
          `UPDATE queue_jobs
           SET locked_until = NULL, run_after = now() + make_interval(secs => $2::float8), last_error = $3, updated_at = now()
           WHERE id = $1`,
          [row.id, backoffSeconds, caughtErrorMessage],
        )
        report.retried++
      }

      return report
    },

    async getStats(): Promise<QueueStats> {
      const [row] = await db.query<{
        ready: number
        oldest_ready_age_seconds: number | null
        dead_lettered: number
      }>(
        `SELECT
           (count(*) FILTER (
              WHERE dead_lettered_at IS NULL AND run_after <= now()
                AND (locked_until IS NULL OR locked_until < now())
           ))::int AS ready,
           (EXTRACT(EPOCH FROM (now() - min(run_after) FILTER (
              WHERE dead_lettered_at IS NULL AND run_after <= now()
                AND (locked_until IS NULL OR locked_until < now())
           ))))::float8 AS oldest_ready_age_seconds,
           (count(*) FILTER (WHERE dead_lettered_at IS NOT NULL))::int AS dead_lettered
         FROM queue_jobs`,
      )
      return {
        ready: row.ready,
        oldestReadyAgeSeconds: row.oldest_ready_age_seconds,
        deadLettered: row.dead_lettered,
      }
    },
  }
}
