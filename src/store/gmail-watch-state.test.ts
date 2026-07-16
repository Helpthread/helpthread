import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createGmailWatchStateStore } from './gmail-watch-state.js'

async function insertMailbox(db: Db, address = 'mailbox@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    'INSERT INTO mailboxes (address, provider) VALUES ($1, $2) RETURNING id',
    [address, 'gmail'],
  )
  return rows[0].id
}

describe('createGmailWatchStateStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore() {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createGmailWatchStateStore(db) }
  }

  it('getCursor returns null when no watch-state row exists yet', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    expect(await store.getCursor(mailboxId)).toBeNull()
  })

  it('getCursor returns null when a row exists but history_id is still null', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query('INSERT INTO gmail_watch_state (mailbox_id) VALUES ($1)', [mailboxId])

    expect(await store.getCursor(mailboxId)).toBeNull()
  })

  it('getCursor returns the stored history_id', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query('INSERT INTO gmail_watch_state (mailbox_id, history_id) VALUES ($1, $2)', [
      mailboxId,
      '123456789',
    ])

    expect(await store.getCursor(mailboxId)).toBe('123456789')
  })

  it('setCursor inserts a baseline row when none exists yet (upsert)', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.setCursor(mailboxId, '111')

    const rows = await db.query<{ history_id: string | null }>(
      'SELECT history_id FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].history_id).toBe('111')
  })

  it('setCursor updates an existing row rather than colliding on the PK (upsert, not a plain insert)', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query('INSERT INTO gmail_watch_state (mailbox_id, history_id) VALUES ($1, $2)', [
      mailboxId,
      '111',
    ])

    await store.setCursor(mailboxId, '222')

    const rows = await db.query<{ history_id: string | null }>(
      'SELECT history_id FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(rows).toHaveLength(1) // still exactly one row for this mailbox
    expect(rows[0].history_id).toBe('222')
  })

  it('setCursor is safe to call twice in a row, always landing on the latest value', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.setCursor(mailboxId, '111')
    await store.setCursor(mailboxId, '222')

    expect(await store.getCursor(mailboxId)).toBe('222')
    const rows = await db.query('SELECT mailbox_id FROM gmail_watch_state WHERE mailbox_id = $1', [
      mailboxId,
    ])
    expect(rows).toHaveLength(1)
  })

  it('setCursor bumps updated_at', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query(
      "INSERT INTO gmail_watch_state (mailbox_id, history_id, updated_at) VALUES ($1, $2, now() - interval '1 hour')",
      [mailboxId, '111'],
    )
    const before = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )

    await store.setCursor(mailboxId, '222')

    const after = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime())
  })

  it('setCursor is per-mailbox — advancing one mailbox does not touch another', async () => {
    const { db, store } = await freshStore()
    const mailboxA = await insertMailbox(db, 'a@example.test')
    const mailboxB = await insertMailbox(db, 'b@example.test')
    await store.setCursor(mailboxA, 'a-1')
    await store.setCursor(mailboxB, 'b-1')

    await store.setCursor(mailboxA, 'a-2')

    expect(await store.getCursor(mailboxA)).toBe('a-2')
    expect(await store.getCursor(mailboxB)).toBe('b-1')
  })

  // --- seedBaseline (HT-40, gmail-connect.md §4 step 5) -----------------------

  describe('seedBaseline', () => {
    it('writes BOTH history_id and watch_expiration from a single call', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      const expiration = new Date('2026-08-01T00:00:00.000Z')

      await store.seedBaseline(mailboxId, { historyId: '555', watchExpiration: expiration })

      const rows = await db.query<{ history_id: string | null; watch_expiration: Date | null }>(
        'SELECT history_id, watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].history_id).toBe('555')
      expect(rows[0].watch_expiration?.toISOString()).toBe(expiration.toISOString())
    })

    it('getCursor reads back the seeded historyId', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)

      await store.seedBaseline(mailboxId, {
        historyId: '777',
        watchExpiration: new Date('2026-08-01T00:00:00.000Z'),
      })

      expect(await store.getCursor(mailboxId)).toBe('777')
    })

    it('a second call upserts over the existing row — one row, both columns rebaselined (reconnect)', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, {
        historyId: '111',
        watchExpiration: new Date('2026-08-01T00:00:00.000Z'),
      })

      const secondExpiration = new Date('2026-09-01T00:00:00.000Z')
      await store.seedBaseline(mailboxId, { historyId: '222', watchExpiration: secondExpiration })

      const rows = await db.query<{ history_id: string | null; watch_expiration: Date | null }>(
        'SELECT history_id, watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows).toHaveLength(1) // still exactly one row for this mailbox
      expect(rows[0].history_id).toBe('222')
      expect(rows[0].watch_expiration?.toISOString()).toBe(secondExpiration.toISOString())
    })

    it('seedBaseline over a row previously advanced by setCursor overwrites BOTH columns, not just history_id', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      // Simulate a cursor advanced by the reconcile handler (setCursor never
      // touches watch_expiration) before a reconnect re-seeds the baseline.
      await store.setCursor(mailboxId, '999')

      const expiration = new Date('2026-10-01T00:00:00.000Z')
      await store.seedBaseline(mailboxId, { historyId: '1000', watchExpiration: expiration })

      const rows = await db.query<{ history_id: string | null; watch_expiration: Date | null }>(
        'SELECT history_id, watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows[0].history_id).toBe('1000')
      expect(rows[0].watch_expiration?.toISOString()).toBe(expiration.toISOString())
    })

    it('bumps updated_at', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await db.query(
        "INSERT INTO gmail_watch_state (mailbox_id, history_id, updated_at) VALUES ($1, $2, now() - interval '1 hour')",
        [mailboxId, '111'],
      )
      const before = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )

      await store.seedBaseline(mailboxId, {
        historyId: '222',
        watchExpiration: new Date('2026-08-01T00:00:00.000Z'),
      })

      const after = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime())
    })

    it('is per-mailbox — seeding one mailbox does not touch another', async () => {
      const { db, store } = await freshStore()
      const mailboxA = await insertMailbox(db, 'seed-a@example.test')
      const mailboxB = await insertMailbox(db, 'seed-b@example.test')
      const expiration = new Date('2026-08-01T00:00:00.000Z')

      await store.seedBaseline(mailboxA, { historyId: 'a-baseline', watchExpiration: expiration })
      await store.seedBaseline(mailboxB, { historyId: 'b-baseline', watchExpiration: expiration })

      expect(await store.getCursor(mailboxA)).toBe('a-baseline')
      expect(await store.getCursor(mailboxB)).toBe('b-baseline')
    })
  })

  // --- setWatchExpiration (HT-42, gmail-push.md §6) ---------------------------

  describe('setWatchExpiration', () => {
    it('updates watch_expiration and PRESERVES the existing history_id — the sacred renewal rule', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, {
        historyId: 'baseline-cursor',
        watchExpiration: new Date('2026-01-01T00:00:00.000Z'),
      })

      const renewed = new Date('2026-01-08T00:00:00.000Z')
      await store.setWatchExpiration(mailboxId, renewed)

      const rows = await db.query<{ history_id: string | null; watch_expiration: Date | null }>(
        'SELECT history_id, watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].history_id).toBe('baseline-cursor')
      expect(rows[0].watch_expiration?.toISOString()).toBe(renewed.toISOString())
      expect(await store.getCursor(mailboxId)).toBe('baseline-cursor')
    })

    it('a second call updates the expiration again, still preserving history_id', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, {
        historyId: 'baseline-cursor-2',
        watchExpiration: new Date('2026-01-01T00:00:00.000Z'),
      })

      await store.setWatchExpiration(mailboxId, new Date('2026-01-08T00:00:00.000Z'))
      const secondRenewal = new Date('2026-01-15T00:00:00.000Z')
      await store.setWatchExpiration(mailboxId, secondRenewal)

      const rows = await db.query<{ history_id: string | null; watch_expiration: Date | null }>(
        'SELECT history_id, watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].history_id).toBe('baseline-cursor-2')
      expect(rows[0].watch_expiration?.toISOString()).toBe(secondRenewal.toISOString())
    })

    it('on a mailbox with no watch-state row yet, inserts a row with NULL history_id and the expiration', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      // No seedBaseline/setCursor call — no gmail_watch_state row exists yet.

      const expiration = new Date('2026-01-08T00:00:00.000Z')
      await store.setWatchExpiration(mailboxId, expiration)

      const rows = await db.query<{ history_id: string | null; watch_expiration: Date | null }>(
        'SELECT history_id, watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].history_id).toBeNull()
      expect(rows[0].watch_expiration?.toISOString()).toBe(expiration.toISOString())
      expect(await store.getCursor(mailboxId)).toBeNull()
    })

    it('bumps updated_at', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await db.query(
        "INSERT INTO gmail_watch_state (mailbox_id, history_id, updated_at) VALUES ($1, $2, now() - interval '1 hour')",
        [mailboxId, '111'],
      )
      const before = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )

      await store.setWatchExpiration(mailboxId, new Date('2026-01-08T00:00:00.000Z'))

      const after = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime())
    })

    it('is per-mailbox — updating one mailbox does not touch another', async () => {
      const { db, store } = await freshStore()
      const mailboxA = await insertMailbox(db, 'expire-a@example.test')
      const mailboxB = await insertMailbox(db, 'expire-b@example.test')
      const initialExpiration = new Date('2026-01-01T00:00:00.000Z')
      await store.seedBaseline(mailboxA, { historyId: 'a-1', watchExpiration: initialExpiration })
      await store.seedBaseline(mailboxB, { historyId: 'b-1', watchExpiration: initialExpiration })

      const renewedA = new Date('2026-01-08T00:00:00.000Z')
      await store.setWatchExpiration(mailboxA, renewedA)

      const rowsA = await db.query<{ watch_expiration: Date | null }>(
        'SELECT watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxA],
      )
      const rowsB = await db.query<{ watch_expiration: Date | null }>(
        'SELECT watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxB],
      )
      expect(rowsA[0].watch_expiration?.toISOString()).toBe(renewedA.toISOString())
      expect(rowsB[0].watch_expiration?.toISOString()).toBe(initialExpiration.toISOString())
      expect(await store.getCursor(mailboxB)).toBe('b-1')
    })
  })

  // --- claimReconcileLease / releaseReconcileLease (HT-48, gmail-push.md §6) ---

  /** Directly rewinds a mailbox's claimed_until into the past — mirrors conversations.test.ts's expireLease for the outbound lease, exercising expiry without a real sleep. */
  async function expireReconcileLease(db: Db, mailboxId: string) {
    await db.query(
      "UPDATE gmail_watch_state SET claimed_until = now() - interval '1 second' WHERE mailbox_id = $1",
      [mailboxId],
    )
  }

  describe('claimReconcileLease / releaseReconcileLease', () => {
    it('claims an unclaimed mailbox, setting claimed_until in the future', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.setCursor(mailboxId, 'cursor-1')

      const before = new Date()
      const claimed = await store.claimReconcileLease(mailboxId, 30_000)

      expect(claimed).toBe(true)
      const rows = await db.query<{ claimed_until: Date | null }>(
        'SELECT claimed_until FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows[0].claimed_until).not.toBeNull()
      expect((rows[0].claimed_until as Date).getTime()).toBeGreaterThan(before.getTime())
    })

    it('a second claim attempt while the lease is held returns false', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.setCursor(mailboxId, 'cursor-1')

      const first = await store.claimReconcileLease(mailboxId, 30_000)
      expect(first).toBe(true)

      const second = await store.claimReconcileLease(mailboxId, 30_000)
      expect(second).toBe(false)
    })

    it('claiming succeeds again once the previous lease has expired', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.setCursor(mailboxId, 'cursor-1')

      const first = await store.claimReconcileLease(mailboxId, 30_000)
      expect(first).toBe(true)
      await expireReconcileLease(db, mailboxId)

      const second = await store.claimReconcileLease(mailboxId, 30_000)
      expect(second).toBe(true)
    })

    it('different mailboxes claim independently — one holding its lease does not block another', async () => {
      const { db, store } = await freshStore()
      const mailboxA = await insertMailbox(db, 'lease-a@example.test')
      const mailboxB = await insertMailbox(db, 'lease-b@example.test')
      await store.setCursor(mailboxA, 'a-1')
      await store.setCursor(mailboxB, 'b-1')

      const claimedA = await store.claimReconcileLease(mailboxA, 30_000)
      const claimedB = await store.claimReconcileLease(mailboxB, 30_000)

      expect(claimedA).toBe(true)
      expect(claimedB).toBe(true)
    })

    it('returns false for a mailbox with no gmail_watch_state row at all', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      // No setCursor/seedBaseline call — no gmail_watch_state row exists yet.

      expect(await store.claimReconcileLease(mailboxId, 30_000)).toBe(false)
    })

    it('releaseReconcileLease clears claimed_until', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.setCursor(mailboxId, 'cursor-1')
      await store.claimReconcileLease(mailboxId, 30_000)

      await store.releaseReconcileLease(mailboxId)

      const rows = await db.query<{ claimed_until: Date | null }>(
        'SELECT claimed_until FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows[0].claimed_until).toBeNull()
    })

    it('releaseReconcileLease throws for a mailbox with no gmail_watch_state row', async () => {
      const { store } = await freshStore()
      await expect(
        store.releaseReconcileLease('00000000-0000-4000-8000-000000000000'),
      ).rejects.toThrow()
    })

    it('after release, the lease is immediately claimable again — no need to wait out leaseMs', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.setCursor(mailboxId, 'cursor-1')
      await store.claimReconcileLease(mailboxId, 10 * 60_000) // a long lease

      await store.releaseReconcileLease(mailboxId)

      // Reclaimable right away — release does not wait out the original
      // leaseMs, exactly like ConversationStore.releaseThreadLease.
      expect(await store.claimReconcileLease(mailboxId, 30_000)).toBe(true)
    })
  })
})
