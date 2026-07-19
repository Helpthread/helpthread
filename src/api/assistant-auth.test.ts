import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mintAssistantToken } from '../auth/assistant-token.js'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createAssistantStore } from '../store/assistants.js'
import { authenticateAssistantRequest } from './assistant-auth.js'

function req(authorization?: string): Request {
  const headers: Record<string, string> = {}
  if (authorization !== undefined) headers.authorization = authorization
  return new Request('https://x.example.test/api/v1/conversations', { headers })
}

describe('authenticateAssistantRequest', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStoreWithAssistant(status: 'active' | 'disabled' = 'active') {
    db = await createPgliteDb()
    await migrate(db)
    const store = createAssistantStore(db)
    const id = randomUUID()
    const minted = mintAssistantToken(id)
    const assistant = await store.create({
      id,
      name: 'Draft Bot',
      module: 'draft-reply',
      tokenHash: minted.tokenHash,
    })
    if (status === 'disabled') {
      await store.patch(id, { status: 'disabled' })
    }
    return { store, assistant, token: minted.token }
  }

  it('resolves the Assistant for a valid token', async () => {
    const { store, assistant, token } = await freshStoreWithAssistant()
    const resolved = await authenticateAssistantRequest(req(`Bearer ${token}`), store)
    expect(resolved?.id).toBe(assistant.id)
  })

  it('returns null for a missing Authorization header', async () => {
    const { store } = await freshStoreWithAssistant()
    expect(await authenticateAssistantRequest(req(), store)).toBeNull()
  })

  it('returns null for a non-Bearer scheme', async () => {
    const { store, token } = await freshStoreWithAssistant()
    expect(await authenticateAssistantRequest(req(`Basic ${token}`), store)).toBeNull()
  })

  it('returns null for a token with the wrong secret (same assistantId)', async () => {
    const { store, assistant } = await freshStoreWithAssistant()
    const forged = `ht_asst_${assistant.id}_wrong-secret-value`
    expect(await authenticateAssistantRequest(req(`Bearer ${forged}`), store)).toBeNull()
  })

  it('returns null for an unknown assistantId', async () => {
    const { store } = await freshStoreWithAssistant()
    const unknownId = '22222222-2222-4222-8222-222222222222'
    const forged = `ht_asst_${unknownId}_some-secret`
    expect(await authenticateAssistantRequest(req(`Bearer ${forged}`), store)).toBeNull()
  })

  it('returns null for a disabled Assistant, even with the correct secret', async () => {
    const { store, token } = await freshStoreWithAssistant('disabled')
    expect(await authenticateAssistantRequest(req(`Bearer ${token}`), store)).toBeNull()
  })

  it('returns null for a malformed token (not our shape)', async () => {
    const { store } = await freshStoreWithAssistant()
    expect(await authenticateAssistantRequest(req('Bearer not-our-token-shape'), store)).toBeNull()
  })
})
