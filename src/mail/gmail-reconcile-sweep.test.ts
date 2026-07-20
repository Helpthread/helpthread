/**
 * `runGmailReconcileSweep` against REAL PGlite-backed `MailboxStore`/
 * `GmailWatchStateStore` (so `listActiveMailboxes`/`getCursor` are genuinely
 * exercised, not just mocked) plus a fake `QueueProvider`. Split out of
 * `./gmail-watch-maintenance.test.ts` (HT-94) along with the sweep itself —
 * see `./gmail-reconcile-sweep.ts`'s module doc for why. Exercises: the
 * happy-path enqueue, the no-baseline-cursor skip, the no-dedupeKey rule
 * (the most important behavior in this file — see the module doc's "no
 * dedupe key, deliberately" section), per-mailbox failure isolation, and
 * propagation of a fault outside the per-mailbox loop.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GMAIL_RECONCILE_TOPIC, type GmailReconcileJob } from '../api/gmail-webhook.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
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

  it('enqueues with no dedupeKey — two consecutive runs both enqueue for the same mailbox rather than being suppressed as a duplicate', async () => {
    // The most important test in this file (module doc): at every-minute
    // cadence, a dedupeKey here would silently suppress a sweep of an
    // already-current, quiet mailbox as a "duplicate" of the prior tick's
    // job — turning the primary inbound transport into an accidental noop.
    const { mailboxStore, watchStateStore } = await freshStores()
    await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'repeat@example.test',
      'cursor-repeat',
    )
    const { queue, enqueued } = fakeQueue()
    const deps = buildDeps(mailboxStore, watchStateStore, queue)

    await runGmailReconcileSweep(deps)
    await runGmailReconcileSweep(deps)

    expect(enqueued).toHaveLength(2)
    for (const call of enqueued) {
      expect(call.opts).not.toHaveProperty('dedupeKey')
      expect(call.opts?.dedupeKey).toBeUndefined()
    }
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
