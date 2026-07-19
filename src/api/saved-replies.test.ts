/**
 * End-to-end tests for the saved replies & macros API (HT-76;
 * specs/api/agent-inbox-v1.md §4h) — driven through the real
 * `createInboxApi` pipeline, matching this codebase's convention
 * (`src/api/agents.test.ts`) of testing API handlers via the full HTTP
 * pipeline rather than calling handler functions directly.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPasswordAuthProvider } from '../auth/password-provider.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender } from '../providers/index.js'
import { type AgentRecord, type AgentStore, createAgentStore } from '../store/agents.js'
import { createAssistantStore } from '../store/assistants.js'
import { createConversationStore } from '../store/conversations.js'
import { createMailboxStore, type MailboxRecord, type MailboxStore } from '../store/mailboxes.js'
import { createSavedReplyStore } from '../store/saved-replies.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import { createWebhookEndpointStore } from '../store/webhook-endpoints.js'
import { createInboxApi } from './index.js'

const WEBHOOKS_ENC_KEY = randomBytes(ENCRYPTION_KEY_BYTES)
const TOKEN = 'test-token-for-the-saved-replies-suite'
const MAIL_DOMAIN = 'mail.example.test'
const SUPPORT_ADDRESS = 'support@example.test'
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const AGENT_HEADER = 'X-Helpthread-Agent-Id'
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

function createFakeSender(): EmailSender {
  return {
    maxSendMs: 30_000,
    async send() {
      return {}
    },
  }
}

describe('Saved replies & macros API (HT-76)', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshApi(): Promise<{
    db: Db
    agentStore: AgentStore
    mailboxStore: MailboxStore
    api: (request: Request) => Promise<Response>
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const agentStore = createAgentStore(db)
    const mailboxStore = createMailboxStore(db)
    const api = createInboxApi({
      store: createConversationStore(db),
      apiToken: TOKEN,
      sender: createFakeSender(),
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
      agents: {
        store: agentStore,
        providers: [createPasswordAuthProvider({ agentStore })],
        mailboxStore,
      },
      webhooks: {
        store: createWebhookEndpointStore(db, WEBHOOKS_ENC_KEY),
        queue: { async enqueue() {} },
      },
      assistants: { store: createAssistantStore(db) },
      savedReplies: { store: createSavedReplyStore(db), mailboxStore },
    })
    return { db, agentStore, mailboxStore, api }
  }

  /** Build a `Request`, always Bearer-authenticated, optionally with an acting-Agent header and/or a JSON body. */
  function req(
    method: string,
    path: string,
    opts: { agentId?: string; body?: unknown; token?: string | null } = {},
  ): Request {
    const headers: Record<string, string> = {}
    const token = 'token' in opts ? opts.token : TOKEN
    if (token !== null) headers.Authorization = `Bearer ${token}`
    if (opts.agentId !== undefined) headers[AGENT_HEADER] = opts.agentId
    const init: RequestInit = { method, headers }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }
    return new Request(`https://x.example.test${path}`, init)
  }

  async function createActiveAgent(
    agentStore: AgentStore,
    overrides: { email?: string; role?: 'admin' | 'agent'; name?: string } = {},
  ): Promise<AgentRecord> {
    const result = await agentStore.createAgent({
      name: overrides.name ?? 'Test Agent',
      email: overrides.email ?? 'agent@example.test',
      role: overrides.role ?? 'agent',
      status: 'active',
      passwordHash: 'scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA',
    })
    if (!result.ok) throw new Error('expected ok')
    return result.agent
  }

  async function createMailbox(mailboxStore: MailboxStore): Promise<MailboxRecord> {
    return mailboxStore.upsertConnectedMailbox({
      address: 'support@example.test',
      provider: 'gmail',
    })
  }

  // --- GET /api/v1/mailboxes/{id}/saved-replies -------------------------------

  describe('GET .../saved-replies', () => {
    it('any ACTIVE agent (not just admin) can list; [] when empty', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const agent = await createActiveAgent(agentStore, { role: 'agent' })
      const mailbox = await createMailbox(mailboxStore)

      const res = await api(
        req('GET', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, { agentId: agent.id }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ savedReplies: [] })
    })

    it('lists saved replies ordered by sortOrder', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)

      await api(
        req('POST', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, {
          agentId: admin.id,
          body: { name: 'Second', bodyText: 'b', sortOrder: 2 },
        }),
      )
      await api(
        req('POST', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, {
          agentId: admin.id,
          body: { name: 'First', bodyText: 'a', sortOrder: 1 },
        }),
      )

      const res = await api(
        req('GET', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, { agentId: admin.id }),
      )
      const body = (await res.json()) as { savedReplies: { name: string }[] }
      expect(body.savedReplies.map((r) => r.name)).toEqual(['First', 'Second'])
    })

    it('404s for an unknown mailbox', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const res = await api(
        req('GET', `/api/v1/mailboxes/${RANDOM_UUID}/saved-replies`, { agentId: agent.id }),
      )
      expect(res.status).toBe(404)
    })

    it('401s without an acting-Agent header', async () => {
      const { api, mailboxStore } = await freshApi()
      const mailbox = await createMailbox(mailboxStore)
      const res = await api(req('GET', `/api/v1/mailboxes/${mailbox.id}/saved-replies`))
      expect(res.status).toBe(401)
    })

    it('401s without a Bearer token, before any routing', async () => {
      const { api, mailboxStore } = await freshApi()
      const mailbox = await createMailbox(mailboxStore)
      const res = await api(
        req('GET', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, { token: null }),
      )
      expect(res.status).toBe(401)
    })
  })

  // --- POST /api/v1/mailboxes/{id}/saved-replies ------------------------------

  describe('POST .../saved-replies', () => {
    it('admin creates a saved reply: 201 with defaults ({} actions, sortOrder 0)', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)

      const res = await api(
        req('POST', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, {
          agentId: admin.id,
          body: { name: 'Thanks', bodyText: 'Thanks for reaching out!' },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        id: string
        mailboxId: string
        name: string
        bodyText: string
        bodyHtml: string | null
        actions: unknown
        sortOrder: number
      }
      expect(body).toMatchObject({
        mailboxId: mailbox.id,
        name: 'Thanks',
        bodyText: 'Thanks for reaching out!',
        bodyHtml: null,
        actions: {},
        sortOrder: 0,
      })
    })

    it('creates a macro with actions', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)

      const res = await api(
        req('POST', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, {
          agentId: admin.id,
          body: {
            name: 'Refund macro',
            bodyText: 'Refund issued.',
            actions: { setStatus: 'closed', addTags: ['Refunded', 'refunded'], assignToSelf: true },
          },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { actions: unknown }
      // addTags dedupes case-insensitively (trimmed + lowercased) — same
      // normalization spec §4e's tags PUT uses.
      expect(body.actions).toEqual({
        setStatus: 'closed',
        addTags: ['refunded'],
        assignToSelf: true,
      })
    })

    it('a non-admin agent gets 403 forbidden', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const agent = await createActiveAgent(agentStore, { role: 'agent' })
      const mailbox = await createMailbox(mailboxStore)

      const res = await api(
        req('POST', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, {
          agentId: agent.id,
          body: { name: 'x', bodyText: 'y' },
        }),
      )
      expect(res.status).toBe(403)
    })

    it('404s for an unknown mailbox', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const res = await api(
        req('POST', `/api/v1/mailboxes/${RANDOM_UUID}/saved-replies`, {
          agentId: admin.id,
          body: { name: 'x', bodyText: 'y' },
        }),
      )
      expect(res.status).toBe(404)
    })

    it('400s on a missing name/bodyText', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)

      const res = await api(
        req('POST', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, {
          agentId: admin.id,
          body: { name: 'x' },
        }),
      )
      expect(res.status).toBe(400)
    })

    it('400s on an actions object with an unknown key', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)

      const res = await api(
        req('POST', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, {
          agentId: admin.id,
          body: { name: 'x', bodyText: 'y', actions: { deleteEverything: true } },
        }),
      )
      expect(res.status).toBe(400)
    })

    it('400s on an invalid setStatus value in actions', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)

      const res = await api(
        req('POST', `/api/v1/mailboxes/${mailbox.id}/saved-replies`, {
          agentId: admin.id,
          body: { name: 'x', bodyText: 'y', actions: { setStatus: 'spam' } },
        }),
      )
      expect(res.status).toBe(400)
    })
  })

  // --- PATCH /api/v1/mailboxes/{id}/saved-replies/{replyId} -------------------

  describe('PATCH .../saved-replies/{replyId}', () => {
    async function createReply(
      api: (request: Request) => Promise<Response>,
      adminId: string,
      mailboxId: string,
    ): Promise<string> {
      const res = await api(
        req('POST', `/api/v1/mailboxes/${mailboxId}/saved-replies`, {
          agentId: adminId,
          body: { name: 'Original', bodyText: 'original body' },
        }),
      )
      const body = (await res.json()) as { id: string }
      return body.id
    }

    it('admin patches only the given fields', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)
      const replyId = await createReply(api, admin.id, mailbox.id)

      const res = await api(
        req('PATCH', `/api/v1/mailboxes/${mailbox.id}/saved-replies/${replyId}`, {
          agentId: admin.id,
          body: { name: 'Renamed' },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { name: string; bodyText: string }
      expect(body).toMatchObject({ name: 'Renamed', bodyText: 'original body' })
    })

    it('a non-admin agent gets 403 forbidden', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const agent = await createActiveAgent(agentStore, {
        role: 'agent',
        email: 'agent2@example.test',
      })
      const mailbox = await createMailbox(mailboxStore)
      const replyId = await createReply(api, admin.id, mailbox.id)

      const res = await api(
        req('PATCH', `/api/v1/mailboxes/${mailbox.id}/saved-replies/${replyId}`, {
          agentId: agent.id,
          body: { name: 'Renamed' },
        }),
      )
      expect(res.status).toBe(403)
    })

    it('404s for a replyId that belongs to a DIFFERENT mailbox — never a cross-mailbox edit', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailboxA = await createMailbox(mailboxStore)
      const mailboxB = await mailboxStore.upsertConnectedMailbox({
        address: 'other@example.test',
        provider: 'gmail',
      })
      const replyId = await createReply(api, admin.id, mailboxA.id)

      const res = await api(
        req('PATCH', `/api/v1/mailboxes/${mailboxB.id}/saved-replies/${replyId}`, {
          agentId: admin.id,
          body: { name: 'Hijacked' },
        }),
      )
      expect(res.status).toBe(404)
    })

    it('404s for an unknown replyId', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)

      const res = await api(
        req('PATCH', `/api/v1/mailboxes/${mailbox.id}/saved-replies/${RANDOM_UUID}`, {
          agentId: admin.id,
          body: { name: 'x' },
        }),
      )
      expect(res.status).toBe(404)
    })

    it('400s on an unknown field', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)
      const replyId = await createReply(api, admin.id, mailbox.id)

      const res = await api(
        req('PATCH', `/api/v1/mailboxes/${mailbox.id}/saved-replies/${replyId}`, {
          agentId: admin.id,
          body: { mailboxId: RANDOM_UUID },
        }),
      )
      expect(res.status).toBe(400)
    })
  })

  // --- DELETE /api/v1/mailboxes/{id}/saved-replies/{replyId} ------------------

  describe('DELETE .../saved-replies/{replyId}', () => {
    async function createReply(
      api: (request: Request) => Promise<Response>,
      adminId: string,
      mailboxId: string,
    ): Promise<string> {
      const res = await api(
        req('POST', `/api/v1/mailboxes/${mailboxId}/saved-replies`, {
          agentId: adminId,
          body: { name: 'To delete', bodyText: 'body' },
        }),
      )
      const body = (await res.json()) as { id: string }
      return body.id
    }

    it('admin deletes: 204, then a second delete is 404', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailbox = await createMailbox(mailboxStore)
      const replyId = await createReply(api, admin.id, mailbox.id)

      const res = await api(
        req('DELETE', `/api/v1/mailboxes/${mailbox.id}/saved-replies/${replyId}`, {
          agentId: admin.id,
        }),
      )
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')

      const second = await api(
        req('DELETE', `/api/v1/mailboxes/${mailbox.id}/saved-replies/${replyId}`, {
          agentId: admin.id,
        }),
      )
      expect(second.status).toBe(404)
    })

    it('a non-admin agent gets 403 forbidden', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const agent = await createActiveAgent(agentStore, {
        role: 'agent',
        email: 'agent3@example.test',
      })
      const mailbox = await createMailbox(mailboxStore)
      const replyId = await createReply(api, admin.id, mailbox.id)

      const res = await api(
        req('DELETE', `/api/v1/mailboxes/${mailbox.id}/saved-replies/${replyId}`, {
          agentId: agent.id,
        }),
      )
      expect(res.status).toBe(403)
    })

    it('404s for a replyId under a DIFFERENT mailbox', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, { role: 'admin' })
      const mailboxA = await createMailbox(mailboxStore)
      const mailboxB = await mailboxStore.upsertConnectedMailbox({
        address: 'other2@example.test',
        provider: 'gmail',
      })
      const replyId = await createReply(api, admin.id, mailboxA.id)

      const res = await api(
        req('DELETE', `/api/v1/mailboxes/${mailboxB.id}/saved-replies/${replyId}`, {
          agentId: admin.id,
        }),
      )
      expect(res.status).toBe(404)

      // The row is untouched, reachable through the correct mailbox.
      const stillThere = await api(
        req('DELETE', `/api/v1/mailboxes/${mailboxA.id}/saved-replies/${replyId}`, {
          agentId: admin.id,
        }),
      )
      expect(stillThere.status).toBe(204)
    })
  })
})
