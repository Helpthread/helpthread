import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { type AgentStore, createAgentStore } from '../store/agents.js'
import { hashPassword } from './password-hash.js'
import { createPasswordAuthProvider } from './password-provider.js'
import type { AuthProvider } from './provider.js'

describe('PasswordAuthProvider', () => {
  let db: Db | undefined
  let agentStore: AgentStore | undefined
  let provider: AuthProvider | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
    agentStore = undefined
    provider = undefined
  })

  async function freshProvider(): Promise<{ agentStore: AgentStore; provider: AuthProvider }> {
    db = await createPgliteDb()
    await migrate(db)
    agentStore = createAgentStore(db)
    provider = createPasswordAuthProvider({ agentStore })
    return { agentStore, provider }
  }

  it('descriptor() reports key: password, kind: credentials', async () => {
    const { provider } = await freshProvider()
    expect(provider.descriptor()).toEqual({
      key: 'password',
      label: expect.any(String),
      kind: 'credentials',
    })
  })

  it('resolves the correct email + password to the Agent identity', async () => {
    const { agentStore, provider } = await freshProvider()
    const created = await agentStore.createAgent({
      name: 'Real Agent',
      email: 'real@example.test',
      role: 'agent',
      status: 'active',
      passwordHash: hashPassword('correct-password'),
    })
    if (!created.ok) throw new Error('expected ok')

    const result = await provider.authenticate({
      providerKey: 'password',
      email: 'real@example.test',
      password: 'correct-password',
    })
    expect(result).toEqual({ agentId: created.agent.id })
  })

  it('email is matched case-insensitively', async () => {
    const { agentStore, provider } = await freshProvider()
    await agentStore.createAgent({
      name: 'Real Agent',
      email: 'real@example.test',
      role: 'agent',
      status: 'active',
      passwordHash: hashPassword('correct-password'),
    })

    const result = await provider.authenticate({
      providerKey: 'password',
      email: 'REAL@EXAMPLE.TEST',
      password: 'correct-password',
    })
    expect(result).not.toBeNull()
  })

  it('rejects a wrong password', async () => {
    const { agentStore, provider } = await freshProvider()
    await agentStore.createAgent({
      name: 'Real Agent',
      email: 'real@example.test',
      role: 'agent',
      status: 'active',
      passwordHash: hashPassword('correct-password'),
    })

    const result = await provider.authenticate({
      providerKey: 'password',
      email: 'real@example.test',
      password: 'wrong-password',
    })
    expect(result).toBeNull()
  })

  it('rejects an unknown email', async () => {
    const { provider } = await freshProvider()
    const result = await provider.authenticate({
      providerKey: 'password',
      email: 'nobody@example.test',
      password: 'anything',
    })
    expect(result).toBeNull()
  })

  it("rejects an 'invited' Agent even with no password set yet (no identity to verify against)", async () => {
    const { agentStore, provider } = await freshProvider()
    await agentStore.createAgent({
      name: 'Invited Agent',
      email: 'invited@example.test',
      role: 'agent',
      status: 'invited',
    })

    const result = await provider.authenticate({
      providerKey: 'password',
      email: 'invited@example.test',
      password: 'anything',
    })
    expect(result).toBeNull()
  })

  it("rejects a 'disabled' Agent even with the CORRECT password", async () => {
    const { agentStore, provider } = await freshProvider()
    const created = await agentStore.createAgent({
      name: 'Disabled Agent',
      email: 'disabled@example.test',
      role: 'agent',
      status: 'active',
      passwordHash: hashPassword('correct-password'),
    })
    if (!created.ok) throw new Error('expected ok')
    await agentStore.updateAgent(created.agent.id, { status: 'disabled' })

    const result = await provider.authenticate({
      providerKey: 'password',
      email: 'disabled@example.test',
      password: 'correct-password',
    })
    expect(result).toBeNull()
  })

  it('is TOTAL over a malformed attempt — non-string email/password never throws, resolves null', async () => {
    const { provider } = await freshProvider()
    const attempts = [
      { providerKey: 'password', email: 123, password: 'x' },
      { providerKey: 'password', email: 'x@example.test', password: 123 },
      { providerKey: 'password', email: undefined, password: undefined },
      { providerKey: 'password' },
    ]
    for (const attempt of attempts) {
      await expect(provider.authenticate(attempt)).resolves.toBeNull()
    }
  })
})
