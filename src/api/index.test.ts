import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPasswordAuthProvider } from '../auth/password-provider.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createGmailConnectService } from '../mail/gmail-connect.js'
import { createGmailDisconnectService } from '../mail/gmail-disconnect.js'
import type { GmailOAuthTokenService } from '../mail/gmail-oauth.js'
import type { Keyring } from '../mail/reply-token.js'
import type { GmailWatchClient } from '../providers/adapters/gmail/index.js'
import type {
  BlobStore,
  EmailSender,
  EnqueueOptions,
  OutboundEmail,
  QueueProvider,
} from '../providers/index.js'
import { type AgentRecord, type AgentStore, createAgentStore } from '../store/agents.js'
import { type AssistantStore, createAssistantStore } from '../store/assistants.js'
import { createThreadAttachmentStore, insertThreadAttachmentsInTx } from '../store/attachments.js'
import {
  type ConversationStore,
  createConversationStore,
  type NewConversation,
} from '../store/conversations.js'
import { createGmailWatchStateStore } from '../store/gmail-watch-state.js'
import { createMailboxTokenStore } from '../store/mailbox-tokens.js'
import { createMailboxStore, type MailboxStore } from '../store/mailboxes.js'
import { createSavedReplyStore, type SavedReplyStore } from '../store/saved-replies.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import { createWebhookEndpointStore } from '../store/webhook-endpoints.js'
import type { AgentsApiDeps } from './agents.js'
import type { AssistantsApiDeps } from './assistants.js'
import type { GmailReconcileJob } from './gmail-webhook.js'
import { createInboxApi, type InboxApiDeps } from './index.js'
import type { SavedRepliesApiDeps } from './saved-replies.js'
import type { WebhooksApiDeps } from './webhooks.js'

const TOKEN_ENC_KEY = randomBytes(ENCRYPTION_KEY_BYTES)

const TOKEN = 'test-token-used-across-the-inbox-api-suite'
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'
const SUPPORT_ADDRESS = 'support@example.test'
const MAIL_DOMAIN = 'mail.example.test'
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }

/**
 * Build the REQUIRED `agents` deps (HT-54) for a `createInboxApi` call
 * wired to `db` — a real PGlite-backed `AgentStore` plus the core
 * `password` provider, matching how `src/composition/root.ts` wires them.
 * None of these tests exercise `/agents/*`/`/auth/*` routes directly (that
 * surface has its own describe block below), so this is just enough for
 * `createInboxApi` to construct and for existing conversation routes to
 * behave unchanged.
 */
function testAgentsDeps(db: Db): AgentsApiDeps {
  const store = createAgentStore(db)
  return {
    store,
    providers: [createPasswordAuthProvider({ agentStore: store })],
    mailboxStore: createMailboxStore(db),
  }
}

/**
 * Build the REQUIRED `webhooks` deps (HT-69) for a `createInboxApi` call
 * wired to `db` — a real PGlite-backed `WebhookEndpointStore` plus a
 * no-op `QueueProvider` (nothing in this suite exercises delivery; that is
 * `src/webhooks/*.test.ts`'s and `src/api/webhooks.test.ts`'s job). Just
 * enough for `createInboxApi` to construct and for the existing routes
 * this suite covers to behave unchanged.
 */
function testWebhooksDeps(db: Db): WebhooksApiDeps {
  return {
    store: createWebhookEndpointStore(db, TOKEN_ENC_KEY),
    queue: { async enqueue() {} },
  }
}

/** Build the REQUIRED `assistants` deps (HT-70) for a `createInboxApi` call wired to `db` — a real PGlite-backed `AssistantStore`, matching how `src/composition/root.ts` wires it. */
function testAssistantsDeps(db: Db): AssistantsApiDeps {
  return { store: createAssistantStore(db) }
}

/** Build the REQUIRED `savedReplies` deps (HT-76) for a `createInboxApi` call wired to `db` — a real PGlite-backed `SavedReplyStore` + `MailboxStore`, matching how `src/composition/root.ts` wires them. None of these tests exercise the saved-replies routes directly (that surface has its own describe block below), so this is just enough for `createInboxApi` to construct. */
function testSavedRepliesDeps(db: Db): SavedRepliesApiDeps {
  return { store: createSavedReplyStore(db), mailboxStore: createMailboxStore(db) }
}

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

/** An in-memory `BlobStore` fake, matching `src/mail/ingest.test.ts`'s — `getSignedUrl` returns a deterministic, inspectable URL. */
function fakeBlobStore(initial: Record<string, Uint8Array> = {}): BlobStore {
  const store = new Map(Object.entries(initial))
  return {
    async put(key, data) {
      store.set(key, data)
    },
    async get(key) {
      const data = store.get(key)
      if (data === undefined) throw new Error(`fakeBlobStore: no object at key ${key}`)
      return data
    },
    async getSignedUrl(key, expiresInSeconds) {
      return `https://blob.example.test/${key}?expires=${expiresInSeconds}`
    },
    async delete(key) {
      store.delete(key)
    },
    async exists(key) {
      return store.has(key)
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
      gmailConnect?: InboxApiDeps['gmailConnect']
      /** When given, wires `attachments: { store: createThreadAttachmentStore(db), blobStore }` — this fake's `db` doesn't exist until this function creates it, so the `ThreadAttachmentStore` is built HERE rather than by the caller. */
      attachmentsBlobStore?: BlobStore
    } = {},
  ): Promise<{
    db: Db
    store: ConversationStore
    agentStore: AgentStore
    assistantStore: AssistantStore
    api: (request: Request) => Promise<Response>
    /** Emails recorded by the default fake sender (empty if `overrides.sender` was supplied instead). */
    sent: OutboundEmail[]
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const store = createConversationStore(db)
    const agentsDeps = testAgentsDeps(db)
    const assistantsDeps = testAssistantsDeps(db)
    const { sender: defaultSender, sent } = createFakeSender()
    const api = createInboxApi({
      store,
      apiToken: TOKEN,
      sender: overrides.sender ?? defaultSender,
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
      agents: agentsDeps,
      webhooks: testWebhooksDeps(db),
      assistants: assistantsDeps,
      savedReplies: testSavedRepliesDeps(db),
      ...(overrides.openTracking !== undefined ? { openTracking: overrides.openTracking } : {}),
      ...(overrides.gmailPush !== undefined ? { gmailPush: overrides.gmailPush } : {}),
      ...(overrides.gmailConnect !== undefined ? { gmailConnect: overrides.gmailConnect } : {}),
      ...(overrides.attachmentsBlobStore !== undefined
        ? {
            attachments: {
              store: createThreadAttachmentStore(db),
              blobStore: overrides.attachmentsBlobStore,
            },
          }
        : {}),
    })
    return {
      db,
      store,
      agentStore: agentsDeps.store,
      assistantStore: assistantsDeps.store,
      api,
      sent,
    }
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

    // --- attachments (HT-46) -------------------------------------------------

    it('every thread carries attachments: [] when the deployment has no `attachments` deps wired (absent-by-default, like openTracking)', async () => {
      const { store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(get(`/api/v1/conversations/${conversationId}`))
      const body = (await res.json()) as { threads: Array<{ attachments: unknown[] }> }
      expect(body.threads).toHaveLength(1)
      expect(body.threads[0].attachments).toEqual([])
    })

    it('surfaces attachment metadata + a signed URL when `attachments` deps ARE wired', async () => {
      const blobStore = fakeBlobStore()
      const { db, store, api } = await freshApi({ attachmentsBlobStore: blobStore })
      const { conversationId, threadId } = await store.createConversation(newConversation())
      await db.transaction((tx) =>
        insertThreadAttachmentsInTx(tx, [
          {
            threadId,
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            size: 1234,
            blobKey: `mbox-1/attach-1/invoice.pdf`,
          },
        ]),
      )

      const res = await api(get(`/api/v1/conversations/${conversationId}`))
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        threads: Array<{
          id: string
          attachments: Array<{
            id: string
            filename: string | null
            contentType: string
            size: number
            url: string
          }>
        }>
      }
      expect(body.threads).toHaveLength(1)
      expect(body.threads[0].attachments).toHaveLength(1)
      expect(body.threads[0].attachments[0]).toMatchObject({
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        size: 1234,
        url: 'https://blob.example.test/mbox-1/attach-1/invoice.pdf?expires=3600',
      })
    })

    it('scopes attachments to the right thread when a conversation has multiple threads', async () => {
      const blobStore = fakeBlobStore()
      const { db, store, api } = await freshApi({ attachmentsBlobStore: blobStore })
      const { conversationId, threadId: firstThreadId } = await store.createConversation(
        newConversation(),
      )
      const appendResult = await store.appendThread(conversationId, {
        direction: 'outbound',
        messageId: '<ht.k1.c1.t2.sig@mail.example.test>',
        fromAddress: 'support@example.test',
        bodyText: 'Looking into it!',
      })
      if (!appendResult.ok) throw new Error('unreachable')

      await db.transaction((tx) =>
        insertThreadAttachmentsInTx(tx, [
          {
            threadId: firstThreadId,
            filename: 'first.txt',
            contentType: 'text/plain',
            size: 1,
            blobKey: 'mbox-1/a/first.txt',
          },
        ]),
      )

      const res = await api(get(`/api/v1/conversations/${conversationId}`))
      const body = (await res.json()) as {
        threads: Array<{ id: string; attachments: Array<{ filename: string | null }> }>
      }
      expect(body.threads).toHaveLength(2)
      const first = body.threads.find((t) => t.id === firstThreadId)
      const second = body.threads.find((t) => t.id === appendResult.threadId)
      expect(first?.attachments.map((a) => a.filename)).toEqual(['first.txt'])
      expect(second?.attachments).toEqual([])
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

      const updated = await store.getConversation(conversationId, { includeDeleted: false })
      const outboundThread = updated?.threads.find((t) => t.id === body.id)
      expect(outboundThread).toBeDefined()
      expect(outboundThread?.direction).toBe('outbound')
      expect(outboundThread?.deliveryStatus).toBe('sent')
      // The engine-minted Message-ID is transmitted verbatim (providers/email-sender.ts's contract).
      expect(sent[0].messageId).toBe(outboundThread?.messageId)

      expect(sent[0]).toMatchObject({
        to: ['customer@example.test'],
        from: SUPPORT_ADDRESS,
        subject: 'Re: Help with my order',
        inReplyTo: '<inbound-1@customer.example.test>',
        // HT-49: References carries the reply's OWN minted messageId as its
        // FINAL entry (after the derived ancestor chain) — the durable
        // channel for the reply token once a provider (Gmail) rewrites
        // Message-ID on send. See send.ts's module doc.
        references: ['<inbound-1@customer.example.test>', outboundThread?.messageId],
      })
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
        agents: testAgentsDeps(db),
        webhooks: testWebhooksDeps(db),
        assistants: testAssistantsDeps(db),
        savedReplies: testSavedRepliesDeps(db),
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
        agents: testAgentsDeps(db),
        webhooks: testWebhooksDeps(db),
        assistants: testAssistantsDeps(db),
        savedReplies: testSavedRepliesDeps(db),
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

    it('an Idempotency-Key starting with the reserved draft: prefix is 400 validation_failed (HT-70 review fix — a raw reply key could otherwise collide with an engine-owned draft key of the same name)', async () => {
      const { store, api, sent } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())

      const res = await api(
        replyPost(
          `/api/v1/conversations/${conversationId}/replies`,
          { text: 'Hi' },
          { idempotencyKey: 'draft:abc' },
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
        agents: testAgentsDeps(db),
        webhooks: testWebhooksDeps(db),
        assistants: testAssistantsDeps(db),
        savedReplies: testSavedRepliesDeps(db),
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

    // --- thenSetStatus ("Send & Close", HT-78) ---------------------------------

    describe('thenSetStatus (HT-78)', () => {
      it('closes the conversation in the same call, firing conversation.status_changed', async () => {
        const { db, store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())

        const res = await api(
          replyPost(`/api/v1/conversations/${conversationId}/replies`, {
            text: 'Resolved!',
            thenSetStatus: 'closed',
          }),
        )
        expect(res.status).toBe(201)

        const updated = await store.getConversation(conversationId, { includeDeleted: false })
        expect(updated?.status).toBe('closed')

        const events = await db.query<{ type: string; data: unknown }>(
          'SELECT type, data FROM event_outbox WHERE conversation_id = $1 AND type = $2',
          [conversationId, 'conversation.status_changed'],
        )
        expect(events).toEqual([
          { type: 'conversation.status_changed', data: { from: 'active', to: 'closed' } },
        ])
      })

      // --- closed/spam-reopen interaction (F2 review fix) -----------------
      //
      // A reply to a closed/spam conversation reopens it SILENTLY (§4a's own
      // reopen rule — no event of its own), so thenSetStatus's `from` is
      // captured BEFORE that reopen, not the transient `active` it passes
      // through. This is deliberately NOT identical to a two-step
      // reply-then-PATCH: a separate PATCH call can only observe the
      // ALREADY-reopened `active` row and would report `from: 'active'`
      // regardless of what the conversation actually was.

      it('replying to a CLOSED conversation with thenSetStatus:"closed" fires NO status_changed — the net status never changed, even though it silently passed through active internally', async () => {
        const { db, store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())
        await setStatus(db, conversationId, 'closed')

        const res = await api(
          replyPost(`/api/v1/conversations/${conversationId}/replies`, {
            text: 'Still resolved.',
            thenSetStatus: 'closed',
          }),
        )
        expect(res.status).toBe(201)

        const updated = await store.getConversation(conversationId, { includeDeleted: false })
        expect(updated?.status).toBe('closed')

        const events = await db.query<{ type: string }>(
          'SELECT type FROM event_outbox WHERE conversation_id = $1 AND type = $2',
          [conversationId, 'conversation.status_changed'],
        )
        expect(events).toEqual([])
      })

      it('replying to a CLOSED conversation with thenSetStatus:"pending" fires status_changed with from:"closed" — never from:"active" (the transient reopen state)', async () => {
        const { db, store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())
        await setStatus(db, conversationId, 'closed')

        const res = await api(
          replyPost(`/api/v1/conversations/${conversationId}/replies`, {
            text: 'Following up separately.',
            thenSetStatus: 'pending',
          }),
        )
        expect(res.status).toBe(201)

        const updated = await store.getConversation(conversationId, { includeDeleted: false })
        expect(updated?.status).toBe('pending')

        const events = await db.query<{ type: string; data: unknown }>(
          'SELECT type, data FROM event_outbox WHERE conversation_id = $1 AND type = $2',
          [conversationId, 'conversation.status_changed'],
        )
        expect(events).toEqual([
          { type: 'conversation.status_changed', data: { from: 'closed', to: 'pending' } },
        ])
      })

      it('sends byte-identical mail with and without thenSetStatus', async () => {
        const { store: storeA, api: apiA, sent: sentA } = await freshApi()
        const { conversationId: idA } = await storeA.createConversation(newConversation())
        await apiA(
          replyPost(
            `/api/v1/conversations/${idA}/replies`,
            { text: 'Same body' },
            {
              idempotencyKey: 'key-a',
            },
          ),
        )

        const { store: storeB, api: apiB, sent: sentB } = await freshApi()
        const { conversationId: idB } = await storeB.createConversation(newConversation())
        await apiB(
          replyPost(
            `/api/v1/conversations/${idB}/replies`,
            { text: 'Same body', thenSetStatus: 'closed' },
            { idempotencyKey: 'key-a' },
          ),
        )

        expect(sentA).toHaveLength(1)
        expect(sentB).toHaveLength(1)
        // Every mail-facing field is identical except the minted Message-ID/
        // References (which embed the conversation id, necessarily distinct
        // per conversation) — the shape and every OTHER field never differ.
        expect({ ...sentA[0], messageId: undefined, references: undefined }).toEqual({
          ...sentB[0],
          messageId: undefined,
          references: undefined,
        })
      })

      it('does not re-apply on an idempotency-key replay', async () => {
        const { db, store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())

        await api(
          replyPost(`/api/v1/conversations/${conversationId}/replies`, {
            text: 'First.',
            thenSetStatus: 'closed',
          }),
        )
        // Manually reopen — a replay must NOT re-close it (thenSetStatus only
        // applies on the genuinely new send, per the module doc).
        await setStatus(db, conversationId, 'active')

        const res = await api(
          replyPost(`/api/v1/conversations/${conversationId}/replies`, {
            text: 'First.',
            thenSetStatus: 'closed',
          }),
        )
        expect(res.status).toBe(201)

        const updated = await store.getConversation(conversationId, { includeDeleted: false })
        expect(updated?.status).toBe('active')
      })

      it('400s on an invalid thenSetStatus value', async () => {
        const { store, api, sent } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())

        const res = await api(
          replyPost(`/api/v1/conversations/${conversationId}/replies`, {
            text: 'Hi',
            thenSetStatus: 'spam',
          }),
        )
        expect(res.status).toBe(400)
        expect(sent).toHaveLength(0)
      })
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

    // --- snooze (HT-77) ---------------------------------------------------------

    describe('snooze (HT-77)', () => {
      it('sets a snooze: status pending + snoozedUntil echoed back', async () => {
        const { store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())
        const snoozedUntil = '2026-08-01T00:00:00.000Z'

        const res = await api(
          patch(`/api/v1/conversations/${conversationId}`, { status: 'pending', snoozedUntil }),
        )
        expect(res.status).toBe(200)
        const body = (await res.json()) as { status: string; snoozedUntil: string | null }
        expect(body.status).toBe('pending')
        expect(body.snoozedUntil).toBe(snoozedUntil)
      })

      it('400s when snoozedUntil accompanies a non-pending status', async () => {
        const { store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())

        const res = await api(
          patch(`/api/v1/conversations/${conversationId}`, {
            status: 'closed',
            snoozedUntil: '2026-08-01T00:00:00.000Z',
          }),
        )
        expect(res.status).toBe(400)
      })

      it('400s on an unparseable snoozedUntil', async () => {
        const { store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())

        const res = await api(
          patch(`/api/v1/conversations/${conversationId}`, {
            status: 'pending',
            snoozedUntil: 'not-a-date',
          }),
        )
        expect(res.status).toBe(400)
      })

      it('plain {status: "pending"} (no snoozedUntil) clears a prior snooze — un-snoozing', async () => {
        const { store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())
        await api(
          patch(`/api/v1/conversations/${conversationId}`, {
            status: 'pending',
            snoozedUntil: '2026-08-01T00:00:00.000Z',
          }),
        )

        const res = await api(
          patch(`/api/v1/conversations/${conversationId}`, { status: 'pending' }),
        )
        expect(res.status).toBe(200)
        const body = (await res.json()) as { status: string; snoozedUntil: string | null }
        expect(body.status).toBe('pending')
        expect(body.snoozedUntil).toBeNull()
      })

      it('snoozedUntil is always null for a non-pending conversation summary', async () => {
        const { store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())

        const res = await api(
          patch(`/api/v1/conversations/${conversationId}`, { status: 'active' }),
        )
        const body = (await res.json()) as { snoozedUntil: string | null }
        expect(body.snoozedUntil).toBeNull()
      })

      it('setting a snooze then moving off pending clears snoozedUntil (schema CHECK: snoozed_until IS NULL OR status = pending)', async () => {
        const { store, api } = await freshApi()
        const { conversationId } = await store.createConversation(newConversation())
        await api(
          patch(`/api/v1/conversations/${conversationId}`, {
            status: 'pending',
            snoozedUntil: '2026-08-01T00:00:00.000Z',
          }),
        )

        const res = await api(
          patch(`/api/v1/conversations/${conversationId}`, { status: 'closed' }),
        )
        expect(res.status).toBe(200)
        const body = (await res.json()) as { status: string; snoozedUntil: string | null }
        expect(body.status).toBe('closed')
        expect(body.snoozedUntil).toBeNull()

        const updated = await store.getConversation(conversationId, { includeDeleted: false })
        expect(updated?.snoozedUntil).toBeNull()
      })
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

    it('deleting a SNOOZED (pending + snoozedUntil) conversation succeeds and clears snoozed_until (HT-77 — migration 025 requires snoozed_until IS NULL OR status = pending)', async () => {
      const { db, store, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await api(
        patch(`/api/v1/conversations/${conversationId}`, {
          status: 'pending',
          snoozedUntil: '2026-08-01T00:00:00.000Z',
        }),
      )

      const res = await api(del(`/api/v1/conversations/${conversationId}`))
      expect(res.status).toBe(204)

      const raw = await db.query<{ status: string; snoozed_until: unknown }>(
        'SELECT status, snoozed_until FROM conversations WHERE id = $1',
        [conversationId],
      )
      expect(raw[0]).toEqual({ status: 'deleted', snoozed_until: null })
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

    /** Like {@link put}, additionally setting `X-Helpthread-Agent-Id` — the assignee route requires it (HT-54, spec §8). */
    function putWithAgent(path: string, body: unknown, agentId: string): Request {
      const request = put(path, body)
      const headers = new Headers(request.headers)
      headers.set('X-Helpthread-Agent-Id', agentId)
      return new Request(request.url, {
        method: request.method,
        headers,
        body: JSON.stringify(body),
      })
    }

    /** Create a real, active Agent directly via the store — the assignee tests need one both as the acting Agent and as a valid assignment target. */
    async function activeAgent(agentStore: AgentStore, email: string): Promise<AgentRecord> {
      const result = await agentStore.createAgent({
        name: 'Test Agent',
        email,
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$unused',
      })
      if (!result.ok) throw new Error('expected ok')
      return result.agent
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

    it('PUT assignee (HT-54 body shape) assigns to a real Agent id, releases with null; 400s otherwise', async () => {
      const { store, agentStore, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      const acting = await activeAgent(agentStore, 'acting@example.test')
      const assignee = await activeAgent(agentStore, 'assignee@example.test')

      const claimed = await api(
        putWithAgent(
          `/api/v1/conversations/${conversationId}/assignee`,
          { assigneeAgentId: assignee.id },
          acting.id,
        ),
      )
      expect(claimed.status).toBe(200)
      expect(((await claimed.json()) as { assigneeAgentId: string | null }).assigneeAgentId).toBe(
        assignee.id,
      )

      const released = await api(
        putWithAgent(
          `/api/v1/conversations/${conversationId}/assignee`,
          { assigneeAgentId: null },
          acting.id,
        ),
      )
      expect(released.status).toBe(200)
      expect(
        ((await released.json()) as { assigneeAgentId: string | null }).assigneeAgentId,
      ).toBeNull()

      // Malformed shapes, and the OLD `{ assignee: 'me' }` body — all 400.
      for (const bad of [
        { assigneeAgentId: 42 },
        {},
        { assignee: 'me' }, // the pre-HT-54 shape — no `assigneeAgentId` key at all
      ]) {
        const res = await api(
          putWithAgent(`/api/v1/conversations/${conversationId}/assignee`, bad, acting.id),
        )
        expect(res.status).toBe(400)
      }

      // A syntactically-uuid-shaped id that names no real Agent is also 400
      // (validation_failed, no existence oracle beyond what any Agent can
      // already see via GET /agents).
      const nonexistent = await api(
        putWithAgent(
          `/api/v1/conversations/${conversationId}/assignee`,
          { assigneeAgentId: RANDOM_UUID },
          acting.id,
        ),
      )
      expect(nonexistent.status).toBe(400)
    })

    it('PUT assignee requires the acting-Agent header — 401 without it, 401 for a disabled acting Agent', async () => {
      const { store, agentStore, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      const disabled = await activeAgent(agentStore, 'disabled@example.test')
      await agentStore.updateAgent(disabled.id, { status: 'disabled' })

      const noHeader = await api(
        put(`/api/v1/conversations/${conversationId}/assignee`, { assigneeAgentId: null }),
      )
      expect(noHeader.status).toBe(401)

      const disabledActing = await api(
        putWithAgent(
          `/api/v1/conversations/${conversationId}/assignee`,
          { assigneeAgentId: null },
          disabled.id,
        ),
      )
      expect(disabledActing.status).toBe(401)
    })

    it('both PUT routes 404 for missing, deleted, and non-UUID ids', async () => {
      const { db, store, agentStore, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      await setStatus(db, conversationId, 'deleted')
      const acting = await activeAgent(agentStore, 'acting2@example.test')

      for (const suffix of ['tags', 'assignee'] as const) {
        const body = suffix === 'tags' ? { tags: ['x'] } : { assigneeAgentId: null }
        const request = (path: string) =>
          suffix === 'tags' ? put(path, body) : putWithAgent(path, body, acting.id)
        expect((await api(request(`/api/v1/conversations/${RANDOM_UUID}/${suffix}`))).status).toBe(
          404,
        )
        expect(
          (await api(request(`/api/v1/conversations/${conversationId}/${suffix}`))).status,
        ).toBe(404)
        expect((await api(request(`/api/v1/conversations/not-a-uuid/${suffix}`))).status).toBe(404)
      }
    })

    it('list summaries and the detail response carry tags and assigneeAgentId', async () => {
      const { store, agentStore, api } = await freshApi()
      const { conversationId } = await store.createConversation(newConversation())
      const assignee = await activeAgent(agentStore, 'assignee2@example.test')
      await store.setConversationTags(conversationId, ['bug'])
      await store.setConversationAssignee(conversationId, assignee.id)

      const list = await api(get('/api/v1/conversations'))
      const listBody = (await list.json()) as {
        conversations: Array<{ tags: string[]; assigneeAgentId: string | null }>
      }
      expect(listBody.conversations[0]).toMatchObject({
        tags: ['bug'],
        assigneeAgentId: assignee.id,
      })

      const detail = await api(get(`/api/v1/conversations/${conversationId}`))
      const detailBody = (await detail.json()) as {
        tags: string[]
        assigneeAgentId: string | null
      }
      expect(detailBody.tags).toEqual(['bug'])
      expect(detailBody.assigneeAgentId).toBe(assignee.id)
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
        async getMailboxById(id: string) {
          return record !== null && record.id === id ? record : null
        },
        async markNeedsReconnect() {
          throw new Error('markNeedsReconnect: not used by the push-webhook path')
        },
        async markPaused() {
          throw new Error('markPaused: not used by the push-webhook path')
        },
        async markDisconnected() {
          throw new Error('markDisconnected: not used by the push-webhook path')
        },
        async upsertConnectedMailbox() {
          throw new Error('upsertConnectedMailbox: not used by the push-webhook path')
        },
        async listActiveMailboxes() {
          throw new Error('listActiveMailboxes: not used by the push-webhook path')
        },
        async listMailboxes() {
          throw new Error('listMailboxes: not used by the push-webhook path')
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
        agents: testAgentsDeps(db),
        webhooks: testWebhooksDeps(db),
        assistants: testAssistantsDeps(db),
        savedReplies: testSavedRepliesDeps(db),
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
        agents: testAgentsDeps(db),
        webhooks: testWebhooksDeps(db),
        assistants: testAssistantsDeps(db),
        savedReplies: testSavedRepliesDeps(db),
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

  // --- gmail connect (HT-40, gmail-connect.md §2) --------------------------------
  //
  // Focused on the WIRING contract createInboxApi owns: `POST .../connect`
  // is an ORDINARY Bearer-gated route (unlike the push webhook, it needs no
  // special pre-auth treatment itself), the callback IS a pre-auth carve-out
  // matched before the Bearer gate, and `deps.gmailConnect` absence 404s both
  // routes. Handler-level response-shape details (HTML escaping, which
  // GmailConnectError code maps to which page) live in
  // `src/api/gmail-connect.test.ts` — this block does not re-derive those.
  //
  // Mirrors the "gmail push webhook" block's own pattern above: `freshApi()`
  // is called ONCE per test to obtain a `db`, then `createInboxApi` is called
  // DIRECTLY (not via `freshApi` again) so every dependency — including the
  // gmail-connect service's own stores — is bound to that SAME database.
  describe('gmail connect', () => {
    const CONNECT_PATH = '/api/v1/inbound/gmail/connect'
    const CALLBACK_PATH = '/api/v1/inbound/gmail/callback'
    const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
    const CLIENT_SECRET = 'test-client-secret'
    const REDIRECT_URI = `https://x.example.test${CALLBACK_PATH}`
    const TOPIC_NAME = 'projects/helpthread-prod/topics/gmail-push'
    const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

    /** A real `GmailConnectService` backed by `db`, with Google's token endpoint and the Gmail watch-arm client both faked. */
    function realGmailConnect(
      db: Db,
      options: {
        tokenResponse?: { status: number; body: unknown }
        watchClient?: GmailWatchClient
      } = {},
    ): { service: ReturnType<typeof createGmailConnectService> } {
      const tokenResp = options.tokenResponse ?? {
        status: 200,
        body: {
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        },
      }
      const fetchImpl = (async () =>
        new Response(JSON.stringify(tokenResp.body), {
          status: tokenResp.status,
        })) as unknown as typeof fetch
      const watchClient: GmailWatchClient = options.watchClient ?? {
        getProfile: async () => ({
          emailAddress: 'connected@example.test',
          historyId: 'profile-hid',
        }),
        watch: async () => ({
          historyId: 'baseline-hid',
          expiration: new Date('2026-08-01T00:00:00.000Z'),
        }),
        stop: async () => {
          throw new Error('stop: not used by the connect flow')
        },
      }

      const service = createGmailConnectService({
        db,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        topicName: TOPIC_NAME,
        scopes: SCOPES,
        keyring: KEYRING,
        mailboxStore: createMailboxStore(db),
        tokenStore: createMailboxTokenStore(db, TOKEN_ENC_KEY),
        watchStateStore: createGmailWatchStateStore(db),
        createWatchClient: () => watchClient,
        fetchImpl,
      })
      return { service }
    }

    /** Build a full `createInboxApi` instance wired to `db`, with `gmailConnect` present (or, if omitted, absent entirely — for the "not configured" tests). */
    function apiWithGmailConnect(
      db: Db,
      gmailConnect?: InboxApiDeps['gmailConnect'],
    ): (request: Request) => Promise<Response> {
      return createInboxApi({
        store: createConversationStore(db),
        apiToken: TOKEN,
        sender: createFakeSender().sender,
        keyring: KEYRING,
        mailDomain: MAIL_DOMAIN,
        supportAddress: SUPPORT_ADDRESS,
        agents: testAgentsDeps(db),
        webhooks: testWebhooksDeps(db),
        assistants: testAssistantsDeps(db),
        savedReplies: testSavedRepliesDeps(db),
        ...(gmailConnect !== undefined ? { gmailConnect } : {}),
      })
    }

    function connectPost(...tokenArg: [string | undefined] | []): Request {
      const token = tokenArg.length > 0 ? tokenArg[0] : TOKEN
      const headers: Record<string, string> = {}
      if (token !== undefined) {
        headers.Authorization = `Bearer ${token}`
      }
      return new Request(`https://x.example.test${CONNECT_PATH}`, { method: 'POST', headers })
    }

    function callbackGet(query: string): Request {
      return new Request(`https://x.example.test${CALLBACK_PATH}${query}`)
    }

    // --- POST .../connect: an ORDINARY Bearer-gated route -----------------

    it('POST .../connect with a valid Bearer token → 200 { consentUrl }', async () => {
      const { db } = await freshApi()
      const gmailConnect = realGmailConnect(db)
      const api = apiWithGmailConnect(db, gmailConnect)

      const res = await api(connectPost())

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('application/json')
      const body = (await res.json()) as { consentUrl: string }
      expect(body.consentUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth')
      expect(new URL(body.consentUrl).searchParams.get('client_id')).toBe(CLIENT_ID)
    })

    it('POST .../connect WITHOUT a Bearer token → 401, before the handler ever runs', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailConnect(db, realGmailConnect(db))

      const res = await api(connectPost(undefined))
      expect(res.status).toBe(401)
    })

    it('POST .../connect with the WRONG Bearer token → 401', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailConnect(db, realGmailConnect(db))

      const res = await api(connectPost('the-wrong-token'))
      expect(res.status).toBe(401)
    })

    it('deps.gmailConnect absent: POST .../connect 404s (no route-table special case needed — Bearer-gated either way)', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailConnect(db) // no gmailConnect

      const res = await api(connectPost())
      expect(res.status).toBe(404)
    })

    // --- GET .../callback: a PRE-AUTH carve-out -----------------------------

    it('GET .../callback runs BEFORE Bearer auth: no Authorization header at all still succeeds', async () => {
      const { db } = await freshApi()
      const gmailConnect = realGmailConnect(db)
      const api = apiWithGmailConnect(db, gmailConnect)
      const { consentUrl } = gmailConnect.service.beginConnect()
      const state = new URL(consentUrl).searchParams.get('state') as string

      // No Authorization header — every OTHER route on this api would 401.
      const res = await api(callbackGet(`?code=auth-code&state=${encodeURIComponent(state)}`))

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    })

    it('a valid code+state completes the connect AND PERSISTS: an active mailbox, encrypted tokens, a seeded watch-state row', async () => {
      const { db } = await freshApi()
      const gmailConnect = realGmailConnect(db)
      const api = apiWithGmailConnect(db, gmailConnect)
      const { consentUrl } = gmailConnect.service.beginConnect()
      const state = new URL(consentUrl).searchParams.get('state') as string

      const res = await api(callbackGet(`?code=auth-code&state=${encodeURIComponent(state)}`))

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('connected@example.test')

      const rows = await db.query<{ status: string }>(
        "SELECT status FROM mailboxes WHERE address = 'connected@example.test'",
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('active')
      const tokenRows = await db.query('SELECT mailbox_id FROM mailbox_oauth_tokens')
      expect(tokenRows).toHaveLength(1)
      const watchRows = await db.query<{ history_id: string }>(
        'SELECT history_id FROM gmail_watch_state',
      )
      expect(watchRows).toHaveLength(1)
      expect(watchRows[0].history_id).toBe('baseline-hid')
    })

    it('a forged state is rejected: 4xx html, nothing persisted', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailConnect(db, realGmailConnect(db))

      const res = await api(callbackGet('?code=auth-code&state=gmc.k1.999.forged-nonce.forged-sig'))

      expect(res.status).toBe(400)
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
      const rows = await db.query('SELECT id FROM mailboxes')
      expect(rows).toHaveLength(0)
    })

    it('an expired state is rejected: 4xx html, nothing persisted', async () => {
      const { db } = await freshApi()
      const gmailConnect = realGmailConnect(db)
      const api = apiWithGmailConnect(db, gmailConnect)
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        const { consentUrl } = gmailConnect.service.beginConnect()
        const state = new URL(consentUrl).searchParams.get('state') as string
        // Advance PAST the default 10 min TTL with fake time STILL ACTIVE, so
        // verifyConnectState's own Date.now() (inside the callback below) sees
        // the advance. Restoring real timers before the request — as an earlier
        // version did — would check the freshly-minted state against wall-clock
        // time instead, so the 10-minute boundary was never actually exercised.
        vi.setSystemTime(new Date('2026-01-01T00:11:00.000Z'))

        const res = await api(callbackGet(`?code=auth-code&state=${encodeURIComponent(state)}`))

        expect(res.status).toBe(400)
        const rows = await db.query('SELECT id FROM mailboxes')
        expect(rows).toHaveLength(0)
      } finally {
        // Always restore, even if an assertion throws, so fake time never
        // leaks into a later test.
        vi.useRealTimers()
      }
    })

    it('deps.gmailConnect absent: GET .../callback 404s (never the gmail-push-webhook uniform-reject shape)', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailConnect(db) // no gmailConnect

      const res = await api(callbackGet('?code=abc&state=xyz'))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
    })

    it('a WRONG method on the callback path is handled by the pre-auth handler itself, never 401-routed', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailConnect(db, realGmailConnect(db))

      // POST to the callback path (Google only ever GETs it) — still a
      // pre-auth match; the handler itself decides how to respond (missing
      // code/state → 400), never falls through to the authed pipeline.
      const res = await api(
        new Request(`https://x.example.test${CALLBACK_PATH}`, { method: 'POST' }),
      )
      expect(res.status).not.toBe(401)
    })

    it('existing routes are unaffected: /api/v1/conversations still 401s without a token', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailConnect(db, realGmailConnect(db))

      const res = await api(get('/api/v1/conversations', undefined))
      expect(res.status).toBe(401)
    })
  })

  // --- gmail disconnect (HT-47, gmail-connect.md's disconnect section) -------
  //
  // Focused on the WIRING contract createInboxApi owns: `POST .../disconnect`
  // is an ORDINARY Bearer-gated route (no pre-auth carve-out at all, unlike
  // `/callback`), and `deps.gmailDisconnect` absence 404s it — mirroring the
  // "gmail connect" block above. Handler-level response-shape details (body
  // validation, error-code mapping) live in `src/api/gmail-disconnect.test.ts`
  // — this block does not re-derive those.
  describe('gmail disconnect', () => {
    const DISCONNECT_PATH = '/api/v1/inbound/gmail/disconnect'

    /** A real `GmailDisconnectService` backed by `db`, with Google's revoke endpoint and the Gmail watch client both faked. */
    function realGmailDisconnect(
      db: Db,
      options: {
        revokeResponse?: { status: number }
        watchClient?: GmailWatchClient
      } = {},
    ): { service: ReturnType<typeof createGmailDisconnectService> } {
      const revokeResp = options.revokeResponse ?? { status: 200 }
      const fetchImpl = (async () =>
        new Response('', { status: revokeResp.status })) as unknown as typeof fetch
      const watchClient: GmailWatchClient = options.watchClient ?? {
        getProfile: async () => {
          throw new Error('getProfile: not used by disconnect')
        },
        watch: async () => {
          throw new Error('watch: not used by disconnect')
        },
        stop: async () => {},
      }
      const tokenService: GmailOAuthTokenService = {
        getAccessToken: async () => 'fresh-access-token',
      }

      const service = createGmailDisconnectService({
        db,
        mailboxStore: createMailboxStore(db),
        tokenStore: createMailboxTokenStore(db, TOKEN_ENC_KEY),
        watchStateStore: createGmailWatchStateStore(db),
        tokenService,
        createWatchClient: () => watchClient,
        fetchImpl,
      })
      return { service }
    }

    /** Build a full `createInboxApi` instance wired to `db`, with `gmailDisconnect` present (or, if omitted, absent entirely — for the "not configured" tests). */
    function apiWithGmailDisconnect(
      db: Db,
      gmailDisconnect?: InboxApiDeps['gmailDisconnect'],
    ): (request: Request) => Promise<Response> {
      return createInboxApi({
        store: createConversationStore(db),
        apiToken: TOKEN,
        sender: createFakeSender().sender,
        keyring: KEYRING,
        mailDomain: MAIL_DOMAIN,
        supportAddress: SUPPORT_ADDRESS,
        agents: testAgentsDeps(db),
        webhooks: testWebhooksDeps(db),
        assistants: testAssistantsDeps(db),
        savedReplies: testSavedRepliesDeps(db),
        ...(gmailDisconnect !== undefined ? { gmailDisconnect } : {}),
      })
    }

    function disconnectPost(address: string, ...tokenArg: [string | undefined] | []): Request {
      const token = tokenArg.length > 0 ? tokenArg[0] : TOKEN
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token !== undefined) {
        headers.Authorization = `Bearer ${token}`
      }
      return new Request(`https://x.example.test${DISCONNECT_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ address }),
      })
    }

    it('POST .../disconnect with a valid Bearer token disconnects a connected mailbox: 200, deactivated in the db', async () => {
      const { db } = await freshApi()
      await createMailboxStore(db).upsertConnectedMailbox({
        address: 'connected@example.test',
        provider: 'gmail',
      })
      const api = apiWithGmailDisconnect(db, realGmailDisconnect(db))

      const res = await api(disconnectPost('connected@example.test'))

      expect(res.status).toBe(200)
      const body = (await res.json()) as { alreadyDisconnected: boolean; address: string }
      expect(body.address).toBe('connected@example.test')
      expect(body.alreadyDisconnected).toBe(false)

      const rows = await db.query<{ status: string }>(
        "SELECT status FROM mailboxes WHERE address = 'connected@example.test'",
      )
      expect(rows[0].status).toBe('disconnected')
    })

    it('POST .../disconnect WITHOUT a Bearer token → 401, before the handler ever runs', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailDisconnect(db, realGmailDisconnect(db))

      const res = await api(disconnectPost('connected@example.test', undefined))
      expect(res.status).toBe(401)
    })

    it('POST .../disconnect with the WRONG Bearer token → 401', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailDisconnect(db, realGmailDisconnect(db))

      const res = await api(disconnectPost('connected@example.test', 'the-wrong-token'))
      expect(res.status).toBe(401)
    })

    it('deps.gmailDisconnect absent: POST .../disconnect 404s (no pre-auth carve-out — Bearer-gated either way)', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailDisconnect(db) // no gmailDisconnect

      const res = await api(disconnectPost('connected@example.test'))
      expect(res.status).toBe(404)
    })

    it('an unknown address → 404 not_found', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailDisconnect(db, realGmailDisconnect(db))

      const res = await api(disconnectPost('nobody@example.test'))

      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({
        error: { code: 'not_found', message: expect.any(String) },
      })
    })

    it('existing routes are unaffected: /api/v1/conversations still 401s without a token', async () => {
      const { db } = await freshApi()
      const api = apiWithGmailDisconnect(db, realGmailDisconnect(db))

      const res = await api(get('/api/v1/conversations', undefined))
      expect(res.status).toBe(401)
    })
  })
})

describe('createInboxApi — hardening (Codex review)', () => {
  const dummyStore = {} as unknown as ConversationStore
  const dummySender = createThrowingSender()
  // None of these tests ever exercise an /agents/*|/auth/* route, so a
  // never-invoked dummy AgentStore is fine — this block is purely about
  // construction-time validation and the conversations-route error paths.
  const dummyDeps = {
    sender: dummySender,
    keyring: KEYRING,
    mailDomain: MAIL_DOMAIN,
    supportAddress: SUPPORT_ADDRESS,
    agents: {
      store: {} as unknown as AgentStore,
      providers: [],
      mailboxStore: {} as unknown as MailboxStore,
    } satisfies AgentsApiDeps,
    // Same "never invoked in this block" reasoning as `agents` above — these
    // tests are purely about construction-time validation and the
    // conversations-route error paths, never /webhooks/*.
    webhooks: {
      store: {} as unknown as WebhooksApiDeps['store'],
      queue: {} as unknown as WebhooksApiDeps['queue'],
    } satisfies WebhooksApiDeps,
    // Same "never invoked, dummy is fine" posture as the AgentStore above —
    // none of these tests exercise an /assistants/* route or the assistant-
    // token auth path.
    assistants: { store: {} as unknown as AssistantStore } satisfies AssistantsApiDeps,
    // Same "never invoked, dummy is fine" posture — none of these tests
    // exercise a /mailboxes/*/saved-replies route.
    savedReplies: {
      store: {} as unknown as SavedReplyStore,
      mailboxStore: {} as unknown as MailboxStore,
    } satisfies SavedRepliesApiDeps,
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
