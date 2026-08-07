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

const NOOP_SENDER: EmailSender = { maxSendMs: 30_000, async send() {} }

/** A `BlobStore` that records writes and can be told to fail on the Nth put. */
function createFakeBlobStore(failOnPut = -1): {
  blobStore: BlobStore
  written: string[]
} {
  const written: string[] = []
  return {
    written,
    blobStore: {
      async put(key) {
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
      attachments: { store: { async listByConversationId() { return [] } }, blobStore },
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
    return { subject: 'Cannot export my report', bodyText: 'It times out every time.', mailboxId, ...extra }
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
        body: validBody(mailbox.id, { customerEmail: 'victim@example.test', fromAddress: 'victim@example.test' }),
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

    for (const email of [null, 'a@example.test,b@example.test', 'not-an-email', '"quoted"@example.test', 'a@@b.test']) {
      const res = await api(req({ email, body: validBody(mailbox.id) }))
      expect(res.status, `email=${String(email)}`).toBe(400)
      expect((await res.json()).error.code).toBe('validation_failed')
    }
  })

  it('rejects an unknown or non-active mailbox', async () => {
    const { api, db, mailbox } = await harness()

    const unknown = await api(
      req({ email: 'customer@example.test', body: validBody('00000000-0000-4000-8000-000000000000') }),
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
          attachments: [{ filename: 'log.txt', contentType: 'text/plain', data: Buffer.from('hello').toString('base64') }],
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
    const all = await conversations.listConversations({ status: 'open', limit: 50 })
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
            { filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('a').toString('base64') },
            { filename: 'b.txt', contentType: 'text/plain', data: Buffer.from('b').toString('base64') },
          ],
        }),
      }),
    )
    expect(res.status).toBe(502)

    const all = await conversations.listConversations({ status: 'open', limit: 50 })
    expect(all).toHaveLength(0)
  })

  it('rejects a method other than POST with 405', async () => {
    const { api } = await harness()
    const res = await api(
      new Request(`https://x.example.test${PATH}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
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
