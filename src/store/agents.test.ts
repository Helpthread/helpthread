import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { type AgentStore, createAgentStore } from './agents.js'

describe('AgentStore', () => {
  let db: Db | undefined
  let store: AgentStore | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
    store = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: AgentStore }> {
    db = await createPgliteDb()
    await migrate(db)
    store = createAgentStore(db)
    return { db, store }
  }

  // --- createFirstAdmin -------------------------------------------------------

  describe('createFirstAdmin', () => {
    it('creates the first admin, active, with a password identity', async () => {
      const { store } = await freshStore()
      const agent = await store.createFirstAdmin({
        name: 'Ada Admin',
        email: 'Ada@Example.test',
        passwordHash: 'scrypt$hash1',
      })
      expect(agent).not.toBeNull()
      expect(agent?.role).toBe('admin')
      expect(agent?.status).toBe('active')
      // Email normalized to lowercase on insert.
      expect(agent?.email).toBe('ada@example.test')

      const identity = await store.getPasswordIdentity(agent?.id as string)
      expect(identity).toEqual({ agentId: agent?.id, secretHash: 'scrypt$hash1' })
    })

    it('returns null when Agents already exist — the /setup 409 case', async () => {
      const { store } = await freshStore()
      const first = await store.createFirstAdmin({
        name: 'Ada Admin',
        email: 'ada@example.test',
        passwordHash: 'scrypt$hash1',
      })
      expect(first).not.toBeNull()

      const second = await store.createFirstAdmin({
        name: 'Bea Admin',
        email: 'bea@example.test',
        passwordHash: 'scrypt$hash2',
      })
      expect(second).toBeNull()

      // Only the first admin exists — the guard predicate (WHERE NOT
      // EXISTS-equivalent) actually prevented a second insert, not just
      // reported a decoy failure.
      const all = await store.listAgents()
      expect(all).toHaveLength(1)
      expect(all[0].email).toBe('ada@example.test')
    })

    it("the guard runs under an advisory lock distinct from migrate.ts's own lock key (issues real lock SQL; true concurrency isn't reproducible against single-connection PGlite)", async () => {
      // PGlite is a single, in-process connection — two genuinely concurrent
      // transactions can't race each other here the way two Postgres backends
      // could (see src/db/migrate.ts's own module doc making the identical
      // point about its cross-process lock). What IS verified here: the lock
      // statement is actually issued (a raw SELECT pg_advisory_xact_lock call
      // succeeds against a real Postgres, proving the SQL is valid and takes
      // the bigint overload), and the zero-Agents predicate genuinely holds
      // (asserted by the two tests above). Real concurrent-createFirstAdmin
      // coverage waits for a Supabase-backed Db, exactly as migrate.test.ts
      // documents for its own advisory lock.
      const { db } = await freshStore()
      await expect(
        db.query('SELECT pg_advisory_xact_lock($1::bigint)', [7_331_009_881]),
      ).resolves.toBeDefined()
    })
  })

  // --- createAgent -------------------------------------------------------------

  describe('createAgent', () => {
    it('creates an invited Agent with no password identity', async () => {
      const { store } = await freshStore()
      const result = await store.createAgent({
        name: 'Invitee',
        email: 'invitee@example.test',
        role: 'agent',
        status: 'invited',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected ok')
      expect(result.agent.status).toBe('invited')
      const identity = await store.getPasswordIdentity(result.agent.id)
      expect(identity).toBeNull()
    })

    it('creates an active Agent with a password identity when passwordHash is given', async () => {
      const { store } = await freshStore()
      const result = await store.createAgent({
        name: 'Active One',
        email: 'active@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$hash',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected ok')
      const identity = await store.getPasswordIdentity(result.agent.id)
      expect(identity?.secretHash).toBe('scrypt$hash')
    })

    it('returns email_taken on a duplicate email (case-insensitive), without throwing', async () => {
      const { store } = await freshStore()
      await store.createAgent({
        name: 'First',
        email: 'dup@example.test',
        role: 'agent',
        status: 'invited',
      })
      const result = await store.createAgent({
        name: 'Second',
        email: 'Dup@Example.test',
        role: 'agent',
        status: 'invited',
      })
      expect(result).toEqual({ ok: false, reason: 'email_taken' })
    })
  })

  // --- getAgent / getAgentByEmail / listAgents --------------------------------

  describe('getAgent / getAgentByEmail / listAgents', () => {
    it('getAgent returns null for a missing id', async () => {
      const { store } = await freshStore()
      expect(await store.getAgent('00000000-0000-0000-0000-000000000000')).toBeNull()
    })

    it('getAgentByEmail is case-insensitive', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Casey',
        email: 'casey@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!created.ok) throw new Error('expected ok')
      const found = await store.getAgentByEmail('CASEY@EXAMPLE.TEST')
      expect(found?.id).toBe(created.agent.id)
    })

    it('listAgents orders by name', async () => {
      const { store } = await freshStore()
      await store.createAgent({
        name: 'Zoe',
        email: 'zoe@example.test',
        role: 'agent',
        status: 'invited',
      })
      await store.createAgent({
        name: 'Amir',
        email: 'amir@example.test',
        role: 'agent',
        status: 'invited',
      })
      const all = await store.listAgents()
      expect(all.map((a) => a.name)).toEqual(['Amir', 'Zoe'])
    })
  })

  // --- updateAgent -------------------------------------------------------------

  describe('updateAgent', () => {
    it('updates name/timezone with no role/status change — no admin-count guard involved', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Original',
        email: 'a@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!created.ok) throw new Error('expected ok')

      const result = await store.updateAgent(created.agent.id, {
        name: 'Renamed',
        timezone: 'America/New_York',
      })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected ok')
      expect(result.agent.name).toBe('Renamed')
      expect(result.agent.timezone).toBe('America/New_York')
      expect(result.agent.status).toBe('invited') // untouched
    })

    it('returns not_found for a missing id', async () => {
      const { store } = await freshStore()
      const result = await store.updateAgent('00000000-0000-0000-0000-000000000000', {
        name: 'x',
      })
      expect(result).toEqual({ ok: false, reason: 'not_found' })
    })

    it('a no-op patch (no fields at all) returns the current record unchanged', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Same',
        email: 'same@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!created.ok) throw new Error('expected ok')
      const result = await store.updateAgent(created.agent.id, {})
      expect(result).toEqual({ ok: true, agent: created.agent })
    })

    it('demoting the ONLY active admin (role admin -> agent) is refused: last_admin', async () => {
      const { store } = await freshStore()
      const admin = await store.createFirstAdmin({
        name: 'Solo Admin',
        email: 'solo@example.test',
        passwordHash: 'scrypt$hash',
      })
      if (admin === null) throw new Error('expected an admin')

      const result = await store.updateAgent(admin.id, { role: 'agent' })
      expect(result).toEqual({ ok: false, reason: 'last_admin' })

      const stillAdmin = await store.getAgent(admin.id)
      expect(stillAdmin?.role).toBe('admin')
    })

    it('disabling the ONLY active admin (status active -> disabled) is refused: last_admin', async () => {
      const { store } = await freshStore()
      const admin = await store.createFirstAdmin({
        name: 'Solo Admin',
        email: 'solo@example.test',
        passwordHash: 'scrypt$hash',
      })
      if (admin === null) throw new Error('expected an admin')

      const result = await store.updateAgent(admin.id, { status: 'disabled' })
      expect(result).toEqual({ ok: false, reason: 'last_admin' })
    })

    it('demoting ONE of TWO active admins succeeds', async () => {
      const { store } = await freshStore()
      const admin1 = await store.createFirstAdmin({
        name: 'Admin One',
        email: 'admin1@example.test',
        passwordHash: 'scrypt$hash',
      })
      if (admin1 === null) throw new Error('expected an admin')
      const created2 = await store.createAgent({
        name: 'Admin Two',
        email: 'admin2@example.test',
        role: 'admin',
        status: 'active',
        passwordHash: 'scrypt$hash2',
      })
      if (!created2.ok) throw new Error('expected ok')

      const result = await store.updateAgent(admin1.id, { role: 'agent' })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected ok')
      expect(result.agent.role).toBe('agent')
    })

    it('a DISABLED admin does not count toward the active-admin invariant — demoting the sole remaining ACTIVE admin is still refused even if a disabled admin also exists', async () => {
      const { store } = await freshStore()
      const activeAdmin = await store.createFirstAdmin({
        name: 'Active Admin',
        email: 'active-admin@example.test',
        passwordHash: 'scrypt$hash',
      })
      if (activeAdmin === null) throw new Error('expected an admin')
      const disabledAdminCreated = await store.createAgent({
        name: 'Disabled Admin',
        email: 'disabled-admin@example.test',
        role: 'admin',
        status: 'active',
        passwordHash: 'scrypt$hash2',
      })
      if (!disabledAdminCreated.ok) throw new Error('expected ok')
      await store.updateAgent(disabledAdminCreated.agent.id, { status: 'disabled' })

      const result = await store.updateAgent(activeAdmin.id, { role: 'agent' })
      expect(result).toEqual({ ok: false, reason: 'last_admin' })
    })

    it('promoting an agent to admin never triggers the guard', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Promotable',
        email: 'promotable@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$hash',
      })
      if (!created.ok) throw new Error('expected ok')
      const result = await store.updateAgent(created.agent.id, { role: 'admin' })
      expect(result.ok).toBe(true)
    })
  })

  // --- deleteAgent -------------------------------------------------------------

  describe('deleteAgent', () => {
    it('returns not_found for a missing id', async () => {
      const { store } = await freshStore()
      const result = await store.deleteAgent('00000000-0000-0000-0000-000000000000')
      expect(result).toEqual({ ok: false, reason: 'not_found' })
    })

    it('deleting the ONLY active admin is refused: last_admin', async () => {
      const { store } = await freshStore()
      const admin = await store.createFirstAdmin({
        name: 'Solo Admin',
        email: 'solo@example.test',
        passwordHash: 'scrypt$hash',
      })
      if (admin === null) throw new Error('expected an admin')
      const result = await store.deleteAgent(admin.id)
      expect(result).toEqual({ ok: false, reason: 'last_admin' })
    })

    it('deleting one of two active admins succeeds', async () => {
      const { store } = await freshStore()
      const admin1 = await store.createFirstAdmin({
        name: 'Admin One',
        email: 'admin1@example.test',
        passwordHash: 'scrypt$hash',
      })
      if (admin1 === null) throw new Error('expected an admin')
      const created2 = await store.createAgent({
        name: 'Admin Two',
        email: 'admin2@example.test',
        role: 'admin',
        status: 'active',
        passwordHash: 'scrypt$hash2',
      })
      if (!created2.ok) throw new Error('expected ok')

      const result = await store.deleteAgent(admin1.id)
      expect(result).toEqual({ ok: true })
      expect(await store.getAgent(admin1.id)).toBeNull()
    })

    it('deleting a non-admin never triggers the guard', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Plain Agent',
        email: 'plain@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$hash',
      })
      if (!created.ok) throw new Error('expected ok')
      const result = await store.deleteAgent(created.agent.id)
      expect(result).toEqual({ ok: true })
    })

    it('cascades password identities', async () => {
      const { db, store } = await freshStore()
      const created = await store.createAgent({
        name: 'Has Identity',
        email: 'has-identity@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$hash',
      })
      if (!created.ok) throw new Error('expected ok')

      await store.deleteAgent(created.agent.id)

      const remaining = await db.query('SELECT id FROM agent_auth_identities WHERE agent_id = $1', [
        created.agent.id,
      ])
      expect(remaining).toEqual([])
    })

    it('un-assigns (does not delete) conversations the deleted Agent was assigned to', async () => {
      const { db, store } = await freshStore()
      const created = await store.createAgent({
        name: 'Assignee',
        email: 'assignee@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$hash',
      })
      if (!created.ok) throw new Error('expected ok')

      const [conversation] = await db.query<{ id: string }>(
        'INSERT INTO conversations (customer_email, assignee_agent_id) VALUES ($1, $2) RETURNING id',
        ['customer@example.test', created.agent.id],
      )

      await store.deleteAgent(created.agent.id)

      const [row] = await db.query<{ assignee_agent_id: string | null }>(
        'SELECT assignee_agent_id FROM conversations WHERE id = $1',
        [conversation.id],
      )
      expect(row.assignee_agent_id).toBeNull()
    })
  })

  // --- setPassword / getPasswordIdentity(ByEmail) -----------------------------

  describe('setPassword / getPasswordIdentity / getPasswordIdentityByEmail', () => {
    it('sets a password identity for an Agent with none yet', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'No Password Yet',
        email: 'nopass@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!created.ok) throw new Error('expected ok')

      await store.setPassword(created.agent.id, 'scrypt$new-hash')
      const identity = await store.getPasswordIdentity(created.agent.id)
      expect(identity).toEqual({ agentId: created.agent.id, secretHash: 'scrypt$new-hash' })
    })

    it('replaces an existing password identity (honors the one-password-per-agent partial unique index)', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Has Password',
        email: 'haspass@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$original',
      })
      if (!created.ok) throw new Error('expected ok')

      await store.setPassword(created.agent.id, 'scrypt$replacement')
      const identity = await store.getPasswordIdentity(created.agent.id)
      expect(identity?.secretHash).toBe('scrypt$replacement')
    })

    it('throws for a nonexistent agentId', async () => {
      const { store } = await freshStore()
      await expect(
        store.setPassword('00000000-0000-0000-0000-000000000000', 'scrypt$hash'),
      ).rejects.toThrow()
    })

    it('getPasswordIdentityByEmail joins through agents, case-insensitively', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Email Lookup',
        email: 'lookup@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$hash',
      })
      if (!created.ok) throw new Error('expected ok')

      const identity = await store.getPasswordIdentityByEmail('LOOKUP@example.test')
      expect(identity).toEqual({ agentId: created.agent.id, secretHash: 'scrypt$hash' })
    })

    it('getPasswordIdentityByEmail returns null for an unknown email', async () => {
      const { store } = await freshStore()
      expect(await store.getPasswordIdentityByEmail('nobody@example.test')).toBeNull()
    })
  })

  // --- acceptInvite --------------------------------------------------------------

  describe('acceptInvite', () => {
    it('flips invited -> active and sets the password, atomically', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Invitee',
        email: 'invitee@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!created.ok) throw new Error('expected ok')

      const agent = await store.acceptInvite(created.agent.id, 'scrypt$new-password')
      expect(agent?.status).toBe('active')
      const identity = await store.getPasswordIdentity(created.agent.id)
      expect(identity?.secretHash).toBe('scrypt$new-password')
    })

    it('is one-time: a second accept affects zero rows and returns null', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Invitee',
        email: 'invitee2@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!created.ok) throw new Error('expected ok')

      const first = await store.acceptInvite(created.agent.id, 'scrypt$first')
      expect(first).not.toBeNull()

      const second = await store.acceptInvite(created.agent.id, 'scrypt$second')
      expect(second).toBeNull()

      // The FIRST password is what survived — the replay never overwrote it.
      const identity = await store.getPasswordIdentity(created.agent.id)
      expect(identity?.secretHash).toBe('scrypt$first')
    })

    it('returns null for a nonexistent Agent', async () => {
      const { store } = await freshStore()
      const result = await store.acceptInvite('00000000-0000-0000-0000-000000000000', 'scrypt$hash')
      expect(result).toBeNull()
    })

    it('returns null for an already-active Agent (not invited)', async () => {
      const { store } = await freshStore()
      const created = await store.createAgent({
        name: 'Already Active',
        email: 'already-active@example.test',
        role: 'agent',
        status: 'active',
        passwordHash: 'scrypt$original',
      })
      if (!created.ok) throw new Error('expected ok')

      const result = await store.acceptInvite(created.agent.id, 'scrypt$hijack')
      expect(result).toBeNull()
      const identity = await store.getPasswordIdentity(created.agent.id)
      expect(identity?.secretHash).toBe('scrypt$original')
    })
  })

  // --- countAgents ---------------------------------------------------------------

  describe('countAgents', () => {
    it('is 0 on a fresh database', async () => {
      const { store } = await freshStore()
      expect(await store.countAgents()).toBe(0)
    })

    it('counts every Agent regardless of status', async () => {
      const { store } = await freshStore()
      await store.createFirstAdmin({
        name: 'Admin',
        email: 'admin@example.test',
        passwordHash: 'scrypt$hash',
      })
      await store.createAgent({
        name: 'Invited',
        email: 'invited@example.test',
        role: 'agent',
        status: 'invited',
      })
      expect(await store.countAgents()).toBe(2)
    })
  })
})
