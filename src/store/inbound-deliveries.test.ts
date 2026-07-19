import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createConversationStore } from './conversations.js'
import {
  createInboundDeliveryStore,
  type InboundDeliveryStore,
  LeaseLostError,
  markStoredInTx,
} from './inbound-deliveries.js'

// --- fixtures ----------------------------------------------------------------

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

/** A representative lease duration for these tests — the exact value is never asserted on, only "still held" vs. "expired" (via {@link expireLease}). */
const LEASE_MS = 30_000

/** Insert a `mailboxes` row directly — `inbound_deliveries.mailbox_id` is a real FK, and creating mailboxes is not this ticket's concern. */
async function createMailbox(db: Db, address = 'support@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "INSERT INTO mailboxes (address, provider) VALUES ($1, 'gmail') RETURNING id",
    [address],
  )
  return rows[0].id
}

/** Directly rewinds a delivery's claimed_until into the past — for exercising lease-expiry (HT-45) without a real sleep, mirroring `conversations.test.ts`'s identical `expireLease` helper for `threads.claimed_until`. */
async function expireLease(db: Db, deliveryId: string): Promise<void> {
  await db.query(
    "UPDATE inbound_deliveries SET claimed_until = now() - interval '1 second' WHERE id = $1",
    [deliveryId],
  )
}

// --- suite ---------------------------------------------------------------------

describe('createInboundDeliveryStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: InboundDeliveryStore; mailboxId: string }> {
    db = await createPgliteDb()
    await migrate(db)
    const mailboxId = await createMailbox(db)
    return { db, store: createInboundDeliveryStore(db), mailboxId }
  }

  it('claim on a fresh key inserts a received row and returns claimed: true', async () => {
    const { store, mailboxId } = await freshStore()

    const result = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(result.claimed).toBe(true)
    expect(result.delivery).toMatchObject({
      mailboxId,
      providerMessageId: 'provider-msg-1',
      status: 'received',
      attempts: 0,
      lastError: null,
      threadId: null,
    })
    expect(result.delivery.id).toEqual(expect.any(String))
    expect(result.delivery.claimedUntil).toBeInstanceOf(Date)
    expect(result.delivery.createdAt).toBeInstanceOf(Date)
    expect(result.delivery.updatedAt).toBeInstanceOf(Date)
  })

  it('claim on the SAME key twice, within the lease, returns claimed: false with the first row, unmodified', async () => {
    const { store, mailboxId } = await freshStore()

    const first = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    const second = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
    expect(second.delivery.id).toBe(first.delivery.id)
    expect(second.delivery.status).toBe('received')
  })

  it('the SAME providerMessageId on a DIFFERENT mailbox is an independent row (the unique key is the pair)', async () => {
    const { db, store, mailboxId: mailboxA } = await freshStore()
    const mailboxB = await createMailbox(db, 'other@example.test')

    const a = await store.claim(mailboxA, 'provider-msg-1', LEASE_MS)
    const b = await store.claim(mailboxB, 'provider-msg-1', LEASE_MS)

    expect(a.claimed).toBe(true)
    expect(b.claimed).toBe(true)
    expect(a.delivery.id).not.toBe(b.delivery.id)
  })

  it('two concurrent claims on the SAME fresh key resolve to exactly one claimed: true', async () => {
    const { store, mailboxId } = await freshStore()

    const [a, b] = await Promise.all([
      store.claim(mailboxId, 'provider-msg-1', LEASE_MS),
      store.claim(mailboxId, 'provider-msg-1', LEASE_MS),
    ])

    expect([a.claimed, b.claimed].sort()).toEqual([false, true])
    expect(a.delivery.id).toBe(b.delivery.id)
  })

  it('markSuppressed sets status suppressed and stores the reason in lastError', async () => {
    const { store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    const updated = await store.markSuppressed(delivery.id, 'own-message-loop', delivery.attempts)

    expect(updated).toMatchObject({
      id: delivery.id,
      status: 'suppressed',
      lastError: 'own-message-loop',
      attempts: 0,
      threadId: null,
    })
  })

  it('markFailed sets status failed, increments attempts, and records the error', async () => {
    const { store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    const updated = await store.markFailed(delivery.id, 'parse: boom', delivery.attempts)

    expect(updated).toMatchObject({
      id: delivery.id,
      status: 'failed',
      lastError: 'parse: boom',
      attempts: 1,
    })
  })

  it('markDeadLetter sets status dead-letter and increments attempts', async () => {
    const { store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    const updated = await store.markDeadLetter(
      delivery.id,
      'store: still broken',
      delivery.attempts,
    )

    expect(updated).toMatchObject({
      id: delivery.id,
      status: 'dead-letter',
      lastError: 'store: still broken',
      attempts: 1,
    })
  })

  it('every mark* method throws for an unknown id', async () => {
    const { store } = await freshStore()
    await expect(store.markSuppressed(RANDOM_UUID, 'x', 0)).rejects.toThrow(/no delivery with id/)
    await expect(store.markFailed(RANDOM_UUID, 'x', 0)).rejects.toThrow(/no delivery with id/)
    await expect(store.markDeadLetter(RANDOM_UUID, 'x', 0)).rejects.toThrow(/no delivery with id/)
  })

  // --- HT-45 review fix: the `attempts` fence (must-fix). -------------------

  it('a mark* write whose claimed-attempts fence no longer matches throws LeaseLostError, and does NOT touch the row', async () => {
    const { db, store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    // Simulate a concurrent reclaim having moved the row's generation on
    // (e.g. a received-lease reclaim bumped attempts) — this stale caller's
    // captured fence (0) is no longer current.
    await store.markFailed(delivery.id, 'boom', delivery.attempts)

    await expect(
      store.markSuppressed(delivery.id, 'own-message-loop', delivery.attempts),
    ).rejects.toThrow(LeaseLostError)

    // The row was NOT overwritten by the stale write — read it directly
    // rather than via `claim()`, which would itself reclaim the 'failed' row.
    const row = await db.query<{ status: string }>(
      'SELECT status FROM inbound_deliveries WHERE id = $1',
      [delivery.id],
    )
    expect(row[0].status).toBe('failed')
  })

  it('a stale owner cannot commit markStoredInTx after another worker reclaimed its lapsed lease (the must-fix scenario)', async () => {
    const { db, store, mailboxId } = await freshStore()
    const first = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    await expireLease(db, first.delivery.id)

    // Worker B reclaims the lapsed lease — a NEW claim generation, attempts
    // bumped 0 -> 1.
    const reclaimed = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    expect(reclaimed.claimed).toBe(true)
    expect(reclaimed.delivery.attempts).toBe(1)

    // Worker A — the original, stale owner — was slow but alive, and only
    // now finishes and tries to commit using the fence IT captured at ITS
    // OWN claim time (attempts: 0), unaware it was ever reclaimed. This is
    // the exact "two live owners, two commits" scenario the fence exists to
    // prevent (module doc's "The fence" section).
    const { threadId } = await createConversationStore(db).createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<cust-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
    await expect(
      db.transaction((tx) =>
        markStoredInTx(tx, first.delivery.id, threadId, first.delivery.attempts, 0),
      ),
    ).rejects.toThrow(LeaseLostError)

    // B's claim is untouched: still 'received', still holding attempts: 1 —
    // A's stale write did not overwrite it, and no duplicate conversation
    // was left behind (Db.transaction rolled the whole attempt back).
    const row = await db.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM inbound_deliveries WHERE id = $1',
      [first.delivery.id],
    )
    expect(row[0]).toMatchObject({ status: 'received', attempts: 1 })
  })

  it('claim on a FAILED row reclaims it: flips back to received, claimed: true', async () => {
    const { store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    await store.markFailed(delivery.id, 'parse: boom', delivery.attempts)

    const retryClaim = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(retryClaim.claimed).toBe(true)
    expect(retryClaim.delivery.id).toBe(delivery.id)
    expect(retryClaim.delivery.status).toBe('received')
    // attempts is a monotonic count of failures — the reclaim itself does
    // not reset or bump it.
    expect(retryClaim.delivery.attempts).toBe(1)
  })

  it('claim on a SUPPRESSED row does NOT reclaim it — claimed: false, status unchanged', async () => {
    const { store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    await store.markSuppressed(delivery.id, 'own-message-loop', delivery.attempts)

    const replay = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(replay.claimed).toBe(false)
    expect(replay.delivery.status).toBe('suppressed')
  })

  it('claim on a DEAD-LETTER row does NOT reclaim it — claimed: false, status unchanged', async () => {
    const { store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    await store.markDeadLetter(delivery.id, 'store: still broken', delivery.attempts)

    const replay = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(replay.claimed).toBe(false)
    expect(replay.delivery.status).toBe('dead-letter')
  })

  it('claim on a RECEIVED row whose lease is still held does NOT reclaim it — claimed: false, status unchanged', async () => {
    const { store, mailboxId } = await freshStore()
    // Fresh claim leaves the row 'received' with a live lease — simulating
    // "another worker's claim is still in flight" (nothing has marked it
    // yet, and the lease has not lapsed).
    await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    const concurrent = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(concurrent.claimed).toBe(false)
    expect(concurrent.delivery.status).toBe('received')
  })

  // --- HT-45: the crash-recovery gap this ticket closes. --------------------

  it('claim reclaims a RECEIVED row whose lease has EXPIRED — simulating a crash between claim() and the step-5 store/markFailed', async () => {
    const { db, store, mailboxId } = await freshStore()
    const first = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    // Nothing ever marked this row — as if the process crashed right after
    // the claim committed. Rewind the lease into the past to simulate time
    // having passed without a real sleep.
    await expireLease(db, first.delivery.id)

    const reclaimed = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(reclaimed.claimed).toBe(true)
    expect(reclaimed.delivery.id).toBe(first.delivery.id)
    expect(reclaimed.delivery.status).toBe('received')
    // Unlike the failed-row reclaim above, a received-lease reclaim DOES bump
    // attempts (HT-45 review fix): a lapsed lease is itself evidence of an
    // abandoned attempt, and the new value becomes the next owner's fence
    // (module doc's "The fence" section) — see the ingest-level dead-letter
    // test in src/mail/ingest.test.ts for why this must count toward the
    // retry budget.
    expect(reclaimed.delivery.attempts).toBe(1)
    expect(reclaimed.delivery.claimedUntil).not.toEqual(first.delivery.claimedUntil)
  })

  it('a pre-existing RECEIVED row with no recorded lease (claimed_until IS NULL) is immediately reclaimable', async () => {
    const { db, store, mailboxId } = await freshStore()
    const first = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    // Simulate a row stranded before migration 014 shipped: no lease was
    // ever recorded for it.
    await db.query('UPDATE inbound_deliveries SET claimed_until = NULL WHERE id = $1', [
      first.delivery.id,
    ])

    const reclaimed = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(reclaimed.claimed).toBe(true)
    expect(reclaimed.delivery.id).toBe(first.delivery.id)
  })

  it('two concurrent reclaim attempts on a lease-expired RECEIVED row resolve to exactly one claimed: true', async () => {
    const { db, store, mailboxId } = await freshStore()
    const first = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    await expireLease(db, first.delivery.id)

    const [a, b] = await Promise.all([
      store.claim(mailboxId, 'provider-msg-1', LEASE_MS),
      store.claim(mailboxId, 'provider-msg-1', LEASE_MS),
    ])

    expect([a.claimed, b.claimed].sort()).toEqual([false, true])
    expect(a.delivery.id).toBe(first.delivery.id)
    expect(b.delivery.id).toBe(first.delivery.id)
  })

  it('claim on a STORED row does NOT reclaim it, even with an expired lease — terminal rows are never reclaimed', async () => {
    const { db, store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    const { threadId } = await createConversationStore(db).createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<cust-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
    await db.transaction(async (tx) =>
      markStoredInTx(tx, delivery.id, threadId, delivery.attempts, 0),
    )
    await expireLease(db, delivery.id)

    const replay = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(replay.claimed).toBe(false)
    expect(replay.delivery.status).toBe('stored')
  })

  it('markStoredInTx (run inside a transaction) sets status stored and records threadId', async () => {
    const { db, store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    // thread_id is a real FK (`threads(id)`) — a genuine conversation/thread
    // must exist first; which store produced it is irrelevant to this test.
    const { threadId } = await createConversationStore(db).createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<cust-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })

    // markStoredInTx itself never opens a transaction (see its doc comment) —
    // the caller (src/mail/ingest.ts, in real use) supplies one; here a
    // single-statement transaction is enough to prove the SQL is correct.
    // forgedTokenCount: 2 proves the migration-019 column round-trips, not
    // just the DEFAULT 0.
    await db.transaction(async (tx) => {
      const updated = await markStoredInTx(tx, delivery.id, threadId, delivery.attempts, 2)
      expect(updated).toMatchObject({
        id: delivery.id,
        status: 'stored',
        threadId,
        forgedTokenCount: 2,
      })
    })

    // claim() replay after a commit confirms it persisted.
    const replay = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    expect(replay).toMatchObject({
      claimed: false,
      delivery: { status: 'stored', threadId, forgedTokenCount: 2 },
    })
  })

  it('markStoredInTx throws for an unknown id', async () => {
    const { db } = await freshStore()
    await expect(
      db.transaction(async (tx) => markStoredInTx(tx, RANDOM_UUID, RANDOM_UUID, 0, 0)),
    ).rejects.toThrow(/no delivery with id/)
  })

  // --- HT-49 review fix: preSuppressOwnSend --------------------------------

  it('preSuppressOwnSend on a fresh key creates an already-suppressed row that claim() then reports as terminal, never re-ingesting it', async () => {
    const { store, mailboxId } = await freshStore()

    await store.preSuppressOwnSend(mailboxId, 'gmail-self-echo-1', 'own-outbound-self-echo')

    const result = await store.claim(mailboxId, 'gmail-self-echo-1', LEASE_MS)

    expect(result.claimed).toBe(false)
    expect(result.delivery).toMatchObject({
      mailboxId,
      providerMessageId: 'gmail-self-echo-1',
      status: 'suppressed',
      lastError: 'own-outbound-self-echo',
    })
  })

  it('preSuppressOwnSend never overwrites a row a genuine claim() already won (the race is conceded, not corrected)', async () => {
    const { store, mailboxId } = await freshStore()

    // A genuine concurrent ingest claims this key FIRST...
    const claimed = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    expect(claimed.claimed).toBe(true)

    // ...then the self-echo guard loses the race and tries to pre-seed the
    // SAME key as suppressed.
    await store.preSuppressOwnSend(mailboxId, 'provider-msg-1', 'own-outbound-self-echo')

    // The already-`received` row is untouched — never silently flipped.
    const replay = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    expect(replay).toMatchObject({ claimed: false, delivery: { status: 'received' } })
  })

  it('preSuppressOwnSend is a silent no-op when the key is already suppressed', async () => {
    const { store, mailboxId } = await freshStore()

    await store.preSuppressOwnSend(mailboxId, 'provider-msg-1', 'own-outbound-self-echo')
    await store.preSuppressOwnSend(mailboxId, 'provider-msg-1', 'own-outbound-self-echo')

    const result = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    expect(result).toMatchObject({ claimed: false, delivery: { status: 'suppressed' } })
  })
})
