import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { Keyring } from '../mail/reply-token.js'
import { type AgentStore, createAgentStore } from '../store/agents.js'
import { createWebAuthnStore, type WebAuthnStore } from '../store/webauthn.js'
import type { WebAuthnRpConfig } from './webauthn-rp.js'
import { mintChallengeToken } from './webauthn-token.js'

const { verifyAuthenticationResponse } = vi.hoisted(() => ({
  verifyAuthenticationResponse: vi.fn(),
}))

vi.mock('@simplewebauthn/server', () => ({ verifyAuthenticationResponse }))

// Imported AFTER the mock is registered, per vitest's hoisting contract.
const { uuidToBytes, verifyAuthenticationCeremony } = await import('./webauthn-ceremony.js')

const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const RP: WebAuthnRpConfig = {
  rpId: 'inbox.example.test',
  expectedOrigin: 'https://inbox.example.test',
}

function verifiedResult(newCounter: number, credentialBackedUp = false) {
  return {
    verified: true,
    authenticationInfo: { newCounter, credentialBackedUp, credentialDeviceType: 'multiDevice' },
  }
}

describe('verifyAuthenticationCeremony', () => {
  let db: Db | undefined
  let store: WebAuthnStore | undefined
  let agentStore: AgentStore | undefined

  afterEach(async () => {
    vi.clearAllMocks()
    await db?.close()
    db = undefined
    store = undefined
    agentStore = undefined
  })

  async function setup(): Promise<{ db: Db; store: WebAuthnStore; agentStore: AgentStore }> {
    db = await createPgliteDb()
    await migrate(db)
    store = createWebAuthnStore(db)
    agentStore = createAgentStore(db)
    return { db, store, agentStore }
  }

  async function makeAgent(a: AgentStore, email: string): Promise<string> {
    const result = await a.createAgent({
      name: 'Agent',
      email,
      role: 'agent',
      status: 'active',
      passwordHash: 'scrypt$hash',
    })
    if (!result.ok) throw new Error('expected ok')
    return result.agent.id
  }

  async function makeCredential(s: WebAuthnStore, agentId: string, signCount = 0): Promise<string> {
    const inserted = await s.insertCredential({
      agentId,
      credentialId: 'cred-1',
      publicKey: new Uint8Array([1, 2, 3]),
      signCount,
      transports: ['internal'],
      backupEligible: true,
      backupState: false,
      name: 'Test Passkey',
    })
    if (!inserted.ok) throw new Error('expected ok')
    return inserted.credential.id
  }

  async function mintAuthChallenge(
    s: WebAuthnStore,
    ceremony: 'authentication' | 'registration' | 'step-up' = 'authentication',
  ) {
    const minted = mintChallengeToken(ceremony, null, KEYRING)
    await s.mintChallenge({
      nonce: minted.nonce,
      ceremony,
      agentId: null,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    })
    return minted
  }

  function responseFor(credentialId: string, agentId?: string) {
    return {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: {
        clientDataJSON: 'x',
        authenticatorData: 'x',
        signature: 'x',
        ...(agentId !== undefined
          ? { userHandle: Buffer.from(uuidToBytes(agentId)).toString('base64url') }
          : {}),
      },
      clientExtensionResults: {},
    }
  }

  it('happy path: verified, non-regressing counter — resolves the agentId and persists the new counter', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    await makeCredential(s, agentId, 0)
    const minted = await mintAuthChallenge(s)
    verifyAuthenticationResponse.mockResolvedValue(verifiedResult(1))

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1', agentId),
        challengeToken: minted.token,
      },
    )

    expect(result).toEqual({ ok: true, agentId })
    const after = await s.getCredentialByCredentialId('cred-1')
    expect(after?.signCount).toBe(1)
    expect(after?.lastUsedAt).not.toBeNull()
  })

  it('challenge_expired: the challenge token verifies but the DB row was never minted (or already consumed)', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    await makeCredential(s, agentId, 0)
    // A signature+TTL-valid token whose nonce has no corresponding DB row.
    const minted = mintChallengeToken('authentication', null, KEYRING)

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1'),
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: false, reason: 'challenge_expired' })
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled()
  })

  it('ceremony mismatch is rejected at the application level, BEFORE the DB consume — the row stays available for its real ceremony', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    await makeCredential(s, agentId, 0)
    const minted = await mintAuthChallenge(s, 'registration')

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1'),
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: false, reason: 'invalid' })
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled()
    // The row minted for 'registration' is untouched — still consumable under its real ceremony.
    expect(await s.consumeChallenge(minted.nonce, 'registration')).toBe(true)
  })

  it('unknown credential id is rejected', async () => {
    const { store: s, agentStore: as } = await setup()
    await makeAgent(as, 'a@example.test')
    const minted = await mintAuthChallenge(s)

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('no-such-credential'),
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('step-up requireAgentId mismatch is rejected before running cryptographic verification', async () => {
    const { store: s, agentStore: as } = await setup()
    const owner = await makeAgent(as, 'owner@example.test')
    const impersonator = await makeAgent(as, 'other@example.test')
    await makeCredential(s, owner, 0)
    const minted = await mintAuthChallenge(s, 'step-up')

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'step-up',
        responseJson: responseFor('cred-1'),
        challengeToken: minted.token,
        requireAgentId: impersonator,
      },
    )
    expect(result).toEqual({ ok: false, reason: 'invalid' })
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled()
  })

  it('a userHandle that resolves to a different Agent than the credential is rejected (defense in depth)', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    const otherAgentId = await makeAgent(as, 'b@example.test')
    await makeCredential(s, agentId, 0)
    const minted = await mintAuthChallenge(s)
    verifyAuthenticationResponse.mockResolvedValue(verifiedResult(1))

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1', otherAgentId), // userHandle names the WRONG agent
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('Tier 1 (never reported nonzero) is exempt from regression checks — a repeated 0 counter is accepted', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    await makeCredential(s, agentId, 0)
    const minted = await mintAuthChallenge(s)
    verifyAuthenticationResponse.mockResolvedValue(verifiedResult(0)) // still 0 — the sentinel

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1', agentId),
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: true, agentId })
  })

  it("Tier 2 (has ever reported nonzero): a counter <= the stored maximum is REJECTED and the regression is marked — using a mock that FAITHFULLY reproduces the real library's own throw-on-regression behavior", async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    await makeCredential(s, agentId, 10) // already graduated to Tier 2
    const minted = await mintAuthChallenge(s)

    // The REAL `verifyAuthenticationResponse` runs its own regression guard
    // BEFORE the signature check: `if ((counter > 0 || credential.counter >
    // 0) && counter <= credential.counter) throw`. A mock that just
    // RESOLVES with a regressed counter (the old version of this test) is a
    // false-green over a dead path — the real library never resolves in
    // that shape, it throws. This mock reproduces the library's exact
    // guard against whatever `credential.counter` our code actually passes,
    // so it throws in EXACTLY the case the real library would.
    const RESPONSE_COUNTER = 5 // <= the stored maximum of 10: a genuine regression
    verifyAuthenticationResponse.mockImplementation(async (opts) => {
      const credentialCounter = (opts as { credential: { counter: number } }).credential.counter
      if (
        (RESPONSE_COUNTER > 0 || credentialCounter > 0) &&
        RESPONSE_COUNTER <= credentialCounter
      ) {
        throw new Error(
          `Response counter value ${RESPONSE_COUNTER} was lower than expected ${credentialCounter}`,
        )
      }
      return verifiedResult(RESPONSE_COUNTER)
    })

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1', agentId),
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: false, reason: 'invalid' })

    // Proves the fix directly: we deliberately pass `counter: 0` (never the
    // real stored `signCount`) so the library's own guard above can never
    // fire — our locked Tier-1/Tier-2 logic is the sole authority. If a
    // future change regressed to passing the real counter, THIS mock would
    // throw before our own logic ever ran, `markCounterRegression` would
    // never fire, and the assertions below would fail.
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({ credential: expect.objectContaining({ counter: 0 }) }),
    )

    const after = await s.getCredentialByCredentialId('cred-1')
    expect(after?.signCountRegressionAt).not.toBeNull() // the HT-44 health signal persisted
    expect(after?.signCount).toBe(10) // NOT overwritten by the lower, rejected value
  })

  it('a loud, structured log line is emitted at the point a regression is detected (spec §8: "the log line is what makes it investigable")', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    const credentialId = await makeCredential(s, agentId, 10)
    const minted = await mintAuthChallenge(s)
    verifyAuthenticationResponse.mockResolvedValue(verifiedResult(3))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await verifyAuthenticationCeremony(
        { db: db as Db, store: s, keyring: KEYRING, rp: RP },
        {
          ceremony: 'authentication',
          responseJson: responseFor('cred-1', agentId),
          challengeToken: minted.token,
        },
      )
      const call = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes('webauthn_counter_regression'),
      )
      expect(call).toBeDefined()
      const logged = JSON.parse(call?.[0] as string)
      expect(logged).toMatchObject({
        event: 'webauthn_counter_regression',
        credentialId,
        agentId,
        storedCounter: 10,
        responseCounter: 3,
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('Tier 2: a counter strictly greater than the stored maximum is accepted and persisted', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    await makeCredential(s, agentId, 10)
    const minted = await mintAuthChallenge(s)
    verifyAuthenticationResponse.mockResolvedValue(verifiedResult(11))

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1', agentId),
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: true, agentId })
    const after = await s.getCredentialByCredentialId('cred-1')
    expect(after?.signCount).toBe(11)
    expect(after?.signCountRegressionAt).toBeNull()
  })

  it('a disabled Agent is rejected even with a fully valid ceremony', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    await makeCredential(s, agentId, 0)
    await as.updateAgent(agentId, { status: 'disabled' })
    const minted = await mintAuthChallenge(s)
    verifyAuthenticationResponse.mockResolvedValue(verifiedResult(1))

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1', agentId),
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('a thrown verifyAuthenticationResponse (a malformed response) is treated as invalid, not a crash', async () => {
    const { store: s, agentStore: as } = await setup()
    const agentId = await makeAgent(as, 'a@example.test')
    await makeCredential(s, agentId, 0)
    const minted = await mintAuthChallenge(s)
    verifyAuthenticationResponse.mockRejectedValue(new Error('malformed clientDataJSON'))

    const result = await verifyAuthenticationCeremony(
      { db: db as Db, store: s, keyring: KEYRING, rp: RP },
      {
        ceremony: 'authentication',
        responseJson: responseFor('cred-1', agentId),
        challengeToken: minted.token,
      },
    )
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })
})
