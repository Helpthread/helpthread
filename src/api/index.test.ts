import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type {
  EmailSender,
  EnqueueOptions,
  OutboundEmail,
  QueueProvider,
} from '../providers/index.js'
import {
  type ConversationStore,
  createConversationStore,
  type NewConversation,
} from '../store/conversations.js'
import { createMailboxStore } from '../store/mailboxes.js'
import type { GmailReconcileJob } from './gmail-webhook.js'
import { createInboxApi, type InboxApiDeps } from './index.js'

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
      maxSendMs: 30_000,
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
    maxSendMs: 30_000,
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

async function setStatus(
  db: Db,
  conversationId: string,
  status: 'active' | 'pending' | 'closed' | 'spam' | 'deleted',
) {
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

  async function freshApi(
    overrides: {
      sender?: EmailSender
      openTracking?: { publicBaseUrl: string }
      gmailPush?: InboxApiDeps['gmailPush']
    } = {},
  ): Promise<{
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
      ...(overrides.openTracking !== undefined ? { openTracking: overrides.openTracking } : {}),
      ...(overrides.gmailPush !== undefined ? { gmailPush: overrides.gmailPush } : {}),
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

    it('filters by folder: open is active + pending; closed and spam are exact (spec §3a, v1.1)', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId: activeId } = await store.createConversation(newConversation())
      const { conversationId: pendingId } = await store.createConversation(newConversation())
      const { conversationId: closedId } = await store.createConversation(newConversation())
      const { conversationId: spamId } = await store.createConversation(newConversation())
      await setStatus(db, pendingId, 'pending')
      await setStatus(db, closedId, 'closed')
      await setStatus(db, spamId, 'spam')

      const openRes = await api(get('/api/v1/conversations?status=open'))
      const openBody = (await openRes.json()) as {
        conversations: Array<{ id: string; status: string }>
      }
      expect(openBody.conversations.map((c) => c.id).sort()).toEqual([activeId, pendingId].sort())
      // The wire summary carries the REAL status — the query param is the folder.
      expect(openBody.conversations.find((c) => c.id === pendingId)?.status).toBe('pending')

      const closedRes = await api(get('/api/v1/conversations?status=closed'))
      const closedBody = (await closedRes.json()) as { conversations: Array<{ id: string }> }
      expect(closedBody.conversations.map((c) => c.id)).toEqual([closedId])

      const spamRes = await api(get('/api/v1/conversations?status=spam'))
      const spamBody = (await spamRes.json()) as { conversations: Array<{ id: string }> }
      expect(spamBody.conversations.map((c) => c.id)).toEqual([spamId])
    })

    it("rejects raw statuses as filter values — 'active' and 'pending' are not folders", async () => {
      const { api } = await freshApi()
      for (const value of ['active', 'pending']) {
        const res = await api(get(`/api/v1/conversations?status=${value}`))
        expect(res.status).toBe(400)
      }
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
      expect(body.status).toBe('active')
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

    it('a reply reopens a closed conversation to active', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'closed')

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'Reopening.' }),
      )
      expect(res.status).toBe(201)

      const updated = await store.getConversation(conversationId, { includeDeleted: false })
      expect(updated?.status).toBe('active')
    })

    it('a reply reopens a spam conversation to active (spec §4a, v1.1)', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'spam')

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, {
          text: 'Not spam after all.',
        }),
      )
      expect(res.status).toBe(201)

      const updated = await store.getConversation(conversationId, { includeDeleted: false })
      expect(updated?.status).toBe('active')
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
    it('closes an active conversation: 200 with the updated summary', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(patch(`/api/v1/conversations/${conversationId}`, { status: 'closed' }))
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      const body = (await res.json()) as { id: string; status: string }
      expect(body.id).toBe(conversationId)
      expect(body.status).toBe('closed')
    })

    it('reopens a closed conversation to active: 200 with the updated summary', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'closed')

      const res = await api(patch(`/api/v1/conversations/${conversationId}`, { status: 'active' }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { status: string }
      expect(body.status).toBe('active')
    })

    it('sets pending and spam: every surfaceable status is settable (spec §4b, v1.1)', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      for (const status of ['pending', 'spam'] as const) {
        const res = await api(patch(`/api/v1/conversations/${conversationId}`, { status }))
        expect(res.status).toBe(200)
        const body = (await res.json()) as { status: string }
        expect(body.status).toBe(status)
      }
    })

    it('404s for a missing conversation id', async () => {
      const { api } = await freshApi()
      const res = await api(patch(`/api/v1/conversations/${RANDOM_UUID}`, { status: 'active' }))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
    })

    it('404s for a non-UUID-shaped id — never reaches the uuid column', async () => {
      const { api } = await freshApi()
      const res = await api(patch('/api/v1/conversations/not-a-uuid', { status: 'active' }))
      expect(res.status).toBe(404)
    })

    it('404s for a deleted conversation — not reachable through this endpoint', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')

      const res = await api(patch(`/api/v1/conversations/${conversationId}`, { status: 'active' }))
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

  // --- delete (HT-30, spec §4d v1.1) ----------------------------------------------

  describe('delete', () => {
    /** A `DELETE` request for `path`, Bearer-authenticated unless `token` is explicitly omitted. */
    function del(path: string, ...tokenArg: [string | undefined] | []): Request {
      const token = tokenArg.length > 0 ? tokenArg[0] : TOKEN
      const headers: Record<string, string> = {}
      if (token !== undefined) {
        headers.Authorization = `Bearer ${token}`
      }
      return new Request(`https://x.example.test${path}`, { method: 'DELETE', headers })
    }

    it('deletes: 204 with an empty body + no-store; afterwards every endpoint treats it as nonexistent', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(del(`/api/v1/conversations/${conversationId}`))
      expect(res.status).toBe(204)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(await res.text()).toBe('')

      // GET → 404.
      const getRes = await api(get(`/api/v1/conversations/${conversationId}`))
      expect(getRes.status).toBe(404)

      // The list never shows it, under any folder.
      const listRes = await api(get('/api/v1/conversations'))
      const listBody = (await listRes.json()) as { conversations: Array<{ id: string }> }
      expect(listBody.conversations.map((c) => c.id)).not.toContain(conversationId)

      // PATCH → 404 (not reachable), reply → 404 (nothing sent).
      const patchRes = await api(
        patch(`/api/v1/conversations/${conversationId}`, { status: 'active' }),
      )
      expect(patchRes.status).toBe(404)
      const replyRes = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, { text: 'Hello?' }),
      )
      expect(replyRes.status).toBe(404)
    })

    it('a second DELETE is 404 — already-deleted is indistinguishable from never-existed', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      expect((await api(del(`/api/v1/conversations/${conversationId}`))).status).toBe(204)
      const second = await api(del(`/api/v1/conversations/${conversationId}`))
      expect(second.status).toBe(404)
      expect(await second.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
    })

    it('404s for a missing id and for a non-UUID-shaped id', async () => {
      const { api } = await freshApi()
      expect((await api(del(`/api/v1/conversations/${RANDOM_UUID}`))).status).toBe(404)
      expect((await api(del('/api/v1/conversations/not-a-uuid'))).status).toBe(404)
    })

    it('a keyed replay of a previously-successful reply returns 404 after the delete (spec §4a replay-vs-delete)', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const first = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'Original send.' },
          { idempotencyKey: 'replay-vs-delete' },
        ),
      )
      expect(first.status).toBe(201)

      expect((await api(del(`/api/v1/conversations/${conversationId}`))).status).toBe(204)

      // The replay does NOT resurrect the original 201 — the conversation is
      // gone; there is no mail-safety impact (the original send already
      // happened).
      const replay = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'Original send.' },
          { idempotencyKey: 'replay-vs-delete' },
        ),
      )
      expect(replay.status).toBe(404)
    })

    it('401s without a token', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      const res = await api(del(`/api/v1/conversations/${conversationId}`, undefined))
      expect(res.status).toBe(401)

      // And nothing was deleted by the unauthenticated call.
      expect((await api(get(`/api/v1/conversations/${conversationId}`))).status).toBe(200)
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

    it('PUT on the item route is 405 with Allow: GET, PATCH, DELETE', async () => {
      const { api } = await freshApi()
      const res = await api(
        new Request(`https://x.example.test/api/v1/conversations/${RANDOM_UUID}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
      expect(res.status).toBe(405)
      expect(res.headers.get('Allow')).toBe('GET, PATCH, DELETE')
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

  // --- open tracking (HT-32, spec §4g v1.1) -----------------------------------------

  describe('open tracking', () => {
    const BASE = 'https://desk.example.test'

    /** Reply with html, then pull the pixel token out of the sent mail. */
    async function replyAndExtractToken(
      api: (request: Request) => Promise<Response>,
      sent: OutboundEmail[],
      conversationId: string,
    ): Promise<{ token: string; threadId: string }> {
      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, {
          text: 'On it.',
          html: '<html><body><p>On it.</p></body></html>',
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { id: string }
      const match = /\/api\/v1\/t\/([^"]+)\.gif/.exec(sent[0].html as string)
      expect(match).not.toBeNull()
      return { token: (match as RegExpExecArray)[1], threadId: body.id }
    }

    it('full loop: enabled → reply carries the pixel; an UNAUTHENTICATED gif fetch records the first view; the detail surfaces it', async () => {
      const { store, api, sent } = await freshApi({ openTracking: { publicBaseUrl: BASE } })
      const { conversationId } = await store.createConversation(newConversation())
      const { token, threadId } = await replyAndExtractToken(api, sent, conversationId)

      // Before any view: null on the wire.
      const before = await api(get(`/api/v1/conversations/${conversationId}`))
      const beforeBody = (await before.json()) as {
        threads: Array<{ id: string; customerViewedAt: string | null }>
      }
      expect(beforeBody.threads.find((t) => t.id === threadId)?.customerViewedAt).toBeNull()

      // The pixel fetch: NO Authorization header — a customer's mail client.
      const pixel = await fetchPixel(api, token)
      expect(pixel.status).toBe(200)
      expect(pixel.headers.get('Content-Type')).toBe('image/gif')
      expect(pixel.headers.get('Cache-Control')).toBe('no-store')
      expect((await pixel.arrayBuffer()).byteLength).toBeGreaterThan(0)

      const after = await api(get(`/api/v1/conversations/${conversationId}`))
      const afterBody = (await after.json()) as {
        threads: Array<{ id: string; customerViewedAt: string | null }>
      }
      const viewedAt = afterBody.threads.find((t) => t.id === threadId)?.customerViewedAt
      expect(viewedAt).toEqual(expect.any(String))

      // Second fetch: same gif, timestamp unchanged (first view wins).
      await fetchPixel(api, token)
      const again = await api(get(`/api/v1/conversations/${conversationId}`))
      const againBody = (await again.json()) as {
        threads: Array<{ id: string; customerViewedAt: string | null }>
      }
      expect(againBody.threads.find((t) => t.id === threadId)?.customerViewedAt).toBe(viewedAt)
    })

    it('an invalid token gets the IDENTICAL gif response and records nothing', async () => {
      const { store, api } = await freshApi({ openTracking: { publicBaseUrl: BASE } })
      await store.createConversation(newConversation())

      const pixel = await fetchPixel(api, 'v.k1.forged-thread-id.AAAA')
      expect(pixel.status).toBe(200)
      expect(pixel.headers.get('Content-Type')).toBe('image/gif')
    })

    it('DISABLED (the default): no pixel in outbound html, and a valid-looking gif fetch records nothing', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        replyPost(`/api/v1/conversations/${conversationId}/replies`, {
          text: 'On it.',
          html: '<html><body><p>On it.</p></body></html>',
        }),
      )
      expect(res.status).toBe(201)
      const replyBody = (await res.json()) as { id: string }
      expect(sent[0].html).toBe('<html><body><p>On it.</p></body></html>')

      // Even a genuinely valid token records nothing while the feature is
      // off — turning tracking off stops recording, not just injection.
      const { mintViewToken } = await import('../mail/open-tracking.js')
      const validToken = mintViewToken(replyBody.id, KEYRING)
      const pixel = await fetchPixel(api, validToken)
      expect(pixel.status).toBe(200)

      const detail = await api(get(`/api/v1/conversations/${conversationId}`))
      const detailBody = (await detail.json()) as {
        threads: Array<{ id: string; customerViewedAt: string | null }>
      }
      expect(detailBody.threads.find((t) => t.id === replyBody.id)?.customerViewedAt).toBeNull()
    })

    function fetchPixel(
      api: (request: Request) => Promise<Response>,
      token: string,
    ): Promise<Response> {
      return api(new Request(`https://x.example.test/api/v1/t/${token}.gif`))
    }
  })

  // --- notes (HT-28, spec §4c v1.1) ------------------------------------------------

  describe('notes', () => {
    it('201 with the note ThreadView: direction note, from = support address, deliveryStatus null — and the sender is NEVER invoked', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        post(`/api/v1/conversations/${conversationId}/notes`, { text: 'Internal context.' }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        direction: string
        from: string
        bodyText: string | null
        bodyHtml: string | null
        deliveryStatus: string | null
      }
      expect(body).toMatchObject({
        direction: 'note',
        from: SUPPORT_ADDRESS,
        bodyText: 'Internal context.',
        bodyHtml: null,
        deliveryStatus: null,
      })
      // The mail boundary (spec §4c): a note never touches the send path.
      expect(sent).toEqual([])
    })

    it('a note on a closed conversation bumps updatedAt but never reopens it', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'closed')
      await setUpdatedAt(db, conversationId, new Date('2020-01-01T00:00:00.000Z'))

      const res = await api(
        post(`/api/v1/conversations/${conversationId}/notes`, { text: 'Still closed.' }),
      )
      expect(res.status).toBe(201)

      const updated = await store.getConversation(conversationId)
      expect(updated?.status).toBe('closed')
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(
        new Date('2020-01-01T00:00:00.000Z').getTime(),
      )
    })

    it('400s on a missing/empty/over-limit text and a non-JSON body', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      for (const bad of [{}, { text: '' }, { text: 'x'.repeat(5001) }, { text: 42 }]) {
        const res = await api(post(`/api/v1/conversations/${conversationId}/notes`, bad))
        expect(res.status).toBe(400)
      }
      const rawRes = await api(
        postRaw(`/api/v1/conversations/${conversationId}/notes`, 'not json{'),
      )
      expect(rawRes.status).toBe(400)
    })

    it('404s for missing, deleted, and non-UUID ids', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')

      expect(
        (await api(post(`/api/v1/conversations/${RANDOM_UUID}/notes`, { text: 'x' }))).status,
      ).toBe(404)
      expect(
        (await api(post(`/api/v1/conversations/${conversationId}/notes`, { text: 'x' }))).status,
      ).toBe(404)
      expect(
        (await api(post('/api/v1/conversations/not-a-uuid/notes', { text: 'x' }))).status,
      ).toBe(404)
    })

    it('GET on the notes route is 405 with Allow: POST; 401 without a token', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const wrongMethod = await api(get(`/api/v1/conversations/${conversationId}/notes`))
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('Allow')).toBe('POST')

      const noAuth = await api(
        post(`/api/v1/conversations/${conversationId}/notes`, { text: 'x' }, undefined),
      )
      expect(noAuth.status).toBe(401)
    })
  })

  // --- tags & assignee (HT-29/HT-31, spec §4e/§4f v1.1) ---------------------------

  describe('tags & assignee', () => {
    function put(path: string, body: unknown, ...tokenArg: [string | undefined] | []): Request {
      return withJsonBody('PUT', path, JSON.stringify(body), tokenArg)
    }

    it('PUT tags replaces the set, normalizing: trim, lowercase, dedupe preserving first occurrence', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        put(`/api/v1/conversations/${conversationId}/tags`, {
          tags: ['  Bug ', 'BILLING', 'bug', 'Billing'],
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { tags: string[] }
      expect(body.tags).toEqual(['bug', 'billing'])

      // Replace-set: [] clears.
      const cleared = await api(put(`/api/v1/conversations/${conversationId}/tags`, { tags: [] }))
      expect(((await cleared.json()) as { tags: string[] }).tags).toEqual([])
    })

    it('PUT tags 400s on a non-array, a non-string entry, an empty-after-trim entry, and an over-40-char entry', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      for (const bad of [
        { tags: 'bug' },
        { tags: [42] },
        { tags: ['   '] },
        { tags: ['x'.repeat(41)] },
        {},
      ]) {
        const res = await api(put(`/api/v1/conversations/${conversationId}/tags`, bad))
        expect(res.status).toBe(400)
      }
    })

    it('PUT assignee claims with me, releases with null; 400s otherwise (including a missing property)', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const claimed = await api(
        put(`/api/v1/conversations/${conversationId}/assignee`, { assignee: 'me' }),
      )
      expect(claimed.status).toBe(200)
      expect(((await claimed.json()) as { assignee: string | null }).assignee).toBe('me')

      const released = await api(
        put(`/api/v1/conversations/${conversationId}/assignee`, { assignee: null }),
      )
      expect(released.status).toBe(200)
      expect(((await released.json()) as { assignee: string | null }).assignee).toBeNull()

      for (const bad of [{ assignee: 'someone' }, { assignee: 42 }, {}]) {
        const res = await api(put(`/api/v1/conversations/${conversationId}/assignee`, bad))
        expect(res.status).toBe(400)
      }
    })

    it('both PUT routes 404 for missing, deleted, and non-UUID ids', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')

      for (const suffix of ['tags', 'assignee'] as const) {
        const body = suffix === 'tags' ? { tags: ['x'] } : { assignee: 'me' }
        expect(
          (await api(put(`/api/v1/conversations/${RANDOM_UUID}/${suffix}`, body))).status,
        ).toBe(404)
        expect(
          (await api(put(`/api/v1/conversations/${conversationId}/${suffix}`, body))).status,
        ).toBe(404)
        expect((await api(put(`/api/v1/conversations/not-a-uuid/${suffix}`, body))).status).toBe(
          404,
        )
      }
    })

    it('list summaries and the detail response carry tags and assignee', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await store.setConversationTags(conversationId, ['bug'])
      await store.setConversationAssignee(conversationId, 'me')

      const list = await api(get('/api/v1/conversations'))
      const listBody = (await list.json()) as {
        conversations: Array<{ tags: string[]; assignee: string | null }>
      }
      expect(listBody.conversations[0]).toMatchObject({ tags: ['bug'], assignee: 'me' })

      const detail = await api(get(`/api/v1/conversations/${conversationId}`))
      const detailBody = (await detail.json()) as { tags: string[]; assignee: string | null }
      expect(detailBody.tags).toEqual(['bug'])
      expect(detailBody.assignee).toBe('me')
    })

    it('GET on the tags route is 405 with Allow: PUT; 401 without a token', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const wrongMethod = await api(get(`/api/v1/conversations/${conversationId}/tags`))
      expect(wrongMethod.status).toBe(405)
      expect(wrongMethod.headers.get('Allow')).toBe('PUT')

      const noAuth = await api(
        put(`/api/v1/conversations/${conversationId}/tags`, { tags: ['x'] }, undefined),
      )
      expect(noAuth.status).toBe(401)
    })
  })

  // --- number & preview on the wire (HT-27, spec §2 v1.1) -----------------------

  describe('number & preview', () => {
    it('list summaries carry number (creation order) and preview (latest text, collapsed)', async () => {
      const { store, api } = await freshApi()
      const { conversationId: firstId } = await store.createConversation(newConversation())
      const { conversationId: secondId } = await store.createConversation(newConversation())
      await store.appendThread(firstId, {
        direction: 'inbound',
        messageId: null,
        fromAddress: 'customer@example.test',
        bodyText: '  latest\n\nreply  ',
      })

      const res = await api(get('/api/v1/conversations'))
      const body = (await res.json()) as {
        conversations: Array<{ id: string; number: number; preview: string }>
      }
      const first = body.conversations.find((c) => c.id === firstId)
      const second = body.conversations.find((c) => c.id === secondId)
      expect(first).toMatchObject({ number: 1, preview: 'latest reply' })
      expect(second).toMatchObject({ number: 2, preview: 'Where is my order?' })
    })

    it('the detail response carries number and the SAME preview rule as the list', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      // An html-only latest thread — preview must fall back to the inbound text.
      await store.appendThread(conversationId, {
        direction: 'inbound',
        messageId: null,
        fromAddress: 'customer@example.test',
        bodyHtml: '<p>rich only</p>',
      })

      const res = await api(get(`/api/v1/conversations/${conversationId}`))
      const body = (await res.json()) as { number: number; preview: string }
      expect(body.number).toBe(1)
      expect(body.preview).toBe('Where is my order?')
    })
  })

  // --- gmail push webhook (HT-39, gmail-push.md §2) -----------------------------
  //
  // Focused on the WIRING contract createInboxApi owns: the pre-auth
  // carve-out runs before Bearer auth, `deps.gmailPush` absence is
  // indistinguishable from a configured-but-failing request, and deps thread
  // through to the handler correctly (including a REAL DB-backed
  // MailboxStore, for at least one end-to-end proof). JWT-claim edge cases
  // live in `src/providers/adapters/gmail/push-auth.test.ts`; envelope/
  // body-limit edge cases live in `src/api/gmail-webhook.test.ts` — this
  // block does not re-derive either.
  describe('gmail push webhook', () => {
    const GMAIL_WEBHOOK_PATH = '/api/v1/inbound/gmail'
    const SUBSCRIPTION = 'projects/helpthread-prod/subscriptions/gmail-push'

    /** A `MailboxStore` fake for wiring tests that never need real persistence — always resolves to `record` (or `null`). */
    function fakeMailboxes(
      record: { id: string; address: string; provider: string; status: 'active' } | null,
    ) {
      return {
        async getMailboxByAddress(address: string) {
          return record !== null && record.address === address ? record : null
        },
        async markNeedsReconnect() {
          throw new Error('markNeedsReconnect: not used by the push-webhook path')
        },
      }
    }

    function fakeQueue(): {
      queue: QueueProvider
      enqueued: Array<{ topic: string; payload: unknown }>
    } {
      const enqueued: Array<{ topic: string; payload: unknown }> = []
      return {
        queue: {
          async enqueue(topic, payload, _opts?: EnqueueOptions) {
            enqueued.push({ topic, payload })
          },
        },
        enqueued,
      }
    }

    function pushEnvelope(emailAddress: string, historyId: string): string {
      const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString('base64url')
      return JSON.stringify({ subscription: SUBSCRIPTION, message: { data } })
    }

    /** A push POST with NO Authorization header — Gmail/Pub/Sub cannot present the service Bearer token. */
    function pushPost(body: string): Request {
      return new Request(`https://x.example.test${GMAIL_WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    }

    it('not configured (deps.gmailPush absent): same uniform rejection a configured-but-failing request gets', async () => {
      const { api: unconfiguredApi } = await freshApi()
      const { queue, enqueued } = fakeQueue()
      const { api: configuredApi } = await freshApi({
        gmailPush: {
          verifySignature: async () => false, // configured, but every request fails verification
          subscription: SUBSCRIPTION,
          mailboxes: fakeMailboxes(null),
          queue,
        },
      })

      const unconfiguredRes = await unconfiguredApi(
        pushPost(pushEnvelope('support@example.test', '1')),
      )
      const configuredRes = await configuredApi(pushPost(pushEnvelope('support@example.test', '1')))

      expect(unconfiguredRes.status).toBe(403)
      expect(configuredRes.status).toBe(403)
      expect(await unconfiguredRes.json()).toEqual(await configuredRes.json())
      expect(enqueued).toHaveLength(0)
    })

    it('runs BEFORE Bearer auth: no Authorization header at all still reaches the handler and can succeed', async () => {
      const { queue, enqueued } = fakeQueue()
      const { api } = await freshApi({
        gmailPush: {
          verifySignature: async () => true,
          subscription: SUBSCRIPTION,
          mailboxes: fakeMailboxes({
            id: '22222222-2222-4222-8222-222222222222',
            address: 'support@example.test',
            provider: 'gmail',
            status: 'active',
          }),
          queue,
        },
      })

      // No Authorization header — every OTHER route on this api would 401.
      const res = await api(pushPost(pushEnvelope('support@example.test', '42')))
      expect(res.status).toBe(200)
      expect(enqueued).toHaveLength(1)
    })

    it('happy path through createInboxApi: resolves a REAL mailbox from the DB, enqueues, 200', async () => {
      const { db } = await freshApi()
      await db.query('INSERT INTO mailboxes (address, provider) VALUES ($1, $2)', [
        'support@example.test',
        'gmail',
      ])
      const { queue, enqueued } = fakeQueue()

      const api = createInboxApi({
        store: createConversationStore(db),
        apiToken: TOKEN,
        sender: createFakeSender().sender,
        keyring: KEYRING,
        mailDomain: MAIL_DOMAIN,
        supportAddress: SUPPORT_ADDRESS,
        gmailPush: {
          verifySignature: async () => true,
          subscription: SUBSCRIPTION,
          mailboxes: createMailboxStore(db),
          queue,
        },
      })

      const res = await api(pushPost(pushEnvelope('support@example.test', '99999')))
      expect(res.status).toBe(200)
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0].topic).toBe('gmail-reconcile')
      expect(enqueued[0].payload).toEqual({
        mailboxId: expect.any(String),
        historyId: '99999',
      } satisfies GmailReconcileJob)
    })

    it('an unknown emailAddress (no matching mailbox in the real DB) is rejected uniformly, nothing enqueued', async () => {
      const { db } = await freshApi()
      const { queue, enqueued } = fakeQueue()

      const api = createInboxApi({
        store: createConversationStore(db),
        apiToken: TOKEN,
        sender: createFakeSender().sender,
        keyring: KEYRING,
        mailDomain: MAIL_DOMAIN,
        supportAddress: SUPPORT_ADDRESS,
        gmailPush: {
          verifySignature: async () => true,
          subscription: SUBSCRIPTION,
          mailboxes: createMailboxStore(db), // no mailboxes table rows at all
          queue,
        },
      })

      const res = await api(pushPost(pushEnvelope('nobody@example.test', '1')))
      expect(res.status).toBe(403)
      expect(enqueued).toHaveLength(0)
    })

    it('a GET to the webhook path is rejected uniformly too, not routed as a normal 401/404', async () => {
      const { queue } = fakeQueue()
      const { api } = await freshApi({
        gmailPush: {
          verifySignature: async () => true,
          subscription: SUBSCRIPTION,
          mailboxes: fakeMailboxes(null),
          queue,
        },
      })

      const res = await api(
        new Request(`https://x.example.test${GMAIL_WEBHOOK_PATH}`, { method: 'GET' }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: { code: 'gmail_push_rejected', message: expect.any(String) },
      })
    })

    it('existing routes are unaffected: /api/v1/conversations still 401s without a token', async () => {
      const { queue } = fakeQueue()
      const { api } = await freshApi({
        gmailPush: {
          verifySignature: async () => true,
          subscription: SUBSCRIPTION,
          mailboxes: fakeMailboxes(null),
          queue,
        },
      })
      const res = await api(get('/api/v1/conversations', undefined))
      expect(res.status).toBe(401)
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
