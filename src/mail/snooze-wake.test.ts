import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { type ConversationStore, createConversationStore } from '../store/conversations.js'
import { runSnoozeWake } from './snooze-wake.js'

async function insertConversation(
  db: Db,
  overrides: { status?: string; snoozedUntil?: Date | null } = {},
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO conversations (customer_email, status, snoozed_until)
     VALUES ($1, $2, $3) RETURNING id`,
    [
      'customer@example.test',
      overrides.status ?? 'pending',
      overrides.snoozedUntil === undefined ? null : overrides.snoozedUntil,
    ],
  )
  return rows[0].id
}

describe('runSnoozeWake', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: ConversationStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createConversationStore(db) }
  }

  it('wakes a due snoozed pending conversation to active and clears snoozed_until', async () => {
    const { db, store } = await freshStore()
    const past = new Date(Date.now() - 60_000)
    const id = await insertConversation(db, { status: 'pending', snoozedUntil: past })

    const report = await runSnoozeWake({ store })
    expect(report).toEqual({ due: 1, woken: 1 })

    const conversation = await store.getConversation(id)
    expect(conversation?.status).toBe('active')
    expect(conversation?.snoozedUntil).toBeNull()
  })

  it('leaves a not-yet-due snoozed conversation alone', async () => {
    const { db, store } = await freshStore()
    const future = new Date(Date.now() + 60 * 60 * 1000)
    const id = await insertConversation(db, { status: 'pending', snoozedUntil: future })

    const report = await runSnoozeWake({ store })
    expect(report).toEqual({ due: 0, woken: 0 })

    const conversation = await store.getConversation(id)
    expect(conversation?.status).toBe('pending')
    expect(conversation?.snoozedUntil?.getTime()).toBe(future.getTime())
  })

  it('leaves a plain (non-snoozed) pending conversation alone', async () => {
    const { db, store } = await freshStore()
    const id = await insertConversation(db, { status: 'pending', snoozedUntil: null })

    const report = await runSnoozeWake({ store })
    expect(report).toEqual({ due: 0, woken: 0 })

    const conversation = await store.getConversation(id)
    expect(conversation?.status).toBe('pending')
  })

  it('emits EXACTLY ONE conversation.status_changed for the timer wake, transactionally — unlike the inbound wake, which fires conversation.message_received(reopened:true) instead (see ingest.test.ts)', async () => {
    const { db, store } = await freshStore()
    const past = new Date(Date.now() - 60_000)
    const id = await insertConversation(db, { status: 'pending', snoozedUntil: past })

    await runSnoozeWake({ store })

    const events = await db.query<{ type: string; conversation_id: string; data: unknown }>(
      'SELECT type, conversation_id, data FROM event_outbox WHERE conversation_id = $1',
      [id],
    )
    // The array-equality (not a `.filter(...)` count) is what proves BOTH
    // halves at once: exactly one event total, AND it is status_changed —
    // never status_changed alongside some other stray event, and never
    // message_received (that field belongs to the inbound-wake path only).
    expect(events).toEqual([
      {
        type: 'conversation.status_changed',
        conversation_id: id,
        data: { from: 'pending', to: 'active' },
      },
    ])
  })

  it('does not force-reopen a conversation an Agent concurrently moved off pending (requireStatus guard)', async () => {
    const { db, store } = await freshStore()
    const past = new Date(Date.now() - 60_000)
    const id = await insertConversation(db, { status: 'pending', snoozedUntil: past })

    // Simulate the exact race the wake pass's `requireStatus` guard exists
    // for: `listDueSnoozed` already read `id` as due (this happened before
    // the line below runs, in the real pass), but by the time the guarded
    // write actually runs, an Agent has independently moved the conversation
    // off `pending` — here, via the SAME store method a PATCH would use, so
    // snoozed_until clears correctly too.
    await store.setConversationStatus(id, 'closed')

    const updated = await store.setConversationStatus(id, 'active', { requireStatus: 'pending' })
    expect(updated).toBeNull()

    const conversation = await store.getConversation(id)
    expect(conversation?.status).toBe('closed')
  })

  it('processes multiple due conversations, oldest-due first, up to batchSize', async () => {
    const { db, store } = await freshStore()
    const older = await insertConversation(db, {
      status: 'pending',
      snoozedUntil: new Date(Date.now() - 120_000),
    })
    const newer = await insertConversation(db, {
      status: 'pending',
      snoozedUntil: new Date(Date.now() - 60_000),
    })

    const report = await runSnoozeWake({ store }, { batchSize: 1 })
    expect(report).toEqual({ due: 1, woken: 1 })

    const olderRow = await store.getConversation(older)
    const newerRow = await store.getConversation(newer)
    expect(olderRow?.status).toBe('active')
    expect(newerRow?.status).toBe('pending')
  })
})
