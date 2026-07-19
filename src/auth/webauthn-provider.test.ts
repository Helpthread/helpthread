import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import { type AgentStore, createAgentStore } from '../store/agents.js'
import { createWebAuthnStore, type WebAuthnStore } from '../store/webauthn.js'
import type { AuthProvider } from './provider.js'
import type { WebAuthnRpConfig } from './webauthn-rp.js'
import { mintChallengeToken } from './webauthn-token.js'

const { verifyAuthenticationResponse } = vi.hoisted(() => ({
  verifyAuthenticationResponse: vi.fn(),
}))

vi.mock('@simplewebauthn/server', () => ({ verifyAuthenticationResponse }))

const { createWebAuthnAuthProvider, WebAuthnChallengeExpiredError } = await import(
  './webauthn-provider.js'
)

const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const RP: WebAuthnRpConfig = {
  rpId: 'inbox.example.test',
  expectedOrigin: 'https://inbox.example.test',
}

describe('createWebAuthnAuthProvider', () => {
  let db: Db | undefined
  let store: WebAuthnStore | undefined
  let agentStore: AgentStore | undefined
  let provider: AuthProvider | undefined

  afterEach(async () => {
    vi.clearAllMocks()
    await db?.close()
    db = undefined
    store = undefined
    agentStore = undefined
    provider = undefined
  })

  async function freshProvider(): Promise<{
    store: WebAuthnStore
    agentStore: AgentStore
    provider: AuthProvider
  }> {
    db = await createPgliteDb()
    await migrate(db)
    store = createWebAuthnStore(db)
    agentStore = createAgentStore(db)
    provider = createWebAuthnAuthProvider({ db, store, keyring: KEYRING, rp: RP })
    return { store, agentStore, provider }
  }

  it('descriptor() reports key: webauthn, kind: webauthn', async () => {
    const { provider: p } = await freshProvider()
    expect(p.descriptor()).toEqual({ key: 'webauthn', label: expect.any(String), kind: 'webauthn' })
  })

  it('resolves the correct Agent on a fully valid ceremony', async () => {
    const { store: s, agentStore: as, provider: p } = await freshProvider()
    const created = await as.createAgent({
      name: 'Agent',
      email: 'a@example.test',
      role: 'agent',
      status: 'active',
      passwordHash: 'scrypt$hash',
    })
    if (!created.ok) throw new Error('expected ok')
    await s.insertCredential({
      agentId: created.agent.id,
      credentialId: 'cred-1',
      publicKey: new Uint8Array([1]),
      signCount: 0,
      transports: [],
      backupEligible: false,
      backupState: false,
      name: 'Key',
    })
    const minted = mintChallengeToken('authentication', null, KEYRING)
    await s.mintChallenge({
      nonce: minted.nonce,
      ceremony: 'authentication',
      agentId: null,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 1, credentialBackedUp: false },
    })

    const result = await p.authenticate({
      providerKey: 'webauthn',
      response: { id: 'cred-1', response: {} },
      challengeToken: minted.token,
    })
    expect(result).toEqual({ agentId: created.agent.id })
  })

  it('returns null (not a throw) for an ordinary invalid ceremony — e.g. an unknown credential', async () => {
    const { provider: p } = await freshProvider()
    const minted = mintChallengeToken('authentication', null, KEYRING)
    await (store as WebAuthnStore).mintChallenge({
      nonce: minted.nonce,
      ceremony: 'authentication',
      agentId: null,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })

    const result = await p.authenticate({
      providerKey: 'webauthn',
      response: { id: 'no-such-credential', response: {} },
      challengeToken: minted.token,
    })
    expect(result).toBeNull()
  })

  it('THROWS WebAuthnChallengeExpiredError specifically when the challenge token is expired/missing/already-used', async () => {
    const { provider: p } = await freshProvider()
    // A signature+TTL-valid token whose DB row was never minted.
    const minted = mintChallengeToken('authentication', null, KEYRING)

    await expect(
      p.authenticate({
        providerKey: 'webauthn',
        response: { id: 'cred-1', response: {} },
        challengeToken: minted.token,
      }),
    ).rejects.toBeInstanceOf(WebAuthnChallengeExpiredError)
  })

  it('returns null for a malformed attempt (missing challengeToken/response) without touching the store', async () => {
    const { provider: p } = await freshProvider()
    expect(await p.authenticate({ providerKey: 'webauthn' })).toBeNull()
    expect(await p.authenticate({ providerKey: 'webauthn', challengeToken: 'x' })).toBeNull()
  })
})
