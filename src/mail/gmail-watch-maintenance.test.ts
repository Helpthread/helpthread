/**
 * `runGmailWatchMaintenance` against REAL PGlite-backed `MailboxStore`/
 * `GmailWatchStateStore` (so the SQL behind HT-42's new
 * `listActiveMailboxes`/`setWatchExpiration` methods is genuinely
 * exercised, not just mocked) plus fakes for the Gmail-API-facing seams
 * (`createWatchClient`, `GmailOAuthTokenService`) and the `QueueProvider`.
 * Exercises the orchestration control flow documented in
 * `gmail-watch-maintenance.ts`'s module doc: the renewal/sweep
 * independence, the token-failure branches, the no-dedupeKey sweep, and
 * failure-isolation per mailbox.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GMAIL_RECONCILE_TOPIC, type GmailReconcileJob } from '../api/gmail-webhook.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { GmailWatchClient } from '../providers/adapters/gmail/index.js'
import type { EnqueueOptions, QueueProvider } from '../providers/queue.js'
import {
  createGmailWatchStateStore,
  type GmailWatchStateStore,
} from '../store/gmail-watch-state.js'
import { createMailboxStore, type MailboxStore } from '../store/mailboxes.js'
import type { GmailOAuthTokenService } from './gmail-oauth.js'
import {
  type GmailWatchMaintenanceDeps,
  runGmailWatchMaintenance,
} from './gmail-watch-maintenance.js'

const TOPIC_NAME = 'projects/helpthread-test/topics/gmail-push'
const DEFAULT_RENEWAL_EXPIRATION = new Date('2026-02-01T00:00:00.000Z')

type EnqueuedCall = { topic: string; payload: GmailReconcileJob; opts: EnqueueOptions | undefined }

/** Records every `enqueue` call — the assertion surface for "swept" behavior and the no-dedupeKey rule (module doc). */
function fakeQueue(): { queue: QueueProvider; enqueued: EnqueuedCall[] } {
  const enqueued: EnqueuedCall[] = []
  return {
    queue: {
      async enqueue(topic, payload, opts) {
        enqueued.push({ topic, payload: payload as GmailReconcileJob, opts })
      },
    },
    enqueued,
  }
}

/**
 * A fake `GmailOAuthTokenService` whose behavior is keyed by mailboxId.
 * `'needs_reconnect'` mirrors gmail-oauth.ts's real `invalid_grant`
 * behavior (see gmail-reconcile.test.ts's identical precedent): it marks
 * the mailbox itself via the REAL `mailboxStore` passed in, THEN throws —
 * so this must run against the same store instance the test asserts
 * against. A resolved token is always `token-for-<mailboxId>`, letting the
 * fake `createWatchClient` below (which only ever sees the `getAccessToken`
 * closure, never the mailboxId directly) recover which mailbox it is
 * arming `watch()` for.
 */
function fakeTokenService(
  mailboxStore: MailboxStore,
  behaviors: Record<string, 'needs_reconnect' | 'transient'>,
): GmailOAuthTokenService {
  return {
    async getAccessToken(mailboxId) {
      const behavior = behaviors[mailboxId]
      if (behavior === 'needs_reconnect') {
        await mailboxStore.markNeedsReconnect(mailboxId)
        throw new Error('fake getAccessToken: invalid_grant')
      }
      if (behavior === 'transient') {
        throw new Error('fake getAccessToken: network error')
      }
      return `token-for-${mailboxId}`
    },
  }
}

/** A fake `createWatchClient` factory whose per-mailbox `watch()` outcome is keyed by mailboxId (recovered from the resolved token — see {@link fakeTokenService}). */
function fakeCreateWatchClient(
  failingMailboxIds: string[],
  expiration: Date = DEFAULT_RENEWAL_EXPIRATION,
): (getAccessToken: () => Promise<string>) => GmailWatchClient {
  return (getAccessToken) => ({
    async watch() {
      const token = await getAccessToken()
      const mailboxId = token.replace('token-for-', '')
      if (failingMailboxIds.includes(mailboxId)) {
        throw new Error('fake watch(): renewal failed')
      }
      return { historyId: `renewed-watermark-for-${mailboxId}`, expiration }
    },
    async getProfile() {
      throw new Error('fakeCreateWatchClient: getProfile not used by maintenance')
    },
  })
}

describe('runGmailWatchMaintenance', () => {
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

  async function readWatchExpiration(rawDb: Db, mailboxId: string): Promise<Date | null> {
    const rows = await rawDb.query<{ watch_expiration: Date | null }>(
      'SELECT watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )
    return rows[0]?.watch_expiration ?? null
  }

  function buildDeps(
    mailboxStore: MailboxStore,
    watchStateStore: GmailWatchStateStore,
    queue: QueueProvider,
    overrides: Partial<GmailWatchMaintenanceDeps> = {},
  ): GmailWatchMaintenanceDeps {
    return {
      tokenService: fakeTokenService(mailboxStore, {}),
      mailboxStore,
      watchStateStore,
      queue,
      createWatchClient: fakeCreateWatchClient([]),
      topicName: TOPIC_NAME,
      ...overrides,
    }
  }

  it('happy path: two active mailboxes with cursors are both renewed and both swept', async () => {
    const { db: rawDb, mailboxStore, watchStateStore } = await freshStores()
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

    const report = await runGmailWatchMaintenance(buildDeps(mailboxStore, watchStateStore, queue))

    expect(report).toEqual({ total: 2, renewed: 2, swept: 2, needsReconnect: 0, failed: 0 })
    expect((await readWatchExpiration(rawDb, mailboxA))?.toISOString()).toBe(
      DEFAULT_RENEWAL_EXPIRATION.toISOString(),
    )
    expect((await readWatchExpiration(rawDb, mailboxB))?.toISOString()).toBe(
      DEFAULT_RENEWAL_EXPIRATION.toISOString(),
    )
    // setWatchExpiration must never touch history_id — the sacred cursor rule.
    expect(await watchStateStore.getCursor(mailboxA)).toBe('cursor-a')
    expect(await watchStateStore.getCursor(mailboxB)).toBe('cursor-b')

    expect(enqueued).toHaveLength(2)
    const byMailbox = new Map(enqueued.map((e) => [e.payload.mailboxId, e]))
    expect(byMailbox.get(mailboxA)).toMatchObject({
      topic: GMAIL_RECONCILE_TOPIC,
      payload: { mailboxId: mailboxA, historyId: 'cursor-a' },
    })
    expect(byMailbox.get(mailboxB)).toMatchObject({
      topic: GMAIL_RECONCILE_TOPIC,
      payload: { mailboxId: mailboxB, historyId: 'cursor-b' },
    })
  })

  it('acquires the access token exactly once per mailbox — reused for watch(), not re-fetched', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const mailboxA = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'once-a@example.test',
      'cursor-a',
    )
    const mailboxB = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'once-b@example.test',
      'cursor-b',
    )
    const { queue } = fakeQueue()
    const tokenService = fakeTokenService(mailboxStore, {})
    const getTokenSpy = vi.spyOn(tokenService, 'getAccessToken')

    await runGmailWatchMaintenance(
      buildDeps(mailboxStore, watchStateStore, queue, { tokenService }),
    )

    // Exactly one token-service call per mailbox: step 1 acquires the token and
    // the watch client reuses it, rather than fetching a second time. (Two
    // calls per mailbox here would mean the redundant re-fetch is back.)
    expect(getTokenSpy).toHaveBeenCalledTimes(2)
    expect(getTokenSpy).toHaveBeenCalledWith(mailboxA)
    expect(getTokenSpy).toHaveBeenCalledWith(mailboxB)
  })

  it('a mailbox with no baseline cursor is renewed but NOT swept', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: 'no-cursor@example.test',
      provider: 'gmail',
    })
    // No seedBaseline call — this mailbox has no gmail_watch_state row at all.
    const { queue, enqueued } = fakeQueue()

    const report = await runGmailWatchMaintenance(buildDeps(mailboxStore, watchStateStore, queue))

    expect(report).toEqual({ total: 1, renewed: 1, swept: 0, needsReconnect: 0, failed: 0 })
    expect(enqueued).toHaveLength(0)
    expect(await watchStateStore.getCursor(mailbox.id)).toBeNull()
  })

  it('a token failure that leaves the mailbox needs_reconnect is counted needsReconnect, not renewed/swept — and other mailboxes still process', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const dead = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'dead@example.test',
      'cursor-dead',
    )
    const healthy = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'healthy@example.test',
      'cursor-healthy',
    )
    const { queue, enqueued } = fakeQueue()

    const report = await runGmailWatchMaintenance(
      buildDeps(mailboxStore, watchStateStore, queue, {
        tokenService: fakeTokenService(mailboxStore, { [dead]: 'needs_reconnect' }),
      }),
    )

    expect(report).toEqual({ total: 2, renewed: 1, swept: 1, needsReconnect: 1, failed: 0 })
    expect((await mailboxStore.getMailboxById(dead))?.status).toBe('needs_reconnect')
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].payload.mailboxId).toBe(healthy)
  })

  it('a transient token failure (mailbox stays active) is counted failed, not needsReconnect — and other mailboxes still process', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const flaky = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'flaky@example.test',
      'cursor-flaky',
    )
    const healthy = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'healthy2@example.test',
      'cursor-healthy2',
    )
    const { queue, enqueued } = fakeQueue()

    const report = await runGmailWatchMaintenance(
      buildDeps(mailboxStore, watchStateStore, queue, {
        tokenService: fakeTokenService(mailboxStore, { [flaky]: 'transient' }),
      }),
    )

    expect(report).toEqual({ total: 2, renewed: 1, swept: 1, needsReconnect: 0, failed: 1 })
    expect((await mailboxStore.getMailboxById(flaky))?.status).toBe('active')
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].payload.mailboxId).toBe(healthy)
  })

  it('a watch() throw is counted failed WITHOUT marking needs_reconnect, and the sweep still runs for that mailbox (valid token) — other mailboxes still process', async () => {
    const { db: rawDb, mailboxStore, watchStateStore } = await freshStores()
    const glitchy = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'glitchy@example.test',
      'cursor-glitchy',
    )
    const healthy = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'healthy3@example.test',
      'cursor-healthy3',
    )
    const originalExpiration = new Date('2026-01-01T00:00:00.000Z') // written by seedBaseline above
    const { queue, enqueued } = fakeQueue()

    const report = await runGmailWatchMaintenance(
      buildDeps(mailboxStore, watchStateStore, queue, {
        createWatchClient: fakeCreateWatchClient([glitchy]),
      }),
    )

    expect(report).toEqual({ total: 2, renewed: 1, swept: 2, needsReconnect: 0, failed: 1 })
    expect((await mailboxStore.getMailboxById(glitchy))?.status).toBe('active')
    // watch() failed, so the expiration seedBaseline wrote earlier is untouched.
    expect((await readWatchExpiration(rawDb, glitchy))?.toISOString()).toBe(
      originalExpiration.toISOString(),
    )
    // The sweep is independent of renewal — both mailboxes still get a job.
    expect(enqueued).toHaveLength(2)
    const sweptIds = enqueued.map((e) => e.payload.mailboxId).sort()
    expect(sweptIds).toEqual([glitchy, healthy].sort())
  })

  it('enqueues with no dedupeKey — a second run sweeps the same mailbox again rather than being suppressed as a duplicate', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'repeat@example.test',
      'cursor-repeat',
    )
    const { queue, enqueued } = fakeQueue()
    const deps = buildDeps(mailboxStore, watchStateStore, queue)

    await runGmailWatchMaintenance(deps)
    await runGmailWatchMaintenance(deps)

    expect(enqueued).toHaveLength(2)
    for (const call of enqueued) {
      expect(call.opts?.dedupeKey).toBeUndefined()
    }
  })

  it('validates topicName is non-empty before doing any work', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const listSpy = vi.spyOn(mailboxStore, 'listActiveMailboxes')
    const { queue } = fakeQueue()

    const deps = buildDeps(mailboxStore, watchStateStore, queue, { topicName: '' })

    await expect(runGmailWatchMaintenance(deps)).rejects.toThrow(/topicName/)
    expect(listSpy).not.toHaveBeenCalled()
  })
})
