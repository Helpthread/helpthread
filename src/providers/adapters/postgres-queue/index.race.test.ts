/**
 * Cross-connection lease-expiry race tests for {@link createPostgresQueue}'s
 * stale-outcome fence (the module doc's "Stale-outcome fence" section).
 *
 * ## Why these can't live in `index.test.ts`
 *
 * The sibling suite runs against a single in-process PGlite handle
 * (`createPgliteDb`). That is exactly ONE connection, so it can never stage
 * the race the fence exists for: worker A leases a row, its lease expires
 * mid-processing, and a SEPARATE worker B on a SEPARATE backend connection
 * reclaims that row (bumping `attempts`) before A writes its outcome. Proving
 * A's stale write cannot delete or overwrite B's row needs two genuinely
 * independent Postgres connections.
 *
 * So — exactly like `src/db/postgres.test.ts` — a real PGlite instance is
 * exposed on a loopback TCP port via `@electric-sql/pglite-socket`, and two
 * independent `pg`-backed `PostgresDb` pools (`workerA`, `workerB`, each its
 * own physical connection, mirroring two separate Vercel Cron invocations)
 * drive the real adapter over the real wire protocol. Every statement the
 * adapter issues is an autocommit single statement, so the race is a
 * deterministic SEQUENCE of committed writes — no two transactions need to
 * hold locks at once — which is what makes these tests reliable rather than
 * timing-dependent.
 *
 * ## How the barrier + lease expiry are staged deterministically
 *
 * A handler is just an async function, so worker A's handler parks on a
 * promise (the "barrier") after A has claimed but before A writes its
 * outcome. While A is parked it holds no in-flight query, so B is free to
 * claim. A's lease is pushed into the past with a direct
 * `locked_until = now() - 1s` UPDATE — the same deterministic "wait out the
 * clock without sleeping" trick `index.test.ts`'s `forceAllDue` uses; the
 * claim's `locked_until < now()` predicate cannot tell a forced expiry from a
 * wall-clock one. No real sleeps, so nothing here is flaky.
 */

import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../../../db/client.js'
import { migrate } from '../../../db/migrate.js'
import { createPostgresDb } from '../../../db/postgres.js'
import type { QueueMessageHandler } from '../../queue.js'
import { createPostgresQueue } from './index.js'

const TOPIC = 'gmail-reconcile'

/** A promise plus its resolver — the barrier primitive these tests coordinate on. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** timestamptz columns cast to `::text` so equality checks compare stable server-rendered strings, not `Date` identities. */
interface RowSnapshot {
  attempts: number
  locked_until: string | null
  run_after: string
  dead_lettered_at: string | null
}

let pglite: PGlite
let server: PGLiteSocketServer
let connectionString: string

/** Dbs opened during a test, closed after it so the socket server's connection budget never leaks across tests. */
let openDbs: Db[] = []

async function openDb(): Promise<Db> {
  // max: 1 — each worker is exactly one physical backend connection, the
  // faithful stand-in for one serverless function instance's pool.
  const db = await createPostgresDb({ connectionString, max: 1 })
  openDbs.push(db)
  return db
}

async function snapshot(db: Db): Promise<RowSnapshot> {
  const rows = await db.query<RowSnapshot>(
    `SELECT attempts,
            locked_until::text AS locked_until,
            run_after::text AS run_after,
            dead_lettered_at::text AS dead_lettered_at
     FROM queue_jobs`,
  )
  expect(rows).toHaveLength(1)
  return rows[0]
}

async function countRows(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM queue_jobs')
  return rows[0].n
}

/** Force the single job's lease into the past — a deterministic stand-in for the lease elapsing while worker A is parked. */
async function expireLease(db: Db): Promise<void> {
  await db.query("UPDATE queue_jobs SET locked_until = now() - interval '1 second'")
}

beforeAll(async () => {
  pglite = await PGlite.create()
  server = new PGLiteSocketServer({ db: pglite, host: '127.0.0.1', port: 0, maxConnections: 10 })
  const listening = new Promise<number>((resolve) => {
    server.addEventListener('listening', (event) => resolve((event as CustomEvent).detail.port), {
      once: true,
    })
  })
  await server.start()
  const port = await listening
  connectionString = `postgresql://fake_user:fake_password@127.0.0.1:${port}/postgres`

  const admin = await createPostgresDb({ connectionString, max: 1 })
  await migrate(admin)
  await admin.close()
})

afterAll(async () => {
  await server.stop()
  await pglite.close()
})

beforeEach(async () => {
  // Structured stale-skip logs are expected here — silence them, but keep the
  // spy so a test can assert the fence logged what it should.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  for (const db of openDbs) {
    await db.close().catch(() => {})
  }
  openDbs = []
  // One PGlite backs every test — clear the queue between them via a throwaway connection.
  const cleaner = await createPostgresDb({ connectionString, max: 1 })
  await cleaner.query('DELETE FROM queue_jobs')
  await cleaner.close()
  vi.restoreAllMocks()
})

describe('createPostgresQueue — cross-connection stale-outcome fence', () => {
  it('a stale ACK cannot delete a row a concurrent worker reclaimed and rescheduled (never-drop)', async () => {
    const seeder = createPostgresQueue(await openDb())
    await seeder.enqueue(TOPIC, { mailboxId: 'm1', historyId: '1' })

    const dbA = await openDb()
    const dbB = await openDb()
    // A leases briefly; B holds the default (long) lease. A's short lease is
    // belt-and-braces — expireLease() below is what deterministically expires it.
    const workerA = createPostgresQueue(dbA, { leaseMs: 500 })
    const workerB = createPostgresQueue(dbB)

    const aClaimed = deferred()
    const aMayFinish = deferred()
    const handlerA: QueueMessageHandler<unknown> = async () => {
      aClaimed.resolve()
      await aMayFinish.promise
      return { kind: 'ack' } // A believes it succeeded — but its lease had expired.
    }
    // B, the reclaimer, decides to RETRY (a transient failure): it reschedules
    // the job into the future. This is the dangerous case — an unfenced stale
    // ACK from A would DELETE the very row B just chose to keep.
    const handlerB: QueueMessageHandler<unknown> = async () => ({
      kind: 'retry',
      backoffSeconds: 300,
    })

    // 1. A claims (attempts 0 -> 1), then parks in its handler.
    const aDrain = workerA.drainOnce({ handlers: { [TOPIC]: handlerA } })
    await aClaimed.promise

    // 2. A's lease elapses.
    await expireLease(dbA)

    // 3. B reclaims (attempts 1 -> 2) and reschedules it.
    const bReport = await workerB.drainOnce({ handlers: { [TOPIC]: handlerB } })
    expect(bReport).toEqual({ claimed: 1, acked: 0, retried: 1, deadLettered: 0, staleSkipped: 0 })
    const afterB = await snapshot(dbB)
    expect(afterB.attempts).toBe(2)
    expect(afterB.locked_until).toBeNull()

    // 4. A resumes and issues its now-stale ACK.
    aMayFinish.resolve()
    const aReport = await aDrain

    // The fence caught it: A wrote nothing, counted it as staleSkipped, acked 0.
    expect(aReport).toEqual({ claimed: 1, acked: 0, retried: 0, deadLettered: 0, staleSkipped: 1 })

    // NEVER-DROP: the job survives, exactly as B left it — not deleted by A.
    expect(await countRows(dbB)).toBe(1)
    const afterA = await snapshot(dbB)
    expect(afterA).toEqual(afterB)

    // And the stale skip was logged for operator visibility.
    expect(console.warn).toHaveBeenCalledTimes(1)
    const logged = JSON.parse((console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(logged).toMatchObject({
      event: 'queue_stale_skip',
      topic: TOPIC,
      claimedAttempts: 1,
      intendedOutcome: 'ack',
    })
  })

  it('a stale RETRY cannot release the lease a concurrent worker now holds; the real owner still completes', async () => {
    const seeder = createPostgresQueue(await openDb())
    await seeder.enqueue(TOPIC, { mailboxId: 'm1', historyId: '1' })

    const dbA = await openDb()
    const dbB = await openDb()
    const workerA = createPostgresQueue(dbA, { leaseMs: 500 })
    const workerB = createPostgresQueue(dbB) // default 60s lease — will NOT expire during this test

    const aClaimed = deferred()
    const aMayFinish = deferred()
    const bClaimed = deferred()
    const bMayFinish = deferred()

    const handlerA: QueueMessageHandler<unknown> = async () => {
      aClaimed.resolve()
      await aMayFinish.promise
      return { kind: 'retry', backoffSeconds: 999 } // stale reschedule — would clear locked_until / reset run_after
    }
    const handlerB: QueueMessageHandler<unknown> = async () => {
      bClaimed.resolve()
      await bMayFinish.promise
      return { kind: 'ack' }
    }

    // 1. A claims (attempts 0 -> 1), parks.
    const aDrain = workerA.drainOnce({ handlers: { [TOPIC]: handlerA } })
    await aClaimed.promise

    // 2. A's lease elapses; B reclaims (attempts 1 -> 2) and parks while HOLDING a fresh lease.
    await expireLease(dbA)
    const bDrain = workerB.drainOnce({ handlers: { [TOPIC]: handlerB } })
    await bClaimed.promise
    const whileBHolds = await snapshot(dbA)
    expect(whileBHolds.attempts).toBe(2)
    expect(whileBHolds.locked_until).not.toBeNull() // B owns a live lease

    // 3. A resumes and issues its stale RETRY. Unfenced, its
    //    `locked_until = NULL, run_after = now()+999s` would RELEASE B's lease
    //    (letting a third worker grab the row B is still processing) and rewind
    //    its schedule. The fence must reject it.
    aMayFinish.resolve()
    const aReport = await aDrain
    expect(aReport).toEqual({ claimed: 1, acked: 0, retried: 0, deadLettered: 0, staleSkipped: 1 })

    // B's lease and schedule are untouched — the row is still exactly B's.
    const afterStaleRetry = await snapshot(dbA)
    expect(afterStaleRetry).toEqual(whileBHolds)

    // 4. The legitimate owner B finishes: its ACK matches the current generation
    //    (attempts 2) and deletes the row cleanly.
    bMayFinish.resolve()
    const bReport = await bDrain
    expect(bReport).toEqual({ claimed: 1, acked: 1, retried: 0, deadLettered: 0, staleSkipped: 0 })
    expect(await countRows(dbA)).toBe(0)

    expect(console.warn).toHaveBeenCalledTimes(1)
    const logged = JSON.parse((console.warn as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(logged).toMatchObject({ event: 'queue_stale_skip', intendedOutcome: 'retry' })
  })
})
