import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createConversationStore } from './conversations.js'
import {
  createInboundDeliveryStore,
  type InboundDeliveryStore,
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

    const updated = await store.markSuppressed(delivery.id, 'own-message-loop')

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

    const updated = await store.markFailed(delivery.id, 'parse: boom')

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

    const updated = await store.markDeadLetter(delivery.id, 'store: still broken')

    expect(updated).toMatchObject({
      id: delivery.id,
      status: 'dead-letter',
      lastError: 'store: still broken',
      attempts: 1,
    })
  })

  it('every mark* method throws for an unknown id', async () => {
    const { store } = await freshStore()
    await expect(store.markSuppressed(RANDOM_UUID, 'x')).rejects.toThrow(/no delivery with id/)
    await expect(store.markFailed(RANDOM_UUID, 'x')).rejects.toThrow(/no delivery with id/)
    await expect(store.markDeadLetter(RANDOM_UUID, 'x')).rejects.toThrow(/no delivery with id/)
  })

  it('claim on a FAILED row reclaims it: flips back to received, claimed: true', async () => {
    const { store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    await store.markFailed(delivery.id, 'parse: boom')

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
    await store.markSuppressed(delivery.id, 'own-message-loop')

    const replay = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)

    expect(replay.claimed).toBe(false)
    expect(replay.delivery.status).toBe('suppressed')
  })

  it('claim on a DEAD-LETTER row does NOT reclaim it — claimed: false, status unchanged', async () => {
    const { store, mailboxId } = await freshStore()
    const { delivery } = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    await store.markDeadLetter(delivery.id, 'store: still broken')

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
    // The reclaim itself is not a failure — attempts is untouched, same as
    // the failed-row reclaim's contract above.
    expect(reclaimed.delivery.attempts).toBe(0)
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
    await db.transaction(async (tx) => markStoredInTx(tx, delivery.id, threadId))
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
    await db.transaction(async (tx) => {
      const updated = await markStoredInTx(tx, delivery.id, threadId)
      expect(updated).toMatchObject({ id: delivery.id, status: 'stored', threadId })
    })

    // claim() replay after a commit confirms it persisted.
    const replay = await store.claim(mailboxId, 'provider-msg-1', LEASE_MS)
    expect(replay).toMatchObject({
      claimed: false,
      delivery: { status: 'stored', threadId },
    })
  })

  it('markStoredInTx throws for an unknown id', async () => {
    const { db } = await freshStore()
    await expect(
      db.transaction(async (tx) => markStoredInTx(tx, RANDOM_UUID, RANDOM_UUID)),
    ).rejects.toThrow(/no delivery with id/)
  })
})
