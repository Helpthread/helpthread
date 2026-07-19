/**
 * End-to-end tests for the webhooks admin API (HT-69; specs/modules/
 * substrate-v1.md §5) — driven through the real `createInboxApi` pipeline,
 * a real PGlite-backed `AgentStore` + `WebhookEndpointStore`, and a fake
 * `QueueProvider` (nothing here exercises real delivery — that is
 * `src/webhooks/delivery.test.ts`'s job), matching `src/api/agents.test.ts`'s
 * convention of testing API handlers via the full HTTP pipeline.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { hashPassword } from '../auth/password-hash.js'
import { createPasswordAuthProvider } from '../auth/password-provider.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender, EnqueueOptions, QueueProvider } from '../providers/index.js'
import { type AgentRecord, type AgentStore, createAgentStore } from '../store/agents.js'
import { createConversationStore } from '../store/conversations.js'
import { createMailboxStore } from '../store/mailboxes.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import {
  createWebhookEndpointStore,
  type WebhookEndpointStore,
} from '../store/webhook-endpoints.js'
import { WEBHOOK_DELIVERY_TOPIC } from '../webhooks/delivery.js'
import type { AssistantStore } from '../store/assistants.js'
import type { AssistantsApiDeps } from './assistants.js'
import { createInboxApi } from './index.js'

const TOKEN = 'test-token-for-the-webhooks-admin-suite'
const MAIL_DOMAIN = 'mail.example.test'
const SUPPORT_ADDRESS = 'support@example.test'
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const AGENT_HEADER = 'X-Helpthread-Agent-Id'
const WEBHOOKS_ENC_KEY = randomBytes(ENCRYPTION_KEY_BYTES)

function createFakeSender(): EmailSender {
  return {
    maxSendMs: 30_000,
    async send() {
      return {}
    },
  }
}

function fakeQueue(): {
  queue: QueueProvider
  enqueued: { topic: string; payload: unknown; opts?: EnqueueOptions }[]
} {
  const enqueued: { topic: string; payload: unknown; opts?: EnqueueOptions }[] = []
  return {
    queue: {
      async enqueue(topic, payload, opts) {
        enqueued.push({ topic, payload, opts })
      },
    },
    enqueued,
  }
}

describe('Webhooks admin API', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshApi(): Promise<{
    db: Db
    agentStore: AgentStore
    webhookStore: WebhookEndpointStore
    api: (request: Request) => Promise<Response>
    enqueued: { topic: string; payload: unknown; opts?: EnqueueOptions }[]
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const agentStore = createAgentStore(db)
    const webhookStore = createWebhookEndpointStore(db, WEBHOOKS_ENC_KEY)
    const mailboxStore = createMailboxStore(db)
    const { queue, enqueued } = fakeQueue()
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
      webhooks: { store: webhookStore, queue },
      assistants: { store: {} as unknown as AssistantStore } satisfies AssistantsApiDeps,
    })
    return { db, agentStore, webhookStore, api, enqueued }
  }

  function req(
    method: string,
    path: string,
    opts: { agentId?: string; body?: unknown } = {},
  ): Request {
    const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
    if (opts.agentId !== undefined) headers[AGENT_HEADER] = opts.agentId
    const init: RequestInit = { method, headers }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }
    return new Request(`https://x.example.test${path}`, init)
  }

  async function createAgent(
    agentStore: AgentStore,
    role: 'admin' | 'agent',
    email: string,
  ): Promise<AgentRecord> {
    const result = await agentStore.createAgent({
      name: 'Test Agent',
      email,
      role,
      status: 'active',
      passwordHash: hashPassword('correct-horse-battery'),
    })
    if (!result.ok) throw new Error('expected ok')
    return result.agent
  }

  // --- authz: every route requires an admin acting-Agent ----------------------

  describe('authz', () => {
    it('401s with no acting-Agent header', async () => {
      const { api } = await freshApi()
      expect((await api(req('GET', '/api/v1/webhooks'))).status).toBe(401)
      expect((await api(req('POST', '/api/v1/webhooks', { body: {} }))).status).toBe(401)
    })

    it('403s for a non-admin acting Agent', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createAgent(agentStore, 'agent', 'nonadmin@example.test')
      const res = await api(req('GET', '/api/v1/webhooks', { agentId: agent.id }))
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: { code: 'forbidden', message: expect.any(String) },
      })
    })
  })

  // --- POST/GET /api/v1/webhooks -----------------------------------------------

  describe('POST /webhooks', () => {
    it('creates an endpoint, returns the secret ONCE, and the secret never reappears on GET', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')

      const created = await api(
        req('POST', '/api/v1/webhooks', {
          agentId: admin.id,
          body: { url: 'https://hooks.example.test/receive', events: ['conversation.created'] },
        }),
      )
      expect(created.status).toBe(201)
      const createdBody = (await created.json()) as { webhook: Record<string, unknown> }
      expect(createdBody.webhook.secret).toEqual(expect.any(String))
      expect((createdBody.webhook.secret as string).length).toBeGreaterThan(20)
      expect(createdBody.webhook.status).toBe('active')
      expect(createdBody.webhook.consecutiveFailures).toBe(0)
      const id = createdBody.webhook.id as string

      const listed = await api(req('GET', '/api/v1/webhooks', { agentId: admin.id }))
      expect(listed.status).toBe(200)
      const listedBody = (await listed.json()) as { webhooks: Record<string, unknown>[] }
      expect(listedBody.webhooks).toHaveLength(1)
      expect(listedBody.webhooks[0].id).toBe(id)
      expect(listedBody.webhooks[0]).not.toHaveProperty('secret')
    })

    it('events omitted defaults to [] (all events, spec §5)', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const res = await api(
        req('POST', '/api/v1/webhooks', {
          agentId: admin.id,
          body: { url: 'https://hooks.example.test/receive' },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { webhook: { events: string[] } }
      expect(body.webhook.events).toEqual([])
    })

    it('400s on a non-https url', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const res = await api(
        req('POST', '/api/v1/webhooks', {
          agentId: admin.id,
          body: { url: 'http://insecure.example.test/hook' },
        }),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
    })

    it('400s on an unknown event type', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const res = await api(
        req('POST', '/api/v1/webhooks', {
          agentId: admin.id,
          body: { url: 'https://hooks.example.test/receive', events: ['not.a.real.event'] },
        }),
      )
      expect(res.status).toBe(400)
    })

    it('400s on a missing url', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const res = await api(req('POST', '/api/v1/webhooks', { agentId: admin.id, body: {} }))
      expect(res.status).toBe(400)
    })
  })

  // --- PATCH/DELETE /api/v1/webhooks/{id} ---------------------------------------

  describe('PATCH /webhooks/{id}', () => {
    async function createEndpoint(
      api: (r: Request) => Promise<Response>,
      adminId: string,
    ): Promise<string> {
      const res = await api(
        req('POST', '/api/v1/webhooks', {
          agentId: adminId,
          body: { url: 'https://hooks.example.test/receive' },
        }),
      )
      const body = (await res.json()) as { webhook: { id: string } }
      return body.webhook.id
    }

    it('updates url/events/module/status and returns the updated row (never the secret)', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const id = await createEndpoint(api, admin.id)

      const res = await api(
        req('PATCH', `/api/v1/webhooks/${id}`, {
          agentId: admin.id,
          body: {
            url: 'https://hooks.example.test/new-receiver',
            events: ['conversation.reply_sent'],
            module: 'draft-reply',
            status: 'disabled',
          },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { webhook: Record<string, unknown> }
      expect(body.webhook).not.toHaveProperty('secret')
      expect(body.webhook).toMatchObject({
        url: 'https://hooks.example.test/new-receiver',
        events: ['conversation.reply_sent'],
        module: 'draft-reply',
        status: 'disabled',
      })
    })

    it('refuses status: auto_disabled — engine-managed only, never admin-settable', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const id = await createEndpoint(api, admin.id)

      const res = await api(
        req('PATCH', `/api/v1/webhooks/${id}`, {
          agentId: admin.id,
          body: { status: 'auto_disabled' },
        }),
      )
      expect(res.status).toBe(400)
    })

    it('404s for an unknown id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const res = await api(
        req('PATCH', '/api/v1/webhooks/00000000-0000-4000-8000-000000000000', {
          agentId: admin.id,
          body: { status: 'disabled' },
        }),
      )
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /webhooks/{id}', () => {
    it('hard-deletes and returns 204; a second delete 404s', async () => {
      const { api, agentStore, webhookStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const created = await webhookStore.create({
        url: 'https://hooks.example.test/hook',
        secret: 's',
        events: [],
      })

      const first = await api(
        req('DELETE', `/api/v1/webhooks/${created.id}`, { agentId: admin.id }),
      )
      expect(first.status).toBe(204)

      const second = await api(
        req('DELETE', `/api/v1/webhooks/${created.id}`, { agentId: admin.id }),
      )
      expect(second.status).toBe(404)

      expect(await webhookStore.list()).toEqual([])
    })
  })

  // --- POST /api/v1/webhooks/{id}/test ------------------------------------------

  describe('POST /webhooks/{id}/test', () => {
    it('enqueues a test.ping through the real delivery topic, addressed to exactly this endpoint', async () => {
      const { api, agentStore, webhookStore, enqueued } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const created = await webhookStore.create({
        url: 'https://hooks.example.test/hook',
        secret: 's',
        events: ['conversation.reply_sent'], // test.ping is NOT in this filter — must still fire
      })

      const res = await api(
        req('POST', `/api/v1/webhooks/${created.id}/test`, { agentId: admin.id }),
      )

      expect(res.status).toBe(202)
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0].topic).toBe(WEBHOOK_DELIVERY_TOPIC)
      const payload = enqueued[0].payload as {
        endpointId: string
        type: string
        conversationId: unknown
      }
      expect(payload.endpointId).toBe(created.id)
      expect(payload.type).toBe('test.ping')
      expect(payload.conversationId).toBeNull()
      expect(enqueued[0].opts?.dedupeKey).toContain(created.id)
    })

    it('409s against a disabled endpoint — re-enable it first', async () => {
      const { api, agentStore, webhookStore, enqueued } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const created = await webhookStore.create({
        url: 'https://hooks.example.test/hook',
        secret: 's',
        events: [],
      })
      await webhookStore.patch(created.id, { status: 'disabled' })

      const res = await api(
        req('POST', `/api/v1/webhooks/${created.id}/test`, { agentId: admin.id }),
      )

      expect(res.status).toBe(409)
      expect(enqueued).toHaveLength(0)
    })

    it('404s for an unknown id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createAgent(agentStore, 'admin', 'admin@example.test')
      const res = await api(
        req('POST', '/api/v1/webhooks/00000000-0000-4000-8000-000000000000/test', {
          agentId: admin.id,
        }),
      )
      expect(res.status).toBe(404)
    })
  })
})
