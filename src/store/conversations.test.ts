import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createConversationStore, type NewConversation, type NewThread } from './conversations.js'

// --- fixtures ----------------------------------------------------------------

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

function newConversation(overrides: Partial<NewConversation> = {}): NewConversation {
  return {
    subject: 'Help with my order',
    customerEmail: 'customer@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<inbound-1@customer.example.test>',
      fromAddress: 'customer@example.test',
      bodyText: 'Where is my order?',
    },
    ...overrides,
  }
}

function newThread(overrides: Partial<NewThread> = {}): NewThread {
  return {
    direction: 'outbound',
    messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
    fromAddress: 'support@example.test',
    bodyText: 'Looking into it!',
    ...overrides,
  }
}

/** Directly flips a conversation's status for test setup — see the task's own note that this is fine for tests. */
async function setStatus(db: Db, conversationId: string, status: 'open' | 'closed' | 'deleted') {
  await db.query('UPDATE conversations SET status = $1 WHERE id = $2', [status, conversationId])
}

/**
 * Directly sets a conversation's `updated_at` for test setup — `now()`
 * resolution inside a single fast test run can tie multiple rows to the
 * same instant, which would make ordering assertions flaky without an
 * explicit, controlled timestamp per row.
 */
async function setUpdatedAt(db: Db, conversationId: string, updatedAt: Date) {
  await db.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [
    updatedAt,
    conversationId,
  ])
}

// --- suite ---------------------------------------------------------------------

describe('createConversationStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore() {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createConversationStore(db) }
  }

  it('createConversation → getConversation returns the conversation with exactly its first thread', async () => {
    const { store } = await freshStore()

    const { conversationId, threadId } = await store.createConversation(newConversation())
    const conversation = await store.getConversation(conversationId)

    expect(conversation).not.toBeNull()
    expect(conversation?.id).toBe(conversationId)
    expect(conversation?.subject).toBe('Help with my order')
    expect(conversation?.customerEmail).toBe('customer@example.test')
    expect(conversation?.status).toBe('open')
    expect(conversation?.createdAt).toBeInstanceOf(Date)
    expect(conversation?.updatedAt).toBeInstanceOf(Date)
    expect(conversation?.threads).toHaveLength(1)
    expect(conversation?.threads[0]).toMatchObject({
      id: threadId,
      conversationId,
      direction: 'inbound',
      messageId: '<inbound-1@customer.example.test>',
      fromAddress: 'customer@example.test',
      bodyText: 'Where is my order?',
    })
    expect(conversation?.threads[0].createdAt).toBeInstanceOf(Date)
  })

  it('getConversation returns null for a conversation that does not exist', async () => {
    const { store } = await freshStore()
    expect(await store.getConversation(RANDOM_UUID)).toBeNull()
  })

  it('appendThread to an OPEN conversation succeeds; getConversation shows 2 threads in created order', async () => {
    const { store } = await freshStore()
    const { conversationId } = await store.createConversation(newConversation())

    const result = await store.appendThread(
      conversationId,
      newThread({ messageId: '<outbound-1@mail.example.test>' }),
    )
    expect(result).toEqual({ ok: true, threadId: expect.any(String) })

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.threads).toHaveLength(2)
    expect(conversation?.threads[0].direction).toBe('inbound')
    expect(conversation?.threads[1].direction).toBe('outbound')
    expect(conversation?.threads[1].messageId).toBe('<outbound-1@mail.example.test>')
    expect(conversation?.status).toBe('open')
  })

  it('optional thread fields: omitted values are stored as null; provided values are preserved', async () => {
    const { store } = await freshStore()
    const { conversationId, threadId } = await store.createConversation(
      newConversation({
        firstMessage: {
          direction: 'inbound',
          messageId: null,
          fromAddress: 'customer@example.test',
          // bodyText/bodyHtml/inReplyTo all omitted.
        },
      }),
    )

    const appended = await store.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
      inReplyTo: '<inbound-1@customer.example.test>',
      fromAddress: 'support@example.test',
      bodyHtml: '<p>hi</p>',
      // bodyText omitted.
    })
    expect(appended.ok).toBe(true)

    const conversation = await store.getConversation(conversationId)
    const first = conversation?.threads.find((t) => t.id === threadId)
    expect(first).toMatchObject({
      messageId: null,
      inReplyTo: null,
      bodyText: null,
      bodyHtml: null,
    })

    const second = conversation?.threads.find(
      (t) => t.id === (appended as { threadId: string }).threadId,
    )
    expect(second).toMatchObject({
      inReplyTo: '<inbound-1@customer.example.test>',
      bodyText: null,
      bodyHtml: '<p>hi</p>',
    })
  })

  it('appendThread to a CLOSED conversation succeeds AND reopens it', async () => {
    const { db, store } = await freshStore()
    const { conversationId } = await store.createConversation(newConversation())
    await setStatus(db, conversationId, 'closed')

    const result = await store.appendThread(conversationId, newThread())
    expect(result.ok).toBe(true)

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.status).toBe('open')
    expect(conversation?.threads).toHaveLength(2)
  })

  it('appendThread to a DELETED conversation is rejected and inserts nothing', async () => {
    const { db, store } = await freshStore()
    const { conversationId } = await store.createConversation(newConversation())
    await setStatus(db, conversationId, 'deleted')

    const result = await store.appendThread(conversationId, newThread())
    expect(result).toEqual({ ok: false, reason: 'deleted' })

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.status).toBe('deleted')
    expect(conversation?.threads).toHaveLength(1)
  })

  it('appendThread to a MISSING conversation returns not-found', async () => {
    const { store } = await freshStore()
    const result = await store.appendThread(RANDOM_UUID, newThread())
    expect(result).toEqual({ ok: false, reason: 'not-found' })
  })

  it('createConversation is atomic: a first-thread CHECK violation leaves zero conversation rows', async () => {
    const { db, store } = await freshStore()

    const bad = newConversation({
      firstMessage: {
        // Deliberately bad: bypasses the type system to exercise the
        // database's CHECK constraint, the same way a bug elsewhere in the
        // codebase might slip an invalid value past compile-time typing.
        ...newThread(),
        direction: 'sideways',
      } as unknown as NewThread,
    })

    await expect(store.createConversation(bad)).rejects.toThrow()

    const rows = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM conversations',
    )
    expect(rows[0].count).toBe(0)
  })

  it('stores and reads back SQL-metacharacter values literally; tables survive (proves parameterization)', async () => {
    const { db, store } = await freshStore()
    const evil = "'); DROP TABLE conversations;--"

    const { conversationId } = await store.createConversation(
      newConversation({
        customerEmail: evil,
        firstMessage: newThread({ direction: 'inbound', fromAddress: evil }),
      }),
    )

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.customerEmail).toBe(evil)
    expect(conversation?.threads[0].fromAddress).toBe(evil)

    // If the value had been interpolated instead of parameterized, this
    // table would no longer exist.
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'conversations'`,
    )
    expect(tables).toHaveLength(1)
  })

  it('setThreadDeliveryStatus flips an outbound thread from pending to sent', async () => {
    const { store } = await freshStore()
    const { conversationId } = await store.createConversation(newConversation())
    const appended = await store.appendThread(conversationId, newThread())
    expect(appended.ok).toBe(true)
    const threadId = (appended as { threadId: string }).threadId

    // Outbound threads default to 'pending' on insert.
    let conversation = await store.getConversation(conversationId)
    expect(conversation?.threads.find((t) => t.id === threadId)?.deliveryStatus).toBe('pending')

    await store.setThreadDeliveryStatus(threadId, 'sent')

    conversation = await store.getConversation(conversationId)
    expect(conversation?.threads.find((t) => t.id === threadId)?.deliveryStatus).toBe('sent')
  })

  it('setThreadDeliveryStatus throws for a nonexistent thread id (no silent no-op)', async () => {
    const { store } = await freshStore()
    await expect(store.setThreadDeliveryStatus(RANDOM_UUID, 'sent')).rejects.toThrow()
  })

  it('setThreadDeliveryStatus refuses to mark an INBOUND thread (direction-scoped)', async () => {
    const { store } = await freshStore()
    // createConversation's first thread is inbound; its id must not be markable.
    const { conversationId, threadId } = await store.createConversation(newConversation())
    const inboundThreadId = threadId
    await expect(store.setThreadDeliveryStatus(inboundThreadId, 'sent')).rejects.toThrow()

    // And it really wasn't touched.
    const conversation = await store.getConversation(conversationId)
    expect(conversation?.threads.find((t) => t.id === inboundThreadId)?.deliveryStatus).toBeNull()
  })

  describe('setConversationStatus', () => {
    it('closes an open conversation and returns the updated summary', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const summary = await store.setConversationStatus(conversationId, 'closed')
      expect(summary).toMatchObject({ id: conversationId, status: 'closed' })

      const conversation = await store.getConversation(conversationId)
      expect(conversation?.status).toBe('closed')
    })

    it('reopens a closed conversation', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'closed')

      const summary = await store.setConversationStatus(conversationId, 'open')
      expect(summary).toMatchObject({ id: conversationId, status: 'open' })
    })

    it('bumps updated_at', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setUpdatedAt(db, conversationId, new Date('2020-01-01T00:00:00.000Z'))

      const summary = await store.setConversationStatus(conversationId, 'closed')
      expect(summary?.updatedAt.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime())
    })

    it('returns null for a nonexistent id — nothing is created or updated', async () => {
      const { store } = await freshStore()
      const summary = await store.setConversationStatus(RANDOM_UUID, 'open')
      expect(summary).toBeNull()
    })

    it('returns null for a deleted conversation — not reopenable through this method', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')

      const summary = await store.setConversationStatus(conversationId, 'open')
      expect(summary).toBeNull()

      // And it really wasn't touched — still deleted.
      const conversation = await store.getConversation(conversationId)
      expect(conversation?.status).toBe('deleted')
    })
  })

  describe('listConversations', () => {
    it('defaults to excluding deleted; a deleted conversation never appears under any status filter', async () => {
      const { db, store } = await freshStore()
      const { conversationId: openId } = await store.createConversation(newConversation())
      const { conversationId: closedId } = await store.createConversation(newConversation())
      const { conversationId: deletedId } = await store.createConversation(newConversation())
      await setStatus(db, closedId, 'closed')
      await setStatus(db, deletedId, 'deleted')

      const all = await store.listConversations({ limit: 50 })
      const ids = all.map((c) => c.id)
      expect(ids).toContain(openId)
      expect(ids).toContain(closedId)
      expect(ids).not.toContain(deletedId)

      const openOnly = await store.listConversations({ status: 'open', limit: 50 })
      expect(openOnly.map((c) => c.id)).toEqual([openId])

      const closedOnly = await store.listConversations({ status: 'closed', limit: 50 })
      expect(closedOnly.map((c) => c.id)).toEqual([closedId])
    })

    it('reports threadCount via the correlated subquery', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await store.appendThread(conversationId, newThread())
      await store.appendThread(
        conversationId,
        newThread({ messageId: '<outbound-2@mail.example.test>' }),
      )

      const [summary] = await store.listConversations({ limit: 50 })
      expect(summary.id).toBe(conversationId)
      expect(summary.threadCount).toBe(3)
    })

    it('orders updated_at DESC, id DESC (stable tiebreak) and reflects an append bumping updated_at', async () => {
      const { db, store } = await freshStore()
      const { conversationId: a } = await store.createConversation(newConversation())
      const { conversationId: b } = await store.createConversation(newConversation())
      await setUpdatedAt(db, a, new Date('2026-01-01T00:00:00.000Z'))
      await setUpdatedAt(db, b, new Date('2026-01-02T00:00:00.000Z'))

      let ordered = await store.listConversations({ limit: 50 })
      expect(ordered.map((c) => c.id)).toEqual([b, a])

      // Appending to `a` bumps its updated_at (appendThread's own policy) —
      // it should now sort ahead of `b`.
      await store.appendThread(a, newThread())
      ordered = await store.listConversations({ limit: 50 })
      expect(ordered.map((c) => c.id)).toEqual([a, b])
    })

    it('limit is respected as an exact fetch count', async () => {
      const { store } = await freshStore()
      for (let i = 0; i < 5; i++) {
        await store.createConversation(newConversation())
      }
      const page = await store.listConversations({ limit: 3 })
      expect(page).toHaveLength(3)
    })

    it('keyset cursor walks pages with no overlap and no gap', async () => {
      const { db, store } = await freshStore()
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const { conversationId } = await store.createConversation(newConversation())
        // Distinct, deterministic updated_at values so ordering is fully
        // controlled rather than relying on real-clock granularity.
        await setUpdatedAt(db, conversationId, new Date(2026, 0, i + 1))
        ids.push(conversationId)
      }
      // Most-recently-active first: ids[4] has the latest updated_at, ids[0] the earliest.
      const expectedOrder = [...ids].reverse()

      const page1 = await store.listConversations({ limit: 2 })
      expect(page1.map((c) => c.id)).toEqual(expectedOrder.slice(0, 2))

      const last = page1[page1.length - 1]
      const page2 = await store.listConversations({
        limit: 2,
        cursor: { updatedAt: last.updatedAt, id: last.id },
      })
      expect(page2.map((c) => c.id)).toEqual(expectedOrder.slice(2, 4))

      const last2 = page2[page2.length - 1]
      const page3 = await store.listConversations({
        limit: 2,
        cursor: { updatedAt: last2.updatedAt, id: last2.id },
      })
      expect(page3.map((c) => c.id)).toEqual(expectedOrder.slice(4, 5))

      // No overlap, no gap across all three pages.
      const walked = [...page1, ...page2, ...page3].map((c) => c.id)
      expect(walked).toEqual(expectedOrder)
    })
  })
})
