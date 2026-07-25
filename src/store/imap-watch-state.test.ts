import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createImapWatchStateStore, type ImapWatchStateStore } from './imap-watch-state.js'

/** A well-formed uuid that is never a live lease token — the shape matters, the value must not match. */
const NOT_A_LIVE_LEASE = '00000000-0000-4000-8000-000000000000'

async function insertMailbox(db: Db, address = 'mailbox@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "INSERT INTO mailboxes (address, provider) VALUES ($1, 'imap') RETURNING id",
    [address],
  )
  return rows[0].id
}

/**
 * Wait until the wall clock advances to a new millisecond. PGlite's `now()` has
 * millisecond resolution and these in-memory ops finish in well under a
 * millisecond, so two back-to-back `claimFetchLease` calls can land on the SAME
 * `claimed_until` and therefore mint the SAME lease token. Production Postgres
 * has microsecond resolution AND serializes same-mailbox claims with real
 * network time between them, so distinct claims always get distinct tokens
 * there — crossing a real millisecond boundary makes the test reflect that.
 */
async function waitForClockTick(): Promise<void> {
  const start = Date.now()
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

describe('createImapWatchStateStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore() {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createImapWatchStateStore(db) }
  }

  it('getCursor returns null when no watch-state row exists yet', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    expect(await store.getCursor(mailboxId)).toBeNull()
  })

  it('getCursor returns null for a mailbox id that does not exist at all', async () => {
    const { store } = await freshStore()
    expect(await store.getCursor('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  // --- seedBaseline ---------------------------------------------------------

  describe('seedBaseline', () => {
    it('writes both uidValidity and lastUid, readable back via getCursor', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)

      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 42 })

      expect(await store.getCursor(mailboxId)).toEqual({ uidValidity: 1000, lastUid: 42 })
    })

    it('a second call upserts over the existing row — one row, both columns rebaselined (reconnect)', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 42 })

      await store.seedBaseline(mailboxId, { uidValidity: 2000, lastUid: 0 })

      expect(await store.getCursor(mailboxId)).toEqual({ uidValidity: 2000, lastUid: 0 })
      const rowCount = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rowCount[0].n).toBe(1)
    })

    it('is per-mailbox — seeding one mailbox does not touch another', async () => {
      const { db, store } = await freshStore()
      const mailboxA = await insertMailbox(db, 'a@example.test')
      const mailboxB = await insertMailbox(db, 'b@example.test')

      await store.seedBaseline(mailboxA, { uidValidity: 111, lastUid: 1 })
      await store.seedBaseline(mailboxB, { uidValidity: 222, lastUid: 2 })

      expect(await store.getCursor(mailboxA)).toEqual({ uidValidity: 111, lastUid: 1 })
      expect(await store.getCursor(mailboxB)).toEqual({ uidValidity: 222, lastUid: 2 })
    })

    it('round-trips large bigint-range values exactly (beyond 32-bit int range)', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      // Above signed-32-bit `integer` max (2_147_483_647) — proving the columns
      // must be `bigint` — but within the RFC 3501 unsigned-32-bit ceiling
      // (4_294_967_295) the migration's CHECK constraints enforce.
      const bigUidValidity = 4_000_000_000
      const bigLastUid = 4_294_967_295 // the RFC 3501 UID/UIDVALIDITY ceiling itself

      await store.seedBaseline(mailboxId, { uidValidity: bigUidValidity, lastUid: bigLastUid })

      expect(await store.getCursor(mailboxId)).toEqual({
        uidValidity: bigUidValidity,
        lastUid: bigLastUid,
      })
    })

    it('runs against a caller-supplied tx, committing atomically with it', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)

      await db.transaction(async (tx) => {
        await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 42 }, tx)
      })

      expect(await store.getCursor(mailboxId)).toEqual({ uidValidity: 1000, lastUid: 42 })
    })
  })

  // --- seedBaselineIfAbsent --------------------------------------------------

  describe('seedBaselineIfAbsent', () => {
    it('seeds a baseline when no cursor row exists yet', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)

      await store.seedBaselineIfAbsent(mailboxId, { uidValidity: 5, lastUid: 100 })

      expect(await store.getCursor(mailboxId)).toEqual({ uidValidity: 5, lastUid: 100 })
    })

    it('PRESERVES an existing cursor (DO NOTHING) — a reconnect never rewinds past un-ingested mail', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1, lastUid: 4 })

      // A reconnect tries to re-baseline to a later point — must be a no-op.
      await store.seedBaselineIfAbsent(mailboxId, { uidValidity: 1, lastUid: 29 })

      expect(await store.getCursor(mailboxId)).toEqual({ uidValidity: 1, lastUid: 4 })
    })
  })

  // --- setCursor -------------------------------------------------------------

  // HT-101 review fix (Codex adversarial pass, 2026-07-25): `setCursor` is
  // lease-fenced and is NO LONGER an upsert. It advances an existing row only
  // while the caller still holds the live lease — see the interface's SACRED
  // section for the reset-quarantine escape this closes.
  describe('setCursor', () => {
    /** Seed a baseline and claim its lease, returning the token `setCursor` requires. */
    async function seededWithLease(
      store: ImapWatchStateStore,
      mailboxId: string,
      cursor = { uidValidity: 1000, lastUid: 5 },
    ): Promise<string> {
      await store.seedBaseline(mailboxId, cursor)
      const token = await store.claimFetchLease(mailboxId, 60_000)
      if (token === null) {
        throw new Error('test setup: expected to win the fetch lease')
      }
      return token
    }

    it('advances an existing row rather than colliding on the PK, and reports true', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      const token = await seededWithLease(store, mailboxId)

      expect(await store.setCursor(mailboxId, { uidValidity: 1000, lastUid: 50 }, token)).toBe(true)

      expect(await store.getCursor(mailboxId)).toEqual({ uidValidity: 1000, lastUid: 50 })
      const rowCount = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rowCount[0].n).toBe(1)
    })

    it('REFUSES the write and reports false when the lease was superseded mid-ingest', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      const staleToken = await seededWithLease(store, mailboxId)

      // Run A's lease expires; run B reclaims it. A is still alive and is
      // about to write the cursor it computed under the old epoch.
      await db.query(
        "UPDATE imap_watch_state SET claimed_until = now() - interval '1 minute' WHERE mailbox_id = $1",
        [mailboxId],
      )
      const liveToken = await store.claimFetchLease(mailboxId, 60_000)
      expect(liveToken).not.toBeNull()
      expect(liveToken).not.toBe(staleToken)

      expect(await store.setCursor(mailboxId, { uidValidity: 7, lastUid: 150 }, staleToken)).toBe(
        false,
      )

      // The cursor is exactly where the live holder left it — unmoved by A.
      expect(await store.getCursor(mailboxId)).toEqual({ uidValidity: 1000, lastUid: 5 })
    })

    it('writes nothing and reports false when no cursor row exists — it is an UPDATE, not an upsert', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)

      expect(
        await store.setCursor(mailboxId, { uidValidity: 1000, lastUid: 5 }, NOT_A_LIVE_LEASE),
      ).toBe(false)

      expect(await store.getCursor(mailboxId)).toBeNull()
    })

    it('is per-mailbox — advancing one mailbox does not touch another', async () => {
      const { db, store } = await freshStore()
      const mailboxA = await insertMailbox(db, 'a2@example.test')
      const mailboxB = await insertMailbox(db, 'b2@example.test')
      const tokenA = await seededWithLease(store, mailboxA, { uidValidity: 1, lastUid: 1 })
      await store.seedBaseline(mailboxB, { uidValidity: 2, lastUid: 1 })

      expect(await store.setCursor(mailboxA, { uidValidity: 1, lastUid: 99 }, tokenA)).toBe(true)

      expect(await store.getCursor(mailboxA)).toEqual({ uidValidity: 1, lastUid: 99 })
      expect(await store.getCursor(mailboxB)).toEqual({ uidValidity: 2, lastUid: 1 })
    })

    it('bumps updated_at', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      const token = await seededWithLease(store, mailboxId, { uidValidity: 1, lastUid: 1 })
      await db.query(
        "UPDATE imap_watch_state SET updated_at = now() - interval '1 hour' WHERE mailbox_id = $1",
        [mailboxId],
      )
      const before = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )

      expect(await store.setCursor(mailboxId, { uidValidity: 1, lastUid: 2 }, token)).toBe(true)

      const after = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime())
    })
  })

  // --- claimFetchLease / releaseFetchLease (never-double-fetch guard) --------

  /** Directly rewinds a mailbox's claimed_until into the past — mirrors gmail-watch-state.test.ts's expireReconcileLease, exercising expiry without a real sleep. */
  async function expireFetchLease(db: Db, mailboxId: string) {
    await db.query(
      "UPDATE imap_watch_state SET claimed_until = now() - interval '1 second' WHERE mailbox_id = $1",
      [mailboxId],
    )
  }

  describe('claimFetchLease / releaseFetchLease', () => {
    it('claims an unclaimed mailbox, setting claimed_until in the future and returning the row lease_token', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 1 })

      const before = new Date()
      const token = await store.claimFetchLease(mailboxId, 30_000)

      expect(token).not.toBeNull()
      const rows = await db.query<{ claimed_until: Date | null; lease_token: string | null }>(
        'SELECT claimed_until, lease_token FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows[0].claimed_until).not.toBeNull()
      expect((rows[0].claimed_until as Date).getTime()).toBeGreaterThan(before.getTime())
      // The token is the row's own `lease_token` uuid, NOT a rendering of
      // `claimed_until` — see migration 027's doc for the tick-collision that
      // made a timestamp token unusable as a write fence.
      expect(rows[0].lease_token).toBe(token)
    })

    it('mints a DISTINCT token on every claim, even when two claims land in the same clock tick', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 1 })

      const first = await store.claimFetchLease(mailboxId, 30_000)
      // Expire it instantly so the next claim wins without any wall-clock
      // delay — the exact same-tick reclaim that collided when the token was
      // derived from `claimed_until`.
      await db.query(
        "UPDATE imap_watch_state SET claimed_until = now() - interval '1 minute' WHERE mailbox_id = $1",
        [mailboxId],
      )
      const second = await store.claimFetchLease(mailboxId, 30_000)

      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(second).not.toBe(first)
    })

    it('a second concurrent claim attempt while the lease is held returns null', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 1 })

      const first = await store.claimFetchLease(mailboxId, 30_000)
      expect(first).not.toBeNull()

      const second = await store.claimFetchLease(mailboxId, 30_000)
      expect(second).toBeNull()
    })

    it('rejects a non-positive or non-finite lease duration (a bad leaseMs would silently defeat the guard)', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1, lastUid: 1 })

      await expect(store.claimFetchLease(mailboxId, 0)).rejects.toThrow('positive integer')
      await expect(store.claimFetchLease(mailboxId, -5)).rejects.toThrow('positive integer')
      await expect(store.claimFetchLease(mailboxId, Number.NaN)).rejects.toThrow('positive integer')
    })

    it('claiming succeeds again once the previous lease has expired, returning a NEW token', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 1 })

      const first = await store.claimFetchLease(mailboxId, 30_000)
      expect(first).not.toBeNull()
      await expireFetchLease(db, mailboxId)
      await waitForClockTick()

      const second = await store.claimFetchLease(mailboxId, 30_000)
      expect(second).not.toBeNull()
      expect(second).not.toBe(first)
    })

    it('different mailboxes claim independently — one holding its lease does not block another', async () => {
      const { db, store } = await freshStore()
      const mailboxA = await insertMailbox(db, 'lease-a@example.test')
      const mailboxB = await insertMailbox(db, 'lease-b@example.test')
      await store.seedBaseline(mailboxA, { uidValidity: 1, lastUid: 1 })
      await store.seedBaseline(mailboxB, { uidValidity: 1, lastUid: 1 })

      const claimedA = await store.claimFetchLease(mailboxA, 30_000)
      const claimedB = await store.claimFetchLease(mailboxB, 30_000)

      expect(claimedA).not.toBeNull()
      expect(claimedB).not.toBeNull()
    })

    it('returns null for a mailbox with no imap_watch_state row at all', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      // No seedBaseline/setCursor call — no imap_watch_state row exists yet.

      expect(await store.claimFetchLease(mailboxId, 30_000)).toBeNull()
    })

    it('releaseFetchLease clears claimed_until when the token matches the current holder', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 1 })
      const token = await store.claimFetchLease(mailboxId, 30_000)

      await store.releaseFetchLease(mailboxId, token as string)

      const rows = await db.query<{ claimed_until: Date | null }>(
        'SELECT claimed_until FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows[0].claimed_until).toBeNull()
    })

    it('releaseFetchLease is a silent no-op (never throws) for a mailbox with no imap_watch_state row', async () => {
      const { store } = await freshStore()
      await expect(
        store.releaseFetchLease('00000000-0000-4000-8000-000000000000', NOT_A_LIVE_LEASE),
      ).resolves.toBeUndefined()
    })

    it("releaseFetchLease is a silent no-op when the token no longer matches — a stale holder cannot clobber a live successor's lease (the precision-safety property)", async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 1 })

      // Holder A claims, then (the scenario this guards against) overruns
      // its lease before ever calling release.
      const tokenA = await store.claimFetchLease(mailboxId, 30_000)
      expect(tokenA).not.toBeNull()
      await expireFetchLease(db, mailboxId)
      await waitForClockTick()

      // Holder B — a legitimate successor — claims the now-expired lease and
      // is actively working.
      const tokenB = await store.claimFetchLease(mailboxId, 30_000)
      expect(tokenB).not.toBeNull()
      expect(tokenB).not.toBe(tokenA)

      // A finally reaches its own (deliberately delayed) release, using ITS
      // stale token — must NOT free B's live lease.
      await store.releaseFetchLease(mailboxId, tokenA as string)

      const rows = await db.query<{ claimed_until: Date | null }>(
        'SELECT claimed_until FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows[0].claimed_until).not.toBeNull()
      // And a third claimant must still be blocked by B's live lease.
      expect(await store.claimFetchLease(mailboxId, 30_000)).toBeNull()
    })

    it('a wrong/stale token that never held the lease at all does NOT free a live lease', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 1 })
      await store.claimFetchLease(mailboxId, 30_000)

      // A syntactically valid but entirely fabricated token.
      await store.releaseFetchLease(mailboxId, NOT_A_LIVE_LEASE)

      const rows = await db.query<{ claimed_until: Date | null }>(
        'SELECT claimed_until FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      expect(rows[0].claimed_until).not.toBeNull()
    })

    it('after release, the lease is immediately claimable again — no need to wait out leaseMs', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db)
      await store.seedBaseline(mailboxId, { uidValidity: 1000, lastUid: 1 })
      const token = await store.claimFetchLease(mailboxId, 10 * 60_000) // a long lease

      await store.releaseFetchLease(mailboxId, token as string)

      expect(await store.claimFetchLease(mailboxId, 30_000)).not.toBeNull()
    })
  })
})
