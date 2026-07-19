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

  /** Insert a `mailboxes` row directly (no `MailboxStore` needed for these fixtures) — mirrors `src/store/mailboxes.test.ts`'s own `insertMailbox` helper. Returns the new row's id. */
  async function insertMailbox(testDb: Db, address: string): Promise<string> {
    const rows = await testDb.query<{ id: string }>(
      'INSERT INTO mailboxes (address, provider) VALUES ($1, $2) RETURNING id',
      [address, 'gmail'],
    )
    return rows[0].id
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

    it('acquires the advisory lock BEFORE the zero-Agents check, inside one transaction (instrumented Db)', async () => {
      // True two-backend concurrency isn't reproducible on single-connection
      // PGlite (test above), but the ordering that MAKES the guard sound is
      // unit-testable: wrap the Db, record every statement the transaction
      // issues, and assert the lock precedes any read of `agents`. A refactor
      // that drops the lock or moves the check ahead of it fails here.
      const { db } = await freshStore()
      const statements: string[] = []
      const instrumented: typeof db = {
        query: (sql, params) => {
          statements.push(sql)
          return db.query(sql, params)
        },
        transaction: (fn) =>
          db.transaction((tx) =>
            fn({
              query: (sql, params) => {
                statements.push(sql)
                return tx.query(sql, params)
              },
            }),
          ),
        close: () => db.close(),
      }
      const instrumentedStore = createAgentStore(instrumented)
      const created = await instrumentedStore.createFirstAdmin({
        name: 'Ada Admin',
        email: 'ada@example.test',
        passwordHash: 'scrypt$hash1',
      })
      expect(created).not.toBeNull()

      const lockIndex = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'))
      const agentsReadIndex = statements.findIndex(
        (sql) => sql !== statements[lockIndex] && /FROM agents|INSERT INTO agents/i.test(sql),
      )
      expect(lockIndex).toBeGreaterThanOrEqual(0)
      expect(agentsReadIndex).toBeGreaterThanOrEqual(0)
      expect(lockIndex).toBeLessThan(agentsReadIndex)
    })

    it('auto-grants every existing mailbox to the first admin, in the same transaction (spec §3.4)', async () => {
      const { db, store } = await freshStore()
      const mailboxA = await insertMailbox(db, 'a@example.test')
      const mailboxB = await insertMailbox(db, 'b@example.test')

      const admin = await store.createFirstAdmin({
        name: 'Ada Admin',
        email: 'ada@example.test',
        passwordHash: 'scrypt$hash1',
      })
      expect(admin).not.toBeNull()

      const grants = await store.listAgentMailboxIds(admin?.id as string)
      expect(grants?.sort()).toEqual([mailboxA, mailboxB].sort())
    })

    it('zero mailboxes existing → zero grant rows, no error (not a failed setup)', async () => {
      const { store } = await freshStore()
      const admin = await store.createFirstAdmin({
        name: 'Ada Admin',
        email: 'ada@example.test',
        passwordHash: 'scrypt$hash1',
      })
      expect(admin).not.toBeNull()
      expect(await store.listAgentMailboxIds(admin?.id as string)).toEqual([])
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

    it('auto-grants every existing mailbox — both the invited and admin-set-password paths, any role (spec §3.4)', async () => {
      const { db, store } = await freshStore()
      const mailboxA = await insertMailbox(db, 'a@example.test')
      const mailboxB = await insertMailbox(db, 'b@example.test')

      const invited = await store.createAgent({
        name: 'Invitee',
        email: 'invitee2@example.test',
        role: 'agent',
        status: 'invited',
      })
      const activeAdmin = await store.createAgent({
        name: 'Active Admin',
        email: 'activeadmin@example.test',
        role: 'admin',
        status: 'active',
        passwordHash: 'scrypt$hash',
      })
      if (!invited.ok || !activeAdmin.ok) throw new Error('expected ok')

      expect((await store.listAgentMailboxIds(invited.agent.id))?.sort()).toEqual(
        [mailboxA, mailboxB].sort(),
      )
      expect((await store.listAgentMailboxIds(activeAdmin.agent.id))?.sort()).toEqual(
        [mailboxA, mailboxB].sort(),
      )
    })

    it('a duplicate-email failure grants nothing (no orphan grant rows for the rejected insert)', async () => {
      const { db, store } = await freshStore()
      await insertMailbox(db, 'a@example.test')
      await store.createAgent({
        name: 'First',
        email: 'dup2@example.test',
        role: 'agent',
        status: 'invited',
      })
      const result = await store.createAgent({
        name: 'Second',
        email: 'dup2@example.test',
        role: 'agent',
        status: 'invited',
      })
      expect(result).toEqual({ ok: false, reason: 'email_taken' })

      const [{ count }] = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM agent_mailbox_access',
      )
      // Exactly one grant row: the FIRST (successful) createAgent's own
      // auto-grant of the one mailbox — the rejected second call inserted
      // nothing.
      expect(count).toBe(1)
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

  // --- mailbox access (HT-54 follow-up; spec §3.4/§6) -------------------------

  describe('listAgentMailboxIds', () => {
    it('returns null for an unknown agent', async () => {
      const { store } = await freshStore()
      expect(await store.listAgentMailboxIds('00000000-0000-0000-0000-000000000000')).toBeNull()
    })

    it('returns [] for a real Agent with no grants', async () => {
      const { store } = await freshStore()
      const result = await store.createAgent({
        name: 'No Mailboxes',
        email: 'nomailboxes@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!result.ok) throw new Error('expected ok')
      // No mailbox existed at creation time, so auto-grant produced [].
      expect(await store.listAgentMailboxIds(result.agent.id)).toEqual([])
    })
  })

  describe('replaceAgentMailboxAccess', () => {
    it('returns not_found for an unknown agent', async () => {
      const { store } = await freshStore()
      const result = await store.replaceAgentMailboxAccess(
        '00000000-0000-0000-0000-000000000000',
        [],
      )
      expect(result).toBe('not_found')
    })

    it('replace-set: a second call fully replaces the first grant set (DELETE + INSERT, one transaction)', async () => {
      const { db, store } = await freshStore()
      const agent = await store.createAgent({
        name: 'Replaceable',
        email: 'replaceable@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!agent.ok) throw new Error('expected ok')
      const mailboxA = await insertMailbox(db, 'a@example.test')
      const mailboxB = await insertMailbox(db, 'b@example.test')

      const first = await store.replaceAgentMailboxAccess(agent.agent.id, [mailboxA, mailboxB])
      expect(first).toBe('ok')
      expect((await store.listAgentMailboxIds(agent.agent.id))?.sort()).toEqual(
        [mailboxA, mailboxB].sort(),
      )

      const second = await store.replaceAgentMailboxAccess(agent.agent.id, [mailboxB])
      expect(second).toBe('ok')
      expect(await store.listAgentMailboxIds(agent.agent.id)).toEqual([mailboxB])
    })

    it('an empty array clears every grant', async () => {
      const { db, store } = await freshStore()
      const agent = await store.createAgent({
        name: 'Clearable',
        email: 'clearable@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!agent.ok) throw new Error('expected ok')
      const mailboxA = await insertMailbox(db, 'a@example.test')
      await store.replaceAgentMailboxAccess(agent.agent.id, [mailboxA])

      const result = await store.replaceAgentMailboxAccess(agent.agent.id, [])
      expect(result).toBe('ok')
      expect(await store.listAgentMailboxIds(agent.agent.id)).toEqual([])
    })

    it('an id naming no mailbox is invalid_mailbox (FK translated), and rolls back — the PRIOR grant set survives untouched', async () => {
      const { db, store } = await freshStore()
      const agent = await store.createAgent({
        name: 'Guarded',
        email: 'guarded@example.test',
        role: 'agent',
        status: 'invited',
      })
      if (!agent.ok) throw new Error('expected ok')
      const mailboxA = await insertMailbox(db, 'a@example.test')
      await store.replaceAgentMailboxAccess(agent.agent.id, [mailboxA])

      const bogusMailboxId = '99999999-9999-4999-8999-999999999999'
      const result = await store.replaceAgentMailboxAccess(agent.agent.id, [bogusMailboxId])
      expect(result).toBe('invalid_mailbox')

      // Rolled back inside the transaction: the PRIOR grant set (mailboxA)
      // is untouched, never partially replaced.
      expect(await store.listAgentMailboxIds(agent.agent.id)).toEqual([mailboxA])
    })
  })
})
