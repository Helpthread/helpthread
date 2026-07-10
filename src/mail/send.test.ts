import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { EmailSender, OutboundEmail } from '../providers/email-sender.js'
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

  it('send failure: sendReply re-throws and the outbound thread is left failed', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const deps: SendReplyDeps = { store, sender: failingSender(), keyring, mailDomain }

    await expect(
      sendReply(
        {
          conversationId,
          from: 'support@example.test',
          to: ['customer@example.test'],
          subject: 'Re: Help with my order',
          text: "We're looking into it!",
        },
        deps,
      ),
    ).rejects.toThrow('boom: provider unreachable')

    const conversation = await store.getConversation(conversationId)
    const outbound = conversation?.threads.find((t) => t.direction === 'outbound')
    expect(outbound).toMatchObject({ deliveryStatus: 'failed' })
  })

  it('send failure AND mark failure: both errors surface via AggregateError; the send cause is not lost', async () => {
    const { store: realStore } = await freshStore()
    const { conversationId } = await seedConversation(realStore)
    // Wrap the real store so the 'failed' mark itself throws — the worst case
    // where a DB blip lands right after the provider rejected.
    const store: ConversationStore = {
      ...realStore,
      async setThreadDeliveryStatus() {
        throw new Error('db down: cannot mark thread failed')
      },
    }
    const deps: SendReplyDeps = { store, sender: failingSender(), keyring, mailDomain }

    let caught: unknown
    try {
      await sendReply(
        {
          conversationId,
          from: 'support@example.test',
          to: ['customer@example.test'],
          subject: 'Re: Help with my order',
          text: "We're looking into it!",
        },
        deps,
      )
      throw new Error('unreachable: sendReply should have thrown')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AggregateError)
    const messages = (caught as AggregateError).errors.map((e) => (e as Error).message)
    // The ORIGINAL provider failure is preserved, not swapped for the DB error.
    expect(messages.some((m) => m.includes('boom: provider unreachable'))).toBe(true)
    expect(messages.some((m) => m.includes('db down: cannot mark thread failed'))).toBe(true)
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
