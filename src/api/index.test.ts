import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import {
  type ConversationStore,
  createConversationStore,
  type NewConversation,
} from '../store/conversations.js'
import { createInboxApi } from './index.js'

const TOKEN = 'test-token-used-across-the-inbox-api-suite'
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'
const SUPPORT_ADDRESS = 'support@example.test'
const MAIL_DOMAIN = 'mail.example.test'
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }

/** A fake `EmailSender` that records every `OutboundEmail` it's asked to send, never fails. */
function createFakeSender(): { sender: EmailSender; sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = []
  return {
    sender: {
      async send(email) {
        sent.push(email)
        return {}
      },
    },
    sent,
  }
}

/** An `EmailSender` that always rejects — for exercising the `502 send_failed` path. */
function createThrowingSender(): EmailSender {
  return {
    async send() {
      throw new Error('provider rejected the message (must never leak to the client)')
    },
  }
}

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

/** Same `token`-omission convention as {@link get}, for `POST`/`PATCH` requests with a JSON body. */
function withJsonBody(
  method: string,
  path: string,
  body: string,
  tokenArg: [string | undefined] | [],
): Request {
  const token = tokenArg.length > 0 ? tokenArg[0] : TOKEN
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`
  }
  return new Request(`https://x.example.test${path}`, { method, headers, body })
}

function post(path: string, body: unknown, ...tokenArg: [string | undefined] | []): Request {
  return withJsonBody('POST', path, JSON.stringify(body), tokenArg)
}

/** Like {@link post}, but sends `rawBody` verbatim — for exercising a malformed/non-JSON body. */
function postRaw(path: string, rawBody: string, ...tokenArg: [string | undefined] | []): Request {
  return withJsonBody('POST', path, rawBody, tokenArg)
}

function patch(path: string, body: unknown, ...tokenArg: [string | undefined] | []): Request {
  return withJsonBody('PATCH', path, JSON.stringify(body), tokenArg)
}

/** Like {@link patch}, but sends `rawBody` verbatim — for exercising a malformed/non-JSON body. */
function patchRaw(path: string, rawBody: string, ...tokenArg: [string | undefined] | []): Request {
  return withJsonBody('PATCH', path, rawBody, tokenArg)
}

/** The `Idempotency-Key` most `replyPost` calls use, unless a test overrides it. */
const DEFAULT_IDEMPOTENCY_KEY = 'test-idempotency-key'

/**
 * Like {@link post}, but for `POST .../replies` (HT-16 requires an
 * `Idempotency-Key` header on every call to that route). Defaults to
 * {@link DEFAULT_IDEMPOTENCY_KEY}; pass `idempotencyKey: null` to omit the
 * header entirely (for exercising the "missing header" 400), or a specific
 * string to control replay/collision scenarios.
 */
function replyPost(
  path: string,
  body: unknown,
  options: { idempotencyKey?: string | null } = {},
): Request {
  const key =
    options.idempotencyKey === undefined ? DEFAULT_IDEMPOTENCY_KEY : options.idempotencyKey
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
  }
  if (key !== null) {
    headers['Idempotency-Key'] = key
  }
  return new Request(`https://x.example.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('createInboxApi', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshApi(overrides: { sender?: EmailSender } = {}): Promise<{
    db: Db
    store: ConversationStore
    api: (request: Request) => Promise<Response>
    /** Emails recorded by the default fake sender (empty if `overrides.sender` was supplied instead). */
    sent: OutboundEmail[]
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const store = createConversationStore(db)
    const { sender: defaultSender, sent } = createFakeSender()
    const api = createInboxApi({
      store,
      apiToken: TOKEN,
      sender: overrides.sender ?? defaultSender,
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
    })
    return { db, store, api, sent }
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

  // --- reply -------------------------------------------------------------------

  describe('reply', () => {
    it('happy path: 201 with the outbound ThreadView; the fake sender received the derived headers verbatim; getConversation shows the outbound thread', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'On it!' }),
      )
      expect(res.status).toBe(201)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      const body = (await res.json()) as {
        id: string
        direction: string
        bodyText: string | null
        deliveryStatus: string | null
      }
      expect(body).toMatchObject({
        direction: 'outbound',
        bodyText: 'On it!',
        deliveryStatus: 'sent',
      })

      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        to: ['customer@example.test'],
        from: SUPPORT_ADDRESS,
        subject: 'Re: Help with my order',
        inReplyTo: '<inbound-1@customer.example.test>',
        references: ['<inbound-1@customer.example.test>'],
      })

      const updated = await store.getConversation(conversationId, { includeDeleted: false })
      const outboundThread = updated?.threads.find((t) => t.id === body.id)
      expect(outboundThread).toBeDefined()
      expect(outboundThread?.direction).toBe('outbound')
      expect(outboundThread?.deliveryStatus).toBe('sent')
      // The engine-minted Message-ID is transmitted verbatim (providers/email-sender.ts's contract).
      expect(sent[0].messageId).toBe(outboundThread?.messageId)
    })

    it('sent-but-mark-sent-fails still returns 201, not 502 (the message WAS delivered — never prompt a resend)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      db = await createPgliteDb()
      await migrate(db)
      const realStore = createConversationStore(db)
      const { conversationId } = await realStore.createConversation(newConversation())
      const { sender, sent } = createFakeSender()
      // Provider accepts, then recording the status throws — the double-send trap.
      const store: ConversationStore = {
        ...realStore,
        async setThreadDeliveryStatus() {
          throw new Error('db blip right after a successful send')
        },
      }
      const api = createInboxApi({
        store,
        apiToken: TOKEN,
        sender,
        keyring: KEYRING,
        mailDomain: MAIL_DOMAIN,
        supportAddress: SUPPORT_ADDRESS,
      })

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'On it!' }),
      )
      expect(res.status).toBe(201) // delivered → success, NOT a 502 that would invite a resend
      expect(sent).toHaveLength(1) // the email really went out
      errorSpy.mockRestore()
    })

    it('does not double-prefix a subject that already starts with "Re: "', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(
        newConversation({ subject: 'Re: Already replied' }),
      )

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'Following up.' }),
      )
      expect(res.status).toBe(201)
      expect(sent[0].subject).toBe('Re: Already replied')
    })

    it('a reply reopens a closed conversation', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'closed')

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'Reopening.' }),
      )
      expect(res.status).toBe(201)

      const updated = await store.getConversation(conversationId, { includeDeleted: false })
      expect(updated?.status).toBe('open')
    })

    it('404s for a missing conversation id; the sender is never called', async () => {
      const { api, sent } = await freshApi()
      const res = await api(
        replyPost(`/api/v1/conversations/${RANDOM_UUID}/replies`, { text: 'Hi' }),
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
      expect(sent).toHaveLength(0)
    })

    it('404s for a deleted conversation; the sender is never called', async () => {
      const { db, store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'Hi' }),
      )
      expect(res.status).toBe(404)
      expect(sent).toHaveLength(0)
    })

    it('404s for a non-UUID-shaped id — never reaches the uuid column', async () => {
      const { api, sent } = await freshApi()
      const res = await api(replyPost('/api/v1/conversations/not-a-uuid/replies', { text: 'Hi' }))
      expect(res.status).toBe(404)
      expect(sent).toHaveLength(0)
    })

    it('404s when the conversation is deleted between the initial fetch and the append (race)', async () => {
      const db = await createPgliteDb()
      await migrate(db)
      const realStore = createConversationStore(db)
      const { conversationId } = await realStore.createConversation(newConversation())

      // Simulate appendThread discovering the conversation gone (deleted/missing)
      // AFTER handleReply's own getConversation already found it present —
      // the narrow race window the spec's 404 branch exists for.
      const racedStore: ConversationStore = {
        ...realStore,
        appendThread: async () => ({ ok: false, reason: 'not-found' }),
      }

      const { sender, sent } = createFakeSender()
      const api = createInboxApi({
        store: racedStore,
        apiToken: TOKEN,
        sender,
        keyring: KEYRING,
        mailDomain: MAIL_DOMAIN,
        supportAddress: SUPPORT_ADDRESS,
      })

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'Hi' }),
      )
      expect(res.status).toBe(404)
      expect(sent).toHaveLength(0)

      await db.close()
    })

    it('400s on a missing text field; the sender is never called', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(replyPost(`/api/v1/conversations/${conversationId}/replies`, {}))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
      expect(sent).toHaveLength(0)
    })

    it('400s on text over 5000 chars; the sender is never called', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'a'.repeat(5001) }),
      )
      expect(res.status).toBe(400)
      expect(sent).toHaveLength(0)
    })

    it('400s on a non-JSON body; the sender is never called', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      // A valid Idempotency-Key header is present so this test isolates the
      // JSON-parse failure specifically, not the header check.
      const req = postRaw(`/api/v1/conversations/${conversationId}/replies`, 'not json{')
      req.headers.set('Idempotency-Key', DEFAULT_IDEMPOTENCY_KEY)
      const res = await api(req)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
      expect(sent).toHaveLength(0)
    })

    it('missing Idempotency-Key header is 400 validation_failed; the sender is never called', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'Hi' },
          { idempotencyKey: null },
        ),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
      expect(sent).toHaveLength(0)
    })

    it('an empty Idempotency-Key header is also 400 validation_failed', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'Hi' },
          { idempotencyKey: '' },
        ),
      )
      expect(res.status).toBe(400)
      expect(sent).toHaveLength(0)
    })

    it('an Idempotency-Key over 255 characters (after trimming) is 400 validation_failed; the sender is never called', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'Hi' },
          { idempotencyKey: `  ${'a'.repeat(256)}  ` },
        ),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
      expect(sent).toHaveLength(0)
    })

    it('leading/trailing whitespace in Idempotency-Key is trimmed before comparison — a whitespace-padded key and its trimmed twin replay the SAME send (one send only)', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      const trimmedKey = 'padded-key-replay'
      // U+00A0 (NO-BREAK SPACE), not a plain ASCII space/tab: the WHATWG
      // `Headers` implementation already strips ORDINARY HTTP optional
      // whitespace (space/tab) from a header value before this handler ever
      // sees it, so padding with plain spaces would pass even without our
      // own `.trim()`. NBSP is whitespace to JS's `String.prototype.trim()`
      // but NOT stripped by `Headers`, so this specifically exercises the
      // application-level trim this fix adds.
      const paddedKey = `\u00A0${trimmedKey}\u00A0`

      const first = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'On it!' },
          { idempotencyKey: paddedKey },
        ),
      )
      expect(first.status).toBe(201)
      const firstBody = await first.json()

      // The replay supplies the SAME logical key with no padding at all — it
      // must be recognized as the identical key, not a distinct one, so the
      // sender is not invoked a second time.
      const second = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'A completely different message' },
          { idempotencyKey: trimmedKey },
        ),
      )
      expect(second.status).toBe(201)
      const secondBody = await second.json()

      expect(secondBody).toEqual(firstBody)
      expect(sent).toHaveLength(1) // the sender was invoked exactly once, for the FIRST call
    })

    it('replay of a sent reply: SAME key on the SAME conversation returns 201 with the ORIGINAL ThreadView, sender not re-invoked', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      const key = 'reply-replay-key'

      const first = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'On it!' },
          { idempotencyKey: key },
        ),
      )
      expect(first.status).toBe(201)
      const firstBody = await first.json()

      // The replay deliberately supplies a DIFFERENT body — same key, same
      // conversation is treated as the SAME logical send; the body is never
      // re-diffed.
      const second = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'A completely different message' },
          { idempotencyKey: key },
        ),
      )
      expect(second.status).toBe(201)
      const secondBody = await second.json()

      expect(secondBody).toEqual(firstBody)
      expect(sent).toHaveLength(1) // the sender was invoked exactly once, for the FIRST call
    })

    it('replay while a delivery attempt for the same key is in progress is 409 retry_in_progress', async () => {
      db = await createPgliteDb()
      await migrate(db)
      const realStore = createConversationStore(db)
      const { conversationId } = await realStore.createConversation(newConversation())
      const key = 'leased-key'

      // Seed a 'failed' row under this key directly via the store, then hold
      // its delivery lease — simulating another in-flight attempt (a worker
      // sweep, or a concurrent request) currently sending it.
      const seeded = await realStore.appendThread(conversationId, {
        id: '11111111-1111-4111-8111-111111111111',
        direction: 'outbound',
        messageId: '<ht.k1.leased.sig@mail.example.test>',
        fromAddress: SUPPORT_ADDRESS,
        bodyText: 'On it!',
        deliveryStatus: 'failed',
        idempotencyKey: key,
        sendEnvelope: { to: ['customer@example.test'], subject: 'Re: Help with my order' },
      })
      if (!seeded.ok) throw new Error('unreachable')
      await realStore.claimThreadForDelivery(seeded.threadId, 30_000)

      const { sender, sent } = createFakeSender()
      const api = createInboxApi({
        store: realStore,
        apiToken: TOKEN,
        sender,
        keyring: KEYRING,
        mailDomain: MAIL_DOMAIN,
        supportAddress: SUPPORT_ADDRESS,
      })

      const res = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'On it!' },
          { idempotencyKey: key },
        ),
      )
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: { code: 'retry_in_progress', message: expect.any(String) },
      })
      expect(sent).toHaveLength(0)
    })

    it('502s when the EmailSender throws; the outbound thread persists with deliveryStatus "failed"', async () => {
      const { store, api } = await freshApi({ sender: createThrowingSender() })
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'On it!' }),
      )
      expect(res.status).toBe(502)
      const body = await res.json()
      expect(body).toEqual({ error: { code: 'send_failed', message: expect.any(String) } })
      expect(JSON.stringify(body)).not.toContain('provider rejected')

      const updated = await store.getConversation(conversationId, { includeDeleted: false })
      const outboundThread = updated?.threads.find((t) => t.direction === 'outbound')
      expect(outboundThread).toBeDefined()
      expect(outboundThread?.deliveryStatus).toBe('failed')
    })

    it('401s without a token, before any routing/handler logic runs', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        post(`/api/v1/conversations/${conversationId}/replies`, { text: 'Hi' }, undefined),
      )
      expect(res.status).toBe(401)
      expect(sent).toHaveLength(0)
    })
  })

  // --- patch (status) -----------------------------------------------------------

  describe('patch status', () => {
    it('closes an open conversation: 200 with the updated summary', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(patch(`/api/v1/conversations/${conversationId}`, { status: 'closed' }))
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      const body = (await res.json()) as { id: string; status: string }
      expect(body.id).toBe(conversationId)
      expect(body.status).toBe('closed')
    })

    it('reopens a closed conversation: 200 with the updated summary', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'closed')

      const res = await api(patch(`/api/v1/conversations/${conversationId}`, { status: 'open' }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string }
      expect(body.status).toBe('open')
    })

    it('404s for a missing conversation id', async () => {
      const { api } = await freshApi()
      const res = await api(patch(`/api/v1/conversations/${RANDOM_UUID}`, { status: 'open' }))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
    })

    it('404s for a non-UUID-shaped id — never reaches the uuid column', async () => {
      const { api } = await freshApi()
      const res = await api(patch('/api/v1/conversations/not-a-uuid', { status: 'open' }))
      expect(res.status).toBe(404)
    })

    it('404s for a deleted conversation — not reopenable through this endpoint', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')

      const res = await api(patch(`/api/v1/conversations/${conversationId}`, { status: 'open' }))
      expect(res.status).toBe(404)
    })

    it('400s on status "deleted" — not settable through this endpoint', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(patch(`/api/v1/conversations/${conversationId}`, { status: 'deleted' }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
    })

    it('400s on a nonsense status value', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        patch(`/api/v1/conversations/${conversationId}`, { status: 'nonsense' }),
      )
      expect(res.status).toBe(400)
    })

    it('400s on a non-JSON body', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(patchRaw(`/api/v1/conversations/${conversationId}`, 'not json{'))
      expect(res.status).toBe(400)
    })

    it('401s without a token', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        patch(`/api/v1/conversations/${conversationId}`, { status: 'closed' }, undefined),
      )
      expect(res.status).toBe(401)
    })
  })

  // --- method routing (HT-18 additions) ------------------------------------------

  describe('method routing', () => {
    it('PATCH on the collection route is 405 with Allow: GET', async () => {
      const { api } = await freshApi()
      const res = await api(
        new Request('https://x.example.test/api/v1/conversations', {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET')
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('DELETE on the item route is 405 with Allow: GET, PATCH', async () => {
      const { api } = await freshApi()
      const res = await api(
        new Request(`https://x.example.test/api/v1/conversations/${RANDOM_UUID}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET, PATCH')
    })

    it('GET on the replies route is 405 with Allow: POST', async () => {
      const { api } = await freshApi()
      const res = await api(get(`/api/v1/conversations/${RANDOM_UUID}/replies`))
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
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
  const dummySender = createThrowingSender()
  const dummyDeps = {
    sender: dummySender,
    keyring: KEYRING,
    mailDomain: MAIL_DOMAIN,
    supportAddress: SUPPORT_ADDRESS,
  }

  it('throws at construction on an empty apiToken (fail closed — an empty token would authenticate every request)', () => {
    expect(() => createInboxApi({ store: dummyStore, apiToken: '', ...dummyDeps })).toThrow()
  })

  it('throws at construction on a too-short apiToken', () => {
    expect(() => createInboxApi({ store: dummyStore, apiToken: 'short', ...dummyDeps })).toThrow()
  })

  it('a non-UUID conversation id is 404 — it never reaches the uuid column, so no invalid-uuid 500', async () => {
    const api = createInboxApi({ store: dummyStore, apiToken: TOKEN, ...dummyDeps })
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
    const api = createInboxApi({ store: throwingStore, apiToken: TOKEN, ...dummyDeps })

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
