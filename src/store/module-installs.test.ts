import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createModuleInstallStore, type ModuleInstallStore } from './module-installs.js'
import { createVercelConnectionStore } from './vercel-connection.js'

/** Insert an `agents` row directly. */
async function insertAgent(db: Db, email = 'admin@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO agents (email, name, role, status) VALUES ($1, 'Admin', 'admin', 'active') RETURNING id`,
    [email],
  )
  return rows[0].id
}

/** Insert a `vercel_connections` row directly — `vercel_connection_id` FKs to it. */
async function insertConnection(db: Db, agentId: string): Promise<string> {
  const store = createVercelConnectionStore(db, randomBytes(32))
  const connection = await store.connect({
    teamId: 'team_abc123',
    token: 'secret',
    tokenFingerprint: 'fp_1',
    connectedByAgentId: agentId,
  })
  return connection.id
}

describe('ModuleInstallStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{
    db: Db
    store: ModuleInstallStore
    agentId: string
    connectionId: string
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const agentId = await insertAgent(db)
    const connectionId = await insertConnection(db, agentId)
    return { db, store: createModuleInstallStore(db), agentId, connectionId }
  }

  function newInstallInput(connectionId: string, idempotencyKey = randomUUID()) {
    return {
      idempotencyKey,
      moduleSlug: 'qa-scoring',
      entitlementId: 'ent_123',
      domain: 'support.example.com',
      vercelConnectionId: connectionId,
      desiredReleaseVersion: '1.2.0',
      artifactDigest: 'sha256:deadbeef',
      manifestKeyId: 'key_1',
    }
  }

  it('create inserts a planned install with a fresh lease token', async () => {
    const { store, connectionId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))

    expect(install.state).toBe('planned')
    expect(install.attempt).toBe(0)
    expect(install.configGeneration).toBe(1)
    expect(install.remoteProjectId).toBeNull()
    expect(install.remoteDeploymentId).toBeNull()
    expect(install.environment).toBe('production')
    expect(install.leaseToken).toBeTruthy()
  })

  it('create is idempotent — the same idempotencyKey returns the same row twice', async () => {
    const { store, connectionId } = await freshStore()
    const input = newInstallInput(connectionId)

    const first = await store.create(input)
    const second = await store.create(input)

    expect(second.id).toBe(first.id)
    expect(second.leaseToken).toBe(first.leaseToken)
  })

  it('the happy transition path advances state and re-mints the lease token', async () => {
    const { store, connectionId, agentId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))

    const result = await store.transition(
      install.id,
      'planned',
      'credentials_issued',
      install.leaseToken,
      { actorAgentId: agentId, detail: { note: 'issued step-up token' } },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.install.state).toBe('credentials_issued')
    expect(result.install.leaseToken).not.toBe(install.leaseToken)
  })

  it('a stale-fence transition is refused', async () => {
    const { store, connectionId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))

    // Advance once for real, invalidating the original lease token.
    const first = await store.transition(
      install.id,
      'planned',
      'credentials_issued',
      install.leaseToken,
    )
    expect(first.ok).toBe(true)

    // Retry with the now-stale original fence token.
    const stale = await store.transition(
      install.id,
      'credentials_issued',
      'project_created',
      install.leaseToken,
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) throw new Error('expected refusal')
    expect(stale.error.reason).toBe('lease_stale')
    expect(stale.error.actual?.state).toBe('credentials_issued')

    // The row was not moved by the refused attempt.
    const current = await store.get(install.id)
    expect(current?.state).toBe('credentials_issued')
  })

  it('a from-state mismatch is refused', async () => {
    const { store, connectionId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))

    const result = await store.transition(
      install.id,
      'project_created', // wrong — the row is still 'planned'
      'artifact_uploaded',
      install.leaseToken,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error.reason).toBe('state_mismatch')
    expect(result.error.actual?.state).toBe('planned')

    const current = await store.get(install.id)
    expect(current?.state).toBe('planned')
  })

  it('a transition against a nonexistent install is refused as not_found', async () => {
    const { store } = await freshStore()
    const result = await store.transition(
      randomUUID(),
      'planned',
      'credentials_issued',
      randomUUID(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.error.reason).toBe('not_found')
    expect(result.error.actual).toBeNull()
  })

  it('events accumulate append-only — one per create plus one per transition', async () => {
    const { store, connectionId, agentId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId), agentId)

    const afterCreate = await store.listEvents(install.id)
    expect(afterCreate).toHaveLength(1)
    expect(afterCreate[0].fromState).toBeNull()
    expect(afterCreate[0].toState).toBe('planned')
    expect(afterCreate[0].actorAgentId).toBe(agentId)

    const t1 = await store.transition(
      install.id,
      'planned',
      'credentials_issued',
      install.leaseToken,
    )
    if (!t1.ok) throw new Error('expected ok')
    const t2 = await store.transition(
      install.id,
      'credentials_issued',
      'project_created',
      t1.install.leaseToken,
    )
    if (!t2.ok) throw new Error('expected ok')

    const events = await store.listEvents(install.id)
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.toState)).toEqual([
      'planned',
      'credentials_issued',
      'project_created',
    ])
    expect(events.map((e) => e.fromState)).toEqual([null, 'planned', 'credentials_issued'])

    // A refused transition never adds an event.
    const refused = await store.transition(
      install.id,
      'planned', // stale — row is already 'project_created'
      'artifact_uploaded',
      install.leaseToken,
    )
    expect(refused.ok).toBe(false)
    expect(await store.listEvents(install.id)).toHaveLength(3)
  })

  it('transition can persist remoteProjectId/remoteDeploymentId on the row, in the SAME fenced write', async () => {
    const { store, connectionId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))

    const t1 = await store.transition(
      install.id,
      'planned',
      'credentials_issued',
      install.leaseToken,
    )
    if (!t1.ok) throw new Error('expected ok')
    const t2 = await store.transition(
      install.id,
      'credentials_issued',
      'project_created',
      t1.install.leaseToken,
      { remoteProjectId: 'proj_123' },
    )
    if (!t2.ok) throw new Error('expected ok')
    expect(t2.install.remoteProjectId).toBe('proj_123')

    // Queryable directly from the row, not just from the event's `detail`.
    const current = await store.get(install.id)
    expect(current?.remoteProjectId).toBe('proj_123')
  })

  it('claim succeeds on a fresh install, mints a fresh lease, sets lease_expires_at, and bumps attempt', async () => {
    const { store, connectionId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))
    expect(install.leaseExpiresAt).toBeNull()
    expect(install.attempt).toBe(0)

    const claimed = await store.claim(install.id, 300)
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) throw new Error('expected ok')
    expect(claimed.install.leaseToken).not.toBe(install.leaseToken)
    expect(claimed.install.leaseExpiresAt).not.toBeNull()
    expect(claimed.install.attempt).toBe(1)
  })

  it('claim refuses a second call while the first claim still holds a live lease', async () => {
    const { store, connectionId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))

    const first = await store.claim(install.id, 300)
    expect(first.ok).toBe(true)

    const second = await store.claim(install.id, 300)
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('expected refusal')
    expect(second.reason).toBe('lease_held')

    // The refused claim did not touch the row at all.
    const current = await store.get(install.id)
    if (!first.ok) throw new Error('expected ok')
    expect(current?.leaseToken).toBe(first.install.leaseToken)
  })

  it('claim against a nonexistent install is refused as not_found', async () => {
    const { store } = await freshStore()
    const result = await store.claim(randomUUID(), 300)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected refusal')
    expect(result.reason).toBe('not_found')
  })

  it('claim succeeds again once a lapsed lease is in the past — the TTL is a crash backstop, not permanent', async () => {
    const { store, db: rawDb, connectionId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))

    const first = await store.claim(install.id, 300)
    expect(first.ok).toBe(true)

    // Simulate the lease having lapsed (a crashed worker that never
    // released) by backdating it directly.
    await rawDb.query(
      "UPDATE module_installs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [install.id],
    )

    const second = await store.claim(install.id, 300)
    expect(second.ok).toBe(true)
  })

  it('release clears the lease so an immediate reclaim succeeds, but only when fenced on the current lease token', async () => {
    const { store, connectionId } = await freshStore()
    const install = await store.create(newInstallInput(connectionId))

    const claimed = await store.claim(install.id, 300)
    expect(claimed.ok).toBe(true)
    if (!claimed.ok) throw new Error('expected ok')

    // A stale fenceToken must not release the CURRENT lease.
    await store.release(install.id, install.leaseToken)
    const stillHeld = await store.claim(install.id, 300)
    expect(stillHeld.ok).toBe(false)

    // The correct fenceToken releases it.
    await store.release(install.id, claimed.install.leaseToken)
    const reclaimed = await store.claim(install.id, 300)
    expect(reclaimed.ok).toBe(true)
  })

  it('module_installs.vercel_connection_id enforces the FK to vercel_connections', async () => {
    const { db: rawDb, agentId } = await freshStore()
    await expect(
      rawDb.query(
        `INSERT INTO module_installs (
           idempotency_key, module_slug, entitlement_id, domain,
           vercel_connection_id, desired_release_version, artifact_digest, manifest_key_id
         ) VALUES ($1, 'qa-scoring', 'ent_1', 'example.com', $2, '1.0.0', 'sha256:x', 'key_1')`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow()
    // agentId only referenced to keep the freshStore() destructure honest
    // about what it provides; no assertion needed on it here.
    expect(agentId).toBeTruthy()
  })
})
