import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { type AssistantStore, createAssistantStore } from './assistants.js'

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

/** Insert an `agents` row directly — `created_by_agent_id` FKs to it. */
async function insertAgent(db: Db, email = 'admin@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO agents (email, name, role, status) VALUES ($1, 'Admin', 'admin', 'active') RETURNING id`,
    [email],
  )
  return rows[0].id
}

describe('AssistantStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: AssistantStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createAssistantStore(db) }
  }

  it('create inserts an active Assistant and never returns tokenHash', async () => {
    const { db, store } = await freshStore()
    const agentId = await insertAgent(db)

    const assistant = await store.create({
      name: 'Draft Bot',
      module: 'draft-reply',
      tokenHash: 'sha256-hash-value',
      createdByAgentId: agentId,
    })

    expect(assistant.name).toBe('Draft Bot')
    expect(assistant.module).toBe('draft-reply')
    expect(assistant.status).toBe('active')
    expect(assistant.createdByAgentId).toBe(agentId)
    expect(assistant.createdAt).toBeInstanceOf(Date)
    expect(assistant.updatedAt).toBeInstanceOf(Date)
    expect(assistant).not.toHaveProperty('tokenHash')
  })

  it('create with createdByAgentId omitted stores NULL', async () => {
    const { store } = await freshStore()
    const assistant = await store.create({
      name: 'Anon Bot',
      module: 'draft-reply',
      tokenHash: 'hash',
    })
    expect(assistant.createdByAgentId).toBeNull()
  })

  it('create with an explicit id (HT-70, the token/id knot) stores that id verbatim', async () => {
    const { store } = await freshStore()
    const explicitId = '11111111-1111-4111-8111-111111111111'
    const assistant = await store.create({
      id: explicitId,
      name: 'Pre-minted Bot',
      module: 'draft-reply',
      tokenHash: 'hash',
    })
    expect(assistant.id).toBe(explicitId)
    expect(await store.get(explicitId)).toEqual(assistant)
  })

  it('get returns null for an unknown id', async () => {
    const { store } = await freshStore()
    expect(await store.get(RANDOM_UUID)).toBeNull()
  })

  it('get round-trips a created Assistant', async () => {
    const { store } = await freshStore()
    const created = await store.create({ name: 'Bot', module: 'm', tokenHash: 'h' })
    expect(await store.get(created.id)).toEqual(created)
  })

  it('list returns every Assistant ordered by name', async () => {
    const { store } = await freshStore()
    await store.create({ name: 'Zed Bot', module: 'm', tokenHash: 'h1' })
    await store.create({ name: 'Alpha Bot', module: 'm', tokenHash: 'h2' })

    const list = await store.list()
    expect(list.map((a) => a.name)).toEqual(['Alpha Bot', 'Zed Bot'])
  })

  it('patch updates name and/or status, bumps updated_at, and a no-op patch fetches-and-returns unchanged', async () => {
    const { store } = await freshStore()
    const created = await store.create({ name: 'Bot', module: 'm', tokenHash: 'h' })

    const renamed = await store.patch(created.id, { name: 'Renamed Bot' })
    expect(renamed?.name).toBe('Renamed Bot')
    expect(renamed?.status).toBe('active')

    const disabled = await store.patch(created.id, { status: 'disabled' })
    expect(disabled?.status).toBe('disabled')
    expect(disabled?.name).toBe('Renamed Bot')

    const noOp = await store.patch(created.id, {})
    expect(noOp).toMatchObject({ id: created.id, name: 'Renamed Bot', status: 'disabled' })
  })

  it('patch returns null for an unknown id', async () => {
    const { store } = await freshStore()
    expect(await store.patch(RANDOM_UUID, { name: 'x' })).toBeNull()
  })

  it('updateTokenHash replaces the hash (verified via getTokenHash) and throws for an unknown id', async () => {
    const { store } = await freshStore()
    const created = await store.create({ name: 'Bot', module: 'm', tokenHash: 'hash-v1' })
    expect(await store.getTokenHash(created.id)).toBe('hash-v1')

    await store.updateTokenHash(created.id, 'hash-v2')
    expect(await store.getTokenHash(created.id)).toBe('hash-v2')

    await expect(store.updateTokenHash(RANDOM_UUID, 'hash-v3')).rejects.toThrow()
  })

  it('getTokenHash returns null for an unknown id', async () => {
    const { store } = await freshStore()
    expect(await store.getTokenHash(RANDOM_UUID)).toBeNull()
  })
})
