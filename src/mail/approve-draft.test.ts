import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import {
  type ConversationStore,
  createConversationStore,
  type StoredConversation,
  type StoredThread,
} from '../store/conversations.js'
import { approveDraft } from './approve-draft.js'
import type { Keyring, SigningKey } from './reply-token.js'

const KEY_A: SigningKey = { keyId: 'k1', secret: 'secret-A-high-entropy-0123456789abcdef' }
const keyring: Keyring = { current: KEY_A }
const mailDomain = 'mail.example.test'
const supportAddress = 'support@example.test'

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

function failingSender(): EmailSender {
  return {
    maxSendMs: 30_000,
    async send() {
      throw new Error('boom: provider unreachable')
    },
  }
}

async function createTestAssistant(db: Db): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO assistants (name, module, token_hash) VALUES ('Draft Bot', 'draft-reply', 'hash') RETURNING id`,
  )
  return row.id
}

async function createTestAgent(db: Db): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO agents (email, name, role, status) VALUES ('agent@example.test', 'Agent', 'agent', 'active') RETURNING id`,
  )
  return row.id
}

describe('approveDraft', () => {
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

  async function seedConversationWithDraft(
    store: ConversationStore,
    assistantId: string,
    bodyText = 'Suggested reply.',
    bodyHtml?: string,
  ): Promise<{
    conversation: StoredConversation & { threads: StoredThread[] }
    draftThreadId: string
  }> {
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
    const draft = await store.appendDraft(conversationId, {
      assistantId,
      bodyText,
      ...(bodyHtml !== undefined ? { bodyHtml } : {}),
      fromAddress: supportAddress,
      idempotencyKey: `draft-${conversationId}`,
    })
    if (!draft.ok) throw new Error('unreachable')
    const conversation = await store.getConversation(conversationId, { includeDeleted: false })
    if (conversation === null) throw new Error('unreachable')
    return { conversation, draftThreadId: draft.threadId }
  }

  it('happy path: mints a token for the draft thread id, derives the envelope, resolves, and delivers', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation, draftThreadId } = await seedConversationWithDraft(store, assistantId)
    const sender = fakeSender()

    const result = await approveDraft(
      { conversation, draftThreadId, resolvedByAgentId: agentId },
      { store, sender, keyring, mailDomain },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.threadId).toBe(draftThreadId)
    expect(result.delivery).toBe('sent')
    // Minted for the DRAFT's existing thread id, not a fresh one.
    expect(result.messageId).toContain(`.${conversation.id}.${draftThreadId}.`)

    expect(sender.sent).toHaveLength(1)
    expect(sender.sent[0]).toMatchObject({
      to: [conversation.customerEmail],
      subject: 'Re: Help with my order',
      from: supportAddress,
      inReplyTo: '<inbound-1@customer.example.test>',
      text: 'Suggested reply.',
    })
    expect(sender.sent[0].references).toEqual([
      '<inbound-1@customer.example.test>',
      result.messageId,
    ])

    const stored = await store.getConversation(conversation.id, { includeDeleted: false })
    const resolvedThread = stored?.threads.find((t) => t.id === draftThreadId)
    expect(resolvedThread).toMatchObject({
      draftStatus: 'approved',
      deliveryStatus: 'sent',
      approvedByAgentId: agentId,
      draftEdited: false,
    })
  })

  it('approve with edits: the sent body reflects the override and draft_edited is recorded true', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation, draftThreadId } = await seedConversationWithDraft(
      store,
      assistantId,
      'Original body.',
    )
    const sender = fakeSender()

    const result = await approveDraft(
      {
        conversation,
        draftThreadId,
        resolvedByAgentId: agentId,
        edit: { bodyText: 'Edited by the Agent before sending.' },
      },
      { store, sender, keyring, mailDomain },
    )

    expect(result.ok).toBe(true)
    expect(sender.sent[0].text).toBe('Edited by the Agent before sending.')

    const stored = await store.getConversation(conversation.id, { includeDeleted: false })
    const resolvedThread = stored?.threads.find((t) => t.id === draftThreadId)
    expect(resolvedThread).toMatchObject({
      draftEdited: true,
      bodyText: 'Edited by the Agent before sending.',
    })
  })

  it('HT-32 pixel injection persists the pixel-injected bodyHtml on the row, even with NO Agent edit (draft_edited stays false)', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation, draftThreadId } = await seedConversationWithDraft(
      store,
      assistantId,
      'Text body.',
      '<p>Html body.</p>',
    )
    const sender = fakeSender()
    const openTracking = { publicBaseUrl: 'https://desk.example.test' }

    const result = await approveDraft(
      { conversation, draftThreadId, resolvedByAgentId: agentId },
      { store, sender, keyring, mailDomain, openTracking },
    )

    expect(result.ok).toBe(true)
    expect(sender.sent[0].html).toContain('<img ')
    expect(sender.sent[0].html).toContain('<p>Html body.</p>')

    const stored = await store.getConversation(conversation.id, { includeDeleted: false })
    const resolvedThread = stored?.threads.find((t) => t.id === draftThreadId)
    // The PERSISTED row already carries the pixel — what a delivery-worker
    // retry would rebuild from — even though no Agent edit was submitted.
    expect(resolvedThread?.bodyHtml).toContain('<img ')
    expect(resolvedThread?.draftEdited).toBe(false)
  })

  it('without HT-32 configured, the persisted bodyHtml is untouched (byte-identical to the draft)', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation, draftThreadId } = await seedConversationWithDraft(
      store,
      assistantId,
      'Text body.',
      '<p>Html body.</p>',
    )
    const sender = fakeSender()

    await approveDraft(
      { conversation, draftThreadId, resolvedByAgentId: agentId },
      { store, sender, keyring, mailDomain },
    )

    const stored = await store.getConversation(conversation.id, { includeDeleted: false })
    const resolvedThread = stored?.threads.find((t) => t.id === draftThreadId)
    expect(resolvedThread?.bodyHtml).toBe('<p>Html body.</p>')
  })

  it('not-a-draft: an unknown draftThreadId (not present on the conversation) is refused before any mint/write', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation } = await seedConversationWithDraft(store, assistantId)
    const sender = fakeSender()

    const result = await approveDraft(
      {
        conversation,
        draftThreadId: '00000000-0000-4000-8000-000000000000',
        resolvedByAgentId: agentId,
      },
      { store, sender, keyring, mailDomain },
    )

    expect(result).toEqual({ ok: false, reason: 'not-a-draft' })
    expect(sender.sent).toHaveLength(0)
  })

  it('not-a-draft: a draft already resolved (race between the snapshot and this call) is refused', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation, draftThreadId } = await seedConversationWithDraft(store, assistantId)

    // Resolve it out from under the snapshot the test is about to pass in.
    await store.resolveDraft({
      action: 'discard',
      threadId: draftThreadId,
      resolvedByAgentId: agentId,
    })

    const sender = fakeSender()
    const result = await approveDraft(
      { conversation, draftThreadId, resolvedByAgentId: agentId },
      { store, sender, keyring, mailDomain },
    )

    expect(result).toEqual({ ok: false, reason: 'not-a-draft' })
    expect(sender.sent).toHaveLength(0)
  })

  it('conversation-deleted: a STALE conversation snapshot (pre-delete) is still refused — resolveDraft re-checks fresh, under lock (HT-70 TOCTOU fix, Codex)', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation, draftThreadId } = await seedConversationWithDraft(store, assistantId)

    // The STALE snapshot — captured BEFORE the "concurrent" delete below,
    // exactly what a caller's own preflight read would have seen.
    const staleConversation = conversation

    // The "concurrent" delete: committed AFTER the snapshot was taken.
    await store.deleteConversation(conversation.id)

    const sender = fakeSender()
    const result = await approveDraft(
      { conversation: staleConversation, draftThreadId, resolvedByAgentId: agentId },
      { store, sender, keyring, mailDomain },
    )

    expect(result).toEqual({ ok: false, reason: 'conversation-deleted' })
    expect(sender.sent).toHaveLength(0)

    const stored = await store.getConversation(conversation.id, { includeDeleted: true })
    const draftThread = stored?.threads.find((t) => t.id === draftThreadId)
    expect(draftThread?.draftStatus).toBe('awaiting_review')
    expect(draftThread?.deliveryStatus).toBeNull()
    expect(draftThread?.messageId).toBeNull()
  })

  it('conversation-spam: a STALE conversation snapshot (pre-spam-mark) is still refused — resolveDraft re-checks fresh, under lock (HT-70 TOCTOU fix, Codex)', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation, draftThreadId } = await seedConversationWithDraft(store, assistantId)

    const staleConversation = conversation
    await testDb.query("UPDATE conversations SET status = 'spam' WHERE id = $1", [conversation.id])

    const sender = fakeSender()
    const result = await approveDraft(
      { conversation: staleConversation, draftThreadId, resolvedByAgentId: agentId },
      { store, sender, keyring, mailDomain },
    )

    expect(result).toEqual({ ok: false, reason: 'conversation-spam' })
    expect(sender.sent).toHaveLength(0)

    const stored = await store.getConversation(conversation.id, { includeDeleted: false })
    const draftThread = stored?.threads.find((t) => t.id === draftThreadId)
    expect(draftThread?.draftStatus).toBe('awaiting_review')
    expect(draftThread?.deliveryStatus).toBeNull()
  })

  it('send-failed: the provider rejects the message — the row is left approved/failed, not resent, and the failure is reported', async () => {
    const { store, db: testDb } = await freshStore()
    const assistantId = await createTestAssistant(testDb)
    const agentId = await createTestAgent(testDb)
    const { conversation, draftThreadId } = await seedConversationWithDraft(store, assistantId)

    const result = await approveDraft(
      { conversation, draftThreadId, resolvedByAgentId: agentId },
      { store, sender: failingSender(), keyring, mailDomain },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('send-failed')
    if (result.reason !== 'send-failed') throw new Error('unreachable')
    expect(result.persistedStatus).toBe('failed')

    const stored = await store.getConversation(conversation.id, { includeDeleted: false })
    const resolvedThread = stored?.threads.find((t) => t.id === draftThreadId)
    // Already resolved to 'approved' — approval is a state transition,
    // distinct from whatever the SEND attempt does afterward.
    expect(resolvedThread?.draftStatus).toBe('approved')
    expect(resolvedThread?.deliveryStatus).toBe('failed')
  })
})
