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
})
