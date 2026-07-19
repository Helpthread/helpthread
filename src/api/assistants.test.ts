/**
 * End-to-end tests for the Assistants admin API (HT-70;
 * specs/plugins/substrate-v1.md §3) — driven through the real
 * `createInboxApi` pipeline (`src/api/index.ts`), matching this codebase's
 * convention of testing API handlers via the full HTTP pipeline
 * (`src/api/agents.test.ts`, `src/api/index.test.ts`) rather than calling
 * handler functions directly.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { hashAssistantSecret, parseAssistantToken } from '../auth/assistant-token.js'
import { createPasswordAuthProvider } from '../auth/password-provider.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import { type AgentRecord, type AgentStore, createAgentStore } from '../store/agents.js'
import { type AssistantStore, createAssistantStore } from '../store/assistants.js'
import { createConversationStore } from '../store/conversations.js'
import { createMailboxStore } from '../store/mailboxes.js'
import type { WebhooksApiDeps } from './webhooks.js'
import { createInboxApi } from './index.js'

const TOKEN = 'test-token-for-the-assistants-suite'
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

describe('Assistants admin API (HT-70)', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshApi(): Promise<{
    db: Db
    agentStore: AgentStore
    assistantStore: AssistantStore
    api: (request: Request) => Promise<Response>
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const agentStore = createAgentStore(db)
    const assistantStore = createAssistantStore(db)
    const { sender } = createFakeSender()
    const api = createInboxApi({
      store: createConversationStore(db),
      apiToken: TOKEN,
      sender,
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
      agents: {
        store: agentStore,
        providers: [createPasswordAuthProvider({ agentStore })],
        mailboxStore: createMailboxStore(db),
      },
      assistants: { store: assistantStore },
      webhooks: { store: {} as unknown as WebhooksApiDeps['store'], queue: { async enqueue() {} } } satisfies WebhooksApiDeps,
    })
    return { db, agentStore, assistantStore, api }
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

  async function createActiveAgent(
    agentStore: AgentStore,
    overrides: { email?: string; role?: 'admin' | 'agent' } = {},
  ): Promise<AgentRecord> {
    const result = await agentStore.createAgent({
      name: 'Test Agent',
      email: overrides.email ?? 'agent@example.test',
      role: overrides.role ?? 'admin',
      status: 'active',
      passwordHash: 'scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA',
    })
    if (!result.ok) throw new Error('expected ok')
    return result.agent
  }

  describe('POST /api/v1/assistants', () => {
    it('admin creates an Assistant and gets the token exactly once, shaped ht_asst_<id>_<secret>', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore)

      const res = await api(
        req('POST', '/api/v1/assistants', {
          agentId: admin.id,
          body: { name: 'Draft Bot', module: 'draft-reply' },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        assistant: { id: string; name: string; module: string; status: string }
        token: string
      }
      expect(body.assistant.name).toBe('Draft Bot')
      expect(body.assistant.module).toBe('draft-reply')
      expect(body.assistant.status).toBe('active')
      expect(body.assistant).not.toHaveProperty('tokenHash')

      const parsed = parseAssistantToken(body.token)
      expect(parsed?.assistantId).toBe(body.assistant.id)
    })

    it('403s for a non-admin Agent', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore, { role: 'agent', email: 'a@example.test' })
      const res = await api(
        req('POST', '/api/v1/assistants', {
          agentId: agent.id,
          body: { name: 'Draft Bot', module: 'draft-reply' },
        }),
      )
      expect(res.status).toBe(403)
    })

    it('401s with no acting-Agent header', async () => {
      const { api } = await freshApi()
      const res = await api(
        req('POST', '/api/v1/assistants', { body: { name: 'Draft Bot', module: 'draft-reply' } }),
      )
      expect(res.status).toBe(401)
    })

    it('400s on a missing/invalid name or module', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore)
      for (const body of [{}, { name: '', module: 'm' }, { name: 'Bot', module: '' }]) {
        const res = await api(req('POST', '/api/v1/assistants', { agentId: admin.id, body }))
        expect(res.status).toBe(400)
      }
    })
  })

  describe('GET /api/v1/assistants', () => {
    it('admin lists every Assistant, never leaking a tokenHash', async () => {
      const { api, agentStore, assistantStore } = await freshApi()
      const admin = await createActiveAgent(agentStore)
      await assistantStore.create({ name: 'Bot A', module: 'm', tokenHash: 'h1' })
      await assistantStore.create({ name: 'Bot B', module: 'm', tokenHash: 'h2' })

      const res = await api(req('GET', '/api/v1/assistants', { agentId: admin.id }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { assistants: Array<Record<string, unknown>> }
      expect(body.assistants).toHaveLength(2)
      for (const a of body.assistants) {
        expect(a).not.toHaveProperty('tokenHash')
      }
    })

    it('403s for a non-admin Agent (unlike GET /agents, which any active Agent may read)', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore, { role: 'agent', email: 'a@example.test' })
      const res = await api(req('GET', '/api/v1/assistants', { agentId: agent.id }))
      expect(res.status).toBe(403)
    })
  })

  describe('PATCH /api/v1/assistants/{id}', () => {
    it('admin updates name and status', async () => {
      const { api, agentStore, assistantStore } = await freshApi()
      const admin = await createActiveAgent(agentStore)
      const assistant = await assistantStore.create({ name: 'Bot', module: 'm', tokenHash: 'h' })

      const res = await api(
        req('PATCH', `/api/v1/assistants/${assistant.id}`, {
          agentId: admin.id,
          body: { name: 'Renamed Bot', status: 'disabled' },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { assistant: { name: string; status: string } }
      expect(body.assistant.name).toBe('Renamed Bot')
      expect(body.assistant.status).toBe('disabled')
    })

    it('404s for an unknown id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore)
      const res = await api(
        req('PATCH', '/api/v1/assistants/00000000-0000-4000-8000-000000000000', {
          agentId: admin.id,
          body: { name: 'X' },
        }),
      )
      expect(res.status).toBe(404)
    })

    it('400s on an unknown field', async () => {
      const { api, agentStore, assistantStore } = await freshApi()
      const admin = await createActiveAgent(agentStore)
      const assistant = await assistantStore.create({ name: 'Bot', module: 'm', tokenHash: 'h' })
      const res = await api(
        req('PATCH', `/api/v1/assistants/${assistant.id}`, {
          agentId: admin.id,
          body: { module: 'not-settable' },
        }),
      )
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/v1/assistants/{id}/rotate-token', () => {
    it('mints a fresh token for the SAME assistant id; the old token stops verifying', async () => {
      const { api, agentStore, assistantStore } = await freshApi()
      const admin = await createActiveAgent(agentStore)
      const created = await api(
        req('POST', '/api/v1/assistants', {
          agentId: admin.id,
          body: { name: 'Bot', module: 'm' },
        }),
      )
      const { assistant, token: oldToken } = (await created.json()) as {
        assistant: { id: string }
        token: string
      }

      const res = await api(
        req('POST', `/api/v1/assistants/${assistant.id}/rotate-token`, { agentId: admin.id }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { assistant: { id: string }; token: string }
      expect(body.assistant.id).toBe(assistant.id)
      expect(body.token).not.toBe(oldToken)

      const oldParsed = parseAssistantToken(oldToken)
      const storedHash = await assistantStore.getTokenHash(assistant.id)
      expect(hashAssistantSecret(oldParsed?.secret ?? '')).not.toBe(storedHash)

      const newParsed = parseAssistantToken(body.token)
      expect(hashAssistantSecret(newParsed?.secret ?? '')).toBe(storedHash)
    })

    it('404s for an unknown id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore)
      const res = await api(
        req('POST', '/api/v1/assistants/00000000-0000-4000-8000-000000000000/rotate-token', {
          agentId: admin.id,
        }),
      )
      expect(res.status).toBe(404)
    })
  })
})
