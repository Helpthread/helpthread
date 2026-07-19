import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db, type Queryable } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import {
  createConversationStore,
  type NewConversation,
  type NewThread,
  type SendEnvelope,
} from './conversations.js'

/** Raw `event_outbox` row shape, for the event-emission assertions below (HT-69). */
interface OutboxEventRow {
  event_id: string
  type: string
  conversation_id: string
  data: Record<string, unknown>
}

/** Every `event_outbox` row for `conversationId`, oldest first — a direct read, bypassing `EventOutboxStore`, since these tests assert on WHAT was written, not on the claim/drain machinery (covered by `event-outbox.test.ts`). */
async function outboxEventsFor(db: Db, conversationId: string): Promise<OutboxEventRow[]> {
  return db.query<OutboxEventRow>(
    'SELECT event_id, type, conversation_id, data FROM event_outbox WHERE conversation_id = $1 ORDER BY occurred_at, event_id',
    [conversationId],
  )
}

/**
 * Wrap `real` so that any `INSERT INTO event_outbox` issued INSIDE a
 * transaction throws — used to prove the state write and the outbox event
 * genuinely share one transaction (spec §4: "an event never fires for a
 * change that rolled back"), by forcing the event write to fail AFTER the
 * state write already ran and confirming BOTH are rolled back, not just the
 * event.
 */
function dbFailingOutboxInsert(real: Db): Db {
  return {
    query: (sql, params) => real.query(sql, params),
    close: () => real.close(),
    transaction: async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> =>
      real.transaction(async (tx) => {
        const guarded: Queryable = {
          query: async (sql, params) => {
            if (sql.includes('INSERT INTO event_outbox')) {
              throw new Error('simulated event_outbox insert failure')
            }
            return tx.query(sql, params)
          },
        }
        return fn(guarded)
      }),
  }
}

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

  describe('number & preview (HT-27, spec §2 v1.1)', () => {
    it('summaries carry the sequential number (creation order) and getConversation carries it too', async () => {
      const { store } = await freshStore()
      const { conversationId: firstId } = await store.createConversation(newConversation())
      const { conversationId: secondId } = await store.createConversation(newConversation())

      const all = await store.listConversations({ limit: 50 })
      expect(all.find((c) => c.id === firstId)?.number).toBe(1)
      expect(all.find((c) => c.id === secondId)?.number).toBe(2)

      const detail = await store.getConversation(firstId)
      expect(detail?.number).toBe(1)
    })

    it("preview is the latest thread's text, whitespace-collapsed and capped at 120 chars", async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const messy = `  padded\t\tand\n\nbroken   ${'x'.repeat(200)}`
      await store.appendThread(conversationId, newThread({ bodyText: messy }))

      const [summary] = await store.listConversations({ limit: 50 })
      const expected = `padded and broken ${'x'.repeat(200)}`.slice(0, 120)
      expect(summary.preview).toBe(expected)
      expect(summary.preview.length).toBe(120)
    })

    it('an html-only latest thread is skipped — preview falls back to the most recent thread WITH text', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await store.appendThread(
        conversationId,
        newThread({ bodyText: null, bodyHtml: '<p>rich only</p>' }),
      )

      const [summary] = await store.listConversations({ limit: 50 })
      // Falls back past the html-only append to the first (inbound) thread's text.
      expect(summary.preview).toBe('Where is my order?')
    })

    it("preview is '' when no thread has text at all", async () => {
      const { store } = await freshStore()
      await store.createConversation(
        newConversation({
          firstMessage: {
            direction: 'inbound',
            messageId: null,
            fromAddress: 'customer@example.test',
            bodyHtml: '<p>html only</p>',
          },
        }),
      )

      const [summary] = await store.listConversations({ limit: 50 })
      expect(summary.preview).toBe('')
    })

    it('setConversationStatus returns number and preview on the updated summary', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const summary = await store.setConversationStatus(conversationId, 'closed')
      expect(summary).toMatchObject({
        id: conversationId,
        number: 1,
        preview: 'Where is my order?',
      })
    })
  })

  describe('deleteConversation (HT-30, spec §4d v1.1)', () => {
    it('soft-deletes a live conversation: true, then invisible to every public path — but the rows survive in storage', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      expect(await store.deleteConversation(conversationId)).toBe(true)

      // Public reads treat it as nonexistent…
      expect(await store.getConversation(conversationId, { includeDeleted: false })).toBeNull()
      expect((await store.listConversations({ limit: 50 })).map((c) => c.id)).not.toContain(
        conversationId,
      )
      expect(await store.setConversationStatus(conversationId, 'active')).toBeNull()
      expect(await store.appendThread(conversationId, newThread())).toEqual({
        ok: false,
        reason: 'deleted',
      })

      // …but the mail itself is still in storage (charter invariant #1) —
      // soft delete changes visibility, never data.
      const raw = await store.getConversation(conversationId)
      expect(raw?.status).toBe('deleted')
      expect(raw?.threads).toHaveLength(1)
      const [{ count }] = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM threads WHERE conversation_id = $1',
        [conversationId],
      )
      expect(count).toBe(1)
    })

    it('a second delete (and a nonexistent id) return false — indistinguishable misses', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      expect(await store.deleteConversation(conversationId)).toBe(true)
      expect(await store.deleteConversation(conversationId)).toBe(false)
      expect(await store.deleteConversation(RANDOM_UUID)).toBe(false)
    })
  })

  describe('tags & assignee (HT-29/HT-31, spec §4e/§4f v1.1; HT-54 graduates assignee to a real Agent id, spec §3.3)', () => {
    /** Insert a minimal `agents` row directly (raw SQL, not via `AgentStore`, matching this file's fixture-setup convention) — just enough to satisfy `assignee_agent_id`'s FK. */
    async function insertAgent(db: Db, email: string): Promise<string> {
      const [row] = await db.query<{ id: string }>(
        'INSERT INTO agents (email, name) VALUES ($1, $2) RETURNING id',
        [email, 'Test Agent'],
      )
      return row.id
    }

    it('defaults: a new conversation has [] tags and null assigneeAgentId, on summaries and detail alike', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const [summary] = await store.listConversations({ limit: 50 })
      expect(summary.tags).toEqual([])
      expect(summary.assigneeAgentId).toBeNull()

      const detail = await store.getConversation(conversationId)
      expect(detail?.tags).toEqual([])
      expect(detail?.assigneeAgentId).toBeNull()
    })

    it('setConversationTags replace-set round-trip: set, re-set, clear — persisted verbatim, no updated_at bump', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setUpdatedAt(db, conversationId, new Date('2020-01-01T00:00:00.000Z'))

      const set = await store.setConversationTags(conversationId, ['bug', 'billing'])
      expect(set?.tags).toEqual(['bug', 'billing'])
      // Metadata, not activity — the sort key is untouched (spec §4e).
      expect(set?.updatedAt.getTime()).toBe(new Date('2020-01-01T00:00:00.000Z').getTime())

      const reset = await store.setConversationTags(conversationId, ['import'])
      expect(reset?.tags).toEqual(['import'])

      const cleared = await store.setConversationTags(conversationId, [])
      expect(cleared?.tags).toEqual([])
    })

    it('setConversationAssignee assigns and releases, no updated_at bump', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setUpdatedAt(db, conversationId, new Date('2020-01-01T00:00:00.000Z'))
      const agentId = await insertAgent(db, 'agent@example.test')

      const claimed = await store.setConversationAssignee(conversationId, agentId)
      if (claimed === null || claimed === 'invalid_agent') throw new Error('expected a summary')
      expect(claimed.assigneeAgentId).toBe(agentId)
      expect(claimed.updatedAt.getTime()).toBe(new Date('2020-01-01T00:00:00.000Z').getTime())

      const released = await store.setConversationAssignee(conversationId, null)
      if (released === null || released === 'invalid_agent') throw new Error('expected a summary')
      expect(released.assigneeAgentId).toBeNull()
    })

    it("setConversationAssignee returns 'invalid_agent' when the id no longer names an Agent (the FK race, translated)", async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      // Calling the store DIRECTLY with an id no Agent has — the same state
      // the API's check-then-act race lands in when the Agent is deleted
      // between the handler's existence check and this UPDATE.
      const outcome = await store.setConversationAssignee(conversationId, RANDOM_UUID)
      expect(outcome).toBe('invalid_agent')
      const raw = await store.getConversation(conversationId)
      expect(raw?.assigneeAgentId).toBeNull()
    })

    it('both return null for a missing or deleted conversation — nothing is written', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')
      const agentId = await insertAgent(db, 'agent2@example.test')

      expect(await store.setConversationTags(RANDOM_UUID, ['x'])).toBeNull()
      expect(await store.setConversationTags(conversationId, ['x'])).toBeNull()
      expect(await store.setConversationAssignee(RANDOM_UUID, agentId)).toBeNull()
      expect(await store.setConversationAssignee(conversationId, agentId)).toBeNull()

      const raw = await store.getConversation(conversationId)
      expect(raw?.tags).toEqual([])
      expect(raw?.assigneeAgentId).toBeNull()
    })
  })

  describe('note threads (HT-28, spec §4c v1.1)', () => {
    it('a note appends with null delivery status, bumps updated_at, but NEVER reopens a closed conversation', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'closed')
      await setUpdatedAt(db, conversationId, new Date('2020-01-01T00:00:00.000Z'))

      const result = await store.appendThread(conversationId, {
        direction: 'note',
        messageId: null,
        fromAddress: 'support@example.test',
        bodyText: 'Finance context: PO required on every invoice.',
      })
      expect(result).toMatchObject({ ok: true, created: true })

      const conversation = await store.getConversation(conversationId)
      // Still closed — a note is not the customer coming back (spec §4c)…
      expect(conversation?.status).toBe('closed')
      // …but it IS activity: the conversation resurfaces in the inbox.
      expect(conversation?.updatedAt.getTime()).toBeGreaterThan(
        new Date('2020-01-01T00:00:00.000Z').getTime(),
      )
      const note = conversation?.threads.at(-1)
      expect(note).toMatchObject({
        direction: 'note',
        deliveryStatus: null,
        messageId: null,
        bodyText: 'Finance context: PO required on every invoice.',
      })
    })

    it('the delivery worker can never see a note — listDeliverableThreads is outbound-scoped', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, {
        direction: 'note',
        messageId: null,
        fromAddress: 'support@example.test',
        bodyText: 'never send me',
      })
      if (!appended.ok) throw new Error('unreachable')
      // Age the note far past any staleness threshold — it must STILL be
      // invisible to the retry sweep (charter invariant #5 adjacency: a note
      // reaching the send path would be a bug, per spec §4c).
      await setCreatedAt(db, appended.threadId, new Date('2020-01-01T00:00:00.000Z'))

      const eligible = await store.listDeliverableThreads({ staleAfterMs: 0, batchSize: 50 })
      expect(eligible).toEqual([])
    })
  })

  describe('recordThreadView (HT-32, spec §4g v1.1)', () => {
    it('records the FIRST view only — a second call changes nothing', async () => {
      const { store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const appended = await store.appendThread(conversationId, newThread())
      if (!appended.ok) throw new Error('unreachable')

      await store.recordThreadView(appended.threadId)
      const first = (await store.getConversation(conversationId))?.threads.find(
        (t) => t.id === appended.threadId,
      )
      expect(first?.customerViewedAt).toBeInstanceOf(Date)

      await store.recordThreadView(appended.threadId)
      const second = (await store.getConversation(conversationId))?.threads.find(
        (t) => t.id === appended.threadId,
      )
      expect(second?.customerViewedAt?.getTime()).toBe(first?.customerViewedAt?.getTime())
    })

    it('is silent on every miss: inbound threads and unknown ids record nothing and never throw', async () => {
      const { store } = await freshStore()
      const { conversationId, threadId: inboundId } = await store.createConversation(
        newConversation(),
      )

      await expect(store.recordThreadView(inboundId)).resolves.toBeUndefined()
      await expect(store.recordThreadView(RANDOM_UUID)).resolves.toBeUndefined()

      const inbound = (await store.getConversation(conversationId))?.threads.find(
        (t) => t.id === inboundId,
      )
      expect(inbound?.customerViewedAt).toBeNull()
    })
  })

  describe('drafts (HT-68, spec §6)', () => {
    /** Insert a real `assistants` row directly — appendDraft's author_assistant_id FKs to it. */
    async function createTestAssistant(db: Db, name = 'Draft Bot'): Promise<string> {
      const [row] = await db.query<{ id: string }>(
        `INSERT INTO assistants (name, module, token_hash) VALUES ($1, 'draft-reply', 'hash') RETURNING id`,
        [name],
      )
      return row.id
    }

    /** Insert a real `agents` row directly — resolveDraft's approved_by_agent_id FKs to it. */
    async function createTestAgent(db: Db, email = 'agent@example.test'): Promise<string> {
      const [row] = await db.query<{ id: string }>(
        `INSERT INTO agents (email, name, role, status) VALUES ($1, 'Agent', 'agent', 'active') RETURNING id`,
        [email],
      )
      return row.id
    }

    const testEnvelope: SendEnvelope = {
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      references: ['<ht.k1.c1.t2.sig@mail.example.test>'],
    }

    it('appendDraft inserts an outbound, awaiting_review, assistant-authored thread with NULL delivery_status, message_id, and send_envelope', async () => {
      const { store, db } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const assistantId = await createTestAssistant(db)

      const result = await store.appendDraft(conversationId, {
        assistantId,
        bodyText: 'Here is a suggested reply.',
        idempotencyKey: 'draft-key-1',
      })

      expect(result).toMatchObject({ ok: true, created: true })
      if (!result.ok) throw new Error('unreachable')
      expect(result.thread).toMatchObject({
        direction: 'outbound',
        authorKind: 'assistant',
        authorAssistantId: assistantId,
        authorAgentId: null,
        draftStatus: 'awaiting_review',
        deliveryStatus: null,
        messageId: null,
        sendEnvelope: null,
        bodyText: 'Here is a suggested reply.',
        approvedByAgentId: null,
        draftResolvedAt: null,
        draftEdited: false,
      })
    })

    it('appendDraft causes NO reopen and NO updated_at bump on a closed conversation — stronger than a note, which still bumps', async () => {
      const { store, db } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const assistantId = await createTestAssistant(db)
      await setStatus(db, conversationId, 'closed')
      await setUpdatedAt(db, conversationId, new Date('2020-01-01T00:00:00.000Z'))

      const draftResult = await store.appendDraft(conversationId, {
        assistantId,
        bodyText: 'Draft on a closed conversation.',
        idempotencyKey: 'draft-key-closed',
      })
      expect(draftResult).toMatchObject({ ok: true, created: true })

      const afterDraft = await store.getConversation(conversationId)
      // Still closed — a draft is not activity (spec §6, stronger than a note).
      expect(afterDraft?.status).toBe('closed')
      expect(afterDraft?.updatedAt.getTime()).toBe(new Date('2020-01-01T00:00:00.000Z').getTime())

      // A NOTE on the SAME fixture still reopens-exempt but DOES bump —
      // regression-guard that the draft carve-out didn't accidentally widen
      // to notes too (existing behavior, byte-identical).
      const noteResult = await store.appendThread(conversationId, {
        direction: 'note',
        messageId: null,
        fromAddress: 'support@example.test',
        bodyText: 'A regular note.',
      })
      expect(noteResult).toMatchObject({ ok: true, created: true })
      const afterNote = await store.getConversation(conversationId)
      expect(afterNote?.status).toBe('closed')
      expect(afterNote?.updatedAt.getTime()).toBeGreaterThan(
        new Date('2020-01-01T00:00:00.000Z').getTime(),
      )
    })

    it('appendDraft causes NO reopen on a SPAM conversation (an ordinary outbound send, by contrast, DOES reopen)', async () => {
      const { store, db } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const assistantId = await createTestAssistant(db)
      await setStatus(db, conversationId, 'spam')

      await store.appendDraft(conversationId, {
        assistantId,
        bodyText: 'Draft on a spam conversation.',
        idempotencyKey: 'draft-key-spam',
      })
      expect((await store.getConversation(conversationId))?.status).toBe('spam')

      // Regression-guard: an ordinary outbound append to the SAME
      // still-spam conversation still reopens it, exactly as before HT-68.
      await store.appendThread(
        conversationId,
        newThread({ messageId: '<reopen@mail.example.test>' }),
      )
      expect((await store.getConversation(conversationId))?.status).toBe('active')
    })

    it('appendDraft prefixes the idempotency key with draft: so it never collides with a reply idempotency key on the same conversation', async () => {
      const { store, db } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const assistantId = await createTestAssistant(db)

      const draftResult = await store.appendDraft(conversationId, {
        assistantId,
        bodyText: 'A draft.',
        idempotencyKey: 'shared-key',
      })
      const replyResult = await store.appendThread(
        conversationId,
        newThread({ messageId: '<reply@mail.example.test>', idempotencyKey: 'shared-key' }),
      )

      expect(draftResult).toMatchObject({ ok: true, created: true })
      expect(replyResult).toMatchObject({ ok: true, created: true })
      if (!draftResult.ok || !replyResult.ok) throw new Error('unreachable')
      // Two DISTINCT rows, not a get-or-insert collision.
      expect(draftResult.threadId).not.toBe(replyResult.threadId)

      const conversation = await store.getConversation(conversationId)
      expect(conversation?.threads.map((t) => t.idempotencyKey)).toEqual(
        expect.arrayContaining(['draft:shared-key', 'shared-key']),
      )
    })

    describe('listAwaitingDrafts', () => {
      it('returns awaiting_review drafts newest first, and excludes a draft on a soft-deleted conversation', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)

        const { conversationId: c1 } = await store.createConversation(newConversation())
        const { conversationId: c2 } = await store.createConversation(
          newConversation({ customerEmail: 'other@example.test' }),
        )
        const { conversationId: c3 } = await store.createConversation(
          newConversation({ customerEmail: 'deleted@example.test' }),
        )

        const d1 = await store.appendDraft(c1, {
          assistantId,
          bodyText: 'first',
          idempotencyKey: 'd1',
        })
        const d2 = await store.appendDraft(c2, {
          assistantId,
          bodyText: 'second',
          idempotencyKey: 'd2',
        })
        const d3 = await store.appendDraft(c3, {
          assistantId,
          bodyText: 'on a soon-to-be-deleted conversation',
          idempotencyKey: 'd3',
        })
        if (!d1.ok || !d2.ok || !d3.ok) throw new Error('unreachable')

        // Distinct created_at so newest-first ordering is unambiguous.
        await db.query('UPDATE threads SET created_at = $1 WHERE id = $2', [
          new Date('2024-01-01T00:00:00.000Z'),
          d1.threadId,
        ])
        await db.query('UPDATE threads SET created_at = $1 WHERE id = $2', [
          new Date('2024-01-02T00:00:00.000Z'),
          d2.threadId,
        ])
        await db.query('UPDATE threads SET created_at = $1 WHERE id = $2', [
          new Date('2024-01-03T00:00:00.000Z'),
          d3.threadId,
        ])
        await store.deleteConversation(c3)

        const drafts = await store.listAwaitingDrafts({ limit: 10 })
        expect(drafts.map((t) => t.id)).toEqual([d2.threadId, d1.threadId])
      })

      it('keyset-paginates with cursor (createdAt, id)', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const { conversationId } = await store.createConversation(newConversation())

        const ids: string[] = []
        for (let i = 0; i < 3; i++) {
          const result = await store.appendDraft(conversationId, {
            assistantId,
            bodyText: `draft ${i}`,
            idempotencyKey: `d${i}`,
          })
          if (!result.ok) throw new Error('unreachable')
          await db.query('UPDATE threads SET created_at = $1 WHERE id = $2', [
            new Date(2024, 0, i + 1),
            result.threadId,
          ])
          ids.push(result.threadId)
        }

        const firstPage = await store.listAwaitingDrafts({ limit: 2 })
        expect(firstPage.map((t) => t.id)).toEqual([ids[2], ids[1]])

        const secondPage = await store.listAwaitingDrafts({
          limit: 2,
          cursor: { createdAt: firstPage[1].createdAt, id: firstPage[1].id },
        })
        expect(secondPage.map((t) => t.id)).toEqual([ids[0]])
      })
    })

    describe('resolveDraft', () => {
      it('approve: writes message_id, send_envelope, draft_status=approved, delivery_status=pending, and audit fields in one write', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Original draft body.',
          idempotencyKey: 'approve-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        const resolved = await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })

        if (resolved === null || typeof resolved === 'string') throw new Error('unreachable')
        expect(resolved).toMatchObject({
          id: draft.threadId,
          direction: 'outbound',
          draftStatus: 'approved',
          deliveryStatus: 'pending',
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          approvedByAgentId: agentId,
          draftEdited: false,
          bodyText: 'Original draft body.',
        })
        expect(resolved.draftResolvedAt).toBeInstanceOf(Date)
      })

      it('approve on a CLOSED conversation reopens it to active (HT-70 review fix — the normal reply-reopen rule applies at approval time)', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Reply to a closed conversation.',
          idempotencyKey: 'approve-reopen-closed',
        })
        if (!draft.ok) throw new Error('unreachable')
        await setStatus(db, conversationId, 'closed')

        const resolved = await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })
        if (resolved === null || typeof resolved === 'string') throw new Error('unreachable')
        expect(resolved.draftStatus).toBe('approved')

        const conversation = await store.getConversation(conversationId)
        expect(conversation?.status).toBe('active')
      })

      it('approve on an ACTIVE conversation leaves its status alone', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Reply to an active conversation.',
          idempotencyKey: 'approve-active-1',
        })
        if (!draft.ok) throw new Error('unreachable')
        expect((await store.getConversation(conversationId))?.status).toBe('active')

        await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })

        expect((await store.getConversation(conversationId))?.status).toBe('active')
      })

      it('approve on a PENDING conversation leaves it pending — never auto-set, matching the normal-reply rule', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Reply to a pending conversation.',
          idempotencyKey: 'approve-pending-1',
        })
        if (!draft.ok) throw new Error('unreachable')
        await setStatus(db, conversationId, 'pending')

        await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })

        expect((await store.getConversation(conversationId))?.status).toBe('pending')
      })

      it('approve on a DELETED conversation is refused (conversation-deleted), leaving the draft row completely untouched (HT-70 review fix, Codex — the TOCTOU close)', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Reply to a deleted conversation.',
          idempotencyKey: 'approve-deleted-1',
        })
        if (!draft.ok) throw new Error('unreachable')
        await store.deleteConversation(conversationId)

        const resolved = await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })
        expect(resolved).toBe('conversation-deleted')

        const conversation = await store.getConversation(conversationId, { includeDeleted: true })
        const thread = conversation?.threads.find((t) => t.id === draft.threadId)
        expect(thread).toMatchObject({
          draftStatus: 'awaiting_review',
          deliveryStatus: null,
          messageId: null,
          sendEnvelope: null,
          approvedByAgentId: null,
        })
      })

      it('approve on a SPAM conversation is refused (conversation-spam), leaving the draft row completely untouched (HT-70 review fix, Codex — the TOCTOU close)', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Reply to a spam conversation.',
          idempotencyKey: 'approve-spam-1',
        })
        if (!draft.ok) throw new Error('unreachable')
        await setStatus(db, conversationId, 'spam')

        const resolved = await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })
        expect(resolved).toBe('conversation-spam')

        const conversation = await store.getConversation(conversationId, { includeDeleted: false })
        const thread = conversation?.threads.find((t) => t.id === draft.threadId)
        expect(thread).toMatchObject({
          draftStatus: 'awaiting_review',
          deliveryStatus: null,
          messageId: null,
          sendEnvelope: null,
          approvedByAgentId: null,
        })
        // The conversation itself is untouched too — still spam, not reopened.
        expect(conversation?.status).toBe('spam')
      })

      it('discard is unaffected by conversation status — no deleted/spam refusal (only approve has that restriction)', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Discard on a spam conversation is harmless.',
          idempotencyKey: 'discard-spam-1',
        })
        if (!draft.ok) throw new Error('unreachable')
        await setStatus(db, conversationId, 'spam')

        const resolved = await store.resolveDraft({
          action: 'discard',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
        })
        if (resolved === null || typeof resolved === 'string') throw new Error('unreachable')
        expect(resolved.draftStatus).toBe('discarded')
      })

      it('approve (HT-70) also persists in_reply_to, derived by the caller at approval time — StoredThread.inReplyTo is what attemptDeliveryOfClaimedThread reads, never sendEnvelope', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'A reply to the inbound message.',
          idempotencyKey: 'approve-inreplyto-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        const resolved = await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: '<inbound-1@customer.example.test>',
          edited: false,
        })

        if (resolved === null || typeof resolved === 'string') throw new Error('unreachable')
        expect(resolved.inReplyTo).toBe('<inbound-1@customer.example.test>')
      })

      it('approve with edits: replaces the body and records draft_edited = true', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Original draft body.',
          idempotencyKey: 'approve-edit-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        const resolved = await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edit: { bodyText: 'Edited by the Agent before sending.' },
          edited: true,
        })

        expect(resolved).toMatchObject({
          draftEdited: true,
          bodyText: 'Edited by the Agent before sending.',
        })
      })

      it('discard: sets draft_status=discarded and audit fields, and delivery_status stays NULL', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Draft to discard.',
          idempotencyKey: 'discard-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        const resolved = await store.resolveDraft({
          action: 'discard',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
        })

        if (resolved === null || typeof resolved === 'string') throw new Error('unreachable')
        expect(resolved).toMatchObject({
          draftStatus: 'discarded',
          deliveryStatus: null,
          approvedByAgentId: agentId,
        })
        expect(resolved.draftResolvedAt).toBeInstanceOf(Date)
      })

      it('returns null for an unknown threadId, a non-draft thread, or a draft already resolved', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId, threadId: inboundId } = await store.createConversation(
          newConversation(),
        )

        expect(
          await store.resolveDraft({
            action: 'discard',
            threadId: RANDOM_UUID,
            resolvedByAgentId: agentId,
          }),
        ).toBeNull()

        // A non-draft (inbound) thread.
        expect(
          await store.resolveDraft({
            action: 'discard',
            threadId: inboundId,
            resolvedByAgentId: agentId,
          }),
        ).toBeNull()

        // A draft resolved TWICE — the second call finds no awaiting_review row.
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Only resolvable once.',
          idempotencyKey: 'once-1',
        })
        if (!draft.ok) throw new Error('unreachable')
        await store.resolveDraft({
          action: 'discard',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
        })
        expect(
          await store.resolveDraft({
            action: 'discard',
            threadId: draft.threadId,
            resolvedByAgentId: agentId,
          }),
        ).toBeNull()
      })

      it('a draft already APPROVED cannot be discarded, or approved again — both find no awaiting_review row', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Approved, then someone tries to resolve it again.',
          idempotencyKey: 'double-resolve-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        const approved = await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })
        if (approved === null || typeof approved === 'string') throw new Error('unreachable')
        expect(approved.draftStatus).toBe('approved')

        // approve-then-discard: the row is no longer awaiting_review, so
        // discard is a no-op — it must NOT flip an already-approved,
        // already-delivery-pending row to 'discarded' out from under the
        // delivery worker.
        const discardAfterApprove = await store.resolveDraft({
          action: 'discard',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
        })
        expect(discardAfterApprove).toBeNull()

        // approve-twice: a second approve must NOT re-mint a message_id/
        // envelope over the already-approved row.
        const approveAgain = await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.SECOND-ATTEMPT@mail.example.test>',
          sendEnvelope: { ...testEnvelope, subject: 'A different subject' },
          inReplyTo: null,
          edited: false,
        })
        expect(approveAgain).toBeNull()

        // The row is untouched by either failed resolution attempt — still
        // approved, still carrying the ORIGINAL message_id/envelope/subject.
        const unchanged = (await store.getConversation(conversationId))?.threads.find(
          (t) => t.id === draft.threadId,
        )
        expect(unchanged).toMatchObject({
          draftStatus: 'approved',
          deliveryStatus: 'pending',
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
        })
      })

      it('an APPROVED draft flows through listDeliverableThreads/claimThreadForDelivery exactly like an ordinary reply — the delivery worker sees it only after approval', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Will be approved.',
          idempotencyKey: 'flows-through-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        // While awaiting_review, invisible to the delivery worker (delivery_status is NULL).
        expect(await store.listDeliverableThreads({ staleAfterMs: 0, batchSize: 50 })).toEqual([])

        await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })
        // Age it so it's past the staleness threshold for a 'pending' row.
        await db.query('UPDATE threads SET created_at = $1 WHERE id = $2', [
          new Date('2020-01-01T00:00:00.000Z'),
          draft.threadId,
        ])

        const eligible = await store.listDeliverableThreads({ staleAfterMs: 0, batchSize: 50 })
        expect(eligible.map((t) => t.id)).toEqual([draft.threadId])

        const claimed = await store.claimThreadForDelivery(draft.threadId, 60_000)
        expect(claimed?.id).toBe(draft.threadId)
      })
    })

    describe('draft.created / draft.resolved events (HT-70, spec §4)', () => {
      /** Read back every `event_outbox` row for `conversationId`, oldest first. */
      async function outboxEventsFor(
        db: Db,
        conversationId: string,
      ): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
        const rows = await db.query<{ type: string; data: unknown }>(
          `SELECT type, data FROM event_outbox WHERE conversation_id = $1 ORDER BY occurred_at, event_id`,
          [conversationId],
        )
        return rows.map((r) => ({ type: r.type, data: r.data as Record<string, unknown> }))
      }

      it('appendDraft fires draft.created exactly once, never again on an idempotency-key replay', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const { conversationId } = await store.createConversation(newConversation())

        const first = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'A draft.',
          idempotencyKey: 'event-key-1',
        })
        if (!first.ok) throw new Error('unreachable')

        // Replay with the SAME key: `created: false`, no second event.
        const replay = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'A draft.',
          idempotencyKey: 'event-key-1',
        })
        expect(replay).toMatchObject({ ok: true, created: false })

        const events = await outboxEventsFor(db, conversationId)
        expect(events).toEqual([
          { type: 'draft.created', data: { threadId: first.threadId, assistantId } },
        ])
      })

      it('appendDraft fires NO event when the conversation is missing or soft-deleted', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const { conversationId } = await store.createConversation(newConversation())
        await store.deleteConversation(conversationId)

        const result = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Stranded draft.',
          idempotencyKey: 'event-key-deleted',
        })
        expect(result).toMatchObject({ ok: false, reason: 'deleted' })
        expect(await outboxEventsFor(db, conversationId)).toEqual([])
      })

      it('resolveDraft(discard) fires draft.resolved with resolution=discarded, edited=false', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'To discard.',
          idempotencyKey: 'event-discard-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        await store.resolveDraft({
          action: 'discard',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
        })

        const events = await outboxEventsFor(db, conversationId)
        expect(events).toContainEqual({
          type: 'draft.resolved',
          data: { threadId: draft.threadId, resolution: 'discarded', edited: false },
        })
      })

      it('resolveDraft(approve) fires draft.resolved with resolution=approved and the real edited flag', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'To approve, edited.',
          idempotencyKey: 'event-approve-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        await store.resolveDraft({
          action: 'approve',
          threadId: draft.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edit: { bodyText: 'Edited body.' },
          edited: true,
        })

        const events = await outboxEventsFor(db, conversationId)
        expect(events).toContainEqual({
          type: 'draft.resolved',
          data: { threadId: draft.threadId, resolution: 'approved', edited: true },
        })
      })

      it('a resolveDraft call that matches no row (already resolved, unknown id) fires no event', async () => {
        const { store, db } = await freshStore()
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())

        const result = await store.resolveDraft({
          action: 'discard',
          threadId: RANDOM_UUID,
          resolvedByAgentId: agentId,
        })
        expect(result).toBeNull()
        expect(await outboxEventsFor(db, conversationId)).toEqual([])
      })
    })

    describe('getConversationByThreadId (HT-70)', () => {
      it('finds the conversation by ANY thread id within it, including the original inbound thread', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const { conversationId, threadId: inboundId } = await store.createConversation(
          newConversation(),
        )
        const draft = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'A draft.',
          idempotencyKey: 'lookup-1',
        })
        if (!draft.ok) throw new Error('unreachable')

        const byInbound = await store.getConversationByThreadId(inboundId)
        expect(byInbound?.id).toBe(conversationId)

        const byDraft = await store.getConversationByThreadId(draft.threadId)
        expect(byDraft?.id).toBe(conversationId)
        expect(byDraft?.threads.map((t) => t.id)).toEqual(
          expect.arrayContaining([inboundId, draft.threadId]),
        )
      })

      it('returns null for an unknown thread id', async () => {
        const { store } = await freshStore()
        expect(await store.getConversationByThreadId(RANDOM_UUID)).toBeNull()
      })

      it('with includeDeleted: false, a thread on a soft-deleted conversation is indistinguishable from unknown', async () => {
        const { store } = await freshStore()
        const { conversationId, threadId } = await store.createConversation(newConversation())
        await store.deleteConversation(conversationId)

        expect(await store.getConversationByThreadId(threadId)).not.toBeNull()
        expect(
          await store.getConversationByThreadId(threadId, { includeDeleted: false }),
        ).toBeNull()
      })
    })

    describe('threadCount/preview exclude unresolved and discarded drafts (HT-70, spec §7)', () => {
      it('listConversations: an awaiting_review draft is invisible to threadCount and preview', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const { conversationId } = await store.createConversation(newConversation())

        const before = (await store.listConversations({ limit: 10 })).find(
          (c) => c.id === conversationId,
        )
        expect(before?.threadCount).toBe(1)

        await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'A draft nobody has approved yet.',
          idempotencyKey: 'preview-1',
        })

        const after = (await store.listConversations({ limit: 10 })).find(
          (c) => c.id === conversationId,
        )
        // Still 1 — the draft does not count, and does not become the preview.
        expect(after?.threadCount).toBe(1)
        expect(after?.preview).not.toContain('A draft nobody has approved yet.')
      })

      it('listConversations: a discarded draft stays invisible; an APPROVED draft counts and can become the preview', async () => {
        const { store, db } = await freshStore()
        const assistantId = await createTestAssistant(db)
        const agentId = await createTestAgent(db)
        const { conversationId } = await store.createConversation(newConversation())

        const discarded = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Will be discarded.',
          idempotencyKey: 'preview-discard',
        })
        if (!discarded.ok) throw new Error('unreachable')
        await store.resolveDraft({
          action: 'discard',
          threadId: discarded.threadId,
          resolvedByAgentId: agentId,
        })

        const afterDiscard = (await store.listConversations({ limit: 10 })).find(
          (c) => c.id === conversationId,
        )
        expect(afterDiscard?.threadCount).toBe(1)

        const approved = await store.appendDraft(conversationId, {
          assistantId,
          bodyText: 'Will be approved and should become the preview.',
          idempotencyKey: 'preview-approve',
        })
        if (!approved.ok) throw new Error('unreachable')
        await store.resolveDraft({
          action: 'approve',
          threadId: approved.threadId,
          resolvedByAgentId: agentId,
          messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
          sendEnvelope: testEnvelope,
          inReplyTo: null,
          edited: false,
        })

        const afterApprove = (await store.listConversations({ limit: 10 })).find(
          (c) => c.id === conversationId,
        )
        expect(afterApprove?.threadCount).toBe(2)
        expect(afterApprove?.preview).toContain('Will be approved and should become the preview.')
      })
    })
  })

  describe('event emission (HT-69, spec §4)', () => {
    /** Insert a real `agents` row directly — setConversationAssignee's assignee_agent_id FKs to it. Same shape as the `tags & assignee`/`drafts` describe blocks' own local helpers (this file's convention: a small per-block helper rather than a shared one). */
    async function createTestAgent(db: Db, email = 'agent@example.test'): Promise<string> {
      const [row] = await db.query<{ id: string }>(
        `INSERT INTO agents (email, name, role, status) VALUES ($1, 'Agent', 'agent', 'active') RETURNING id`,
        [email],
      )
      return row.id
    }

    it('setConversationStatus emits conversation.status_changed with a thin {from,to} payload, in the SAME transaction — a rollback fires NOTHING', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const updated = await store.setConversationStatus(conversationId, 'closed')
      expect(updated).not.toBeNull()

      const events = await outboxEventsFor(db, conversationId)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('conversation.status_changed')
      // Thin payload: exactly {from, to} — never subject/customerEmail/etc.
      expect(Object.keys(events[0].data).sort()).toEqual(['from', 'to'])
      expect(events[0].data).toEqual({ from: 'active', to: 'closed' })

      // Rollback: force the event write itself to fail, and prove the STATUS
      // change rolled back with it (not just that no event landed).
      const failingStore = createConversationStore(dbFailingOutboxInsert(db))
      await expect(failingStore.setConversationStatus(conversationId, 'spam')).rejects.toThrow()
      const afterRollback = await store.getConversation(conversationId)
      expect(afterRollback?.status).toBe('closed') // unchanged — the failed attempt never committed
      expect(await outboxEventsFor(db, conversationId)).toHaveLength(1) // still just the first
    })

    it('re-asserting the SAME status is not a "transition" — fires nothing', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      await store.setConversationStatus(conversationId, 'active') // conversations start 'active'

      expect(await outboxEventsFor(db, conversationId)).toHaveLength(0)
    })

    it('setConversationTags emits conversation.tags_changed with a thin {tags} payload on every replace, even a no-op one', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      await store.setConversationTags(conversationId, ['billing', 'urgent'])
      await store.setConversationTags(conversationId, ['billing', 'urgent']) // same set again

      const events = await outboxEventsFor(db, conversationId)
      expect(events).toHaveLength(2)
      for (const event of events) {
        expect(event.type).toBe('conversation.tags_changed')
        expect(Object.keys(event.data)).toEqual(['tags'])
      }
      expect(events[0].data).toEqual({ tags: ['billing', 'urgent'] })

      const failingStore = createConversationStore(dbFailingOutboxInsert(db))
      await expect(
        failingStore.setConversationTags(conversationId, ['rolled-back']),
      ).rejects.toThrow()
      const afterRollback = await store.getConversation(conversationId)
      expect(afterRollback?.tags).toEqual(['billing', 'urgent']) // unchanged
      expect(await outboxEventsFor(db, conversationId)).toHaveLength(2) // still just the first two
    })

    it('setConversationAssignee emits conversation.assignee_changed with a thin {assigneeAgentId} payload, set or cleared', async () => {
      const { db, store } = await freshStore()
      const agentId = await createTestAgent(db)
      const { conversationId } = await store.createConversation(newConversation())

      await store.setConversationAssignee(conversationId, agentId)
      await store.setConversationAssignee(conversationId, null)

      const events = await outboxEventsFor(db, conversationId)
      expect(events).toHaveLength(2)
      for (const event of events) {
        expect(event.type).toBe('conversation.assignee_changed')
        expect(Object.keys(event.data)).toEqual(['assigneeAgentId'])
      }
      expect(events[0].data).toEqual({ assigneeAgentId: agentId })
      expect(events[1].data).toEqual({ assigneeAgentId: null })
    })

    it('setConversationAssignee: an invalid_agent FK failure fires no event (the UPDATE itself never committed)', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())

      const result = await store.setConversationAssignee(conversationId, RANDOM_UUID)

      expect(result).toBe('invalid_agent')
      expect(await outboxEventsFor(db, conversationId)).toHaveLength(0)
    })

    it("releaseThreadLease('sent') emits conversation.reply_sent with a thin {threadId,authorKind} payload; 'failed' fires nothing", async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const sentThread = await store.appendThread(conversationId, newThread())
      if (!sentThread.ok) throw new Error('unreachable')
      const failedThread = await store.appendThread(
        conversationId,
        newThread({ messageId: '<outbound-2@mail.example.test>' }),
      )
      if (!failedThread.ok) throw new Error('unreachable')

      await store.claimThreadForDelivery(sentThread.threadId, 30_000)
      await store.releaseThreadLease(sentThread.threadId, 'sent')
      await store.claimThreadForDelivery(failedThread.threadId, 30_000)
      await store.releaseThreadLease(failedThread.threadId, 'failed')

      const events = await outboxEventsFor(db, conversationId)
      expect(events).toHaveLength(1) // only the 'sent' one
      expect(events[0].type).toBe('conversation.reply_sent')
      expect(Object.keys(events[0].data).sort()).toEqual(['authorKind', 'threadId'])
      expect(events[0].data).toEqual({ threadId: sentThread.threadId, authorKind: 'agent' })
    })

    it("a thread stranded 'pending'/claimed when its conversation is soft-deleted still delivers ('sent' recorded) but fires NO event (spec §4's absolute soft-delete exclusion, review fix)", async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      const strandedThread = await store.appendThread(conversationId, newThread())
      if (!strandedThread.ok) throw new Error('unreachable')

      // Claim the lease FIRST (as the delivery worker/keyed retry would),
      // THEN the conversation is soft-deleted underneath it — mail delivery
      // is not conversation-status-scoped, so this claimed thread can still
      // be force-delivered after the fact.
      await store.claimThreadForDelivery(strandedThread.threadId, 30_000)
      const deleted = await store.deleteConversation(conversationId)
      expect(deleted).toBe(true)

      await store.releaseThreadLease(strandedThread.threadId, 'sent')

      // The delivery status write itself is honest and unaffected — the
      // mail really did go out (charter invariant #1).
      const raw = await store.getConversation(conversationId)
      const thread = raw?.threads.find((t) => t.id === strandedThread.threadId)
      expect(thread?.deliveryStatus).toBe('sent')

      // But NO event fired — soft delete fires nothing, ever, with no
      // exception for a delivery that happened to land after the fact.
      expect(await outboxEventsFor(db, conversationId)).toHaveLength(0)
    })

    it('soft delete fires NOTHING, ever — deleting a conversation with prior events adds no new row for the deletion', async () => {
      const { db, store } = await freshStore()
      const { conversationId } = await store.createConversation(newConversation())
      await store.setConversationStatus(conversationId, 'closed') // one event, for the baseline
      const before = await outboxEventsFor(db, conversationId)
      expect(before).toHaveLength(1)

      const deleted = await store.deleteConversation(conversationId)
      expect(deleted).toBe(true)

      const after = await outboxEventsFor(db, conversationId)
      expect(after).toHaveLength(1) // unchanged — the delete itself added nothing
      expect(after).toEqual(before)

      // And every write path on a now-deleted conversation is a no-op that
      // also fires nothing (the null/invalid-agent returns are already
      // covered elsewhere; this just confirms zero NEW event rows).
      await store.setConversationStatus(conversationId, 'active')
      await store.setConversationTags(conversationId, ['x'])
      expect(await outboxEventsFor(db, conversationId)).toHaveLength(1)
    })
  })
})
