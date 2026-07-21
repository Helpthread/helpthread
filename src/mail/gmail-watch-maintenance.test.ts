/**
 * `runGmailWatchMaintenance` against REAL PGlite-backed `MailboxStore`/
 * `GmailWatchStateStore` (so the SQL behind HT-42's new
 * `listActiveMailboxes`/`setWatchExpiration` methods is genuinely
 * exercised, not just mocked) plus fakes for the Gmail-API-facing seams
 * (`createWatchClient`, `GmailOAuthTokenService`). No queue seam any more —
 * renewal never enqueues; the sweep that did moved out in HT-94.
 * Exercises the orchestration control flow documented in
 * `gmail-watch-maintenance.ts`'s module doc: renewal and the
 * token-failure branches, and failure-isolation per mailbox. The
 * reconciliation sweep itself moved to `./gmail-reconcile-sweep.ts` (HT-94)
 * along with its own coverage (`./gmail-reconcile-sweep.test.ts`) — this
 * file tests renewal only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { GmailWatchClient } from '../providers/adapters/gmail/index.js'
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
    async stop() {
      throw new Error('fakeCreateWatchClient: stop not used by maintenance')
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
    overrides: Partial<GmailWatchMaintenanceDeps> = {},
  ): GmailWatchMaintenanceDeps {
    return {
      tokenService: fakeTokenService(mailboxStore, {}),
      mailboxStore,
      watchStateStore,
      createWatchClient: fakeCreateWatchClient([]),
      topicName: TOPIC_NAME,
      ...overrides,
    }
  }

  it('happy path: two active mailboxes with cursors are both renewed', async () => {
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

    const report = await runGmailWatchMaintenance(buildDeps(mailboxStore, watchStateStore))

    expect(report).toEqual({ total: 2, renewed: 2, needsReconnect: 0, failed: 0 })
    expect((await readWatchExpiration(rawDb, mailboxA))?.toISOString()).toBe(
      DEFAULT_RENEWAL_EXPIRATION.toISOString(),
    )
    expect((await readWatchExpiration(rawDb, mailboxB))?.toISOString()).toBe(
      DEFAULT_RENEWAL_EXPIRATION.toISOString(),
    )
    // setWatchExpiration must never touch history_id — the sacred cursor rule.
    expect(await watchStateStore.getCursor(mailboxA)).toBe('cursor-a')
    expect(await watchStateStore.getCursor(mailboxB)).toBe('cursor-b')
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
    const tokenService = fakeTokenService(mailboxStore, {})
    const getTokenSpy = vi.spyOn(tokenService, 'getAccessToken')

    await runGmailWatchMaintenance(buildDeps(mailboxStore, watchStateStore, { tokenService }))

    // Exactly one token-service call per mailbox: step 1 acquires the token and
    // the watch client reuses it, rather than fetching a second time. (Two
    // calls per mailbox here would mean the redundant re-fetch is back.)
    expect(getTokenSpy).toHaveBeenCalledTimes(2)
    expect(getTokenSpy).toHaveBeenCalledWith(mailboxA)
    expect(getTokenSpy).toHaveBeenCalledWith(mailboxB)
  })

  it('a mailbox with no baseline cursor is still renewed', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: 'no-cursor@example.test',
      provider: 'gmail',
    })
    // No seedBaseline call — this mailbox has no gmail_watch_state row at all.

    const report = await runGmailWatchMaintenance(buildDeps(mailboxStore, watchStateStore))

    expect(report).toEqual({ total: 1, renewed: 1, needsReconnect: 0, failed: 0 })
    expect(await watchStateStore.getCursor(mailbox.id)).toBeNull()
  })

  it('a token failure that leaves the mailbox needs_reconnect is counted needsReconnect, not renewed — and other mailboxes still process', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const dead = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'dead@example.test',
      'cursor-dead',
    )
    await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'healthy@example.test',
      'cursor-healthy',
    )

    const report = await runGmailWatchMaintenance(
      buildDeps(mailboxStore, watchStateStore, {
        tokenService: fakeTokenService(mailboxStore, { [dead]: 'needs_reconnect' }),
      }),
    )

    expect(report).toEqual({ total: 2, renewed: 1, needsReconnect: 1, failed: 0 })
    expect((await mailboxStore.getMailboxById(dead))?.status).toBe('needs_reconnect')
  })

  it('a transient token failure (mailbox stays active) is counted failed, not needsReconnect — and other mailboxes still process', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const flaky = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'flaky@example.test',
      'cursor-flaky',
    )
    await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'healthy2@example.test',
      'cursor-healthy2',
    )

    const report = await runGmailWatchMaintenance(
      buildDeps(mailboxStore, watchStateStore, {
        tokenService: fakeTokenService(mailboxStore, { [flaky]: 'transient' }),
      }),
    )

    expect(report).toEqual({ total: 2, renewed: 1, needsReconnect: 0, failed: 1 })
    expect((await mailboxStore.getMailboxById(flaky))?.status).toBe('active')
  })

  it('a watch() throw is counted failed WITHOUT marking needs_reconnect — other mailboxes still process', async () => {
    const { db: rawDb, mailboxStore, watchStateStore } = await freshStores()
    const glitchy = await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'glitchy@example.test',
      'cursor-glitchy',
    )
    await seedActiveMailboxWithCursor(
      mailboxStore,
      watchStateStore,
      'healthy3@example.test',
      'cursor-healthy3',
    )
    const originalExpiration = new Date('2026-01-01T00:00:00.000Z') // written by seedBaseline above

    const report = await runGmailWatchMaintenance(
      buildDeps(mailboxStore, watchStateStore, {
        createWatchClient: fakeCreateWatchClient([glitchy]),
      }),
    )

    expect(report).toEqual({ total: 2, renewed: 1, needsReconnect: 0, failed: 1 })
    expect((await mailboxStore.getMailboxById(glitchy))?.status).toBe('active')
    // watch() failed, so the expiration seedBaseline wrote earlier is untouched.
    expect((await readWatchExpiration(rawDb, glitchy))?.toISOString()).toBe(
      originalExpiration.toISOString(),
    )
  })

  it('validates topicName is non-empty before doing any work', async () => {
    const { mailboxStore, watchStateStore } = await freshStores()
    const listSpy = vi.spyOn(mailboxStore, 'listActiveMailboxes')

    const deps = buildDeps(mailboxStore, watchStateStore, { topicName: '' })

    await expect(runGmailWatchMaintenance(deps)).rejects.toThrow(/topicName/)
    expect(listSpy).not.toHaveBeenCalled()
  })
})
