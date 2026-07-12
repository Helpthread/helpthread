import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import {
  createConversationStore,
  type NewConversation,
  type NewThread,
  type SendEnvelope,
} from './conversations.js'

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
async function setStatus(
  db: Db,
  conversationId: string,
  status: 'active' | 'pending' | 'closed' | 'spam' | 'deleted',
) {
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
    // Inbound mail creates conversations 'active' — the schema default
    // (migration 004; spec §2's status semantics).
    expect(conversation?.status).toBe('active')
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

  it('appendThread to an ACTIVE conversation succeeds; getConversation shows 2 threads in created order', async () => {
    const { store } = await freshStore()
    const { conversationId } = await store.createConversation(newConversation())

    const result = await store.appendThread(
      conversationId,
      newThread({ messageId: '<outbound-1@mail.example.test>' }),
    )
    expect(result).toMatchObject({ ok: true, threadId: expect.any(String), created: true })

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.threads).toHaveLength(2)
    expect(conversation?.threads[0].direction).toBe('inbound')
    expect(conversation?.threads[1].direction).toBe('outbound')
    expect(conversation?.threads[1].messageId).toBe('<outbound-1@mail.example.test>')
    expect(conversation?.status).toBe('active')
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

  it('appendThread to a CLOSED conversation succeeds AND reopens it to active', async () => {
    const { db, store } = await freshStore()
    const { conversationId } = await store.createConversation(newConversation())
    await setStatus(db, conversationId, 'closed')

    const result = await store.appendThread(conversationId, newThread())
    expect(result.ok).toBe(true)

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.status).toBe('active')
    expect(conversation?.threads).toHaveLength(2)
  })

  it('appendThread to a SPAM conversation succeeds AND reopens it to active (spec §4a, v1.1)', async () => {
    const { db, store } = await freshStore()
    const { conversationId } = await store.createConversation(newConversation())
    await setStatus(db, conversationId, 'spam')

    const result = await store.appendThread(conversationId, newThread())
    expect(result.ok).toBe(true)

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.status).toBe('active')
    expect(conversation?.threads).toHaveLength(2)
  })

  it('appendThread to a PENDING conversation inserts but leaves it pending — pending is an Agent statement, never auto-cleared', async () => {
    const { db, store } = await freshStore()
    const { conversationId } = await store.createConversation(newConversation())
    await setStatus(db, conversationId, 'pending')

    const result = await store.appendThread(conversationId, newThread())
    expect(result.ok).toBe(true)

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.status).toBe('pending')
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

    it('reopens a closed conversation to active', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'closed')

      const summary = await store.setConversationStatus(conversationId, 'active')
      expect(summary).toMatchObject({ id: conversationId, status: 'active' })
    })

    it('every surfaceable status is settable: pending and spam round-trip too (spec §4b, v1.1)', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const pending = await store.setConversationStatus(conversationId, 'pending')
      expect(pending).toMatchObject({ id: conversationId, status: 'pending' })

      const spam = await store.setConversationStatus(conversationId, 'spam')
      expect(spam).toMatchObject({ id: conversationId, status: 'spam' })

      const conversation = await store.getConversation(conversationId)
      expect(conversation?.status).toBe('spam')
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
      const summary = await store.setConversationStatus(RANDOM_UUID, 'active')
      expect(summary).toBeNull()
    })

    it('returns null for a deleted conversation — not reachable through this method', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')

      const summary = await store.setConversationStatus(conversationId, 'active')
      expect(summary).toBeNull()

      // And it really wasn't touched — still deleted.
      const conversation = await store.getConversation(conversationId)
      expect(conversation?.status).toBe('deleted')
    })
  })

  describe('listConversations', () => {
    it('defaults to excluding deleted; a deleted conversation never appears under any folder', async () => {
      const { db, store } = await freshStore()
      const { conversationId: activeId } = await store.createConversation(newConversation())
      const { conversationId: closedId } = await store.createConversation(newConversation())
      const { conversationId: deletedId } = await store.createConversation(newConversation())
      await setStatus(db, closedId, 'closed')
      await setStatus(db, deletedId, 'deleted')

      const all = await store.listConversations({ limit: 50 })
      const ids = all.map((c) => c.id)
      expect(ids).toContain(activeId)
      expect(ids).toContain(closedId)
      expect(ids).not.toContain(deletedId)

      const openOnly = await store.listConversations({ folder: 'open', limit: 50 })
      expect(openOnly.map((c) => c.id)).toEqual([activeId])

      const closedOnly = await store.listConversations({ folder: 'closed', limit: 50 })
      expect(closedOnly.map((c) => c.id)).toEqual([closedId])
    })

    it("the open folder is active + pending; 'closed' and 'spam' are exact (spec §3a's folder semantics)", async () => {
      const { db, store } = await freshStore()
      const { conversationId: activeId } = await store.createConversation(newConversation())
      const { conversationId: pendingId } = await store.createConversation(newConversation())
      const { conversationId: closedId } = await store.createConversation(newConversation())
      const { conversationId: spamId } = await store.createConversation(newConversation())
      await setStatus(db, pendingId, 'pending')
      await setStatus(db, closedId, 'closed')
      await setStatus(db, spamId, 'spam')

      const open = await store.listConversations({ folder: 'open', limit: 50 })
      expect(open.map((c) => c.id).sort()).toEqual([activeId, pendingId].sort())
      // The summary carries the REAL status — the folder is only the filter
      // grain; pills disambiguate within the open folder (spec §3a).
      expect(open.find((c) => c.id === pendingId)?.status).toBe('pending')
      expect(open.find((c) => c.id === activeId)?.status).toBe('active')

      const spam = await store.listConversations({ folder: 'spam', limit: 50 })
      expect(spam.map((c) => c.id)).toEqual([spamId])

      const closed = await store.listConversations({ folder: 'closed', limit: 50 })
      expect(closed.map((c) => c.id)).toEqual([closedId])
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

  // --- send idempotency + delivery leasing (HT-16) ---------------------------

  function newEnvelope(overrides: Partial<SendEnvelope> = {}): SendEnvelope {
    return {
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      ...overrides,
    }
  }

  /** Directly rewinds a thread's claimed_until into the past — for exercising lease-expiry without a real sleep. */
  async function expireLease(db: Db, threadId: string) {
    await db.query("UPDATE threads SET claimed_until = now() - interval '1 second' WHERE id = $1", [
      threadId,
    ])
  }

  /** Directly rewinds a thread's created_at — for exercising the delivery worker's "stale pending" window without a real sleep. */
  async function setCreatedAt(db: Db, threadId: string, createdAt: Date) {
    await db.query('UPDATE threads SET created_at = $1 WHERE id = $2', [createdAt, threadId])
  }

  describe('appendThread idempotency key (get-or-insert)', () => {
    it('a fresh idempotencyKey inserts a new row (created: true) and persists the envelope', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const result = await store.appendThread(
        conversationId,
        newThread({ idempotencyKey: 'send-key-1', sendEnvelope: newEnvelope() }),
      )
      expect(result).toMatchObject({ ok: true, created: true })
      if (!result.ok) throw new Error('unreachable')
      expect(result.thread.idempotencyKey).toBe('send-key-1')
      expect(result.thread.sendEnvelope).toEqual(newEnvelope())
      expect(result.thread.claimedUntil).toBeNull()
    })

    it('a repeated idempotencyKey on the SAME conversation finds the existing row (created: false); inserts nothing new', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const first = await store.appendThread(
        conversationId,
        newThread({
          messageId: '<ht.k1.c1.t1.sig@mail.example.test>',
          idempotencyKey: 'send-key-1',
          sendEnvelope: newEnvelope(),
        }),
      )
      expect(first).toMatchObject({ ok: true, created: true })

      // A "retry": same key, deliberately DIFFERENT messageId/envelope to
      // prove the store returns the ORIGINAL row rather than the retry's
      // (a real caller would never actually vary these, but this is the
      // sharpest way to prove get-or-insert never re-inserts or overwrites).
      const second = await store.appendThread(
        conversationId,
        newThread({
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          idempotencyKey: 'send-key-1',
          sendEnvelope: newEnvelope({ subject: 'A different subject entirely' }),
        }),
      )
      expect(second).toMatchObject({ ok: true, created: false })
      if (!first.ok || !second.ok) throw new Error('unreachable')
      expect(second.threadId).toBe(first.threadId)
      expect(second.thread.messageId).toBe('<ht.k1.c1.t1.sig@mail.example.test>')
      expect(second.thread.sendEnvelope).toEqual(newEnvelope())

      const conversation = await store.getConversation(conversationId)
      const outboundThreads = conversation?.threads.filter((t) => t.direction === 'outbound')
      expect(outboundThreads).toHaveLength(1)
    })

    it('a replay (created: false) does not bump updated_at or reopen a closed conversation', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await store.appendThread(
        conversationId,
        newThread({ idempotencyKey: 'send-key-1', sendEnvelope: newEnvelope() }),
      )
      await setStatus(db, conversationId, 'closed')
      await setUpdatedAt(db, conversationId, new Date('2020-01-01T00:00:00.000Z'))

      const replay = await store.appendThread(
        conversationId,
        newThread({ idempotencyKey: 'send-key-1', sendEnvelope: newEnvelope() }),
      )
      expect(replay).toMatchObject({ ok: true, created: false })

      const conversation = await store.getConversation(conversationId)
      // Still closed, still the old updated_at — a replay is not new activity.
      expect(conversation?.status).toBe('closed')
      expect(conversation?.updatedAt.getTime()).toBe(new Date('2020-01-01T00:00:00.000Z').getTime())
    })

    it('DIFFERENT idempotencyKeys on the same conversation each insert their own row', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const a = await store.appendThread(
        conversationId,
        newThread({
          messageId: '<a@mail.example.test>',
          idempotencyKey: 'key-A',
          sendEnvelope: newEnvelope(),
        }),
      )
      const b = await store.appendThread(
        conversationId,
        newThread({
          messageId: '<b@mail.example.test>',
          idempotencyKey: 'key-B',
          sendEnvelope: newEnvelope(),
        }),
      )
      expect(a).toMatchObject({ created: true })
      expect(b).toMatchObject({ created: true })
      if (!a.ok || !b.ok) throw new Error('unreachable')
      expect(a.threadId).not.toBe(b.threadId)
    })

    // (Runs against the single-connection, in-process PGlite used in tests —
    // see createPgliteDb above. A single connection serializes the two
    // `appendThread` transactions below rather than truly overlapping them,
    // so this proves the sequential claim-while-held logic — the later
    // `Promise.all` caller observes the earlier one's conflict correctly —
    // but NOT true multi-connection atomicity of the underlying `INSERT ...
    // ON CONFLICT`. Real-race coverage (two genuinely concurrent Postgres
    // connections racing the same unique index) waits for a multi-connection
    // backend in tests, same caveat as migrate.ts's advisory-lock note.)
    it('concurrent appendThread calls with the SAME key resolve to exactly one created row', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const [a, b] = await Promise.all([
        store.appendThread(
          conversationId,
          newThread({
            messageId: '<a@mail.example.test>',
            idempotencyKey: 'concurrent-key',
            sendEnvelope: newEnvelope(),
          }),
        ),
        store.appendThread(
          conversationId,
          newThread({
            messageId: '<b@mail.example.test>',
            idempotencyKey: 'concurrent-key',
            sendEnvelope: newEnvelope(),
          }),
        ),
      ])
      expect(a.ok && b.ok).toBe(true)
      if (!a.ok || !b.ok) throw new Error('unreachable')
      expect(a.threadId).toBe(b.threadId)
      // Exactly one of the two calls actually created the row.
      expect([a.created, b.created].sort()).toEqual([false, true])

      const conversation = await store.getConversation(conversationId)
      expect(conversation?.threads.filter((t) => t.direction === 'outbound')).toHaveLength(1)
    })

    it('an idempotencyKey is scoped PER CONVERSATION — the same key on a different conversation inserts its own row', async () => {
      const { store } = await freshStore()
      const { conversationId: convA } = await store.createConversation(newConversation())
      const { conversationId: convB } = await store.createConversation(newConversation())

      const a = await store.appendThread(
        convA,
        newThread({
          messageId: '<a@mail.example.test>',
          idempotencyKey: 'shared-key',
          sendEnvelope: newEnvelope(),
        }),
      )
      const b = await store.appendThread(
        convB,
        newThread({
          messageId: '<b@mail.example.test>',
          idempotencyKey: 'shared-key',
          sendEnvelope: newEnvelope(),
        }),
      )
      expect(a).toMatchObject({ created: true })
      expect(b).toMatchObject({ created: true })
    })
  })

  describe('claimThreadForDelivery / releaseThreadLease', () => {
    it('claims an unclaimed outbound thread, setting claimedUntil in the future', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, newThread())
      if (!appended.ok) throw new Error('unreachable')

      const before = new Date()
      const claimed = await store.claimThreadForDelivery(appended.threadId, 30_000)
      expect(claimed).not.toBeNull()
      if (claimed === null) throw new Error('unreachable')
      expect(claimed.claimedUntil).not.toBeNull()
      expect((claimed.claimedUntil as Date).getTime()).toBeGreaterThan(before.getTime())
    })

    it('a second claim attempt while the lease is held returns null', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, newThread())
      if (!appended.ok) throw new Error('unreachable')

      const first = await store.claimThreadForDelivery(appended.threadId, 30_000)
      expect(first).not.toBeNull()

      const second = await store.claimThreadForDelivery(appended.threadId, 30_000)
      expect(second).toBeNull()
    })

    it('claiming succeeds again once the previous lease has expired', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, newThread())
      if (!appended.ok) throw new Error('unreachable')

      const first = await store.claimThreadForDelivery(appended.threadId, 30_000)
      expect(first).not.toBeNull()
      await expireLease(db, appended.threadId)

      const second = await store.claimThreadForDelivery(appended.threadId, 30_000)
      expect(second).not.toBeNull()
    })

    it('releaseThreadLease sets delivery_status and clears claimedUntil', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, newThread())
      if (!appended.ok) throw new Error('unreachable')
      await store.claimThreadForDelivery(appended.threadId, 30_000)

      await store.releaseThreadLease(appended.threadId, 'sent')

      const conversation = await store.getConversation(conversationId)
      const thread = conversation?.threads.find((t) => t.id === appended.threadId)
      expect(thread?.deliveryStatus).toBe('sent')
      expect(thread?.claimedUntil).toBeNull()
    })

    it('releaseThreadLease throws for a nonexistent thread id', async () => {
      const { store } = await freshStore()
      await expect(store.releaseThreadLease(RANDOM_UUID, 'sent')).rejects.toThrow()
    })

    it('claimThreadForDelivery returns null for an inbound thread id (direction-scoped)', async () => {
      const { store } = await freshStore()
      const { threadId } = await store.createConversation(newConversation())
      expect(await store.claimThreadForDelivery(threadId, 30_000)).toBeNull()
    })

    // --- HT-16 CodeRabbit fix: claim re-checks delivery_status, not just the lease ---

    it('claimThreadForDelivery returns null for a row already marked "sent", even with a free lease (closes the sent-row reclaim double-send)', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, newThread())
      if (!appended.ok) throw new Error('unreachable')
      await store.claimThreadForDelivery(appended.threadId, 30_000)
      // releaseThreadLease clears claimed_until in the SAME write that
      // records 'sent' — the lease is free, but the row is delivered.
      await store.releaseThreadLease(appended.threadId, 'sent')

      const reclaimed = await store.claimThreadForDelivery(appended.threadId, 30_000)
      expect(reclaimed).toBeNull()
    })

    it('claimThreadForDelivery still succeeds for a "failed" row with a free lease (retries remain claimable)', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, newThread())
      if (!appended.ok) throw new Error('unreachable')
      await store.claimThreadForDelivery(appended.threadId, 30_000)
      await store.releaseThreadLease(appended.threadId, 'failed')

      const reclaimed = await store.claimThreadForDelivery(appended.threadId, 30_000)
      expect(reclaimed).not.toBeNull()
    })

    it('claimThreadForDelivery still succeeds for a "pending" row with a free lease (a fresh, never-claimed row remains claimable)', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, newThread())
      if (!appended.ok) throw new Error('unreachable')

      const claimed = await store.claimThreadForDelivery(appended.threadId, 30_000)
      expect(claimed).not.toBeNull()
      expect(claimed?.deliveryStatus).toBe('pending')
    })
  })

  describe('listDeliverableThreads', () => {
    it('returns a failed row regardless of age', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(
        conversationId,
        newThread({ deliveryStatus: 'failed', sendEnvelope: newEnvelope() }),
      )
      if (!appended.ok) throw new Error('unreachable')

      const eligible = await store.listDeliverableThreads({
        staleAfterMs: 5 * 60_000,
        batchSize: 50,
      })
      expect(eligible.map((t) => t.id)).toContain(appended.threadId)
    })

    it('excludes a fresh pending row but includes a STALE pending row', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const fresh = await store.appendThread(
        conversationId,
        newThread({ messageId: '<fresh@mail.example.test>', sendEnvelope: newEnvelope() }),
      )
      const stale = await store.appendThread(
        conversationId,
        newThread({ messageId: '<stale@mail.example.test>', sendEnvelope: newEnvelope() }),
      )
      if (!fresh.ok || !stale.ok) throw new Error('unreachable')
      await setCreatedAt(db, stale.threadId, new Date(Date.now() - 10 * 60_000))

      const eligible = await store.listDeliverableThreads({
        staleAfterMs: 5 * 60_000,
        batchSize: 50,
      })
      const ids = eligible.map((t) => t.id)
      expect(ids).toContain(stale.threadId)
      expect(ids).not.toContain(fresh.threadId)
    })

    it('excludes a row whose lease is currently held', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(
        conversationId,
        newThread({ deliveryStatus: 'failed', sendEnvelope: newEnvelope() }),
      )
      if (!appended.ok) throw new Error('unreachable')
      await store.claimThreadForDelivery(appended.threadId, 30_000)

      const eligible = await store.listDeliverableThreads({
        staleAfterMs: 5 * 60_000,
        batchSize: 50,
      })
      expect(eligible.map((t) => t.id)).not.toContain(appended.threadId)
    })

    it('excludes a row with no stored send_envelope (pre-HT-16 data) even if otherwise eligible', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(
        conversationId,
        newThread({ deliveryStatus: 'failed' }), // no sendEnvelope
      )
      if (!appended.ok) throw new Error('unreachable')

      const eligible = await store.listDeliverableThreads({
        staleAfterMs: 5 * 60_000,
        batchSize: 50,
      })
      expect(eligible.map((t) => t.id)).not.toContain(appended.threadId)
    })

    it('respects batchSize as a hard cap, ordered oldest-created_at-first', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const ids: string[] = []
      for (let i = 0; i < 3; i++) {
        const appended = await store.appendThread(
          conversationId,
          newThread({
            messageId: `<failed-${i}@mail.example.test>`,
            deliveryStatus: 'failed',
            sendEnvelope: newEnvelope(),
          }),
        )
        if (!appended.ok) throw new Error('unreachable')
        await setCreatedAt(db, appended.threadId, new Date(2026, 0, i + 1))
        ids.push(appended.threadId)
      }

      const eligible = await store.listDeliverableThreads({
        staleAfterMs: 5 * 60_000,
        batchSize: 2,
      })
      expect(eligible).toHaveLength(2)
      expect(eligible.map((t) => t.id)).toEqual([ids[0], ids[1]])
    })
  })
})
