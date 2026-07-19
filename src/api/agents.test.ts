/**
 * End-to-end tests for the Agents & Authentication API (HT-54;
 * specs/auth/agents-and-auth.md §6) — driven through the real
 * `createInboxApi` pipeline (`src/api/index.ts`), a real PGlite-backed
 * `AgentStore`, and the real `password` `AuthProvider`, matching this
 * codebase's convention of testing the API handlers via the full HTTP
 * pipeline (`src/api/index.test.ts`) rather than calling handler functions
 * directly.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mintInviteToken } from '../auth/invite-token.js'
import { hashPassword } from '../auth/password-hash.js'
import { createPasswordAuthProvider } from '../auth/password-provider.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import { type AgentRecord, type AgentStore, createAgentStore } from '../store/agents.js'
import { createAssistantStore } from '../store/assistants.js'
import { createConversationStore } from '../store/conversations.js'
import { createMailboxStore, type MailboxStore } from '../store/mailboxes.js'
import { createSavedReplyStore } from '../store/saved-replies.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import { createWebhookEndpointStore } from '../store/webhook-endpoints.js'
import { createInboxApi } from './index.js'

/** None of this suite's tests exercise `/webhooks/*` — a real PGlite-backed store plus a no-op queue is just enough for `createInboxApi` to construct (HT-69's `webhooks` deps are now REQUIRED, mirroring `agents`). */
const WEBHOOKS_ENC_KEY = randomBytes(ENCRYPTION_KEY_BYTES)

const TOKEN = 'test-token-for-the-agents-and-auth-suite'
const MAIL_DOMAIN = 'mail.example.test'
const SUPPORT_ADDRESS = 'support@example.test'
const UI_BASE_URL = 'https://desk.example.test'
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const AGENT_HEADER = 'X-Helpthread-Agent-Id'

/** A fake `EmailSender` that records every send and never fails. */
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

/** An `EmailSender` that always rejects — for exercising `502 send_failed`. */
function createThrowingSender(): EmailSender {
  return {
    maxSendMs: 30_000,
    async send() {
      throw new Error('provider rejected the message')
    },
  }
}

describe('Agents & Authentication API', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshApi(overrides: { uiBaseUrl?: string; sender?: EmailSender } = {}): Promise<{
    db: Db
    agentStore: AgentStore
    mailboxStore: MailboxStore
    api: (request: Request) => Promise<Response>
    sent: OutboundEmail[]
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const agentStore = createAgentStore(db)
    const mailboxStore = createMailboxStore(db)
    const { sender: defaultSender, sent } = createFakeSender()
    const api = createInboxApi({
      store: createConversationStore(db),
      apiToken: TOKEN,
      sender: overrides.sender ?? defaultSender,
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
      agents: {
        store: agentStore,
        providers: [createPasswordAuthProvider({ agentStore })],
        mailboxStore,
        ...(overrides.uiBaseUrl !== undefined ? { uiBaseUrl: overrides.uiBaseUrl } : {}),
      },
      webhooks: {
        store: createWebhookEndpointStore(db, WEBHOOKS_ENC_KEY),
        queue: { async enqueue() {} },
      },
      assistants: { store: createAssistantStore(db) },
      savedReplies: { store: createSavedReplyStore(db), mailboxStore },
    })
    return { db, agentStore, mailboxStore, api, sent }
  }

  /** Build a `Request`, always Bearer-authenticated, optionally with an acting-Agent header and/or a JSON body. */
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

  // --- GET /api/v1/auth/providers ---------------------------------------------

  describe('GET /auth/providers', () => {
    it('reports the core password provider and needsSetup:true on a fresh deployment', async () => {
      const { api } = await freshApi()
      const res = await api(req('GET', '/api/v1/auth/providers'))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        providers: [{ key: 'password', label: expect.any(String), kind: 'credentials' }],
        needsSetup: true,
      })
    })

    it('needsSetup:false once at least one Agent exists', async () => {
      const { api, agentStore } = await freshApi()
      await createActiveAgent(agentStore)
      const res = await api(req('GET', '/api/v1/auth/providers'))
      expect((await res.json()).needsSetup).toBe(false)
    })

    it('still requires the service Bearer token', async () => {
      const { api } = await freshApi()
      const res = await api(new Request('https://x.example.test/api/v1/auth/providers'))
      expect(res.status).toBe(401)
    })
  })

  // --- POST /api/v1/setup ------------------------------------------------------

  describe('POST /setup', () => {
    it('creates the first admin, active, with a usable password', async () => {
      const { api } = await freshApi()
      const res = await api(
        req('POST', '/api/v1/setup', {
          body: { name: 'Ada Admin', email: 'ada@example.test', password: 'correct-horse-battery' },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { agent: { role: string; status: string; email: string } }
      expect(body.agent.role).toBe('admin')
      expect(body.agent.status).toBe('active')
      expect(body.agent.email).toBe('ada@example.test')

      const verify = await api(
        req('POST', '/api/v1/auth/verify', {
          body: {
            providerKey: 'password',
            email: 'ada@example.test',
            password: 'correct-horse-battery',
          },
        }),
      )
      expect(verify.status).toBe(200)
    })

    it('409s once an Agent already exists', async () => {
      const { api, agentStore } = await freshApi()
      await createActiveAgent(agentStore)
      const res = await api(
        req('POST', '/api/v1/setup', {
          body: { name: 'Late Admin', email: 'late@example.test', password: 'another-password' },
        }),
      )
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: { code: 'conflict', message: expect.any(String) } })
    })

    it('400s on missing/invalid fields', async () => {
      const { api } = await freshApi()
      for (const body of [
        {},
        { name: '', email: 'a@example.test', password: 'password123' },
        { name: 'A', email: 'not-an-email', password: 'password123' },
        { name: 'A', email: 'a@example.test', password: 'short' },
      ]) {
        const res = await api(req('POST', '/api/v1/setup', { body }))
        expect(res.status).toBe(400)
      }
    })
  })

  // --- POST /api/v1/auth/verify ------------------------------------------------

  describe('POST /auth/verify', () => {
    it('verifies the correct email + password, returning the Agent', async () => {
      const { api, agentStore } = await freshApi()
      const result = await agentStore.createAgent({
        name: 'Real Agent',
        email: 'real@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: hashPassword('correct-password'),
      })
      if (!result.ok) throw new Error('expected ok')

      const res = await api(
        req('POST', '/api/v1/auth/verify', {
          body: {
            providerKey: 'password',
            email: 'real@example.test',
            password: 'correct-password',
          },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { agent: { id: string } }
      expect(body.agent.id).toBe(result.agent.id)
    })

    it('is uniformly 401 for unknown email, wrong password, invited, and disabled — same status/code/body shape', async () => {
      const { api, agentStore } = await freshApi()

      const active = await agentStore.createAgent({
        name: 'Active',
        email: 'active@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: hashPassword('correct-password'),
      })
      if (!active.ok) throw new Error('expected ok')
      const disabledAgent = await agentStore.createAgent({
        name: 'Disabled',
        email: 'disabled@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: hashPassword('correct-password'),
      })
      if (!disabledAgent.ok) throw new Error('expected ok')
      await agentStore.updateAgent(disabledAgent.agent.id, { status: 'disabled' })
      await agentStore.createAgent({
        name: 'Invited',
        email: 'invited@example.test',
        role: 'agent',
        status: 'invited',
      })

      const attempts = [
        { providerKey: 'password', email: 'nobody@example.test', password: 'anything' },
        { providerKey: 'password', email: 'active@example.test', password: 'wrong-password' },
        { providerKey: 'password', email: 'invited@example.test', password: 'anything' },
        { providerKey: 'password', email: 'disabled@example.test', password: 'correct-password' },
        {
          providerKey: 'unknown-provider',
          email: 'active@example.test',
          password: 'correct-password',
        },
      ]
      const bodies: unknown[] = []
      for (const body of attempts) {
        const res = await api(req('POST', '/api/v1/auth/verify', { body }))
        expect(res.status).toBe(401)
        bodies.push(await res.json())
      }
      // Every failure shares the exact same envelope shape — no distinguishing detail.
      for (const body of bodies) {
        expect(body).toEqual(bodies[0])
      }
    })

    it('malformed bodies are also 401 (no distinguishing validation_failed oracle on this endpoint)', async () => {
      const { api } = await freshApi()
      for (const body of [{}, { providerKey: 123 }, { providerKey: 'password' }]) {
        const res = await api(req('POST', '/api/v1/auth/verify', { body }))
        expect(res.status).toBe(401)
      }
    })
  })

  // --- GET /api/v1/auth/me -----------------------------------------------------

  describe('GET /auth/me', () => {
    it('returns the acting Agent', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore, { email: 'me@example.test' })
      const res = await api(req('GET', '/api/v1/auth/me', { agentId: agent.id }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        id: agent.id,
        email: agent.email,
        name: agent.name,
        role: agent.role,
        timezone: agent.timezone,
      })
    })

    it('401s without the header, and for a disabled/invited/missing Agent', async () => {
      const { api, agentStore } = await freshApi()
      const disabled = await createActiveAgent(agentStore, { email: 'disabled@example.test' })
      await agentStore.updateAgent(disabled.id, { status: 'disabled' })
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')

      expect((await api(req('GET', '/api/v1/auth/me'))).status).toBe(401)
      expect((await api(req('GET', '/api/v1/auth/me', { agentId: disabled.id }))).status).toBe(401)
      expect(
        (await api(req('GET', '/api/v1/auth/me', { agentId: invitedResult.agent.id }))).status,
      ).toBe(401)
      expect(
        (
          await api(
            req('GET', '/api/v1/auth/me', { agentId: '00000000-0000-0000-0000-000000000000' }),
          )
        ).status,
      ).toBe(401)
      expect((await api(req('GET', '/api/v1/auth/me', { agentId: 'not-a-uuid' }))).status).toBe(401)
    })
  })

  // --- GET /api/v1/agents (any active Agent — coordinator amendment) ---------

  describe('GET /agents', () => {
    it('a non-admin ACTIVE Agent gets 200 — the roster is not admin-gated', async () => {
      const { api, agentStore } = await freshApi()
      const nonAdmin = await createActiveAgent(agentStore, {
        email: 'nonadmin@example.test',
        role: 'agent',
      })
      await createActiveAgent(agentStore, { email: 'someone@example.test' })

      const res = await api(req('GET', '/api/v1/agents', { agentId: nonAdmin.id }))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { agents: Array<{ email: string }> }
      expect(body.agents.map((a) => a.email).sort()).toEqual(
        ['nonadmin@example.test', 'someone@example.test'].sort(),
      )
    })

    it('401s without the header, and for a disabled acting Agent', async () => {
      const { api, agentStore } = await freshApi()
      const disabled = await createActiveAgent(agentStore, { email: 'disabled2@example.test' })
      await agentStore.updateAgent(disabled.id, { status: 'disabled' })

      expect((await api(req('GET', '/api/v1/agents'))).status).toBe(401)
      expect((await api(req('GET', '/api/v1/agents', { agentId: disabled.id }))).status).toBe(401)
    })
  })

  // --- POST /api/v1/agents -----------------------------------------------------

  describe('POST /agents', () => {
    it('admin creates an invited Agent (sendInvite, no uiBaseUrl configured) — inviteSent:false, Agent still created', async () => {
      const { api, agentStore, sent } = await freshApi() // no uiBaseUrl
      const admin = await createActiveAgent(agentStore, {
        email: 'admin@example.test',
        role: 'admin',
      })

      const res = await api(
        req('POST', '/api/v1/agents', {
          agentId: admin.id,
          body: { name: 'New Agent', email: 'new@example.test', role: 'agent', sendInvite: true },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { agent: { status: string }; inviteSent: boolean }
      expect(body.agent.status).toBe('invited')
      expect(body.inviteSent).toBe(false)
      expect(sent).toHaveLength(0)
    })

    it('admin creates an invited Agent WITH uiBaseUrl configured — inviteSent:true, email sent', async () => {
      const { api, agentStore, sent } = await freshApi({ uiBaseUrl: UI_BASE_URL })
      const admin = await createActiveAgent(agentStore, {
        email: 'admin2@example.test',
        role: 'admin',
      })

      const res = await api(
        req('POST', '/api/v1/agents', {
          agentId: admin.id,
          body: { name: 'New Agent', email: 'new2@example.test', role: 'agent', sendInvite: true },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { inviteSent: boolean }
      expect(body.inviteSent).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0].to).toEqual(['new2@example.test'])
    })

    it('admin creates an active Agent directly with an admin-set password', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin3@example.test',
        role: 'admin',
      })

      const res = await api(
        req('POST', '/api/v1/agents', {
          agentId: admin.id,
          body: {
            name: 'Direct Agent',
            email: 'direct@example.test',
            role: 'agent',
            sendInvite: false,
            password: 'admin-set-password',
          },
        }),
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { agent: { status: string } }
      expect(body.agent.status).toBe('active')
    })

    it('400s when both or neither of sendInvite/password are given', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin4@example.test',
        role: 'admin',
      })

      const both = await api(
        req('POST', '/api/v1/agents', {
          agentId: admin.id,
          body: {
            name: 'X',
            email: 'x@example.test',
            role: 'agent',
            sendInvite: true,
            password: 'some-password',
          },
        }),
      )
      expect(both.status).toBe(400)

      const neither = await api(
        req('POST', '/api/v1/agents', {
          agentId: admin.id,
          body: { name: 'X', email: 'x2@example.test', role: 'agent' },
        }),
      )
      expect(neither.status).toBe(400)
    })

    it('409s on a duplicate email', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin5@example.test',
        role: 'admin',
      })
      await createActiveAgent(agentStore, { email: 'dup@example.test' })

      const res = await api(
        req('POST', '/api/v1/agents', {
          agentId: admin.id,
          body: { name: 'Dup', email: 'dup@example.test', role: 'agent', sendInvite: true },
        }),
      )
      expect(res.status).toBe(409)
    })

    it('403s for a non-admin acting Agent', async () => {
      const { api, agentStore } = await freshApi()
      const nonAdmin = await createActiveAgent(agentStore, { email: 'nonadmin2@example.test' })

      const res = await api(
        req('POST', '/api/v1/agents', {
          agentId: nonAdmin.id,
          body: { name: 'X', email: 'x3@example.test', role: 'agent', sendInvite: true },
        }),
      )
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({
        error: { code: 'forbidden', message: expect.any(String) },
      })
    })

    it('401s without the acting-Agent header', async () => {
      const { api } = await freshApi()
      const res = await api(
        req('POST', '/api/v1/agents', {
          body: { name: 'X', email: 'x4@example.test', role: 'agent', sendInvite: true },
        }),
      )
      expect(res.status).toBe(401)
    })
  })

  // --- GET /api/v1/agents/{id} -------------------------------------------------

  describe('GET /agents/{id}', () => {
    it('admin can view anyone', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin6@example.test',
        role: 'admin',
      })
      const other = await createActiveAgent(agentStore, { email: 'other@example.test' })

      const res = await api(req('GET', `/api/v1/agents/${other.id}`, { agentId: admin.id }))
      expect(res.status).toBe(200)
    })

    it('self can view own profile', async () => {
      const { api, agentStore } = await freshApi()
      const self = await createActiveAgent(agentStore, { email: 'self@example.test' })
      const res = await api(req('GET', `/api/v1/agents/${self.id}`, { agentId: self.id }))
      expect(res.status).toBe(200)
    })

    it("403s for a non-admin viewing SOMEONE ELSE's profile", async () => {
      const { api, agentStore } = await freshApi()
      const nonAdmin = await createActiveAgent(agentStore, { email: 'nonadmin3@example.test' })
      const other = await createActiveAgent(agentStore, { email: 'other2@example.test' })

      const res = await api(req('GET', `/api/v1/agents/${other.id}`, { agentId: nonAdmin.id }))
      expect(res.status).toBe(403)
    })

    it('404s for a missing id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin7@example.test',
        role: 'admin',
      })
      const res = await api(
        req('GET', '/api/v1/agents/00000000-0000-0000-0000-000000000000', { agentId: admin.id }),
      )
      expect(res.status).toBe(404)
    })
  })

  // --- PATCH /api/v1/agents/{id} -----------------------------------------------

  describe('PATCH /agents/{id}', () => {
    it('self may PATCH own name/timezone', async () => {
      const { api, agentStore } = await freshApi()
      const self = await createActiveAgent(agentStore, { email: 'self2@example.test' })
      const res = await api(
        req('PATCH', `/api/v1/agents/${self.id}`, {
          agentId: self.id,
          body: { name: 'Renamed', timezone: 'America/New_York' },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { agent: { name: string; timezone: string } }
      expect(body.agent.name).toBe('Renamed')
      expect(body.agent.timezone).toBe('America/New_York')
    })

    it('self attempting to PATCH role or status is 403', async () => {
      const { api, agentStore } = await freshApi()
      const self = await createActiveAgent(agentStore, { email: 'self3@example.test' })
      const roleRes = await api(
        req('PATCH', `/api/v1/agents/${self.id}`, { agentId: self.id, body: { role: 'admin' } }),
      )
      expect(roleRes.status).toBe(403)
      const statusRes = await api(
        req('PATCH', `/api/v1/agents/${self.id}`, {
          agentId: self.id,
          body: { status: 'disabled' },
        }),
      )
      expect(statusRes.status).toBe(403)
    })

    it('admin may PATCH name/timezone/role/status on anyone', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin8@example.test',
        role: 'admin',
      })
      const other = await createActiveAgent(agentStore, { email: 'other3@example.test' })

      const res = await api(
        req('PATCH', `/api/v1/agents/${other.id}`, {
          agentId: admin.id,
          body: { role: 'admin', status: 'disabled', name: 'Changed' },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        agent: { role: string; status: string; name: string }
      }
      expect(body.agent).toMatchObject({ role: 'admin', status: 'disabled', name: 'Changed' })
    })

    it('email is never settable — 400 regardless of actor', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin9@example.test',
        role: 'admin',
      })
      const res = await api(
        req('PATCH', `/api/v1/agents/${admin.id}`, {
          agentId: admin.id,
          body: { email: 'new-email@example.test' },
        }),
      )
      expect(res.status).toBe(400)
    })

    it('PATCHing status on an INVITED Agent is 409, either direction', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin10@example.test',
        role: 'admin',
      })
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited2@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')

      const res = await api(
        req('PATCH', `/api/v1/agents/${invitedResult.agent.id}`, {
          agentId: admin.id,
          body: { status: 'active' },
        }),
      )
      expect(res.status).toBe(409)
    })

    it('setting status to a value other than active/disabled is 400 (invited is never a settable target)', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin11@example.test',
        role: 'admin',
      })
      const other = await createActiveAgent(agentStore, { email: 'other4@example.test' })
      const res = await api(
        req('PATCH', `/api/v1/agents/${other.id}`, {
          agentId: admin.id,
          body: { status: 'invited' },
        }),
      )
      expect(res.status).toBe(400)
    })

    it('demoting the last active admin is 409 conflict', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'soloadmin@example.test',
        role: 'admin',
      })
      const res = await api(
        req('PATCH', `/api/v1/agents/${admin.id}`, {
          agentId: admin.id,
          body: { role: 'agent' },
        }),
      )
      expect(res.status).toBe(409)
    })

    it('404s for a missing id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin12@example.test',
        role: 'admin',
      })
      const res = await api(
        req('PATCH', '/api/v1/agents/00000000-0000-0000-0000-000000000000', {
          agentId: admin.id,
          body: { name: 'X' },
        }),
      )
      expect(res.status).toBe(404)
    })
  })

  // --- DELETE /api/v1/agents/{id} ----------------------------------------------

  describe('DELETE /agents/{id}', () => {
    it('admin hard-deletes an Agent — 204', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin13@example.test',
        role: 'admin',
      })
      const other = await createActiveAgent(agentStore, { email: 'other5@example.test' })

      const res = await api(req('DELETE', `/api/v1/agents/${other.id}`, { agentId: admin.id }))
      expect(res.status).toBe(204)
      expect(await agentStore.getAgent(other.id)).toBeNull()
    })

    it('deleting the last active admin is 409 conflict', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'soloadmin2@example.test',
        role: 'admin',
      })
      const res = await api(req('DELETE', `/api/v1/agents/${admin.id}`, { agentId: admin.id }))
      expect(res.status).toBe(409)
    })

    it('403s for a non-admin', async () => {
      const { api, agentStore } = await freshApi()
      const nonAdmin = await createActiveAgent(agentStore, { email: 'nonadmin4@example.test' })
      const other = await createActiveAgent(agentStore, { email: 'other6@example.test' })
      const res = await api(req('DELETE', `/api/v1/agents/${other.id}`, { agentId: nonAdmin.id }))
      expect(res.status).toBe(403)
    })

    it('404s for a missing id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin14@example.test',
        role: 'admin',
      })
      const res = await api(
        req('DELETE', '/api/v1/agents/00000000-0000-0000-0000-000000000000', {
          agentId: admin.id,
        }),
      )
      expect(res.status).toBe(404)
    })
  })

  // --- POST /api/v1/agents/{id}/password ---------------------------------------

  describe('POST /agents/{id}/password', () => {
    it('self may set their own password', async () => {
      const { api, agentStore } = await freshApi()
      const self = await createActiveAgent(agentStore, { email: 'self4@example.test' })
      const res = await api(
        req('POST', `/api/v1/agents/${self.id}/password`, {
          agentId: self.id,
          body: { password: 'brand-new-password' },
        }),
      )
      expect(res.status).toBe(204)
    })

    it("admin may reset someone else's password", async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin15@example.test',
        role: 'admin',
      })
      const other = await createActiveAgent(agentStore, { email: 'other7@example.test' })
      const res = await api(
        req('POST', `/api/v1/agents/${other.id}/password`, {
          agentId: admin.id,
          body: { password: 'admin-reset-password' },
        }),
      )
      expect(res.status).toBe(204)
    })

    it("403s for a non-admin trying to set SOMEONE ELSE's password", async () => {
      const { api, agentStore } = await freshApi()
      const nonAdmin = await createActiveAgent(agentStore, { email: 'nonadmin5@example.test' })
      const other = await createActiveAgent(agentStore, { email: 'other8@example.test' })
      const res = await api(
        req('POST', `/api/v1/agents/${other.id}/password`, {
          agentId: nonAdmin.id,
          body: { password: 'sneaky-password' },
        }),
      )
      expect(res.status).toBe(403)
    })

    it('409s when the target is invited', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin16@example.test',
        role: 'admin',
      })
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited3@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')

      const res = await api(
        req('POST', `/api/v1/agents/${invitedResult.agent.id}/password`, {
          agentId: admin.id,
          body: { password: 'wont-work' },
        }),
      )
      expect(res.status).toBe(409)
    })

    it('is allowed for a disabled target (admin reset)', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'admin17@example.test',
        role: 'admin',
      })
      const disabled = await createActiveAgent(agentStore, { email: 'disabled3@example.test' })
      await agentStore.updateAgent(disabled.id, { status: 'disabled' })

      const res = await api(
        req('POST', `/api/v1/agents/${disabled.id}/password`, {
          agentId: admin.id,
          body: { password: 'reset-while-disabled' },
        }),
      )
      expect(res.status).toBe(204)
    })

    it('400s on a too-short password', async () => {
      const { api, agentStore } = await freshApi()
      const self = await createActiveAgent(agentStore, { email: 'self5@example.test' })
      const res = await api(
        req('POST', `/api/v1/agents/${self.id}/password`, {
          agentId: self.id,
          body: { password: 'short' },
        }),
      )
      expect(res.status).toBe(400)
    })
  })

  // --- POST /api/v1/agents/{id}/invite -----------------------------------------

  describe('POST /agents/{id}/invite', () => {
    it('admin resends an invite when uiBaseUrl is configured — 204, email sent', async () => {
      const { api, agentStore, sent } = await freshApi({ uiBaseUrl: UI_BASE_URL })
      const admin = await createActiveAgent(agentStore, {
        email: 'admin18@example.test',
        role: 'admin',
      })
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited4@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')

      const res = await api(
        req('POST', `/api/v1/agents/${invitedResult.agent.id}/invite`, { agentId: admin.id }),
      )
      expect(res.status).toBe(204)
      expect(sent).toHaveLength(1)
      expect(sent[0].to).toEqual(['invited4@example.test'])
    })

    it('409s when the target is active/disabled (not invited)', async () => {
      const { api, agentStore } = await freshApi({ uiBaseUrl: UI_BASE_URL })
      const admin = await createActiveAgent(agentStore, {
        email: 'admin19@example.test',
        role: 'admin',
      })
      const active = await createActiveAgent(agentStore, { email: 'active2@example.test' })

      const res = await api(
        req('POST', `/api/v1/agents/${active.id}/invite`, { agentId: admin.id }),
      )
      expect(res.status).toBe(409)
    })

    it('409s when no uiBaseUrl is configured', async () => {
      const { api, agentStore } = await freshApi() // no uiBaseUrl
      const admin = await createActiveAgent(agentStore, {
        email: 'admin20@example.test',
        role: 'admin',
      })
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited5@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')

      const res = await api(
        req('POST', `/api/v1/agents/${invitedResult.agent.id}/invite`, { agentId: admin.id }),
      )
      expect(res.status).toBe(409)
    })

    it('502s when the sender rejects the message', async () => {
      const { api, agentStore } = await freshApi({
        uiBaseUrl: UI_BASE_URL,
        sender: createThrowingSender(),
      })
      const admin = await createActiveAgent(agentStore, {
        email: 'admin21@example.test',
        role: 'admin',
      })
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited6@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')

      const res = await api(
        req('POST', `/api/v1/agents/${invitedResult.agent.id}/invite`, { agentId: admin.id }),
      )
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({
        error: { code: 'send_failed', message: expect.any(String) },
      })
    })

    it('403s for a non-admin', async () => {
      const { api, agentStore } = await freshApi({ uiBaseUrl: UI_BASE_URL })
      const nonAdmin = await createActiveAgent(agentStore, { email: 'nonadmin6@example.test' })
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited7@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')

      const res = await api(
        req('POST', `/api/v1/agents/${invitedResult.agent.id}/invite`, { agentId: nonAdmin.id }),
      )
      expect(res.status).toBe(403)
    })
  })

  // --- POST /api/v1/auth/invite/accept -----------------------------------------

  describe('POST /auth/invite/accept', () => {
    it('activates the invited Agent and sets the password', async () => {
      const { api, agentStore } = await freshApi()
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited8@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')
      const token = mintInviteToken(invitedResult.agent.id, KEYRING)

      const res = await api(
        req('POST', '/api/v1/auth/invite/accept', {
          body: { token, password: 'accepted-password' },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { agent: { status: string } }
      expect(body.agent.status).toBe('active')

      // The web would now sign in with this password.
      const verify = await api(
        req('POST', '/api/v1/auth/verify', {
          body: {
            providerKey: 'password',
            email: 'invited8@example.test',
            password: 'accepted-password',
          },
        }),
      )
      expect(verify.status).toBe(200)
    })

    it('is one-time: accepting the SAME token twice 401s the second time', async () => {
      const { api, agentStore } = await freshApi()
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited9@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')
      const token = mintInviteToken(invitedResult.agent.id, KEYRING)

      const first = await api(
        req('POST', '/api/v1/auth/invite/accept', { body: { token, password: 'first-password' } }),
      )
      expect(first.status).toBe(200)

      const second = await api(
        req('POST', '/api/v1/auth/invite/accept', { body: { token, password: 'second-password' } }),
      )
      expect(second.status).toBe(401)
    })

    it('401s for a bogus/tampered token', async () => {
      const { api } = await freshApi()
      const res = await api(
        req('POST', '/api/v1/auth/invite/accept', {
          body: { token: 'hti.k1.garbage.sig', password: 'whatever-password' },
        }),
      )
      expect(res.status).toBe(401)
    })

    it('400s on a too-short password (checked independently of the token)', async () => {
      const { api, agentStore } = await freshApi()
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited10@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')
      const token = mintInviteToken(invitedResult.agent.id, KEYRING)

      const res = await api(
        req('POST', '/api/v1/auth/invite/accept', { body: { token, password: 'short' } }),
      )
      expect(res.status).toBe(400)
    })

    it('does not require the acting-Agent header (pre-session)', async () => {
      const { api, agentStore } = await freshApi()
      const invitedResult = await agentStore.createAgent({
        name: 'Invited',
        email: 'invited11@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!invitedResult.ok) throw new Error('expected ok')
      const token = mintInviteToken(invitedResult.agent.id, KEYRING)

      // No X-Helpthread-Agent-Id header at all — must still succeed.
      const res = await api(
        new Request('https://x.example.test/api/v1/auth/invite/accept', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, password: 'no-header-needed' }),
        }),
      )
      expect(res.status).toBe(200)
    })
  })

  // --- Mailbox access (HT-54 follow-up; spec §3.4/§6) -------------------------

  describe('GET /mailboxes', () => {
    it('admin gets 200 with the full roster, id/address/status ONLY (never provider or a token)', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin1@example.test',
        role: 'admin',
      })
      const mailbox = await mailboxStore.upsertConnectedMailbox({
        address: 'support@example.test',
        provider: 'gmail',
      })

      const res = await api(req('GET', '/api/v1/mailboxes', { agentId: admin.id }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        mailboxes: [{ id: mailbox.id, address: 'support@example.test', status: 'active' }],
      })
      // Response shape exactness — no provider, no token, no other field.
      expect(Object.keys(body.mailboxes[0]).sort()).toEqual(['address', 'id', 'status'])
    })

    it('includes disconnected/paused mailboxes too — the Permissions roster is unfiltered', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin2@example.test',
        role: 'admin',
      })
      await mailboxStore.upsertConnectedMailbox({ address: 'a@example.test', provider: 'gmail' })
      const paused = await mailboxStore.upsertConnectedMailbox({
        address: 'b@example.test',
        provider: 'gmail',
      })
      await mailboxStore.markPaused(paused.id)
      const disconnected = await mailboxStore.upsertConnectedMailbox({
        address: 'c@example.test',
        provider: 'gmail',
      })
      await mailboxStore.markDisconnected(disconnected.id)

      const res = await api(req('GET', '/api/v1/mailboxes', { agentId: admin.id }))
      const body = (await res.json()) as { mailboxes: Array<{ status: string }> }
      expect(body.mailboxes.map((m) => m.status).sort()).toEqual([
        'active',
        'disconnected',
        'paused',
      ])
    })

    it('403s for a non-admin', async () => {
      const { api, agentStore } = await freshApi()
      const nonAdmin = await createActiveAgent(agentStore, { email: 'mbnonadmin1@example.test' })

      const res = await api(req('GET', '/api/v1/mailboxes', { agentId: nonAdmin.id }))
      expect(res.status).toBe(403)
    })

    it('401s without the acting-Agent header', async () => {
      const { api } = await freshApi()
      const res = await api(req('GET', '/api/v1/mailboxes'))
      expect(res.status).toBe(401)
    })
  })

  describe('GET /agents/{id}/mailboxes', () => {
    it("admin gets 200 with the target's grants (auto-granted at creation)", async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const mailbox = await mailboxStore.upsertConnectedMailbox({
        address: 'support2@example.test',
        provider: 'gmail',
      })
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin3@example.test',
        role: 'admin',
      })
      const target = await createActiveAgent(agentStore, { email: 'mbtarget1@example.test' })

      const res = await api(
        req('GET', `/api/v1/agents/${target.id}/mailboxes`, { agentId: admin.id }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mailboxIds: [mailbox.id] })
    })

    it('403s for a non-admin (even viewing their own grants)', async () => {
      const { api, agentStore } = await freshApi()
      const nonAdmin = await createActiveAgent(agentStore, { email: 'mbnonadmin2@example.test' })

      const res = await api(
        req('GET', `/api/v1/agents/${nonAdmin.id}/mailboxes`, { agentId: nonAdmin.id }),
      )
      expect(res.status).toBe(403)
    })

    it('401s without the acting-Agent header', async () => {
      const { api, agentStore } = await freshApi()
      const target = await createActiveAgent(agentStore, { email: 'mbtarget2@example.test' })
      const res = await api(req('GET', `/api/v1/agents/${target.id}/mailboxes`))
      expect(res.status).toBe(401)
    })

    it('404s for an unknown agent id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin4@example.test',
        role: 'admin',
      })
      const res = await api(
        req('GET', '/api/v1/agents/00000000-0000-0000-0000-000000000000/mailboxes', {
          agentId: admin.id,
        }),
      )
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /agents/{id}/mailboxes', () => {
    it('admin replaces the grant set — 200 with the stored set', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin5@example.test',
        role: 'admin',
      })
      const target = await createActiveAgent(agentStore, { email: 'mbtarget3@example.test' })
      const mailboxA = await mailboxStore.upsertConnectedMailbox({
        address: 'a2@example.test',
        provider: 'gmail',
      })
      const mailboxB = await mailboxStore.upsertConnectedMailbox({
        address: 'b2@example.test',
        provider: 'gmail',
      })

      const res = await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: admin.id,
          body: { mailboxIds: [mailboxA.id, mailboxB.id] },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { mailboxIds: string[] }
      expect(body.mailboxIds.sort()).toEqual([mailboxA.id, mailboxB.id].sort())

      const getRes = await api(
        req('GET', `/api/v1/agents/${target.id}/mailboxes`, { agentId: admin.id }),
      )
      const getBody = (await getRes.json()) as { mailboxIds: string[] }
      expect(getBody.mailboxIds.sort()).toEqual([mailboxA.id, mailboxB.id].sort())
    })

    it('dedupes input ids before storing', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin6@example.test',
        role: 'admin',
      })
      const target = await createActiveAgent(agentStore, { email: 'mbtarget4@example.test' })
      const mailbox = await mailboxStore.upsertConnectedMailbox({
        address: 'dup@example.test',
        provider: 'gmail',
      })

      const res = await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: admin.id,
          body: { mailboxIds: [mailbox.id, mailbox.id] },
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mailboxIds: [mailbox.id] })
    })

    it('an empty array clears every grant — 200', async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin7@example.test',
        role: 'admin',
      })
      const target = await createActiveAgent(agentStore, { email: 'mbtarget5@example.test' })
      const mailbox = await mailboxStore.upsertConnectedMailbox({
        address: 'c@example.test',
        provider: 'gmail',
      })
      await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: admin.id,
          body: { mailboxIds: [mailbox.id] },
        }),
      )

      const res = await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: admin.id,
          body: { mailboxIds: [] },
        }),
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mailboxIds: [] })

      // The response merely echoes the submitted set — re-read through the
      // GET endpoint to prove the clear actually PERSISTED.
      const readBack = await api(
        req('GET', `/api/v1/agents/${target.id}/mailboxes`, { agentId: admin.id }),
      )
      expect(await readBack.json()).toEqual({ mailboxIds: [] })
    })

    it('400s when mailboxIds is not an array', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin8@example.test',
        role: 'admin',
      })
      const target = await createActiveAgent(agentStore, { email: 'mbtarget6@example.test' })

      const res = await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: admin.id,
          body: { mailboxIds: 'not-an-array' },
        }),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })
    })

    it('400s when an entry is not a uuid', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin9@example.test',
        role: 'admin',
      })
      const target = await createActiveAgent(agentStore, { email: 'mbtarget7@example.test' })

      const res = await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: admin.id,
          body: { mailboxIds: ['not-a-uuid'] },
        }),
      )
      expect(res.status).toBe(400)
    })

    it("400s (invalid_mailbox) when an id names no mailbox — the target's PRIOR grants are untouched", async () => {
      const { api, agentStore, mailboxStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin10@example.test',
        role: 'admin',
      })
      const target = await createActiveAgent(agentStore, { email: 'mbtarget8@example.test' })
      const mailbox = await mailboxStore.upsertConnectedMailbox({
        address: 'd@example.test',
        provider: 'gmail',
      })
      await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: admin.id,
          body: { mailboxIds: [mailbox.id] },
        }),
      )

      const bogusId = '99999999-9999-4999-8999-999999999999'
      const res = await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: admin.id,
          body: { mailboxIds: [bogusId] },
        }),
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { code: 'validation_failed', message: expect.any(String) },
      })

      const getRes = await api(
        req('GET', `/api/v1/agents/${target.id}/mailboxes`, { agentId: admin.id }),
      )
      expect(await getRes.json()).toEqual({ mailboxIds: [mailbox.id] })
    })

    it('404s for an unknown agent id', async () => {
      const { api, agentStore } = await freshApi()
      const admin = await createActiveAgent(agentStore, {
        email: 'mbadmin11@example.test',
        role: 'admin',
      })
      const res = await api(
        req('PUT', '/api/v1/agents/00000000-0000-0000-0000-000000000000/mailboxes', {
          agentId: admin.id,
          body: { mailboxIds: [] },
        }),
      )
      expect(res.status).toBe(404)
    })

    it('403s for a non-admin', async () => {
      const { api, agentStore } = await freshApi()
      const nonAdmin = await createActiveAgent(agentStore, { email: 'mbnonadmin3@example.test' })
      const target = await createActiveAgent(agentStore, { email: 'mbtarget9@example.test' })

      const res = await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, {
          agentId: nonAdmin.id,
          body: { mailboxIds: [] },
        }),
      )
      expect(res.status).toBe(403)
    })

    it('401s without the acting-Agent header', async () => {
      const { api, agentStore } = await freshApi()
      const target = await createActiveAgent(agentStore, { email: 'mbtarget10@example.test' })

      const res = await api(
        req('PUT', `/api/v1/agents/${target.id}/mailboxes`, { body: { mailboxIds: [] } }),
      )
      expect(res.status).toBe(401)
    })
  })
})
