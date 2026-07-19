/**
 * End-to-end tests for the drafts API and the Assistant capability gate
 * (HT-70; specs/plugins/substrate-v1.md §3, §6) — driven through the real
 * `createInboxApi` pipeline (`src/api/index.ts`), matching this codebase's
 * convention of testing API handlers via the full HTTP pipeline rather
 * than calling handler functions directly.
 */

import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mintAssistantToken } from '../auth/assistant-token.js'
import { createPasswordAuthProvider } from '../auth/password-provider.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import { type AgentRecord, type AgentStore, createAgentStore } from '../store/agents.js'
import {
  type AssistantRecord,
  type AssistantStore,
  createAssistantStore,
} from '../store/assistants.js'
import { type ConversationStore, createConversationStore } from '../store/conversations.js'
import { createMailboxStore } from '../store/mailboxes.js'
import { createInboxApi } from './index.js'

const TOKEN = 'test-token-for-the-drafts-suite'
const MAIL_DOMAIN = 'mail.example.test'
const SUPPORT_ADDRESS = 'support@example.test'
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const AGENT_HEADER = 'X-Helpthread-Agent-Id'

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

function createThrowingSender(): EmailSender {
  return {
    maxSendMs: 30_000,
    async send() {
      throw new Error('provider rejected the message')
    },
  }
}

describe('Drafts API + Assistant capability gate (HT-70)', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshApi(overrides: { sender?: EmailSender } = {}): Promise<{
    db: Db
    store: ConversationStore
    agentStore: AgentStore
    assistantStore: AssistantStore
    api: (request: Request) => Promise<Response>
    sent: OutboundEmail[]
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const store = createConversationStore(db)
    const agentStore = createAgentStore(db)
    const assistantStore = createAssistantStore(db)
    const { sender: defaultSender, sent } = createFakeSender()
    const api = createInboxApi({
      store,
      apiToken: TOKEN,
      sender: overrides.sender ?? defaultSender,
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
      agents: {
        store: agentStore,
        providers: [createPasswordAuthProvider({ agentStore })],
        mailboxStore: createMailboxStore(db),
      },
      assistants: { store: assistantStore },
    })
    return { db, store, agentStore, assistantStore, api, sent }
  }

  /** A Bearer-authenticated request (service token), optionally with an acting-Agent header and/or JSON body. */
  function req(
    method: string,
    path: string,
    opts: { agentId?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Request {
    const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
    if (opts.agentId !== undefined) headers[AGENT_HEADER] = opts.agentId
    if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey
    const init: RequestInit = { method, headers }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }
    return new Request(`https://x.example.test${path}`, init)
  }

  /** An Assistant-token-authenticated request. */
  function assistantReq(
    method: string,
    path: string,
    token: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Request {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey
    const init: RequestInit = { method, headers }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }
    return new Request(`https://x.example.test${path}`, init)
  }

  async function createActiveAgent(
    agentStore: AgentStore,
    overrides: { email?: string; role?: 'admin' | 'agent' } = {},
  ): Promise<AgentRecord> {
    const result = await agentStore.createAgent({
      name: 'Test Agent',
      email: overrides.email ?? 'agent@example.test',
      role: overrides.role ?? 'agent',
      status: 'active',
      passwordHash: 'scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA',
    })
    if (!result.ok) throw new Error('expected ok')
    return result.agent
  }

  async function createActiveAssistant(
    assistantStore: AssistantStore,
    status: 'active' | 'disabled' = 'active',
  ): Promise<{ assistant: AssistantRecord; token: string }> {
    const id = randomUUID()
    const minted = mintAssistantToken(id)
    const assistant = await assistantStore.create({
      id,
      name: 'Draft Bot',
      module: 'draft-reply',
      tokenHash: minted.tokenHash,
    })
    if (status === 'disabled') {
      await assistantStore.patch(id, { status: 'disabled' })
    }
    return { assistant, token: minted.token }
  }

  async function seedConversation(store: ConversationStore, overrides: { subject?: string } = {}) {
    return store.createConversation({
      subject: overrides.subject ?? 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<inbound-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
  }

  // --- Assistant token auth: the second credential class -------------------

  describe('Assistant token authentication', () => {
    it('an Assistant token authenticates alongside the service Bearer token', async () => {
      const { api, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const res = await api(assistantReq('GET', '/api/v1/conversations', token))
      expect(res.status).toBe(200)
    })

    it('a disabled Assistant token is 401', async () => {
      const { api, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore, 'disabled')
      const res = await api(assistantReq('GET', '/api/v1/conversations', token))
      expect(res.status).toBe(401)
    })

    it('a malformed/unknown token is 401, same as a missing one', async () => {
      const { api } = await freshApi()
      const res1 = await api(assistantReq('GET', '/api/v1/conversations', 'ht_asst_not-real'))
      expect(res1.status).toBe(401)
      const res2 = await api(new Request('https://x.example.test/api/v1/conversations'))
      expect(res2.status).toBe(401)
    })
  })

  // --- Capability gate: an Assistant may GET conversations, POST notes/drafts, nothing else ---

  describe('Assistant capability gate', () => {
    it('an Assistant may GET the conversations list and a conversation detail', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)

      expect((await api(assistantReq('GET', '/api/v1/conversations', token))).status).toBe(200)
      expect(
        (await api(assistantReq('GET', `/api/v1/conversations/${conversationId}`, token))).status,
      ).toBe(200)
    })

    it('an Assistant may POST a note', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)

      const res = await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/notes`, token, {
          body: { text: 'Internal note from the assistant.' },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { authorKind: string }
      expect(body.authorKind).toBe('assistant')
    })

    it('an Assistant is 403 on every other conversations route', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)

      const forbidden = [
        assistantReq('PATCH', `/api/v1/conversations/${conversationId}`, token, {
          body: { status: 'closed' },
        }),
        assistantReq('DELETE', `/api/v1/conversations/${conversationId}`, token),
        assistantReq('POST', `/api/v1/conversations/${conversationId}/replies`, token, {
          body: { text: 'hi' },
        }),
        assistantReq('PUT', `/api/v1/conversations/${conversationId}/tags`, token, {
          body: { tags: [] },
        }),
        assistantReq('PUT', `/api/v1/conversations/${conversationId}/assignee`, token, {
          body: { assigneeAgentId: null },
        }),
      ]
      for (const request of forbidden) {
        const res = await api(request)
        expect(res.status).toBe(403)
      }
    })

    it('an Assistant is 403 on admin surfaces (agents, assistants, mailboxes) and the drafts review queue', async () => {
      const { api, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)

      const forbidden = [
        assistantReq('GET', '/api/v1/agents', token),
        assistantReq('GET', '/api/v1/assistants', token),
        assistantReq('GET', '/api/v1/mailboxes', token),
        assistantReq('GET', '/api/v1/drafts?status=awaiting_review', token),
      ]
      for (const request of forbidden) {
        const res = await api(request)
        expect(res.status).toBe(403)
      }
    })

    it('a soft-deleted conversation is 404 (indistinguishable from nonexistent) on every Assistant path', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)
      await store.deleteConversation(conversationId)

      expect(
        (await api(assistantReq('GET', `/api/v1/conversations/${conversationId}`, token))).status,
      ).toBe(404)
      expect(
        (
          await api(
            assistantReq('POST', `/api/v1/conversations/${conversationId}/notes`, token, {
              body: { text: 'hi' },
            }),
          )
        ).status,
      ).toBe(404)
      expect(
        (
          await api(
            assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
              body: { bodyText: 'hi' },
              idempotencyKey: 'k1',
            }),
          )
        ).status,
      ).toBe(404)
    })
  })

  // --- POST /api/v1/conversations/{id}/drafts ---------------------------------

  describe('POST /api/v1/conversations/{id}/drafts', () => {
    it('an Assistant creates a draft: awaiting_review, no message id, no delivery status', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)

      const res = await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
          body: { bodyText: 'Suggested reply.' },
          idempotencyKey: 'draft-key-1',
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        draftStatus: string
        deliveryStatus: string | null
        authorKind: string
      }
      expect(body.draftStatus).toBe('awaiting_review')
      expect(body.deliveryStatus).toBeNull()
      expect(body.authorKind).toBe('assistant')
    })

    it('requires Idempotency-Key (400 when absent)', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)

      const res = await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
          body: { bodyText: 'Suggested reply.' },
        }),
      )
      expect(res.status).toBe(400)
    })

    it('a replayed Idempotency-Key returns the original draft, not a second one', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)

      const first = await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
          body: { bodyText: 'Suggested reply.' },
          idempotencyKey: 'replay-key',
        }),
      )
      const second = await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
          body: { bodyText: 'A completely different body — ignored on replay.' },
          idempotencyKey: 'replay-key',
        }),
      )
      const firstBody = (await first.json()) as { id: string }
      const secondBody = (await second.json()) as { id: string; bodyText: string }
      expect(secondBody.id).toBe(firstBody.id)
      expect(secondBody.bodyText).toBe('Suggested reply.')

      const conversation = await store.getConversation(conversationId, { includeDeleted: false })
      expect(conversation?.threads.filter((t) => t.draftStatus !== null)).toHaveLength(1)
    })

    it('a draft idempotency key never collides with a reply idempotency key on the same conversation (draft: prefix)', async () => {
      const { api, store, agentStore, assistantStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)

      await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
          body: { bodyText: 'Draft body.' },
          idempotencyKey: 'shared-key',
        }),
      )
      const replyRes = await api(
        req('POST', `/api/v1/conversations/${conversationId}/replies`, {
          agentId: agent.id,
          body: { text: 'Real reply body.' },
          idempotencyKey: 'shared-key',
        }),
      )
      expect(replyRes.status).toBe(201)

      const conversation = await store.getConversation(conversationId, { includeDeleted: false })
      const idempotencyKeys = conversation?.threads.map((t) => t.idempotencyKey)
      expect(idempotencyKeys).toEqual(expect.arrayContaining(['draft:shared-key', 'shared-key']))
    })

    it('a service-Bearer caller (no Assistant identity) cannot create a draft', async () => {
      const { api, store, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { conversationId } = await seedConversation(store)

      const res = await api(
        req('POST', `/api/v1/conversations/${conversationId}/drafts`, {
          agentId: agent.id,
          body: { bodyText: 'hi' },
          idempotencyKey: 'k1',
        }),
      )
      expect(res.status).toBe(403)
    })
  })

  // --- GET /api/v1/drafts?status=awaiting_review -------------------------

  describe('GET /api/v1/drafts', () => {
    it('lists awaiting_review drafts newest first for a service/Agent caller', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId: c1 } = await seedConversation(store)
      const { conversationId: c2 } = await seedConversation(store, { subject: 'Second' })

      await api(
        assistantReq('POST', `/api/v1/conversations/${c1}/drafts`, token, {
          body: { bodyText: 'first' },
          idempotencyKey: 'd1',
        }),
      )
      await api(
        assistantReq('POST', `/api/v1/conversations/${c2}/drafts`, token, {
          body: { bodyText: 'second' },
          idempotencyKey: 'd2',
        }),
      )

      const res = await api(req('GET', '/api/v1/drafts?status=awaiting_review'))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { drafts: Array<{ draftStatus: string }> }
      expect(body.drafts).toHaveLength(2)
      expect(body.drafts.every((d) => d.draftStatus === 'awaiting_review')).toBe(true)
    })

    it('400s without status=awaiting_review', async () => {
      const { api } = await freshApi()
      expect((await api(req('GET', '/api/v1/drafts'))).status).toBe(400)
      expect((await api(req('GET', '/api/v1/drafts?status=approved'))).status).toBe(400)
    })
  })

  // --- POST /api/v1/drafts/{threadId}/approve ---------------------------------

  describe('POST /api/v1/drafts/{threadId}/approve', () => {
    async function seedDraft(
      api: (request: Request) => Promise<Response>,
      store: ConversationStore,
      assistantToken: string,
      bodyText = 'Suggested reply.',
    ): Promise<{ conversationId: string; threadId: string }> {
      const { conversationId } = await seedConversation(store)
      const res = await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, assistantToken, {
          body: { bodyText },
          idempotencyKey: `draft-${conversationId}`,
        }),
      )
      const body = (await res.json()) as { id: string }
      return { conversationId, threadId: body.id }
    }

    it('an Agent approves an unedited draft: it gets delivered and the row is updated', async () => {
      const { api, store, agentStore, assistantStore, sent } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { threadId } = await seedDraft(api, store, token)

      const res = await api(
        req('POST', `/api/v1/drafts/${threadId}/approve`, { agentId: agent.id }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        draftStatus: string
        deliveryStatus: string | null
        bodyText: string
      }
      expect(body.draftStatus).toBe('approved')
      expect(body.deliveryStatus).toBe('sent')
      expect(body.bodyText).toBe('Suggested reply.')
      expect(sent).toHaveLength(1)
      expect(sent[0].to).toEqual(['customer@example.test'])
    })

    it('approve with edits overrides the body and is delivered with the edited content', async () => {
      const { api, store, agentStore, assistantStore, sent } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { threadId } = await seedDraft(api, store, token, 'Original body.')

      const res = await api(
        req('POST', `/api/v1/drafts/${threadId}/approve`, {
          agentId: agent.id,
          body: { bodyText: 'Edited before sending.' },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { bodyText: string }
      expect(body.bodyText).toBe('Edited before sending.')
      expect(sent[0].text).toBe('Edited before sending.')
    })

    it('401s with no acting-Agent header', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { threadId } = await seedDraft(api, store, token)

      const res = await api(req('POST', `/api/v1/drafts/${threadId}/approve`))
      expect(res.status).toBe(401)
    })

    it('404s for an unknown threadId or an already-resolved draft', async () => {
      const { api, agentStore, store, assistantStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { threadId } = await seedDraft(api, store, token)

      expect(
        (
          await api(
            req('POST', '/api/v1/drafts/00000000-0000-4000-8000-000000000000/approve', {
              agentId: agent.id,
            }),
          )
        ).status,
      ).toBe(404)

      await api(req('POST', `/api/v1/drafts/${threadId}/approve`, { agentId: agent.id }))
      const second = await api(
        req('POST', `/api/v1/drafts/${threadId}/approve`, { agentId: agent.id }),
      )
      expect(second.status).toBe(404)
    })

    it('404s for a draft on a soft-deleted conversation', async () => {
      const { api, agentStore, store, assistantStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId, threadId } = await seedDraft(api, store, token)
      await store.deleteConversation(conversationId)

      const res = await api(
        req('POST', `/api/v1/drafts/${threadId}/approve`, { agentId: agent.id }),
      )
      expect(res.status).toBe(404)
    })

    it('409s for a draft on a spam conversation', async () => {
      const { api, agentStore, store, assistantStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId, threadId } = await seedDraft(api, store, token)
      await api(
        req('PATCH', `/api/v1/conversations/${conversationId}`, {
          agentId: agent.id,
          body: { status: 'spam' },
        }),
      )

      const res = await api(
        req('POST', `/api/v1/drafts/${threadId}/approve`, { agentId: agent.id }),
      )
      expect(res.status).toBe(409)
    })

    it('approving a draft on a CLOSED conversation reopens it to active, end to end (Opus review fix)', async () => {
      const { api, agentStore, store, assistantStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId, threadId } = await seedDraft(api, store, token)
      await api(
        req('PATCH', `/api/v1/conversations/${conversationId}`, {
          agentId: agent.id,
          body: { status: 'closed' },
        }),
      )

      const res = await api(
        req('POST', `/api/v1/drafts/${threadId}/approve`, { agentId: agent.id }),
      )
      expect(res.status).toBe(200)

      const conversation = await store.getConversation(conversationId, { includeDeleted: false })
      expect(conversation?.status).toBe('active')
    })

    it('502s when the provider rejects the send; the draft stays approved but delivery fails', async () => {
      const { api, agentStore, store, assistantStore } = await freshApi({
        sender: createThrowingSender(),
      })
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { threadId } = await seedDraft(api, store, token)

      const res = await api(
        req('POST', `/api/v1/drafts/${threadId}/approve`, { agentId: agent.id }),
      )
      expect(res.status).toBe(502)

      const conversation = await store.getConversation(
        (await store.getConversationByThreadId(threadId))?.id ?? '',
        { includeDeleted: false },
      )
      const thread = conversation?.threads.find((t) => t.id === threadId)
      expect(thread?.draftStatus).toBe('approved')
      expect(thread?.deliveryStatus).toBe('failed')
    })

    it('an Assistant may never approve (not in the capability gate; also has no Agent identity)', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { threadId } = await seedDraft(api, store, token)

      const res = await api(assistantReq('POST', `/api/v1/drafts/${threadId}/approve`, token))
      expect(res.status).toBe(403)
    })
  })

  // --- POST /api/v1/drafts/{threadId}/discard ---------------------------------

  describe('POST /api/v1/drafts/{threadId}/discard', () => {
    it('an Agent discards a draft: no delivery, no reply sent', async () => {
      const { api, store, agentStore, assistantStore, sent } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)
      const created = await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
          body: { bodyText: 'Will be discarded.' },
          idempotencyKey: 'discard-key',
        }),
      )
      const { id: threadId } = (await created.json()) as { id: string }

      const res = await api(
        req('POST', `/api/v1/drafts/${threadId}/discard`, { agentId: agent.id }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { draftStatus: string; deliveryStatus: string | null }
      expect(body.draftStatus).toBe('discarded')
      expect(body.deliveryStatus).toBeNull()
      expect(sent).toHaveLength(0)
    })

    it('401s with no acting-Agent header', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)
      const created = await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
          body: { bodyText: 'hi' },
          idempotencyKey: 'k1',
        }),
      )
      const { id: threadId } = (await created.json()) as { id: string }

      const res = await api(req('POST', `/api/v1/drafts/${threadId}/discard`))
      expect(res.status).toBe(401)
    })
  })

  // --- Conversation list/detail: unresolved drafts excluded from preview/threadCount ---

  describe('threadCount/preview exclude unresolved drafts on the list AND detail views', () => {
    it('GET /conversations and GET /conversations/{id} both ignore an awaiting_review draft', async () => {
      const { api, store, assistantStore } = await freshApi()
      const { token } = await createActiveAssistant(assistantStore)
      const { conversationId } = await seedConversation(store)

      await api(
        assistantReq('POST', `/api/v1/conversations/${conversationId}/drafts`, token, {
          body: { bodyText: 'Nobody has approved this yet.' },
          idempotencyKey: 'k1',
        }),
      )

      const listRes = await api(req('GET', '/api/v1/conversations'))
      const listBody = (await listRes.json()) as {
        conversations: Array<{ id: string; threadCount: number; preview: string }>
      }
      const summary = listBody.conversations.find((c) => c.id === conversationId)
      expect(summary?.threadCount).toBe(1)
      expect(summary?.preview).not.toContain('Nobody has approved this yet.')

      const detailRes = await api(req('GET', `/api/v1/conversations/${conversationId}`))
      const detailBody = (await detailRes.json()) as {
        threadCount: number
        preview: string
        threads: unknown[]
      }
      expect(detailBody.threadCount).toBe(1)
      expect(detailBody.preview).not.toContain('Nobody has approved this yet.')
      // The full timeline STILL includes the draft row (spec §7's last bullet).
      expect(detailBody.threads).toHaveLength(2)
    })
  })
})
