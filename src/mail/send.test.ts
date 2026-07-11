import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import { type ConversationStore, createConversationStore } from '../store/conversations.js'
import type { ParsedEmail } from './parse.js'
import type { Keyring, SigningKey } from './reply-token.js'
import { type SendReplyDeps, sendReply } from './send.js'
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
    async send(email) {
      sent.push(email)
      return { providerMessageId: 'provider-1' }
    },
  }
}

/** Always throws — simulates a provider transport failure. */
function failingSender(): EmailSender {
  return {
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
      references: ['<inbound-1@customer.example.test>'],
    })

    const conversation = await store.getConversation(conversationId)
    const outbound = conversation?.threads.find((t) => t.id === first.threadId)
    expect(outbound?.deliveryStatus).toBe('sent')
  })

  it('concurrency: a second same-key sendReply call made while the first is still in flight observes the lease and never sends', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)

    let releaseSend: () => void = () => {}
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve
    })
    let sendCallCount = 0
    const sender: EmailSender = {
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
})
