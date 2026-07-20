/**
 * `runGmailReconcileSweep` against REAL PGlite-backed `MailboxStore`/
 * `GmailWatchStateStore` (so `listActiveMailboxes`/`getCursor` are genuinely
 * exercised, not just mocked) plus a fake `QueueProvider`. Split out of
 * `./gmail-watch-maintenance.test.ts` (HT-94) along with the sweep itself —
 * see `./gmail-reconcile-sweep.ts`'s module doc for why. Exercises: the
 * happy-path enqueue, the no-baseline-cursor skip, per-mailbox failure
 * isolation, and propagation of a fault outside the per-mailbox loop with a
 * fake queue; the bare-`mailboxId`-dedupe-key liveness contract (the most
 * important behavior in this file — see the module doc's "The dedupe key is
 * the bare mailboxId" section) against the REAL `createPostgresQueue`, since
 * only the real adapter's partial unique index can actually prove it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GMAIL_RECONCILE_TOPIC, type GmailReconcileJob } from '../api/gmail-webhook.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createPostgresQueue } from '../providers/adapters/postgres-queue/index.js'
import type { EnqueueOptions, QueueProvider } from '../providers/queue.js'
import {
  createGmailWatchStateStore,
  type GmailWatchStateStore,
} from '../store/gmail-watch-state.js'
import { createMailboxStore, type MailboxStore } from '../store/mailboxes.js'
import { type GmailReconcileSweepDeps, runGmailReconcileSweep } from './gmail-reconcile-sweep.js'

type EnqueuedCall = { topic: string; payload: GmailReconcileJob; opts: EnqueueOptions | undefined }

/** Records every `enqueue` call — the assertion surface for "swept" behavior and the no-dedupeKey rule (module doc). Optionally fails enqueue for specific mailboxIds, for the failure-isolation tests. */
function fakeQueue(failingMailboxIds: string[] = []): {
  queue: QueueProvider
  enqueued: EnqueuedCall[]
} {
  const enqueued: EnqueuedCall[] = []
  return {
    queue: {
      async enqueue(topic, payload, opts) {
        const job = payload as GmailReconcileJob
        if (failingMailboxIds.includes(job.mailboxId)) {
          throw new Error('fake enqueue: queue write failed')
        }
        enqueued.push({ topic, payload: job, opts })
      },
    },
    enqueued,
  }
}

describe('runGmailReconcileSweep', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStores(): Promise<{
    db: Db
    mailboxStore: MailboxStore
    watchStateStore: GmailWatchStateStore
  }> {
    db = await createPgliteDb()
    await migrate(db)
    return {
      db,
      mailboxStore: createMailboxStore(db),
      watchStateStore: createGmailWatchStateStore(db),
    }
  }

  async function seedActiveMailboxWithCursor(
    mailboxStore: MailboxStore,
    watchStateStore: GmailWatchStateStore,
    address: string,
    cursor: string,
  ): Promise<string> {
    const mailbox = await mailboxStore.upsertConnectedMailbox({ address, provider: 'gmail' })
    await watchStateStore.seedBaseline(mailbox.id, {
      historyId: cursor,
      watchExpiration: new Date('2026-01-01T00:00:00.000Z'),
    })
    return mailbox.id
  }

  function buildDeps(
    mailboxStore: MailboxStore,
    watchStateStore: GmailWatchStateStore,
    queue: QueueProvider,
  ): GmailReconcileSweepDeps {
    return { mailboxStore, watchStateStore, queue }
  }

  /** Count `queue_jobs` rows, optionally restricted to the live set (not dead-lettered) — the partial unique index's own predicate. */
  async function countQueueRows(db: Db, opts: { onlyLive?: boolean } = {}): Promise<number> {
    const where = opts.onlyLive ? 'WHERE dead_lettered_at IS NULL' : ''
    const rows = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM queue_jobs ${where}`,
    )
    return rows[0].count
  }

  it('two active mailboxes with cursors are both enqueued', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const mailboxA = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'a@example.test',
      'cursor-a',
    )
    const mailboxB = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'b@example.test',
      'cursor-b',
    )
    const { queue, enqueued } = fakeQueue()

    const report = await runGmailReconcileSweep(buildDeps(mailboxStore, watchStateStore, queue))

    expect(report).toEqual({ total: 2, swept: 2, skipped: 0, failed: 0 })
    expect(enqueued).toHaveLength(2)
    const byMailbox = new Map(enqueued.map((e) => [e.payload.mailboxId, e]))
    // The enqueued job shape is { mailboxId, historyId: <the stored cursor> } on GMAIL_RECONCILE_TOPIC.
    expect(byMailbox.get(mailboxA)).toMatchObject({
      topic: GMAIL_RECONCILE_TOPIC,
      payload: { mailboxId: mailboxA, historyId: 'cursor-a' },
    })
    expect(byMailbox.get(mailboxB)).toMatchObject({
      topic: GMAIL_RECONCILE_TOPIC,
      payload: { mailboxId: mailboxB, historyId: 'cursor-b' },
    })
  })

  it('a mailbox with no baseline cursor (getCursor returns null) is skipped, not enqueued', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: 'no-cursor@example.test',
      provider: 'gmail',
    })
    // No seedBaseline call — this mailbox has no gmail_watch_state row at all.
    const { queue, enqueued } = fakeQueue()

    const report = await runGmailReconcileSweep(buildDeps(mailboxStore, watchStateStore, queue))

    expect(report).toEqual({ total: 1, swept: 0, skipped: 1, failed: 0 })
    expect(enqueued).toHaveLength(0)
    expect(await watchStateStore.getCursor(mailbox.id)).toBeNull()
  })

  it('a second sweep tick does NOT enqueue a second row while the mailbox job is still pending (live) — the bare-mailboxId dedupe key, against the REAL queue', async () => {
    // The most important test in this file (module doc's "The dedupe key is
    // the bare mailboxId" section): only the real adapter's partial unique
    // index (`WHERE dedupe_key IS NOT NULL AND dead_lettered_at IS NULL`) can
    // prove this — a fake queue would be tautological here and would not
    // catch a regression to a composite `mailboxId:historyId` key.
    const { db, mailboxStore, watchStateStore } = await freshStores()
    const mailboxId = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'live@example.test',
      'cursor-live',
    )
    const queue = createPostgresQueue(db)
    const deps = buildDeps(mailboxStore, watchStateStore, queue)

    await runGmailReconcileSweep(deps)
    await runGmailReconcileSweep(deps)

    expect(await countQueueRows(db)).toBe(1)
    const rows = await db.query<{ dedupe_key: string | null }>('SELECT dedupe_key FROM queue_jobs')
    expect(rows[0].dedupe_key).toBe(mailboxId)
  })

  it('once the pending job is ACKED, the next sweep tick enqueues again — a quiet mailbox is not permanently suppressed', async () => {
    const { db, mailboxStore, watchStateStore } = await freshStores()
    await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'acked@example.test',
      'cursor-acked',
    )
    const queue = createPostgresQueue(db)
    const deps = buildDeps(mailboxStore, watchStateStore, queue)

    await runGmailReconcileSweep(deps)
    expect(await countQueueRows(db)).toBe(1)

    const drainReport = await queue.drainOnce({
      handlers: { [GMAIL_RECONCILE_TOPIC]: async () => ({ kind: 'ack' }) },
    })
    expect(drainReport.acked).toBe(1)
    expect(await countQueueRows(db)).toBe(0)

    await runGmailReconcileSweep(deps)
    expect(await countQueueRows(db)).toBe(1)
  })

  it('once the pending job is DEAD-LETTERED, the next sweep tick enqueues again — a quiet mailbox is not permanently suppressed', async () => {
    const { db, mailboxStore, watchStateStore } = await freshStores()
    await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'dead-lettered@example.test',
      'cursor-dead-lettered',
    )
    const queue = createPostgresQueue(db)
    const deps = buildDeps(mailboxStore, watchStateStore, queue)

    await runGmailReconcileSweep(deps)
    expect(await countQueueRows(db)).toBe(1)

    const drainReport = await queue.drainOnce({
      handlers: {
        [GMAIL_RECONCILE_TOPIC]: async () => ({ kind: 'deadLetter', reason: 'test dead-letter' }),
      },
    })
    expect(drainReport.deadLettered).toBe(1)
    // Dead-lettered row is retained (never deleted — invariant #1), but it is
    // no longer "live", so the unique index's predicate no longer covers it.
    expect(await countQueueRows(db)).toBe(1)
    expect(await countQueueRows(db, { onlyLive: true })).toBe(0)

    await runGmailReconcileSweep(deps)
    // A new live row is inserted alongside the retained dead-lettered one —
    // the dead-lettered row is excluded from the partial unique index, so it
    // never conflicts with (and never suppresses) the fresh enqueue.
    expect(await countQueueRows(db)).toBe(2)
    expect(await countQueueRows(db, { onlyLive: true })).toBe(1)
  })

  it('a mailbox whose getCursor throws is counted failed — other mailboxes still enqueue', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const broken = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'broken@example.test',
      'cursor-broken',
    )
    const healthy = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'healthy@example.test',
      'cursor-healthy',
    )
    const originalGetCursor = watchStateStore.getCursor.bind(watchStateStore)
    vi.spyOn(watchStateStore, 'getCursor').mockImplementation(async (mailboxId) => {
      if (mailboxId === broken) {
        throw new Error('fake getCursor: store read failed')
      }
      return originalGetCursor(mailboxId)
    })
    const { queue, enqueued } = fakeQueue()

    const report = await runGmailReconcileSweep(buildDeps(mailboxStore, watchStateStore, queue))

    expect(report).toEqual({ total: 2, swept: 1, skipped: 0, failed: 1 })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].payload.mailboxId).toBe(healthy)
  })

  it('a mailbox whose enqueue throws is counted failed — other mailboxes still enqueue', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const broken = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'broken2@example.test',
      'cursor-broken2',
    )
    const healthy = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'healthy2@example.test',
      'cursor-healthy2',
    )
    const { queue, enqueued } = fakeQueue([broken])

    const report = await runGmailReconcileSweep(buildDeps(mailboxStore, watchStateStore, queue))

    expect(report).toEqual({ total: 2, swept: 1, skipped: 0, failed: 1 })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].payload.mailboxId).toBe(healthy)
  })

  it('a fault outside the per-mailbox loop (listActiveMailboxes itself throwing) propagates rather than being swallowed', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    vi.spyOn(mailboxStore, 'listActiveMailboxes').mockRejectedValue(
      new Error('fake listActiveMailboxes: store read failed'),
    )
    const { queue } = fakeQueue()

    await expect(
      runGmailReconcileSweep(buildDeps(mailboxStore, watchStateStore, queue)),
    ).rejects.toThrow('fake listActiveMailboxes: store read failed')
  })
})
