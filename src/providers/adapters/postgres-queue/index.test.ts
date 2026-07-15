import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../../../db/client.js'
import { migrate } from '../../../db/migrate.js'
import type { QueueHandlerResult, QueueMessage, QueueMessageHandler } from '../../queue.js'
import { createPostgresQueue, type PostgresQueue } from './index.js'

// --- fixtures ----------------------------------------------------------------

/** A loose stand-in for the real Gmail reconcile job shape — this suite tests the QUEUE, not reconcile (brief). */
interface ReconcileJob {
  mailboxId: string
  historyId: string
}

const TOPIC = 'gmail-reconcile'

function reconcileJob(n: number): ReconcileJob {
  return { mailboxId: `mailbox-${n}`, historyId: String(n) }
}

/** Build a handler that always returns `result` and records every message it was invoked with. */
function fakeHandler(result: QueueHandlerResult): {
  handler: QueueMessageHandler<unknown>
  calls: QueueMessage<unknown>[]
} {
  const calls: QueueMessage<unknown>[] = []
  const handler: QueueMessageHandler<unknown> = async (message) => {
    calls.push(message)
    return result
  }
  return { handler, calls }
}

interface RawQueueJobRow {
  id: string
  topic: string
  payload: unknown
  dedupe_key: string | null
  attempts: number
  max_attempts: number
  run_after: string
  locked_until: string | null
  last_error: string | null
  dead_lettered_at: string | null
  created_at: string
  updated_at: string
}

async function allJobRows(db: Db): Promise<RawQueueJobRow[]> {
  return db.query<RawQueueJobRow>('SELECT * FROM queue_jobs ORDER BY created_at, id')
}

async function countRows(db: Db, table: string): Promise<number> {
  const rows = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)
  return rows[0].count
}

/** Move every row's `run_after` into the past — a deterministic stand-in for waiting out a delay/backoff, avoiding a real sleep in the test. */
async function forceAllDue(db: Db): Promise<void> {
  await db.query("UPDATE queue_jobs SET run_after = now() - interval '1 second'")
}

// --- suite ---------------------------------------------------------------------

describe('createPostgresQueue', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshQueue(): Promise<{ db: Db; queue: PostgresQueue }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, queue: createPostgresQueue(db) }
  }

  it('enqueue inserts a row whose payload round-trips as jsonb', async () => {
    const { db, queue } = await freshQueue()

    await queue.enqueue(TOPIC, reconcileJob(1))

    const rows = await allJobRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      topic: TOPIC,
      payload: reconcileJob(1),
      dedupe_key: null,
      attempts: 0,
      max_attempts: 5,
      locked_until: null,
      last_error: null,
      dead_lettered_at: null,
    })
  })

  it('dedupeKey suppresses a duplicate enqueue on the same topic, but a different key (or no key) still inserts', async () => {
    const { db, queue } = await freshQueue()

    await queue.enqueue(TOPIC, reconcileJob(1), { dedupeKey: 'mailbox-1:1' })
    await queue.enqueue(TOPIC, reconcileJob(1), { dedupeKey: 'mailbox-1:1' })
    expect(await countRows(db, 'queue_jobs')).toBe(1)

    await queue.enqueue(TOPIC, reconcileJob(1), { dedupeKey: 'mailbox-1:2' })
    expect(await countRows(db, 'queue_jobs')).toBe(2)

    // Omitting the key entirely never dedupes against anything, including itself.
    await queue.enqueue(TOPIC, reconcileJob(1))
    await queue.enqueue(TOPIC, reconcileJob(1))
    expect(await countRows(db, 'queue_jobs')).toBe(4)
  })

  it('delaySeconds sets run_after in the future, and the job is not claimed until due', async () => {
    const { db, queue } = await freshQueue()

    await queue.enqueue(TOPIC, reconcileJob(1), { delaySeconds: 3600 })

    const [row] = await allJobRows(db)
    const delayMs = new Date(row.run_after).getTime() - new Date(row.created_at).getTime()
    expect(delayMs).toBeGreaterThan(3500 * 1000)

    const { handler, calls } = fakeHandler({ kind: 'ack' })
    const report = await queue.drainOnce({ handlers: { [TOPIC]: handler } })

    expect(report).toEqual({ claimed: 0, acked: 0, retried: 0, deadLettered: 0 })
    expect(calls).toHaveLength(0)
    expect(await countRows(db, 'queue_jobs')).toBe(1)
  })

  it('drainOnce claims a ready job, invokes its handler with attempts: 1, and ack deletes the row', async () => {
    const { db, queue } = await freshQueue()
    await queue.enqueue(TOPIC, reconcileJob(1))

    const { handler, calls } = fakeHandler({ kind: 'ack' })
    const report = await queue.drainOnce({ handlers: { [TOPIC]: handler } })

    expect(report).toEqual({ claimed: 1, acked: 1, retried: 0, deadLettered: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ topic: TOPIC, payload: reconcileJob(1), attempts: 1 })
    expect(calls[0].id).toEqual(expect.any(String))
    expect(calls[0].enqueuedAt).toBeInstanceOf(Date)
    expect(await countRows(db, 'queue_jobs')).toBe(0)
  })

  it('retry reschedules into the future and clears the lease; the job is re-drained once due', async () => {
    const { db, queue } = await freshQueue()
    await queue.enqueue(TOPIC, reconcileJob(1))

    let invocation = 0
    const handler: QueueMessageHandler<unknown> = async () => {
      invocation++
      return invocation === 1 ? { kind: 'retry', backoffSeconds: 30 } : { kind: 'ack' }
    }

    const first = await queue.drainOnce({ handlers: { [TOPIC]: handler } })
    expect(first).toEqual({ claimed: 1, acked: 0, retried: 1, deadLettered: 0 })

    const [afterRetry] = await allJobRows(db)
    expect(afterRetry.attempts).toBe(1)
    expect(afterRetry.locked_until).toBeNull()
    expect(afterRetry.dead_lettered_at).toBeNull()
    expect(new Date(afterRetry.run_after).getTime()).toBeGreaterThan(Date.now())

    // Not yet due — a drain right now claims nothing.
    const tooSoon = await queue.drainOnce({ handlers: { [TOPIC]: handler } })
    expect(tooSoon.claimed).toBe(0)

    // Time-travel run_after into the past rather than sleeping out the backoff.
    await forceAllDue(db)

    const second = await queue.drainOnce({ handlers: { [TOPIC]: handler } })
    expect(second).toEqual({ claimed: 1, acked: 1, retried: 0, deadLettered: 0 })
    expect(invocation).toBe(2)
  })

  it('a handler that throws is treated as retry: attempts incremented, rescheduled, error message recorded', async () => {
    const { db, queue } = await freshQueue()
    await queue.enqueue(TOPIC, reconcileJob(1))

    const handler: QueueMessageHandler<unknown> = async () => {
      throw new Error('boom')
    }

    const report = await queue.drainOnce({ handlers: { [TOPIC]: handler } })
    expect(report).toEqual({ claimed: 1, acked: 0, retried: 1, deadLettered: 0 })

    const [row] = await allJobRows(db)
    expect(row.attempts).toBe(1)
    expect(row.last_error).toBe('boom')
    expect(row.dead_lettered_at).toBeNull()
    expect(row.locked_until).toBeNull()
  })

  it('retry past maxAttempts dead-letters the job: row retained, NOT re-claimed on the next drain', async () => {
    const { db, queue } = await freshQueue()
    await queue.enqueue(TOPIC, reconcileJob(1))

    const { handler } = fakeHandler({ kind: 'retry' })

    // maxAttempts: 2 — first drain retries (attempts -> 1, below ceiling).
    const first = await queue.drainOnce({ handlers: { [TOPIC]: handler } }, { maxAttempts: 2 })
    expect(first).toEqual({ claimed: 1, acked: 0, retried: 1, deadLettered: 0 })

    await forceAllDue(db)

    // Second drain: attempts -> 2, at the ceiling -> dead-letter instead of retry.
    const second = await queue.drainOnce({ handlers: { [TOPIC]: handler } }, { maxAttempts: 2 })
    expect(second).toEqual({ claimed: 1, acked: 0, retried: 0, deadLettered: 1 })

    const [row] = await allJobRows(db)
    expect(row.attempts).toBe(2)
    expect(row.dead_lettered_at).not.toBeNull()
    expect(row.locked_until).toBeNull()
    expect(await countRows(db, 'queue_jobs')).toBe(1) // retained, never deleted

    // Force due again — a dead-lettered row must never be re-claimed.
    await forceAllDue(db)
    const third = await queue.drainOnce({ handlers: { [TOPIC]: handler } }, { maxAttempts: 2 })
    expect(third).toEqual({ claimed: 0, acked: 0, retried: 0, deadLettered: 0 })
  })

  it('an explicit deadLetter result dead-letters the job immediately and records the reason', async () => {
    const { db, queue } = await freshQueue()
    await queue.enqueue(TOPIC, reconcileJob(1))

    const { handler } = fakeHandler({ kind: 'deadLetter', reason: 'malformed payload' })
    const report = await queue.drainOnce({ handlers: { [TOPIC]: handler } })

    expect(report).toEqual({ claimed: 1, acked: 0, retried: 0, deadLettered: 1 })

    const [row] = await allJobRows(db)
    expect(row.attempts).toBe(1)
    expect(row.dead_lettered_at).not.toBeNull()
    expect(row.locked_until).toBeNull()
    expect(row.last_error).toBe('malformed payload')
    expect(await countRows(db, 'queue_jobs')).toBe(1) // retained, never deleted
  })

  it('a job whose topic has no registered handler is not claimed', async () => {
    const { db, queue } = await freshQueue()
    await queue.enqueue('some-other-topic', reconcileJob(1))

    const { handler, calls } = fakeHandler({ kind: 'ack' })
    const report = await queue.drainOnce({ handlers: { [TOPIC]: handler } })

    expect(report).toEqual({ claimed: 0, acked: 0, retried: 0, deadLettered: 0 })
    expect(calls).toHaveLength(0)
    expect(await countRows(db, 'queue_jobs')).toBe(1)
  })

  it('batchSize bounds how many jobs one drainOnce call claims', async () => {
    const { db, queue } = await freshQueue()
    for (let i = 0; i < 5; i++) {
      await queue.enqueue(TOPIC, reconcileJob(i))
    }

    const { handler, calls } = fakeHandler({ kind: 'ack' })
    const report = await queue.drainOnce({ handlers: { [TOPIC]: handler } }, { batchSize: 2 })

    expect(report).toEqual({ claimed: 2, acked: 2, retried: 0, deadLettered: 0 })
    expect(calls).toHaveLength(2)
    expect(await countRows(db, 'queue_jobs')).toBe(3)
  })

  it('getStats reports the ready count, oldest-ready age, and dead-letter count from a single query', async () => {
    const { queue } = await freshQueue()

    expect(await queue.getStats()).toEqual({
      ready: 0,
      oldestReadyAgeSeconds: null,
      deadLettered: 0,
    })

    await queue.enqueue(TOPIC, reconcileJob(1))
    await queue.enqueue(TOPIC, reconcileJob(2), { delaySeconds: 3600 })

    const withOneReady = await queue.getStats()
    expect(withOneReady.ready).toBe(1)
    expect(withOneReady.deadLettered).toBe(0)
    expect(withOneReady.oldestReadyAgeSeconds).not.toBeNull()
    expect(withOneReady.oldestReadyAgeSeconds as number).toBeGreaterThanOrEqual(0)

    // Dead-letter the one ready job; the delayed one is still not ready.
    const { handler } = fakeHandler({ kind: 'deadLetter', reason: 'x' })
    await queue.drainOnce({ handlers: { [TOPIC]: handler } })

    expect(await queue.getStats()).toEqual({
      ready: 0,
      oldestReadyAgeSeconds: null,
      deadLettered: 1,
    })
  })

  it('two concurrent drainOnce calls never process the same job twice (FOR UPDATE SKIP LOCKED)', async () => {
    const { db, queue } = await freshQueue()
    const jobCount = 10
    for (let i = 0; i < jobCount; i++) {
      await queue.enqueue(TOPIC, reconcileJob(i))
    }

    // PGlite is single-connection/in-process, so these two `drainOnce` calls
    // are not necessarily racing on separate backend connections the way two
    // real Supabase-backed Vercel Cron invocations would (see
    // src/db/migrate.ts's `migrate()` doc comment on the same PGlite
    // limitation for true concurrent-lock coverage). What this DOES prove
    // unconditionally, regardless of how the two calls actually interleave:
    // the claim query's WHERE clause (`locked_until IS NULL OR locked_until
    // < now()`, re-checked inside the same atomic UPDATE the FOR UPDATE SKIP
    // LOCKED subquery drives) never lets two calls claim the same row.
    const processedIds: string[] = []
    const handler: QueueMessageHandler<unknown> = async (message) => {
      processedIds.push(message.id)
      return { kind: 'ack' }
    }

    const [a, b] = await Promise.all([
      queue.drainOnce({ handlers: { [TOPIC]: handler } }, { batchSize: jobCount }),
      queue.drainOnce({ handlers: { [TOPIC]: handler } }, { batchSize: jobCount }),
    ])

    expect(a.claimed + b.claimed).toBe(jobCount)
    expect(processedIds).toHaveLength(jobCount)
    // No id appears twice — the union of what each call processed has no overlap.
    expect(new Set(processedIds).size).toBe(jobCount)
    expect(await countRows(db, 'queue_jobs')).toBe(0)
  })
})
