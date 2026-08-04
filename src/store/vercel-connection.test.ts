import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import {
  createVercelConnectionStore,
  VercelConnectionAlreadyActiveError,
  type VercelConnectionStore,
} from './vercel-connection.js'

/** Insert an `agents` row directly — `connected_by_agent_id` FKs to it. */
async function insertAgent(db: Db, email = 'admin@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO agents (email, name, role, status) VALUES ($1, 'Admin', 'admin', 'active') RETURNING id`,
    [email],
  )
  return rows[0].id
}

describe('VercelConnectionStore', () => {
  let db: Db | undefined
  const encryptionKey = randomBytes(32)

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: VercelConnectionStore; agentId: string }> {
    db = await createPgliteDb()
    await migrate(db)
    const agentId = await insertAgent(db)
    return { db, store: createVercelConnectionStore(db, encryptionKey), agentId }
  }

  it('connect stores an encrypted token and getToken decrypts it back', async () => {
    const { store, agentId } = await freshStore()

    const connection = await store.connect({
      teamId: 'team_abc123',
      token: 'vercel_bearer_secret_value',
      tokenFingerprint: 'fp_ab12',
      connectedByAgentId: agentId,
    })

    expect(connection.teamId).toBe('team_abc123')
    expect(connection.tokenFingerprint).toBe('fp_ab12')
    expect(connection.connectedByAgentId).toBe(agentId)
    expect(connection.revokedAt).toBeNull()
    expect(connection).not.toHaveProperty('token')
    expect(connection).not.toHaveProperty('tokenCiphertext')

    const token = await store.getToken(connection.id)
    expect(token).toBe('vercel_bearer_secret_value')
  })

  it('getActive returns the current active connection', async () => {
    const { store, agentId } = await freshStore()
    expect(await store.getActive()).toBeNull()

    const connection = await store.connect({
      teamId: 'team_abc123',
      token: 'secret',
      tokenFingerprint: 'fp_ab12',
      connectedByAgentId: agentId,
    })

    const active = await store.getActive()
    expect(active?.id).toBe(connection.id)
  })

  it('a second connect while one is active is refused (single-active-connection index)', async () => {
    const { store, agentId } = await freshStore()
    await store.connect({
      teamId: 'team_first',
      token: 'secret-1',
      tokenFingerprint: 'fp_1',
      connectedByAgentId: agentId,
    })

    await expect(
      store.connect({
        teamId: 'team_second',
        token: 'secret-2',
        tokenFingerprint: 'fp_2',
        connectedByAgentId: agentId,
      }),
    ).rejects.toBeInstanceOf(VercelConnectionAlreadyActiveError)
  })

  it('revoke frees the index so a new connection can be made', async () => {
    const { store, agentId } = await freshStore()
    const first = await store.connect({
      teamId: 'team_first',
      token: 'secret-1',
      tokenFingerprint: 'fp_1',
      connectedByAgentId: agentId,
    })

    await store.revoke(first.id)
    expect(await store.getActive()).toBeNull()

    const second = await store.connect({
      teamId: 'team_second',
      token: 'secret-2',
      tokenFingerprint: 'fp_2',
      connectedByAgentId: agentId,
    })
    const active = await store.getActive()
    expect(active?.id).toBe(second.id)

    // The revoked row is untouched history, not deleted.
    const revoked = await store.get(first.id)
    expect(revoked?.revokedAt).not.toBeNull()
  })

  it('team_id is immutable once set — a raw UPDATE attempting to change it is rejected', async () => {
    const { db: rawDb, store, agentId } = await freshStore()
    const connection = await store.connect({
      teamId: 'team_original',
      token: 'secret',
      tokenFingerprint: 'fp_1',
      connectedByAgentId: agentId,
    })

    await expect(
      rawDb.query('UPDATE vercel_connections SET team_id = $1 WHERE id = $2', [
        'team_hijacked',
        connection.id,
      ]),
    ).rejects.toThrow(/immutable/)
  })

  it('recordVerification stamps last_verified_at', async () => {
    const { store, agentId } = await freshStore()
    const connection = await store.connect({
      teamId: 'team_first',
      token: 'secret',
      tokenFingerprint: 'fp_1',
      connectedByAgentId: agentId,
    })
    expect(connection.lastVerifiedAt).toBeNull()

    await store.recordVerification(connection.id)
    const updated = await store.get(connection.id)
    expect(updated?.lastVerifiedAt).toBeInstanceOf(Date)
  })
})
