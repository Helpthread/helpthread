/**
 * End-to-end tests for the passkey (WebAuthn) management API (HT-75;
 * specs/auth/passkeys.md), driven through the real `createInboxApi`
 * pipeline — same convention as `src/api/agents.test.ts`. Only
 * `@simplewebauthn/server`'s four ceremony functions are mocked (the
 * library's own CBOR/COSE/signature correctness is out of scope here; what
 * this suite proves is OUR wiring, step-up gating, ceremony discrimination,
 * and the counter/last-credential policies around it).
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../auth/password-hash.js'
import { createPasswordAuthProvider } from '../auth/password-provider.js'
import { createWebAuthnAuthProvider } from '../auth/webauthn-provider.js'
import type { WebAuthnRpConfig } from '../auth/webauthn-rp.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import { type AgentRecord, type AgentStore, createAgentStore } from '../store/agents.js'
import { createAssistantStore } from '../store/assistants.js'
import { createConversationStore } from '../store/conversations.js'
import { createMailboxStore } from '../store/mailboxes.js'
import { createSavedReplyStore } from '../store/saved-replies.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import { createWebAuthnStore, type WebAuthnStore } from '../store/webauthn.js'
import { createWebhookEndpointStore } from '../store/webhook-endpoints.js'
import { createInboxApi } from './index.js'

const {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} = vi.hoisted(() => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}))

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
}))

const WEBHOOKS_ENC_KEY = randomBytes(ENCRYPTION_KEY_BYTES)
const TOKEN = 'test-token-for-the-webauthn-suite'
const MAIL_DOMAIN = 'mail.example.test'
const SUPPORT_ADDRESS = 'support@example.test'
const UI_BASE_URL = 'https://inbox.example.test'
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const AGENT_HEADER = 'X-Helpthread-Agent-Id'
const RP: WebAuthnRpConfig = { rpId: 'inbox.example.test', expectedOrigin: UI_BASE_URL }

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

function registrationVerified(
  credentialId: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    verified: true,
    registrationInfo: {
      credential: {
        id: credentialId,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ['internal'],
      },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: false,
      ...overrides,
    },
  }
}

describe('Passkey (WebAuthn) API', () => {
  let db: Db | undefined

  afterEach(async () => {
    vi.clearAllMocks()
    await db?.close()
    db = undefined
  })

  async function freshApi(): Promise<{
    db: Db
    agentStore: AgentStore
    webAuthnStore: WebAuthnStore
    api: (request: Request) => Promise<Response>
    sent: OutboundEmail[]
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const agentStore = createAgentStore(db)
    const mailboxStore = createMailboxStore(db)
    const webAuthnStore = createWebAuthnStore(db)
    const { sender, sent } = createFakeSender()
    const providers = [
      createPasswordAuthProvider({ agentStore }),
      createWebAuthnAuthProvider({ db, store: webAuthnStore, keyring: KEYRING, rp: RP }),
    ]
    const api = createInboxApi({
      store: createConversationStore(db),
      apiToken: TOKEN,
      sender,
      keyring: KEYRING,
      mailDomain: MAIL_DOMAIN,
      supportAddress: SUPPORT_ADDRESS,
      agents: { store: agentStore, providers, mailboxStore, uiBaseUrl: UI_BASE_URL },
      webhooks: {
        store: createWebhookEndpointStore(db, WEBHOOKS_ENC_KEY),
        queue: { async enqueue() {} },
      },
      assistants: { store: createAssistantStore(db) },
      savedReplies: { store: createSavedReplyStore(db), mailboxStore },
      webauthn: {
        db,
        store: webAuthnStore,
        agentStore,
        providers,
        keyring: KEYRING,
        rp: RP,
        rpName: 'Helpthread',
        sender,
        mailDomain: MAIL_DOMAIN,
        supportAddress: SUPPORT_ADDRESS,
      },
    })
    return { db, agentStore, webAuthnStore, api, sent }
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

  const PASSWORD = 'correct-horse-battery-staple'

  async function createActiveAgent(
    agentStore: AgentStore,
    email = 'agent@example.test',
  ): Promise<AgentRecord> {
    const result = await agentStore.createAgent({
      name: 'Test Agent',
      email,
      role: 'agent',
      status: 'active',
      passwordHash: hashPassword(PASSWORD),
    })
    if (!result.ok) throw new Error('expected ok')
    return result.agent
  }

  async function stepUpToken(
    api: (r: Request) => Promise<Response>,
    agentId: string,
  ): Promise<string> {
    const res = await api(
      req('POST', '/api/v1/auth/step-up/password', { agentId, body: { password: PASSWORD } }),
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { stepUpToken: string }).stepUpToken
  }

  // --- GET /auth/providers — the webauthn descriptor appears -----------------

  it('GET /auth/providers reports BOTH password and webauthn descriptors', async () => {
    const { api } = await freshApi()
    const res = await api(req('GET', '/api/v1/auth/providers'))
    const body = (await res.json()) as { providers: { key: string; kind: string }[] }
    expect(body.providers).toEqual(
      expect.arrayContaining([
        { key: 'password', label: expect.any(String), kind: 'credentials' },
        { key: 'webauthn', label: expect.any(String), kind: 'webauthn' },
      ]),
    )
  })

  // --- POST /auth/webauthn/authentication/options -----------------------------

  it('authentication/options is pre-session (no acting-Agent header needed) and omits allowCredentials', async () => {
    const { api } = await freshApi()
    generateAuthenticationOptions.mockResolvedValue({ challenge: 'x', rpId: RP.rpId })

    const res = await api(
      new Request('https://x.example.test/api/v1/auth/webauthn/authentication/options', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { options: unknown; challengeToken: string }
    expect(body.challengeToken).toMatch(/^htw\./)
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.not.objectContaining({ allowCredentials: expect.anything() }),
    )
  })

  // --- POST /auth/step-up/password --------------------------------------------

  describe('POST /auth/step-up/password', () => {
    it('mints a step-up token on the correct password', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const res = await api(
        req('POST', '/api/v1/auth/step-up/password', {
          agentId: agent.id,
          body: { password: PASSWORD },
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { stepUpToken: string }
      expect(body.stepUpToken).toMatch(/^htsu\./)
    })

    it('401s on a wrong password', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const res = await api(
        req('POST', '/api/v1/auth/step-up/password', {
          agentId: agent.id,
          body: { password: 'wrong' },
        }),
      )
      expect(res.status).toBe(401)
    })

    it('401s with no acting-Agent header', async () => {
      const { api } = await freshApi()
      const res = await api(
        req('POST', '/api/v1/auth/step-up/password', { body: { password: PASSWORD } }),
      )
      expect(res.status).toBe(401)
    })
  })

  // --- POST /auth/webauthn/registration/options + /verify ---------------------

  describe('registration/options + registration/verify', () => {
    it('registration/options 401s without a valid stepUpToken', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const res = await api(
        req('POST', '/api/v1/auth/webauthn/registration/options', { agentId: agent.id, body: {} }),
      )
      expect(res.status).toBe(401)
    })

    it("registration/options 401s with another Agent's stepUpToken", async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore, 'a@example.test')
      const other = await createActiveAgent(agentStore, 'b@example.test')
      const su = await stepUpToken(api, other.id)
      const res = await api(
        req('POST', '/api/v1/auth/webauthn/registration/options', {
          agentId: agent.id,
          body: { stepUpToken: su },
        }),
      )
      expect(res.status).toBe(401)
    })

    it('the step-up token is single-use — spent by registration/options, refused on retry', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      generateRegistrationOptions.mockResolvedValue({ challenge: 'x' })
      const su = await stepUpToken(api, agent.id)

      const first = await api(
        req('POST', '/api/v1/auth/webauthn/registration/options', {
          agentId: agent.id,
          body: { stepUpToken: su },
        }),
      )
      expect(first.status).toBe(200)

      const second = await api(
        req('POST', '/api/v1/auth/webauthn/registration/options', {
          agentId: agent.id,
          body: { stepUpToken: su },
        }),
      )
      expect(second.status).toBe(401)
    })

    it('a full registration round trip: options → verify → 201, credential never exposes the public key/credentialId, and a notification email is sent', async () => {
      const { api, agentStore, sent } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      generateRegistrationOptions.mockResolvedValue({ challenge: 'x' })
      verifyRegistrationResponse.mockResolvedValue(registrationVerified('cred-abc'))

      const su = await stepUpToken(api, agent.id)
      const optionsRes = await api(
        req('POST', '/api/v1/auth/webauthn/registration/options', {
          agentId: agent.id,
          body: { stepUpToken: su },
        }),
      )
      const { challengeToken } = (await optionsRes.json()) as { challengeToken: string }

      const verifyRes = await api(
        req('POST', '/api/v1/auth/webauthn/registration/verify', {
          agentId: agent.id,
          body: { response: {}, challengeToken, stepUpToken: su, name: 'My MacBook' },
        }),
      )
      expect(verifyRes.status).toBe(201)
      const body = (await verifyRes.json()) as { credential: Record<string, unknown> }
      expect(body.credential.name).toBe('My MacBook')
      expect(body.credential).not.toHaveProperty('publicKey')
      expect(body.credential).not.toHaveProperty('credentialId')
      expect(sent).toHaveLength(1)
      expect(sent[0].to).toEqual([agent.email])
    })

    it('defaults a blank name to "Passkey — {date}"', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      generateRegistrationOptions.mockResolvedValue({ challenge: 'x' })
      verifyRegistrationResponse.mockResolvedValue(registrationVerified('cred-blank-name'))

      const su = await stepUpToken(api, agent.id)
      const optionsRes = await api(
        req('POST', '/api/v1/auth/webauthn/registration/options', {
          agentId: agent.id,
          body: { stepUpToken: su },
        }),
      )
      const { challengeToken } = (await optionsRes.json()) as { challengeToken: string }
      const verifyRes = await api(
        req('POST', '/api/v1/auth/webauthn/registration/verify', {
          agentId: agent.id,
          body: { response: {}, challengeToken, stepUpToken: su, name: '   ' },
        }),
      )
      const body = (await verifyRes.json()) as { credential: { name: string } }
      expect(body.credential.name).toMatch(/^Passkey — \d{4}-\d{2}-\d{2}$/)
    })

    it('409s when the credential_id is already registered', async () => {
      const { api, agentStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      generateRegistrationOptions.mockResolvedValue({ challenge: 'x' })
      verifyRegistrationResponse.mockResolvedValue(registrationVerified('dup-cred'))

      async function attempt() {
        const su = await stepUpToken(api, agent.id)
        const optionsRes = await api(
          req('POST', '/api/v1/auth/webauthn/registration/options', {
            agentId: agent.id,
            body: { stepUpToken: su },
          }),
        )
        const { challengeToken } = (await optionsRes.json()) as { challengeToken: string }
        return api(
          req('POST', '/api/v1/auth/webauthn/registration/verify', {
            agentId: agent.id,
            body: { response: {}, challengeToken, stepUpToken: su },
          }),
        )
      }

      expect((await attempt()).status).toBe(201)
      const second = await attempt()
      expect(second.status).toBe(409)
    })
  })

  // --- step-up/webauthn/options + verify ---------------------------------------

  it('step-up/webauthn/options populates allowCredentials with the acting Agent’s own credentials', async () => {
    const { api, agentStore, webAuthnStore } = await freshApi()
    const agent = await createActiveAgent(agentStore)
    await webAuthnStore.insertCredential({
      agentId: agent.id,
      credentialId: 'my-cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      transports: ['internal'],
      backupEligible: true,
      backupState: false,
      name: 'Key',
    })
    generateAuthenticationOptions.mockResolvedValue({ challenge: 'x' })

    const res = await api(
      req('POST', '/api/v1/auth/step-up/webauthn/options', { agentId: agent.id, body: {} }),
    )
    expect(res.status).toBe(200)
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ allowCredentials: [{ id: 'my-cred', transports: ['internal'] }] }),
    )
  })

  it('step-up/webauthn/verify rejects a credential belonging to a DIFFERENT Agent than the session', async () => {
    const { api, agentStore, webAuthnStore } = await freshApi()
    const owner = await createActiveAgent(agentStore, 'owner@example.test')
    const impersonator = await createActiveAgent(agentStore, 'impersonator@example.test')
    await webAuthnStore.insertCredential({
      agentId: owner.id,
      credentialId: 'owner-cred',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      transports: [],
      backupEligible: false,
      backupState: false,
      name: 'Key',
    })
    generateAuthenticationOptions.mockResolvedValue({ challenge: 'x' })
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1, credentialBackedUp: false },
    })

    const optionsRes = await api(
      req('POST', '/api/v1/auth/step-up/webauthn/options', { agentId: impersonator.id, body: {} }),
    )
    const { challengeToken } = (await optionsRes.json()) as { challengeToken: string }

    const verifyRes = await api(
      req('POST', '/api/v1/auth/step-up/webauthn/verify', {
        agentId: impersonator.id,
        body: { response: { id: 'owner-cred' }, challengeToken },
      }),
    )
    expect(verifyRes.status).toBe(401)
  })

  // --- /auth/verify's webauthn case + challenge_expired -------------------------

  describe("POST /auth/verify { providerKey: 'webauthn' }", () => {
    it('logs in on a fully valid assertion', async () => {
      const { api, agentStore, webAuthnStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      await webAuthnStore.insertCredential({
        agentId: agent.id,
        credentialId: 'login-cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        transports: [],
        backupEligible: false,
        backupState: false,
        name: 'Key',
      })
      generateAuthenticationOptions.mockResolvedValue({ challenge: 'x' })
      verifyAuthenticationResponse.mockResolvedValue({
        verified: true,
        authenticationInfo: { newCounter: 1, credentialBackedUp: false },
      })

      const optionsRes = await api(
        new Request('https://x.example.test/api/v1/auth/webauthn/authentication/options', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
      const { challengeToken } = (await optionsRes.json()) as { challengeToken: string }

      const verifyRes = await api(
        req('POST', '/api/v1/auth/verify', {
          body: { providerKey: 'webauthn', response: { id: 'login-cred' }, challengeToken },
        }),
      )
      expect(verifyRes.status).toBe(200)
      const body = (await verifyRes.json()) as { agent: { id: string } }
      expect(body.agent.id).toBe(agent.id)
    })

    it('returns the distinguishable challenge_expired code, not a generic 401, for an expired/reused challenge', async () => {
      const { api } = await freshApi()
      generateAuthenticationOptions.mockResolvedValue({ challenge: 'x' })
      const optionsRes = await api(
        new Request('https://x.example.test/api/v1/auth/webauthn/authentication/options', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
      )
      const { challengeToken } = (await optionsRes.json()) as { challengeToken: string }

      // Consume it once via a normal (failing, unknown-credential) attempt so the
      // DB row is gone — the second attempt then finds no row at all.
      await api(
        req('POST', '/api/v1/auth/verify', {
          body: { providerKey: 'webauthn', response: { id: 'no-such-credential' }, challengeToken },
        }),
      )
      const res = await api(
        req('POST', '/api/v1/auth/verify', {
          body: { providerKey: 'webauthn', response: { id: 'no-such-credential' }, challengeToken },
        }),
      )
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({
        error: { code: 'challenge_expired', message: expect.any(String) },
      })
    })
  })

  // --- credential list/rename/revoke -------------------------------------------

  describe('GET/PATCH/DELETE /agents/{id}/webauthn-credentials', () => {
    it('self may list, rename, and revoke their own credential', async () => {
      const { api, agentStore, webAuthnStore } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      const inserted = await webAuthnStore.insertCredential({
        agentId: agent.id,
        credentialId: 'self-cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        transports: [],
        backupEligible: false,
        backupState: false,
        name: 'Original name',
      })
      if (!inserted.ok) throw new Error('expected ok')

      const listRes = await api(
        req('GET', `/api/v1/agents/${agent.id}/webauthn-credentials`, { agentId: agent.id }),
      )
      expect(listRes.status).toBe(200)
      const listBody = (await listRes.json()) as { credentials: { id: string; name: string }[] }
      expect(listBody.credentials).toHaveLength(1)
      expect(listBody.credentials[0]).not.toHaveProperty('publicKey')

      const patchRes = await api(
        req('PATCH', `/api/v1/agents/${agent.id}/webauthn-credentials/${inserted.credential.id}`, {
          agentId: agent.id,
          body: { name: 'Renamed' },
        }),
      )
      expect(patchRes.status).toBe(200)

      const deleteRes = await api(
        req('DELETE', `/api/v1/agents/${agent.id}/webauthn-credentials/${inserted.credential.id}`, {
          agentId: agent.id,
        }),
      )
      expect(deleteRes.status).toBe(204)
    })

    it('a non-admin, non-self Agent is forbidden', async () => {
      const { api, agentStore } = await freshApi()
      const owner = await createActiveAgent(agentStore, 'owner@example.test')
      const other = await createActiveAgent(agentStore, 'other@example.test')
      const res = await api(
        req('GET', `/api/v1/agents/${owner.id}/webauthn-credentials`, { agentId: other.id }),
      )
      expect(res.status).toBe(403)
    })

    it('an admin may list/rename/revoke another Agent’s credentials', async () => {
      const { api, agentStore, webAuthnStore } = await freshApi()
      const target = await createActiveAgent(agentStore, 'target@example.test')
      const admin = await agentStore.createAgent({
        name: 'Admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        passwordHash: hashPassword(PASSWORD),
      })
      if (!admin.ok) throw new Error('expected ok')
      await webAuthnStore.insertCredential({
        agentId: target.id,
        credentialId: 'admin-managed',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        transports: [],
        backupEligible: false,
        backupState: false,
        name: 'Key',
      })

      const res = await api(
        req('GET', `/api/v1/agents/${target.id}/webauthn-credentials`, { agentId: admin.agent.id }),
      )
      expect(res.status).toBe(200)
    })

    it("409s ('conflict') revoking the Agent's only credential once they have no password identity — the spec §9.1 defensive guard", async () => {
      const { api, agentStore, webAuthnStore, db: testDb } = await freshApi()
      const agent = await createActiveAgent(agentStore)
      await testDb.query('DELETE FROM agent_auth_identities WHERE agent_id = $1', [agent.id])
      const inserted = await webAuthnStore.insertCredential({
        agentId: agent.id,
        credentialId: 'only-cred',
        publicKey: new Uint8Array([1]),
        signCount: 0,
        transports: [],
        backupEligible: false,
        backupState: false,
        name: 'Key',
      })
      if (!inserted.ok) throw new Error('expected ok')

      const res = await api(
        req('DELETE', `/api/v1/agents/${agent.id}/webauthn-credentials/${inserted.credential.id}`, {
          agentId: agent.id,
        }),
      )
      expect(res.status).toBe(409)
    })
  })
})
