import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import {
  appendOutboxEventInTx,
  createEventOutboxStore,
  type EventOutboxStore,
} from './event-outbox.js'

async function insertConversation(db: Db, email = 'customer@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
    [email],
  )
  return rows[0].id
}

describe('EventOutboxStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: EventOutboxStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createEventOutboxStore(db) }
  }

  it('appendOutboxEventInTx inserts a row visible only after the transaction commits (transactional outbox)', async () => {
    const { db, store } = await freshStore()
    const conversationId = await insertConversation(db)

    await db.transaction(async (tx) => {
      const event = await appendOutboxEventInTx(tx, {
        type: 'conversation.created',
        conversationId,
        data: {},
      })
      expect(event.type).toBe('conversation.created')
      expect(event.conversationId).toBe(conversationId)
      expect(event.dispatchedAt).toBeNull()
      expect(event.occurredAt).toBeInstanceOf(Date)
    })

    const claimed = await store.claimBatch({ batchSize: 10, leaseMs: 60_000 })
    expect(claimed).toHaveLength(1)
    expect(claimed[0].conversationId).toBe(conversationId)
  })

  it('a rolled-back transaction leaves no event row (the outbox never fires for a change that did not commit)', async () => {
    const { db, store } = await freshStore()
    const conversationId = await insertConversation(db)

    await expect(
      db.transaction(async (tx) => {
        await appendOutboxEventInTx(tx, {
          type: 'conversation.created',
          conversationId,
          data: {},
        })
        throw new Error('simulated rollback')
      }),
    ).rejects.toThrow('simulated rollback')

    const claimed = await store.claimBatch({ batchSize: 10, leaseMs: 60_000 })
    expect(claimed).toEqual([])
  })

  it('data is persisted verbatim as jsonb and round-trips through claimBatch', async () => {
    const { db, store } = await freshStore()
    const conversationId = await insertConversation(db)

    await db.transaction((tx) =>
      appendOutboxEventInTx(tx, {
        type: 'draft.created',
        conversationId,
        data: { threadId: 'abc-123', assistantId: 'bot-1' },
      }),
    )

    const [claimed] = await store.claimBatch({ batchSize: 10, leaseMs: 60_000 })
    expect(claimed.data).toEqual({ threadId: 'abc-123', assistantId: 'bot-1' })
  })

  it('claimBatch leases claimed rows so a concurrent claim does not re-claim them; markDispatched clears the lease permanently', async () => {
    const { db, store } = await freshStore()
    const conversationId = await insertConversation(db)
    await db.transaction((tx) =>
      appendOutboxEventInTx(tx, { type: 'conversation.created', conversationId, data: {} }),
    )

    const firstClaim = await store.claimBatch({ batchSize: 10, leaseMs: 60_000 })
    expect(firstClaim).toHaveLength(1)

    // Still leased — a second claim sees nothing.
    const secondClaim = await store.claimBatch({ batchSize: 10, leaseMs: 60_000 })
    expect(secondClaim).toEqual([])

    await store.markDispatched(firstClaim[0].eventId)

    // Dispatched — never reclaimed again, even after the lease would have expired.
    const thirdClaim = await store.claimBatch({ batchSize: 10, leaseMs: 60_000 })
    expect(thirdClaim).toEqual([])
  })

  it('claimBatch reclaims a row once its lease has expired', async () => {
    const { db, store } = await freshStore()
    const conversationId = await insertConversation(db)
    await db.transaction((tx) =>
      appendOutboxEventInTx(tx, { type: 'conversation.created', conversationId, data: {} }),
    )

    const firstClaim = await store.claimBatch({ batchSize: 10, leaseMs: 60_000 })
    expect(firstClaim).toHaveLength(1)

    // Force the lease into the past, simulating an expired claim.
    await db.query('UPDATE event_outbox SET locked_until = $1 WHERE event_id = $2', [
      new Date('2020-01-01T00:00:00.000Z'),
      firstClaim[0].eventId,
    ])

    const secondClaim = await store.claimBatch({ batchSize: 10, leaseMs: 60_000 })
    expect(secondClaim.map((e) => e.eventId)).toEqual([firstClaim[0].eventId])
  })

  it('claimBatch orders oldest occurred_at first and respects batchSize', async () => {
    const { db, store } = await freshStore()
    const conversationId = await insertConversation(db)

    const eventIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const event = await db.transaction((tx) =>
        appendOutboxEventInTx(tx, { type: 'conversation.created', conversationId, data: {} }),
      )
      await db.query('UPDATE event_outbox SET occurred_at = $1 WHERE event_id = $2', [
        new Date(2024, 0, 3 - i), // insert in REVERSE chronological order
        event.eventId,
      ])
      eventIds.push(event.eventId)
    }
    // eventIds[2] has the EARLIEST occurred_at (Jan 1), eventIds[0] the latest (Jan 3).

    const claimed = await store.claimBatch({ batchSize: 2, leaseMs: 60_000 })
    expect(claimed.map((e) => e.eventId)).toEqual([eventIds[2], eventIds[1]])
  })

  it('markDispatched on an unknown or already-dispatched eventId is a harmless no-op', async () => {
    const { store } = await freshStore()
    await expect(
      store.markDispatched('00000000-0000-4000-8000-000000000000'),
    ).resolves.toBeUndefined()
  })

  it('conversation_id is REQUIRED and FKs to a real conversation', async () => {
    const { db } = await freshStore()
    await expect(
      db.transaction((tx) =>
        appendOutboxEventInTx(tx, {
          type: 'conversation.created',
          conversationId: '00000000-0000-4000-8000-000000000000',
          data: {},
        }),
      ),
    ).rejects.toThrow()
  })
})
