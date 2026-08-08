/**
 * Tests for the customer-side create path
 * (specs/api/customer-conversations-v1.md §6a), driven through the real
 * `createInboxApi` pipeline against a PGlite-backed store — this codebase's
 * convention for API tests, rather than calling the handler directly.
 *
 * The properties worth pinning here are the ones a future change could break
 * silently: identity comes from the header and never the body (§5), the
 * Bearer token is checked before the customer header (§3a), attachments are
 * all-or-nothing (§6a), and an API-opened conversation is indistinguishable
 * from a mail-opened one to an event consumer.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { BlobStore } from '../providers/blob.js'
import type { EmailSender } from '../providers/index.js'
import { createAgentStore } from '../store/agents.js'
import { createAssistantStore } from '../store/assistants.js'
import { createConversationStore } from '../store/conversations.js'
import { createEventOutboxStore } from '../store/event-outbox.js'
import { createMailboxStore } from '../store/mailboxes.js'
import { createSavedReplyStore } from '../store/saved-replies.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import { createWebhookEndpointStore } from '../store/webhook-endpoints.js'
import { normalizeCustomerEmail } from './customer-conversations.js'
import { createInboxApi } from './index.js'

const TOKEN = 'test-token-for-the-customer-conversations-suite'
const MAIL_DOMAIN = 'mail.example.test'
const SUPPORT_ADDRESS = 'support@example.test'
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const CUSTOMER_HEADER = 'X-Helpthread-Customer-Email'
const PATH = '/api/v1/customer/conversations'

const NOOP_SENDER: EmailSender = {
  maxSendMs: 30_000,
  async send() {
    return {}
  },
}

/** A `BlobStore` that records writes and can be told to fail on the Nth put. */
function createFakeBlobStore(failOnPut = -1): {
  blobStore: BlobStore
  written: string[]
} {
  const written: string[] = []
  return {
    written,
    blobStore: {
      async put(key: string) {
        if (written.length === failOnPut) throw new Error('blob write failed')
        written.push(key)
      },
      async get() {
        throw new Error('not used')
      },
      async signedUrl() {
        return 'https://blob.example.test/signed'
      },
    } as unknown as BlobStore,
  }
}

describe('POST /api/v1/customer/conversations (spec §6a)', () => {
  let open: Db | null = null

  afterEach(async () => {
    await open?.close()
    open = null
  })

  async function harness(opts: { failBlobOnPut?: number } = {}) {
    const db = await createPgliteDb()
    open = db
    await migrate(db)

    const mailboxStore = createMailboxStore(db)
    const conversations = createConversationStore(db)
    const outbox = createEventOutboxStore(db)
    const { blobStore, written } = createFakeBlobStore(opts.failBlobOnPut ?? -1)
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: SUPPORT_ADDRESS,
      provider: 'gmail',
    })

    const api = createInboxApi({
      store: conversations,
      apiToken: TOKEN,
      sender: NOOP_SENDER,
      senderResolver: { resolve: async () => ({ sender: NOOP_SENDER, from: SUPPORT_ADDRESS }) },
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
      agents: {
        store: createAgentStore(db),
        providers: [],
        mailboxStore,
      },
      webhooks: {
        store: createWebhookEndpointStore(db, randomBytes(ENCRYPTION_KEY_BYTES)),
        queue: { async enqueue() {} },
      },
      assistants: { store: createAssistantStore(db) },
      savedReplies: { store: createSavedReplyStore(db), mailboxStore },
      attachments: {
        store: {
          async listByConversationId() {
            return []
          },
        },
        blobStore,
      },
    })

    return { db, api, conversations, outbox, mailbox, written }
  }

  function req(opts: { token?: string | null; email?: string | null; body?: unknown }): Request {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
    if (opts.email !== null && opts.email !== undefined) headers[CUSTOMER_HEADER] = opts.email
    return new Request(`https://x.example.test${PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.body ?? {}),
    })
  }

  function validBody(mailboxId: string, extra: Record<string, unknown> = {}) {
    return {
      subject: 'Cannot export my report',
      bodyText: 'It times out every time.',
      mailboxId,
      ...extra,
    }
  }

  it('creates a conversation owned by the header address, with an inbound first thread', async () => {
    const { api, conversations, mailbox } = await harness()

    const res = await api(req({ email: 'Customer@Example.TEST', body: validBody(mailbox.id) }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.status).toBe('active')
    expect(typeof body.id).toBe('string')

    const stored = await conversations.getConversation(body.id)
    expect(stored?.customerEmail).toBe('customer@example.test')
    expect(stored?.subject).toBe('Cannot export my report')
    expect(stored?.threads).toHaveLength(1)
    expect(stored?.threads[0]?.direction).toBe('inbound')
    expect(stored?.threads[0]?.fromAddress).toBe('customer@example.test')
    expect(stored?.threads[0]?.bodyText).toBe('It times out every time.')
  })

  it('takes identity from the header, never the body (§5)', async () => {
    const { api, conversations, mailbox } = await harness()

    const res = await api(
      req({
        email: 'real@example.test',
        // A body that tries to name someone else must be ignored outright.
        body: validBody(mailbox.id, {
          customerEmail: 'victim@example.test',
          fromAddress: 'victim@example.test',
        }),
      }),
    )
    expect(res.status).toBe(201)

    const stored = await conversations.getConversation((await res.clone().json()).id)
    expect(stored?.customerEmail).toBe('real@example.test')
    expect(stored?.threads[0]?.fromAddress).toBe('real@example.test')
  })

  it('emits the same event pair a mail-ingested new conversation emits', async () => {
    const { api, outbox, mailbox } = await harness()

    const res = await api(req({ email: 'customer@example.test', body: validBody(mailbox.id) }))
    const { id } = await res.json()

    const events = await outbox.claimBatch({ batchSize: 10, leaseMs: 30_000 })
    const mine = events.filter((e) => e.conversationId === id)

    // Asserted as a SET, not a sequence. Both rows are written in one
    // transaction and therefore share an `occurred_at`, while `claimBatch`
    // orders by `occurred_at` alone — so their relative order is genuinely
    // undefined, here and equally on the mail-ingest path this mirrors.
    expect(new Set(mine.map((e) => e.type))).toEqual(
      new Set(['conversation.created', 'conversation.message_received']),
    )
    expect(mine).toHaveLength(2)
    expect(mine.find((e) => e.type === 'conversation.message_received')?.data).toMatchObject({
      reopened: false,
    })
  })

  it('checks the Bearer token before the customer header (§3a)', async () => {
    const { api, mailbox } = await harness()

    // Bad token AND missing header — must be 401, never 400.
    const res = await api(req({ token: 'wrong', email: null, body: validBody(mailbox.id) }))
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe('unauthorized')
  })

  it('rejects a missing, multi-valued, or unsupported customer header', async () => {
    const { api, mailbox } = await harness()

    for (const email of [
      null,
      'a@example.test,b@example.test',
      'not-an-email',
      '"quoted"@example.test',
      'a@@b.test',
    ]) {
      const res = await api(req({ email, body: validBody(mailbox.id) }))
      expect(res.status, `email=${String(email)}`).toBe(400)
      expect((await res.json()).error.code).toBe('validation_failed')
    }
  })

  it('rejects an unknown or non-active mailbox', async () => {
    const { api, db, mailbox } = await harness()

    const unknown = await api(
      req({
        email: 'customer@example.test',
        body: validBody('00000000-0000-4000-8000-000000000000'),
      }),
    )
    expect(unknown.status).toBe(400)

    await db.query("UPDATE mailboxes SET status = 'paused' WHERE id = $1", [mailbox.id])
    const paused = await api(req({ email: 'customer@example.test', body: validBody(mailbox.id) }))
    expect(paused.status).toBe(400)
  })

  it('rejects a bad body', async () => {
    const { api, mailbox } = await harness()

    const cases: Record<string, unknown>[] = [
      { bodyText: 'x', mailboxId: mailbox.id }, // no subject
      { subject: 'x', mailboxId: mailbox.id }, // no bodyText
      { subject: '   ', bodyText: 'x', mailboxId: mailbox.id }, // subject blank after trim
      { subject: 'x', bodyText: 'y' }, // no mailboxId
      { subject: 'x', bodyText: 'y', mailboxId: mailbox.id, attachments: 'nope' },
    ]
    for (const body of cases) {
      const res = await api(req({ email: 'customer@example.test', body }))
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('stores attachments and rejects invalid base64', async () => {
    const { api, conversations, mailbox, written } = await harness()

    const ok = await api(
      req({
        email: 'customer@example.test',
        body: validBody(mailbox.id, {
          attachments: [
            {
              filename: 'log.txt',
              contentType: 'text/plain',
              data: Buffer.from('hello').toString('base64'),
            },
          ],
        }),
      }),
    )
    expect(ok.status).toBe(201)
    expect(written).toHaveLength(1)
    expect(written[0]).toContain(`${mailbox.id}/`)

    const bad = await api(
      req({
        email: 'customer@example.test',
        body: validBody(mailbox.id, {
          attachments: [{ filename: 'log.txt', contentType: 'text/plain', data: 'not!base64!' }],
        }),
      }),
    )
    expect(bad.status).toBe(400)

    // The rejected request created nothing.
    const all = await conversations.listConversations({ folder: 'open', limit: 50 })
    expect(all).toHaveLength(1)
  })

  it('leaves no conversation when an attachment blob write fails (§6a all-or-nothing)', async () => {
    // Fail on the SECOND put, so the first blob is already written — the case
    // where a naive implementation would commit a conversation missing a file.
    const { api, conversations, mailbox } = await harness({ failBlobOnPut: 1 })

    const res = await api(
      req({
        email: 'customer@example.test',
        body: validBody(mailbox.id, {
          attachments: [
            {
              filename: 'a.txt',
              contentType: 'text/plain',
              data: Buffer.from('a').toString('base64'),
            },
            {
              filename: 'b.txt',
              contentType: 'text/plain',
              data: Buffer.from('b').toString('base64'),
            },
          ],
        }),
      }),
    )
    expect(res.status).toBe(502)

    const all = await conversations.listConversations({ folder: 'open', limit: 50 })
    expect(all).toHaveLength(0)
  })

  it('rejects an unsupported method with 405 and an Allow header', async () => {
    const { api } = await harness()
    // GET is the list endpoint (§6b), so DELETE is the unsupported verb here.
    const res = await api(
      new Request(`https://x.example.test${PATH}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET, POST')
  })
})

describe('normalizeCustomerEmail (spec §3b)', () => {
  it('trims, NFC-normalizes, and lowercases', () => {
    expect(normalizeCustomerEmail('  Customer@Example.TEST ')).toBe('customer@example.test')
  })

  it('accepts the ordinary forms', () => {
    for (const value of ['a@b.test', 'first.last+tag@sub.example.co.uk', "o'brien@example.test"]) {
      expect(normalizeCustomerEmail(value), value).not.toBeNull()
    }
  })

  it('rejects everything outside the v1 grammar', () => {
    for (const value of [
      '',
      'no-at-sign',
      'a@@b.test',
      'a@b',
      '"quoted"@example.test',
      'a@exämple.test',
      'a b@example.test',
      '.leading@example.test',
      'trailing.@example.test',
      'double..dot@example.test',
      `${'a'.repeat(250)}@example.test`,
    ]) {
      expect(normalizeCustomerEmail(value), value).toBeNull()
    }
  })
})

describe('customer reads and replies (spec §6b–§6d)', () => {
  let open2: Db | null = null

  afterEach(async () => {
    await open2?.close()
    open2 = null
  })

  const CUSTOMER = 'customer@example.test'
  const OTHER = 'someone-else@example.test'

  async function harness() {
    const db = await createPgliteDb()
    open2 = db
    await migrate(db)
    const mailboxStore = createMailboxStore(db)
    const conversations = createConversationStore(db)
    const outbox = createEventOutboxStore(db)
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: SUPPORT_ADDRESS,
      provider: 'gmail',
    })
    const api = createInboxApi({
      store: conversations,
      apiToken: TOKEN,
      sender: NOOP_SENDER,
      senderResolver: { resolve: async () => ({ sender: NOOP_SENDER, from: SUPPORT_ADDRESS }) },
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
      agents: { store: createAgentStore(db), providers: [], mailboxStore },
      webhooks: {
        store: createWebhookEndpointStore(db, randomBytes(ENCRYPTION_KEY_BYTES)),
        queue: { async enqueue() {} },
      },
      assistants: { store: createAssistantStore(db) },
      savedReplies: { store: createSavedReplyStore(db), mailboxStore },
    })
    return { db, api, conversations, outbox, mailbox }
  }

  function get(path: string, email: string | null = CUSTOMER): Request {
    const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
    if (email !== null) headers[CUSTOMER_HEADER] = email
    return new Request(`https://x.example.test${path}`, { method: 'GET', headers })
  }

  /** A conversation owned by `email` with one visible inbound thread. */
  async function seed(
    conversations: ReturnType<typeof createConversationStore>,
    mailboxId: string,
    email: string,
    subject = 'Seeded',
  ) {
    return conversations.createCustomerConversation({
      subject,
      customerEmail: email,
      mailboxId,
      firstMessage: {
        direction: 'inbound',
        messageId: null,
        fromAddress: email,
        bodyText: 'first message',
      },
    })
  }

  it('lists only the caller’s own conversations', async () => {
    const { api, conversations, mailbox } = await harness()
    await seed(conversations, mailbox.id, CUSTOMER, 'Mine')
    await seed(conversations, mailbox.id, OTHER, 'Theirs')

    const res = await api(get('/api/v1/customer/conversations'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.conversations.map((c: { subject: string }) => c.subject)).toEqual(['Mine'])
  })

  it('matches a stored address that differs only by case (§3b)', async () => {
    const { api, conversations, mailbox } = await harness()
    await seed(conversations, mailbox.id, 'Mixed.Case@Example.TEST', 'Mine')

    const res = await api(get('/api/v1/customer/conversations', 'mixed.case@example.test'))
    const body = await res.json()
    expect(body.conversations).toHaveLength(1)
  })

  it('hides notes, unapproved drafts, and approved-but-unsent replies (§4a)', async () => {
    const { api, conversations, mailbox } = await harness()
    const { conversationId } = await seed(conversations, mailbox.id, CUSTOMER)

    await conversations.appendThread(conversationId, {
      direction: 'note',
      messageId: null,
      fromAddress: SUPPORT_ADDRESS,
      bodyText: 'INTERNAL: customer is on the free plan',
    })
    await conversations.appendThread(conversationId, {
      direction: 'outbound',
      messageId: null,
      fromAddress: SUPPORT_ADDRESS,
      bodyText: 'DRAFT: not approved yet',
      draftStatus: 'awaiting_review',
    })
    // Approved but never actually sent — the trap the predicate exists for.
    await conversations.appendThread(conversationId, {
      direction: 'outbound',
      messageId: null,
      fromAddress: SUPPORT_ADDRESS,
      bodyText: 'APPROVED BUT UNSENT',
      draftStatus: 'approved',
      deliveryStatus: 'pending',
    })

    const res = await api(get(`/api/v1/customer/conversations/${conversationId}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    const serialized = JSON.stringify(body)

    expect(serialized).not.toContain('INTERNAL')
    expect(serialized).not.toContain('DRAFT')
    expect(serialized).not.toContain('APPROVED BUT UNSENT')
    expect(body.threads).toHaveLength(1)
    expect(body.threadCount).toBe(1)
    expect(body.preview).toBe('first message')
  })

  it('shows an approved reply once it is sent', async () => {
    const { api, conversations, mailbox } = await harness()
    const { conversationId } = await seed(conversations, mailbox.id, CUSTOMER)
    await conversations.appendThread(conversationId, {
      direction: 'outbound',
      messageId: null,
      fromAddress: SUPPORT_ADDRESS,
      bodyText: 'here is your answer',
      draftStatus: 'approved',
      deliveryStatus: 'sent',
    })

    const res = await api(get(`/api/v1/customer/conversations/${conversationId}`))
    const body = await res.json()
    expect(body.threads).toHaveLength(2)
    expect(body.threads[1].bodyText).toBe('here is your answer')
  })

  it('hides an inbound row carrying a delivery_status the schema forbids (§4a)', async () => {
    const { api, conversations, db, mailbox } = await harness()
    const { conversationId } = await seed(conversations, mailbox.id, CUSTOMER)

    // Migration 002's CHECK forbids this combination, so the constraint is
    // dropped to seed it. That is the scenario: the predicate is a whitelist
    // over rows this API does not exclusively write, and a future migration
    // relaxing the CHECK, an import, or a manual repair must not silently
    // widen what a customer can see.
    await db.query('ALTER TABLE threads DROP CONSTRAINT threads_delivery_draft_status_check')
    await db.query(
      `INSERT INTO threads (conversation_id, direction, from_address, body_text, delivery_status, author_kind)
       VALUES ($1, 'inbound', $2, 'MALFORMED ROW', 'pending', 'customer')`,
      [conversationId, CUSTOMER],
    )

    const res = await api(get(`/api/v1/customer/conversations/${conversationId}`))
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('MALFORMED')
    expect(body.threads).toHaveLength(1)
    expect(body.threadCount).toBe(1)
  })

  it('hides a third-party inbound thread (§4c)', async () => {
    const { api, conversations, mailbox } = await harness()
    const { conversationId } = await seed(conversations, mailbox.id, CUSTOMER)
    await conversations.appendThread(conversationId, {
      direction: 'inbound',
      messageId: null,
      fromAddress: 'stranger@elsewhere.test',
      bodyText: 'FORWARDED TOKEN REPLY',
    })

    const res = await api(get(`/api/v1/customer/conversations/${conversationId}`))
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('FORWARDED')
    expect(body.threads).toHaveLength(1)
  })

  it('does not let an internal note change the customer’s updatedAt or ordering (§4b)', async () => {
    const { api, conversations, mailbox } = await harness()
    const older = await seed(conversations, mailbox.id, CUSTOMER, 'Older')
    await seed(conversations, mailbox.id, CUSTOMER, 'Newer')

    const before = await (await api(get('/api/v1/customer/conversations'))).json()
    expect(before.conversations.map((c: { subject: string }) => c.subject)).toEqual([
      'Newer',
      'Older',
    ])

    // A note bumps the STORED updated_at; the customer must see neither the
    // timestamp change nor the reordering it would cause.
    await conversations.appendThread(older.conversationId, {
      direction: 'note',
      messageId: null,
      fromAddress: SUPPORT_ADDRESS,
      bodyText: 'internal chatter',
    })

    const after = await (await api(get('/api/v1/customer/conversations'))).json()
    expect(after.conversations.map((c: { subject: string }) => c.subject)).toEqual([
      'Newer',
      'Older',
    ])
    const olderBefore = before.conversations.find((c: { subject: string }) => c.subject === 'Older')
    const olderAfter = after.conversations.find((c: { subject: string }) => c.subject === 'Older')
    expect(olderAfter.updatedAt).toBe(olderBefore.updatedAt)
  })

  it('returns the same 404 for another customer’s conversation and an unknown id (§5)', async () => {
    const { api, conversations, mailbox } = await harness()
    const theirs = await seed(conversations, mailbox.id, OTHER)

    const foreign = await api(get(`/api/v1/customer/conversations/${theirs.conversationId}`))
    const unknown = await api(
      get('/api/v1/customer/conversations/00000000-0000-4000-8000-000000000000'),
    )
    expect(foreign.status).toBe(unknown.status)
    expect(await foreign.json()).toEqual(await unknown.json())
    expect(foreign.status).toBe(404)
  })

  it('hides a spam conversation across list, get, and reply — and does not reopen it (§3c)', async () => {
    const { api, conversations, mailbox } = await harness()
    const { conversationId } = await seed(conversations, mailbox.id, CUSTOMER)
    await conversations.setConversationStatus(conversationId, 'spam')

    const list = await (await api(get('/api/v1/customer/conversations'))).json()
    expect(list.conversations).toHaveLength(0)

    expect((await api(get(`/api/v1/customer/conversations/${conversationId}`))).status).toBe(404)

    const reply = await api(
      new Request(
        `https://x.example.test/api/v1/customer/conversations/${conversationId}/replies`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            [CUSTOMER_HEADER]: CUSTOMER,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ bodyText: 'are you there?' }),
        },
      ),
    )
    expect(reply.status).toBe(404)

    // The refusal must happen BEFORE appendThread, which reopens closed OR
    // spam — a reopened row would leak the verdict by side-effect.
    const stored = await conversations.getConversation(conversationId)
    expect(stored?.status).toBe('spam')
    expect(stored?.threads).toHaveLength(1)
  })

  it('applies every row of §6d’s transition table, with its event', async () => {
    const { api, conversations, outbox, mailbox } = await harness()

    async function replyTo(id: string) {
      return api(
        new Request(`https://x.example.test/api/v1/customer/conversations/${id}/replies`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            [CUSTOMER_HEADER]: CUSTOMER,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ bodyText: 'following up' }),
        }),
      )
    }

    /**
     * The `reopened` flag on the message_received event for one specific
     * thread. Selected by threadId, never by position: a conversation has two
     * message_received events (its opening message and this reply), and
     * `claimBatch` orders by `occurredAt` alone, so a timestamp tie would make
     * a positional pick nondeterministic.
     */
    async function reopenedFlagForThread(threadId: string): Promise<boolean | undefined> {
      const events = await outbox.claimBatch({ batchSize: 200, leaseMs: 30_000 })
      const mine = events.find(
        (e) => e.type === 'conversation.message_received' && e.data.threadId === threadId,
      )
      return mine?.data.reopened as boolean | undefined
    }

    // active → active
    const active = await seed(conversations, mailbox.id, CUSTOMER, 'Active')
    const activeReply = await replyTo(active.conversationId)
    expect(activeReply.status).toBe(201)
    expect((await conversations.getConversation(active.conversationId))?.status).toBe('active')
    expect(await reopenedFlagForThread((await activeReply.json()).id)).toBe(false)

    // closed → active, reopened
    const closed = await seed(conversations, mailbox.id, CUSTOMER, 'Closed')
    await conversations.setConversationStatus(closed.conversationId, 'closed')
    const closedReply = await replyTo(closed.conversationId)
    expect(closedReply.status).toBe(201)
    expect((await conversations.getConversation(closed.conversationId))?.status).toBe('active')
    expect(await reopenedFlagForThread((await closedReply.json()).id)).toBe(true)

    // snoozed pending → active, snoozedUntil cleared, reopened
    const snoozed = await seed(conversations, mailbox.id, CUSTOMER, 'Snoozed')
    await conversations.setConversationStatus(snoozed.conversationId, 'pending', {
      snoozedUntil: new Date(Date.now() + 86_400_000),
    })
    const snoozedReply = await replyTo(snoozed.conversationId)
    expect(snoozedReply.status).toBe(201)
    const woken = await conversations.getConversation(snoozed.conversationId)
    expect(woken?.status).toBe('active')
    expect(woken?.snoozedUntil).toBeNull()
    expect(await reopenedFlagForThread((await snoozedReply.json()).id)).toBe(true)

    // plain pending → stays pending (an operator statement a reply must not override)
    const pending = await seed(conversations, mailbox.id, CUSTOMER, 'Pending')
    await conversations.setConversationStatus(pending.conversationId, 'pending')
    const pendingReply = await replyTo(pending.conversationId)
    expect(pendingReply.status).toBe(201)
    expect((await conversations.getConversation(pending.conversationId))?.status).toBe('pending')
    expect(await reopenedFlagForThread((await pendingReply.json()).id)).toBe(false)
  })

  it('rejects a genuinely duplicated or empty customer header (§3a)', async () => {
    const { api, mailbox } = await harness()

    // A Record cannot express a repeated header; Headers can, and joins
    // repeats with ", " — which is the behavior the rejection relies on.
    const duplicated = new Headers({ Authorization: `Bearer ${TOKEN}` })
    duplicated.append(CUSTOMER_HEADER, CUSTOMER)
    duplicated.append(CUSTOMER_HEADER, OTHER)
    const dupRes = await api(
      new Request(`https://x.example.test/api/v1/customer/conversations`, {
        method: 'GET',
        headers: duplicated,
      }),
    )
    expect(dupRes.status).toBe(400)

    const empty = await api(get('/api/v1/customer/conversations', ''))
    expect(empty.status).toBe(400)
    expect(mailbox.id).toBeTruthy()
  })

  it('binds the cursor to the customer and folder (§3d)', async () => {
    const { api, conversations, mailbox } = await harness()
    for (let i = 0; i < 3; i++) await seed(conversations, mailbox.id, CUSTOMER, `C${i}`)

    const first = await (await api(get('/api/v1/customer/conversations?limit=1'))).json()
    expect(first.conversations).toHaveLength(1)
    expect(first.nextCursor).toBeTruthy()

    const cursor = encodeURIComponent(first.nextCursor)
    // Same customer, same folder — accepted.
    expect((await api(get(`/api/v1/customer/conversations?limit=1&cursor=${cursor}`))).status).toBe(
      200,
    )
    // Different customer — rejected.
    expect(
      (await api(get(`/api/v1/customer/conversations?limit=1&cursor=${cursor}`, OTHER))).status,
    ).toBe(400)
    // Different folder — rejected.
    expect(
      (await api(get(`/api/v1/customer/conversations?status=closed&limit=1&cursor=${cursor}`)))
        .status,
    ).toBe(400)
  })
})
