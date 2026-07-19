import { describe, expect, it } from 'vitest'
import type { StoredThread } from '../store/conversations.js'
import { deriveReplyHeaders } from './reply-headers.js'

/** Minimal StoredThread builder — only the fields deriveReplyHeaders reads vary per test. */
function thread(overrides: Partial<StoredThread>): StoredThread {
  return {
    id: 'thread-id',
    conversationId: 'conversation-id',
    direction: 'inbound',
    messageId: null,
    inReplyTo: null,
    fromAddress: 'customer@example.test',
    bodyText: null,
    bodyHtml: null,
    deliveryStatus: null,
    idempotencyKey: null,
    sendEnvelope: null,
    claimedUntil: null,
    customerViewedAt: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    authorKind: 'customer',
    authorAgentId: null,
    authorAssistantId: null,
    draftStatus: null,
    approvedByAgentId: null,
    draftResolvedAt: null,
    draftEdited: false,
    ...overrides,
  }
}

describe('deriveReplyHeaders', () => {
  it('prefixes the subject with Re: when not already prefixed', () => {
    const { subject } = deriveReplyHeaders({ subject: 'Help with my order', threads: [] })
    expect(subject).toBe('Re: Help with my order')
  })

  it('does not double-prefix a subject already starting with re: (case-insensitive)', () => {
    expect(deriveReplyHeaders({ subject: 'RE: Help', threads: [] }).subject).toBe('RE: Help')
    expect(deriveReplyHeaders({ subject: 're: Help', threads: [] }).subject).toBe('re: Help')
  })

  it('inReplyTo is the most recent INBOUND thread with a messageId; references is every non-null messageId in order', () => {
    const threads = [
      thread({ direction: 'inbound', messageId: '<inbound-1@customer.example.test>' }),
      thread({ direction: 'outbound', messageId: '<ht.k1.c1.t1.sig@mail.example.test>' }),
      thread({ direction: 'inbound', messageId: '<inbound-2@customer.example.test>' }),
    ]
    const { inReplyTo, references } = deriveReplyHeaders({ subject: 'Help', threads })
    expect(inReplyTo).toBe('<inbound-2@customer.example.test>')
    expect(references).toEqual([
      '<inbound-1@customer.example.test>',
      '<ht.k1.c1.t1.sig@mail.example.test>',
      '<inbound-2@customer.example.test>',
    ])
  })

  it('inReplyTo is undefined when no inbound thread has a messageId', () => {
    const threads = [thread({ direction: 'inbound', messageId: null })]
    expect(deriveReplyHeaders({ subject: 'Help', threads }).inReplyTo).toBeUndefined()
  })

  it('references is undefined (never []) when no thread has a messageId', () => {
    const threads = [thread({ direction: 'inbound', messageId: null })]
    expect(deriveReplyHeaders({ subject: 'Help', threads }).references).toBeUndefined()
  })

  it('a draft thread (messageId null pre-approval) contributes nothing to references without special-casing', () => {
    const threads = [
      thread({ direction: 'inbound', messageId: '<inbound-1@customer.example.test>' }),
      thread({
        direction: 'outbound',
        messageId: null,
        draftStatus: 'awaiting_review',
        authorKind: 'assistant',
      }),
    ]
    const { references } = deriveReplyHeaders({ subject: 'Help', threads })
    expect(references).toEqual(['<inbound-1@customer.example.test>'])
  })
})
