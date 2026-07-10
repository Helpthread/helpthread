import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import {
  type ConversationStore,
  createConversationStore,
  type NewConversation,
} from '../store/conversations.js'
import { createInboxApi } from './index.js'

const TOKEN = 'test-token-used-across-the-inbox-api-suite'
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

async function setStatus(db: Db, conversationId: string, status: 'open' | 'closed' | 'deleted') {
  await db.query('UPDATE conversations SET status = $1 WHERE id = $2', [status, conversationId])
}

async function setUpdatedAt(db: Db, conversationId: string, updatedAt: Date) {
  await db.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [
    updatedAt,
    conversationId,
  ])
}

/**
 * Build a `Request` for `path`, with `Authorization: Bearer <token>` unless
 * `token` is explicitly `undefined` (meaning: omit the header entirely).
 * Uses a rest parameter rather than a default value so `get(path,
 * undefined)` reliably means "no token" — a plain default parameter would
 * substitute `TOKEN` for an explicitly-passed `undefined`, which is exactly
 * backwards for the "missing header" test cases below.
 */
function get(path: string, ...tokenArg: [string | undefined] | []): Request {
  const token = tokenArg.length > 0 ? tokenArg[0] : TOKEN
  const headers: Record<string, string> = {}
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`
  }
  return new Request(`https://x.example.test${path}`, { headers })
}

describe('createInboxApi', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshApi(): Promise<{
    db: Db
    store: ConversationStore
    api: (request: Request) => Promise<Response>
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const store = createConversationStore(db)
    const api = createInboxApi({ store, apiToken: TOKEN })
    return { db, store, api }
  }

  // --- auth ------------------------------------------------------------------

  describe('auth', () => {
    it('401s with the error envelope when the Authorization header is missing', async () => {
      const { api } = await freshApi()
      const res = await api(get('/api/v1/conversations', undefined))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({
        error: { code: 'unauthorized', message: expect.any(String) },
      })
    })

    it('401s for a wrong scheme', async () => {
      const { api } = await freshApi()
      const req = new Request('https://x.example.test/api/v1/conversations', {
        headers: { Authorization: `Basic ${TOKEN}` },
      })
      const res = await api(req)
      expect(res.status).toBe(401)
    })

    it('401s for a wrong token of the SAME length as the real one', async () => {
      const { api } = await freshApi()
      const wrongSameLength = `${TOKEN.slice(0, -1)}${TOKEN.at(-1) === 'x' ? 'y' : 'x'}`
      expect(wrongSameLength).toHaveLength(TOKEN.length)
      const res = await api(get('/api/v1/conversations', wrongSameLength))
      expect(res.status).toBe(401)
    })

    it('401s for a wrong token of a DIFFERENT length than the real one', async () => {
      const { api } = await freshApi()
      const res = await api(get('/api/v1/conversations', 'short'))
      expect(res.status).toBe(401)
    })

    it('200s for the correct token', async () => {
      const { api } = await freshApi()
      const res = await api(get('/api/v1/conversations'))
      expect(res.status).toBe(200)
    })

    it('401 comes before routing details leak: an unauthenticated request to an unknown path is still 401, not 404', async () => {
      const { api } = await freshApi()
      const res = await api(get('/api/v1/nope', undefined))
      expect(res.status).toBe(401)
    })
  })

  // --- list ------------------------------------------------------------------

  describe('list', () => {
    it('orders updatedAt desc; bumping a conversation via append moves it to the top', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId: a } = await store.createConversation(newConversation())
      const { conversationId: b } = await store.createConversation(newConversation())
      await setUpdatedAt(db, a, new Date('2026-01-01T00:00:00.000Z'))
      await setUpdatedAt(db, b, new Date('2026-01-02T00:00:00.000Z'))

      let res = await api(get('/api/v1/conversations'))
      let body = (await res.json()) as { conversations: Array<{ id: string }> }
      expect(body.conversations.map((c) => c.id)).toEqual([b, a])

      await store.appendThread(a, {
        direction: 'outbound',
        messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
        fromAddress: 'support@example.test',
        bodyText: 'bump',
      })

      res = await api(get('/api/v1/conversations'))
      body = (await res.json()) as { conversations: Array<{ id: string }> }
      expect(body.conversations.map((c) => c.id)).toEqual([a, b])
    })

    it('filters by status: open vs closed', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId: openId } = await store.createConversation(newConversation())
      const { conversationId: closedId } = await store.createConversation(newConversation())
      await setStatus(db, closedId, 'closed')

      const openRes = await api(get('/api/v1/conversations?status=open'))
      const openBody = (await openRes.json()) as { conversations: Array<{ id: string }> }
      expect(openBody.conversations.map((c) => c.id)).toEqual([openId])

      const closedRes = await api(get('/api/v1/conversations?status=closed'))
      const closedBody = (await closedRes.json()) as { conversations: Array<{ id: string }> }
      expect(closedBody.conversations.map((c) => c.id)).toEqual([closedId])
    })

    it('rejects an invalid status value with 400', async () => {
      const { api } = await freshApi()
      const res = await api(get('/api/v1/conversations?status=deleted'))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
    })

    it('a deleted conversation never appears, filtered or not', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId: openId } = await store.createConversation(newConversation())
      const { conversationId: deletedId } = await store.createConversation(newConversation())
      await setStatus(db, deletedId, 'deleted')

      const res = await api(get('/api/v1/conversations'))
      const body = (await res.json()) as { conversations: Array<{ id: string }> }
      expect(body.conversations.map((c) => c.id)).toEqual([openId])
    })

    it('clamps limit above the max and rejects non-numeric limit', async () => {
      const { store, api } = await freshApi()
      for (let i = 0; i < 3; i++) {
        await store.createConversation(newConversation())
      }

      const res = await api(get('/api/v1/conversations?limit=9999'))
      const body = (await res.json()) as { conversations: unknown[] }
      expect(body.conversations).toHaveLength(3) // clamped to 50, but only 3 exist

      const badRes = await api(get('/api/v1/conversations?limit=notanumber'))
      expect(badRes.status).toBe(400)
    })

    it('paginates via nextCursor: walking two pages covers everything with no overlap or gap, and the final nextCursor is null', async () => {
      const { db, store, api } = await freshApi()
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const { conversationId } = await store.createConversation(newConversation())
        await setUpdatedAt(db, conversationId, new Date(2026, 0, i + 1))
        ids.push(conversationId)
      }
      const expectedOrder = [...ids].reverse()

      const page1Res = await api(get('/api/v1/conversations?limit=2'))
      const page1 = (await page1Res.json()) as {
        conversations: Array<{ id: string }>
        nextCursor: string | null
      }
      expect(page1.conversations.map((c) => c.id)).toEqual(expectedOrder.slice(0, 2))
      expect(page1.nextCursor).not.toBeNull()

      const page2Res = await api(
        get(
          `/api/v1/conversations?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
        ),
      )
      const page2 = (await page2Res.json()) as {
        conversations: Array<{ id: string }>
        nextCursor: string | null
      }
      expect(page2.conversations.map((c) => c.id)).toEqual(expectedOrder.slice(2, 4))
      expect(page2.nextCursor).not.toBeNull()

      const page3Res = await api(
        get(
          `/api/v1/conversations?limit=2&cursor=${encodeURIComponent(page2.nextCursor as string)}`,
        ),
      )
      const page3 = (await page3Res.json()) as {
        conversations: Array<{ id: string }>
        nextCursor: string | null
      }
      expect(page3.conversations.map((c) => c.id)).toEqual(expectedOrder.slice(4, 5))
      expect(page3.nextCursor).toBeNull()

      const walked = [...page1.conversations, ...page2.conversations, ...page3.conversations].map(
        (c) => c.id,
      )
      expect(walked).toEqual(expectedOrder)
    })

    it('rejects a malformed cursor with 400', async () => {
      const { api } = await freshApi()
      const res = await api(get('/api/v1/conversations?cursor=not-a-real-cursor!!!'))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
    })
  })

  // --- get -------------------------------------------------------------------

  describe('get', () => {
    it('returns the conversation with its threads oldest-first, ThreadView-shaped', async () => {
      const { store, api } = await freshApi()
      const { conversationId, threadId } = await store.createConversation(newConversation())
      await store.appendThread(conversationId, {
        direction: 'outbound',
        messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
        fromAddress: 'support@example.test',
        bodyText: 'Looking into it!',
        bodyHtml: '<p>Looking into it!</p>',
      })

      const res = await api(get(`/api/v1/conversations/${conversationId}`))
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        id: string
        subject: string
        customerEmail: string
        status: string
        threadCount: number
        threads: Array<{
          id: string
          direction: string
          from: string
          bodyText: string | null
          bodyHtml: string | null
          deliveryStatus: string | null
          createdAt: string
        }>
      }

      expect(body.id).toBe(conversationId)
      expect(body.subject).toBe('Help with my order')
      expect(body.customerEmail).toBe('customer@example.test')
      expect(body.status).toBe('open')
      expect(body.threadCount).toBe(2)
      expect(body.threads).toHaveLength(2)
      expect(body.threads[0]).toMatchObject({
        id: threadId,
        direction: 'inbound',
        from: 'customer@example.test',
        bodyText: 'Where is my order?',
        deliveryStatus: null,
      })
      expect(body.threads[1]).toMatchObject({
        direction: 'outbound',
        from: 'support@example.test',
        bodyText: 'Looking into it!',
        bodyHtml: '<p>Looking into it!</p>',
        deliveryStatus: 'pending',
      })
      expect(typeof body.threads[0].createdAt).toBe('string')
    })

    it('404s for an unknown id', async () => {
      const { api } = await freshApi()
      const res = await api(get(`/api/v1/conversations/${RANDOM_UUID}`))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
    })

    it('404s for a deleted conversation (not 200) — indistinguishable from nonexistent', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')

      const res = await api(get(`/api/v1/conversations/${conversationId}`))
      expect(res.status).toBe(404)
    })
  })

  // --- conventions -------------------------------------------------------------

  describe('conventions', () => {
    it('every response — 200 and errors alike — carries Cache-Control: no-store', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const ok = await api(get('/api/v1/conversations'))
      expect(ok.headers.get('Cache-Control')).toBe('no-store')

      const getOk = await api(get(`/api/v1/conversations/${conversationId}`))
      expect(getOk.headers.get('Cache-Control')).toBe('no-store')

      const unauthorized = await api(get('/api/v1/conversations', undefined))
      expect(unauthorized.headers.get('Cache-Control')).toBe('no-store')

      const notFound = await api(get('/api/v1/nope'))
      expect(notFound.headers.get('Cache-Control')).toBe('no-store')

      const methodNotAllowed = await api(
        new Request('https://x.example.test/api/v1/conversations', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
      expect(methodNotAllowed.headers.get('Cache-Control')).toBe('no-store')
    })

    it('an unknown path is 404', async () => {
      const { api } = await freshApi()
      const res = await api(get('/api/v1/nope'))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
    })

    it('a known path with an unsupported method is 405 with an Allow header', async () => {
      const { api } = await freshApi()
      const res = await api(
        new Request('https://x.example.test/api/v1/conversations', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET')
      expect(await res.json()).toEqual({
        error: { code: expect.any(String), message: expect.any(String) },
      })
    })
  })
})

describe('createInboxApi — hardening (Codex review)', () => {
  const dummyStore = {} as unknown as ConversationStore

  it('throws at construction on an empty apiToken (fail closed — an empty token would authenticate every request)', () => {
    expect(() => createInboxApi({ store: dummyStore, apiToken: '' })).toThrow()
  })

  it('throws at construction on a too-short apiToken', () => {
    expect(() => createInboxApi({ store: dummyStore, apiToken: 'short' })).toThrow()
  })

  it('a non-UUID conversation id is 404 — it never reaches the uuid column, so no invalid-uuid 500', async () => {
    const api = createInboxApi({ store: dummyStore, apiToken: TOKEN })
    const res = await api(get('/api/v1/conversations/not-a-uuid'))
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    })
  })

  it('an unexpected handler error is a 500 with the error envelope + no-store, leaking nothing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwingStore = {
      listConversations: async () => {
        throw new Error('boom: store internals that must never reach the client')
      },
    } as unknown as ConversationStore
    const api = createInboxApi({ store: throwingStore, apiToken: TOKEN })

    const res = await api(get('/api/v1/conversations'))
    expect(res.status).toBe(500)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body).toEqual({ error: { code: 'server_error', message: expect.any(String) } })
    // The generic message must NOT carry the internal error text.
    expect(JSON.stringify(body)).not.toContain('boom')
    errorSpy.mockRestore()
  })
})
