import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import { type ConversationStore, createConversationStore } from '../store/conversations.js'
import { createInboundDeliveryStore } from '../store/inbound-deliveries.js'
import { createMailboxStore } from '../store/mailboxes.js'
import { verifyViewToken } from './open-tracking.js'
import type { ParsedEmail } from './parse.js'
import type { Keyring, SigningKey } from './reply-token.js'
import { DEFAULT_LEASE_MS, type SendReplyDeps, sendReply } from './send.js'
import { decideThreading } from './thread.js'

// --- fixtures ----------------------------------------------------------------

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

const KEY_A: SigningKey = { keyId: 'k1', secret: 'secret-A-high-entropy-0123456789abcdef' }
const keyring: Keyring = { current: KEY_A }
const mailDomain = 'mail.example.test'

/** Records every `OutboundEmail` it is asked to send; never fails. */
function fakeSender(): EmailSender & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = []
  return {
    sent,
    maxSendMs: 30_000,
    async send(email) {
      sent.push(email)
      return { providerMessageId: 'provider-1' }
    },
  }
}

/** Always throws — simulates a provider transport failure. */
function failingSender(): EmailSender {
  return {
    maxSendMs: 30_000,
    async send() {
      throw new Error('boom: provider unreachable')
    },
  }
}

/** Minimal ParsedEmail builder — only threading-relevant fields vary per test. */
function inboundReplyTo(messageId: string): ParsedEmail {
  return {
    messageId: '<inbound-2@customer.example.test>',
    inReplyTo: messageId,
    references: [],
    from: { address: 'customer@example.test' },
    to: [{ address: 'support@example.test' }],
    cc: [],
    subject: 'Re: Help with my order',
    date: null,
    text: 'Thanks, still broken though.',
    html: null,
    headers: {},
    attachments: [],
  }
}

/** Directly flips a conversation's status for test setup. */
async function setStatus(db: Db, conversationId: string, status: 'open' | 'closed' | 'deleted') {
  await db.query('UPDATE conversations SET status = $1 WHERE id = $2', [status, conversationId])
}

// --- suite ---------------------------------------------------------------------

describe('sendReply', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: ConversationStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createConversationStore(db) }
  }

  async function seedConversation(store: ConversationStore) {
    return store.createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<inbound-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
  }

  it('happy path: persists a sent outbound thread and hands the exact messageId to the sender', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
        inReplyTo: '<inbound-1@customer.example.test>',
      },
      deps,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.delivery).toBe('sent')
    expect(result.threadId).toEqual(expect.any(String))
    expect(result.messageId).toMatch(/^<ht\.k1\./)

    // The fake sender received the EXACT engine-minted messageId, verbatim.
    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0].messageId).toBe(result.messageId)
    expect(sender.sent[0].inReplyTo).toBe('<inbound-1@customer.example.test>')

    const conversation = await store.getConversation(conversationId)
    const outbound = conversation?.threads.find((t) => t.direction === 'outbound')
    expect(outbound).toMatchObject({
      id: result.threadId,
      messageId: result.messageId,
      deliveryStatus: 'sent',
      bodyText: "We're looking into it!",
    })
  })

  it('round-trip: a reply to the minted messageId threads back to the same conversation and outbound thread', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const sent = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )
    if (!sent.ok) throw new Error('unreachable')

    const inbound = inboundReplyTo(sent.messageId)
    const decision = decideThreading(inbound, keyring)

    expect(decision).toEqual({
      kind: 'append',
      conversationId,
      threadId: sent.threadId,
      forgedTokenCount: 0,
    })
  })

  // HT-49: live production evidence (2026-07-17) showed Gmail's
  // `users.messages.send` REPLACING the engine-minted Message-ID with a
  // Gmail-generated one on the wire — so a customer's reply threading purely
  // on `In-Reply-To`/the trailing `References` entry finds no verified token
  // and (correctly, per invariant #5) starts a NEW conversation instead of
  // appending. The fix: `sendReply` appends its own minted messageId as the
  // FINAL References entry (module doc), which survives because Gmail does
  // NOT rewrite References — so it rides along into the customer's reply
  // one position before whatever foreign id the provider substituted.
  it("HT-49: derived envelope — sendEnvelope.references ends with this reply's OWN minted messageId, after any ancestor ids", async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
        inReplyTo: '<inbound-1@customer.example.test>',
        references: ['<inbound-1@customer.example.test>'],
      },
      deps,
    )
    if (!result.ok) throw new Error('unreachable')

    // Sent on the wire (via the provider seam) — ends with our own token.
    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0].references).toEqual([
      '<inbound-1@customer.example.test>',
      result.messageId,
    ])
    // In-Reply-To is UNCHANGED — it still names the ancestor being answered,
    // never this reply's own id.
    expect(sender.sent[0].inReplyTo).toBe('<inbound-1@customer.example.test>')

    // Persisted verbatim in the outbound thread's send_envelope snapshot —
    // what any later retry (a keyed replay, or the delivery worker) resends.
    const conversation = await store.getConversation(conversationId)
    const outbound = conversation?.threads.find((t) => t.id === result.threadId)
    expect(outbound?.sendEnvelope?.references).toEqual([
      '<inbound-1@customer.example.test>',
      result.messageId,
    ])
  })

  it('HT-49: a first reply with NO ancestor references still gets a one-element References: [ownMessageId]', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )
    if (!result.ok) throw new Error('unreachable')

    expect(sender.sent[0].references).toEqual([result.messageId])
  })

  it('HT-49: the exact live-production failure — a customer reply whose In-Reply-To is a FOREIGN (Gmail-rewritten) id and whose References carries our token one position before it still threads into the original conversation', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const sent = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
        inReplyTo: '<inbound-1@customer.example.test>',
        references: ['<inbound-1@customer.example.test>'],
      },
      deps,
    )
    if (!sent.ok) throw new Error('unreachable')

    // What the engine actually sent (mime.ts/gmail sender wire contract):
    // References = [...ancestors, ourMintedToken].
    expect(sender.sent[0].references).toEqual(['<inbound-1@customer.example.test>', sent.messageId])

    // Gmail REPLACES the wire Message-ID with its own id (live-confirmed
    // 2026-07-17) — so the customer's mail client builds ITS OWN reply as
    // In-Reply-To: {gmail's id}, References: {our outbound References} +
    // {gmail's id}. Our token ends up MID-CHAIN, one position before the
    // trailing foreign id — never last, never in In-Reply-To at all.
    const gmailRewrittenId = '<CAKWkAL3-gmail-generated-id@mail.gmail.com>'
    const customerReply = inboundReplyTo(gmailRewrittenId)
    customerReply.references = [
      '<inbound-1@customer.example.test>',
      sent.messageId,
      gmailRewrittenId,
    ]

    const decision = decideThreading(customerReply, keyring)

    expect(decision).toEqual({
      kind: 'append',
      conversationId,
      threadId: sent.threadId,
      forgedTokenCount: 0,
    })
  })

  it('send failure: returns { send-failed, persistedStatus: failed } and leaves the thread failed', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const deps: SendReplyDeps = { store, sender: failingSender(), keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: 'send-failed',
      persistedStatus: 'failed',
      threadId: expect.any(String),
      messageId: expect.any(String),
    })

    const conversation = await store.getConversation(conversationId)
    const outbound = conversation?.threads.find((t) => t.direction === 'outbound')
    expect(outbound).toMatchObject({ deliveryStatus: 'failed' })
  })

  it('send failure AND mark-failed failure: returns { send-failed, persistedStatus: pending } (no throw)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store: realStore } = await freshStore()
    const { conversationId } = await seedConversation(realStore)
    // Provider rejects, then the 'failed' mark ALSO throws — the row is stuck
    // 'pending'. sendReply must report that honestly, not throw and not claim a
    // durable 'failed' state.
    const store: ConversationStore = {
      ...realStore,
      async setThreadDeliveryStatus() {
        throw new Error('db down: cannot mark thread failed')
      },
    }
    const deps: SendReplyDeps = { store, sender: failingSender(), keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )

    expect(result).toMatchObject({ ok: false, reason: 'send-failed', persistedStatus: 'pending' })
    errorSpy.mockRestore()
  })

  it('sent-but-mark-sent-fails: still returns ok (the message WAS delivered — must not report failure)', async () => {
    // The double-send hole: provider ACCEPTS the message, then recording 'sent'
    // throws. The email went out, so sendReply must resolve ok — reporting a
    // failure here would make a caller resend an already-delivered message.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store: realStore } = await freshStore()
    const { conversationId } = await seedConversation(realStore)
    const sender = fakeSender()
    const store: ConversationStore = {
      ...realStore,
      async setThreadDeliveryStatus() {
        throw new Error('db blip right after a successful send')
      },
    }
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )

    expect(result).toMatchObject({ ok: true, delivery: 'sent' })
    // And the message really was handed to the provider.
    expect(sender.sent).toHaveLength(1)
    errorSpy.mockRestore()
  })

  it('refused: a deleted conversation is refused, the sender is never called, and nothing is added', async () => {
    const { db: rawDb, store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    await setStatus(rawDb, conversationId, 'deleted')

    const sender = fakeSender()
    const sendSpy = vi.spyOn(sender, 'send')
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )

    expect(result).toEqual({ ok: false, reason: 'conversation-deleted' })
    expect(sendSpy).not.toHaveBeenCalled()

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.threads).toHaveLength(1)
  })

  it('refused: a missing conversation is refused and the sender is never called', async () => {
    const { store } = await freshStore()
    const sender = fakeSender()
    const sendSpy = vi.spyOn(sender, 'send')
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId: RANDOM_UUID,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )

    expect(result).toEqual({ ok: false, reason: 'conversation-not-found' })
    expect(sendSpy).not.toHaveBeenCalled()
  })
})

// --- self-echo guard (HT-49 review fix) -------------------------------------
//
// Gmail delivers a sent reply's own copy back into the SAME mailbox it was
// sent from; without this guard, the reply token this fix (HT-49) puts in
// EVERY outbound References would make that self-echo `append` into the very
// conversation it belongs to (module doc's "The reply token's own self-echo"
// section). These tests exercise `selfEchoGuard` directly against a real
// `InboundDeliveryStore`/`MailboxStore`, rather than a fake, so the
// suppressed row's shape (and `claim()`'s later behavior against it) is
// verified, not assumed.

describe('sendReply self-echo guard (HT-49 review fix)', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshDeps() {
    db = await createPgliteDb()
    await migrate(db)
    const store = createConversationStore(db)
    const mailboxStore = createMailboxStore(db)
    const inboundDeliveryStore = createInboundDeliveryStore(db)
    await db.query("INSERT INTO mailboxes (address, provider) VALUES ($1, 'gmail')", [
      'support@example.test',
    ])
    const { conversationId } = await store.createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<inbound-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
    return { db, store, mailboxStore, inboundDeliveryStore, conversationId }
  }

  it("a successful send whose sender returns a providerMessageId pre-suppresses that id in the FROM mailbox's inbound delivery ledger", async () => {
    const { store, mailboxStore, inboundDeliveryStore, conversationId } = await freshDeps()
    const sender = fakeSender() // returns { providerMessageId: 'provider-1' }
    const deps: SendReplyDeps = {
      store,
      sender,
      keyring,
      mailDomain,
      selfEchoGuard: { mailboxStore, inboundDeliveryStore },
    }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )
    if (!result.ok) throw new Error('unreachable')

    // The exact self-echo Gmail would later report via history.list for
    // THIS send is already suppressed — claim() reports it as terminal,
    // never as a fresh 'received' row ingest would append.
    const mailbox = await mailboxStore.getMailboxByAddress('support@example.test')
    const claim = await inboundDeliveryStore.claim(mailbox?.id ?? '', 'provider-1', 30_000)
    expect(claim).toMatchObject({
      claimed: false,
      delivery: { status: 'suppressed', lastError: 'own-outbound-self-echo' },
    })
  })

  it('no selfEchoGuard configured: send succeeds exactly as before, no ledger row is created', async () => {
    const { db, store, conversationId } = await freshDeps()
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )

    expect(result.ok).toBe(true)
    // No mailbox lookup or ledger write ever happens without a configured guard.
    const rows = await db.query('SELECT id FROM inbound_deliveries')
    expect(rows).toHaveLength(0)
  })

  it('sender returns no providerMessageId: guard is configured but a no-op (nothing to correlate against)', async () => {
    const { store, mailboxStore, inboundDeliveryStore, conversationId } = await freshDeps()
    const sender: EmailSender = {
      maxSendMs: 30_000,
      async send() {
        return {} // no providerMessageId
      },
    }
    const deps: SendReplyDeps = {
      store,
      sender,
      keyring,
      mailDomain,
      selfEchoGuard: { mailboxStore, inboundDeliveryStore },
    }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )

    expect(result.ok).toBe(true)
    const mailbox = await mailboxStore.getMailboxByAddress('support@example.test')
    expect(mailbox).not.toBeNull()
    // Nothing to correlate against without a providerMessageId — no row was seeded.
    const claim = await inboundDeliveryStore.claim(mailbox?.id ?? '', 'whatever', 30_000)
    expect(claim.claimed).toBe(true) // fresh — proves nothing was pre-seeded.
  })

  it('a failed send never pre-suppresses anything (nothing was delivered, so there is no self-echo to guard against)', async () => {
    const { store, mailboxStore, inboundDeliveryStore, conversationId } = await freshDeps()
    const sender = failingSender()
    const deps: SendReplyDeps = {
      store,
      sender,
      keyring,
      mailDomain,
      selfEchoGuard: { mailboxStore, inboundDeliveryStore },
    }

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
      },
      deps,
    )

    expect(result.ok).toBe(false)
    const mailbox = await mailboxStore.getMailboxByAddress('support@example.test')
    const claim = await inboundDeliveryStore.claim(mailbox?.id ?? '', 'provider-1', 30_000)
    expect(claim.claimed).toBe(true) // fresh — nothing was pre-seeded for a rejected send.
  })
})

// --- idempotency (HT-16) -----------------------------------------------------

describe('sendReply idempotency (HT-16)', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: ConversationStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createConversationStore(db) }
  }

  async function seedConversation(store: ConversationStore) {
    return store.createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<inbound-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
  }

  it('regression pin: two sendReply calls with NO idempotencyKey are two independent sends with distinct threadIds — by design, permanent', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }
    const input = {
      conversationId,
      from: 'support@example.test',
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      text: "We're looking into it!",
    }

    const first = await sendReply(input, deps)
    const second = await sendReply(input, deps)

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('unreachable')
    expect(second.threadId).not.toBe(first.threadId)
    expect(second.messageId).not.toBe(first.messageId)
    expect(sender.sent).toHaveLength(2)
  })

  it('two sendReply calls with the SAME idempotencyKey result in exactly ONE sender.send() call', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }
    const input = {
      conversationId,
      from: 'support@example.test',
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      text: "We're looking into it!",
      idempotencyKey: 'same-key',
    }

    await sendReply(input, deps)
    await sendReply(input, deps)

    expect(sender.sent).toHaveLength(1)
  })

  it('replay after success: the SAME threadId/messageId is returned and the sender is not re-invoked', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }
    const input = {
      conversationId,
      from: 'support@example.test',
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      text: "We're looking into it!",
      idempotencyKey: 'replay-key',
    }

    const first = await sendReply(input, deps)
    const second = await sendReply(input, deps)

    expect(first).toEqual(second)
    expect(sender.sent).toHaveLength(1)
  })

  it('replay after failure: failed → sent, messageId byte-identical, and the RESENT envelope matches the ORIGINAL attempt even when the retry call supplies different to/subject/references and a new inbound message arrived in between', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const deps1: SendReplyDeps = { store, sender: failingSender(), keyring, mailDomain }

    const first = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: "We're looking into it!",
        references: ['<inbound-1@customer.example.test>'],
        idempotencyKey: 'retry-key-1',
      },
      deps1,
    )
    expect(first).toMatchObject({ ok: false, reason: 'send-failed', persistedStatus: 'failed' })
    if (first.ok || first.reason !== 'send-failed') throw new Error('unreachable')

    // A new inbound message lands on the conversation BETWEEN the failed
    // attempt and the retry — a caller that recomputed References from the
    // conversation's current state would now see a longer chain.
    await store.appendThread(conversationId, {
      direction: 'inbound',
      messageId: '<inbound-2@customer.example.test>',
      fromAddress: 'customer@example.test',
      bodyText: 'Any update?',
    })

    const sender = fakeSender()
    const deps2: SendReplyDeps = { store, sender, keyring, mailDomain }
    // The retry deliberately supplies DIFFERENT to/subject/references — this
    // must be ignored in favor of the stored snapshot from the first attempt.
    const second = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['someone-else@example.test'],
        subject: 'A totally different subject',
        text: 'different body',
        references: ['<inbound-1@customer.example.test>', '<inbound-2@customer.example.test>'],
        idempotencyKey: 'retry-key-1',
      },
      deps2,
    )
    expect(second).toMatchObject({ ok: true, delivery: 'sent' })
    if (!second.ok) throw new Error('unreachable')
    expect(second.messageId).toBe(first.messageId)
    expect(second.threadId).toBe(first.threadId)

    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]).toMatchObject({
      messageId: first.messageId,
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      // HT-49: References carries the reply's OWN minted messageId as its
      // FINAL entry (after the persisted ancestor chain) — see send.ts's
      // module doc. This is the ORIGINAL attempt's messageId/references,
      // unaffected by the retry's different (ignored) references input.
      references: ['<inbound-1@customer.example.test>', first.messageId],
    })

    const conversation = await store.getConversation(conversationId)
    const outbound = conversation?.threads.find((t) => t.id === first.threadId)
    expect(outbound?.deliveryStatus).toBe('sent')
  })

  // (Runs against the single-connection, in-process PGlite used in tests —
  // the sender gate below deterministically interleaves the two `sendReply`
  // calls at the application level, but the underlying `claimThreadForDelivery`
  // UPDATE is still executed by a single DB connection, never by two
  // genuinely concurrent ones. This proves the sequential claim-while-held
  // logic — a second caller sees the first's lease and backs off — but NOT
  // true multi-connection atomicity of the row-locked `UPDATE`. Real-race
  // coverage waits for a multi-connection backend, same caveat as
  // migrate.ts's advisory-lock note.)
  it('concurrency: a second same-key sendReply call made while the first is still in flight observes the lease and never sends', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)

    let releaseSend: () => void = () => {}
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    let sendCallCount = 0
    const sender: EmailSender = {
      maxSendMs: 30_000,
      async send() {
        sendCallCount++
        await sendGate
        return {}
      },
    }
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }
    const input = {
      conversationId,
      from: 'support@example.test',
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      text: "We're looking into it!",
      idempotencyKey: 'concurrent-key',
    }

    const firstPromise = sendReply(input, deps)
    // Wait until the first call has actually reached the (blocked) sender —
    // i.e. it has persisted, claimed the lease, and is mid-send.
    await vi.waitFor(() => expect(sendCallCount).toBe(1))

    const second = await sendReply(input, deps)
    expect(second).toEqual({ ok: false, reason: 'retry-in-progress' })
    expect(sendCallCount).toBe(1) // the second call never reached the sender

    releaseSend()
    const first = await firstPromise
    expect(first).toMatchObject({ ok: true, delivery: 'sent' })

    const conversation = await store.getConversation(conversationId)
    expect(conversation?.threads.filter((t) => t.direction === 'outbound')).toHaveLength(1)
  })

  // --- HT-16 CodeRabbit fix: sent-row reclaim double-send ---------------------
  //
  // CodeRabbit (Major): claimThreadForDelivery's WHERE clause checked only the
  // lease, not delivery_status. Interleaving: a keyed sendReply's get-or-insert
  // snapshot observes a row as 'pending'/'failed', but by the time it calls
  // claimThreadForDelivery, a concurrent attempt has already delivered the
  // message and released the lease with 'sent' — the lease is free, so the
  // (unfixed) claim would succeed again and attemptDeliveryOfClaimedThread
  // would resend an already-delivered message. The fix adds `AND
  // delivery_status IN ('pending', 'failed')` to the claim's WHERE clause
  // (src/store/conversations.ts) and, on the client side, re-reads the row on
  // a failed claim so a genuinely-'sent' row resolves to the same
  // success-replay result as the early 'sent' check, not 'retry-in-progress'.
  it('reclaim-after-sent: a keyed row that turns "sent" between the get-or-insert snapshot and the claim call resolves as a success replay, not a resend', async () => {
    const { store: realStore, db: rawDb } = await freshStore()
    const { conversationId } = await seedConversation(realStore)
    const sender = fakeSender()

    // A store double whose appendThread behaves exactly like the real one,
    // except that — simulating a concurrent same-key attempt (or the
    // delivery worker) completing delivery in the gap between this
    // get-or-insert snapshot and sendReply's later claim call — it flips the
    // row to 'sent' (lease already free) immediately after returning the
    // ORIGINAL (still 'pending') snapshot to the caller.
    const store: ConversationStore = {
      ...realStore,
      async appendThread(convId, thread) {
        const result = await realStore.appendThread(convId, thread)
        if (result.ok) {
          await rawDb.query(
            "UPDATE threads SET delivery_status = 'sent', claimed_until = NULL WHERE id = $1",
            [result.threadId],
          )
        }
        return result
      },
    }
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }
    const input = {
      conversationId,
      from: 'support@example.test',
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      text: "We're looking into it!",
      idempotencyKey: 'toctou-key',
    }

    const result = await sendReply(input, deps)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.delivery).toBe('sent')
    expect(sender.sent).toHaveLength(0) // never re-sent — already delivered
  })
})

describe('lease / sender-bound coupling', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: ConversationStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createConversationStore(db) }
  }

  async function seedConversation(store: ConversationStore) {
    return store.createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<inbound-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
  }

  const input = (conversationId: string) => ({
    conversationId,
    from: 'support@example.test',
    to: ['customer@example.test'],
    subject: 'Re: Help with my order',
    text: "We're looking into it!",
  })

  it('keyed path: a sender whose maxSendMs does not stay strictly below the lease throws BEFORE claiming or sending', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    // Equality is deliberately a violation too — the lease must STRICTLY
    // exceed the bound (specs/mail/sending.md §3a).
    const sender = { ...fakeSender(), maxSendMs: DEFAULT_LEASE_MS }
    const sendSpy = vi.spyOn(sender, 'send')
    const claimSpy = vi.spyOn(store, 'claimThreadForDelivery')
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    await expect(
      sendReply({ ...input(conversationId), idempotencyKey: 'k-violating' }, deps),
    ).rejects.toThrow(/must strictly exceed/)

    expect(claimSpy).not.toHaveBeenCalled()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('no-key path: the assertion does not apply — there is no lease to violate', async () => {
    // A fresh no-key send never claims a lease, so a sender whose bound
    // exceeds DEFAULT_LEASE_MS is not a misconfiguration ON THIS PATH; the
    // retry paths (keyed claim above, worker sweep — see
    // delivery-worker.test.ts) are where the invariant is enforced.
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = { ...fakeSender(), maxSendMs: DEFAULT_LEASE_MS * 2 }
    const deps: SendReplyDeps = { store, sender, keyring, mailDomain }

    const result = await sendReply(input(conversationId), deps)
    expect(result).toMatchObject({ ok: true, delivery: 'sent' })
    expect(sender.sent).toHaveLength(1)
  })
})
describe('open tracking (HT-32, spec §4g v1.1)', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: ConversationStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createConversationStore(db) }
  }

  async function seedConversation(store: ConversationStore) {
    return store.createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<inbound-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
  }

  const HTML = '<html><body><p>Fixed in the next release.</p></body></html>'

  function replyInput(conversationId: string) {
    return {
      conversationId,
      from: 'support@example.test',
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      text: 'Fixed in the next release.',
      html: HTML,
    }
  }

  it('OFF (the default): the sent html and text are byte-identical to the input — no pixel anywhere', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()

    const result = await sendReply(replyInput(conversationId), {
      store,
      sender,
      keyring,
      mailDomain,
    })
    expect(result.ok).toBe(true)

    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0].html).toBe(HTML)
    expect(sender.sent[0].text).toBe('Fixed in the next release.')
    expect(sender.sent[0].html).not.toContain('/api/v1/t/')

    const conversation = await store.getConversation(conversationId)
    const outbound = conversation?.threads.find((t) => t.direction === 'outbound')
    expect(outbound?.bodyHtml).toBe(HTML)
    expect(outbound?.customerViewedAt).toBeNull()
  })

  it('ON: the html body (and ONLY the html body) carries a pixel whose token verifies and binds THIS thread', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()

    const result = await sendReply(replyInput(conversationId), {
      store,
      sender,
      keyring,
      mailDomain,
      openTracking: { publicBaseUrl: 'https://desk.example.test' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const sentHtml = sender.sent[0].html as string
    const match = /https:\/\/desk\.example\.test\/api\/v1\/t\/([^"]+)\.gif/.exec(sentHtml)
    expect(match).not.toBeNull()
    // The token is a SIGNED credential bound to the outbound thread — never
    // the bare uuid (spec §4g's forgery guard).
    const token = (match as RegExpExecArray)[1]
    expect(token).not.toBe(result.threadId)
    expect(verifyViewToken(token, keyring)).toEqual({ threadId: result.threadId })

    // Injected before </body>; the text part is untouched.
    expect(sentHtml).toMatch(/style="display:none"><\/body><\/html>$/)
    expect(sender.sent[0].text).toBe('Fixed in the next release.')

    // Persisted bodyHtml === sent html, so every retry path (which rebuilds
    // from the stored row) carries the same pixel with no extra logic.
    const conversation = await store.getConversation(conversationId)
    const outbound = conversation?.threads.find((t) => t.direction === 'outbound')
    expect(outbound?.bodyHtml).toBe(sentHtml)
  })

  it('ON with a text-only reply: no html part is fabricated just to track', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const sender = fakeSender()

    const result = await sendReply(
      {
        conversationId,
        from: 'support@example.test',
        to: ['customer@example.test'],
        subject: 'Re: Help with my order',
        text: 'Plain text only.',
      },
      {
        store,
        sender,
        keyring,
        mailDomain,
        openTracking: { publicBaseUrl: 'https://desk.example.test' },
      },
    )
    expect(result.ok).toBe(true)
    expect(sender.sent[0].html).toBeUndefined()
    expect(sender.sent[0].text).toBe('Plain text only.')
  })
})
