import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { AgentStore } from './agents.js'
import { createAgentStore } from './agents.js'
import { createWebAuthnStore, type WebAuthnStore } from './webauthn.js'

describe('WebAuthnStore', () => {
  let db: Db | undefined
  let store: WebAuthnStore | undefined
  let agentStore: AgentStore | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
    store = undefined
    agentStore = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: WebAuthnStore; agentStore: AgentStore }> {
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

  const CREDENTIAL_1 = {
    credentialId: 'cred-1',
    publicKey: new Uint8Array([1, 2, 3, 4]),
    signCount: 0,
    transports: ['internal'],
    backupEligible: true,
    backupState: false,
    name: 'MacBook Touch ID',
  }

  // --- insertCredential / lookups --------------------------------------------

  describe('insertCredential / getCredentialByCredentialId / getCredentialById', () => {
    it('inserts and reads a credential back with every field intact', async () => {
      const { store, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')

      const result = await store.insertCredential({ agentId, ...CREDENTIAL_1 })
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected ok')
      expect(result.credential.agentId).toBe(agentId)
      expect(result.credential.credentialId).toBe('cred-1')
      expect(Array.from(result.credential.publicKey)).toEqual([1, 2, 3, 4])
      expect(result.credential.signCount).toBe(0)
      expect(result.credential.transports).toEqual(['internal'])
      expect(result.credential.backupEligible).toBe(true)
      expect(result.credential.backupState).toBe(false)
      expect(result.credential.signCountRegressionAt).toBeNull()
      expect(result.credential.lastUsedAt).toBeNull()

      const byCredentialId = await store.getCredentialByCredentialId('cred-1')
      expect(byCredentialId?.id).toBe(result.credential.id)

      const byId = await store.getCredentialById(result.credential.id)
      expect(byId?.credentialId).toBe('cred-1')
    })

    it('returns null for an unknown credential_id / id', async () => {
      const { store } = await freshStore()
      expect(await store.getCredentialByCredentialId('nope')).toBeNull()
      expect(await store.getCredentialById('00000000-0000-4000-8000-000000000000')).toBeNull()
    })

    it("'credential_taken' on a duplicate credential_id — even across different Agents (spec §6.1: the UNIQUE index enforces it either way)", async () => {
      const { store, agentStore } = await freshStore()
      const agent1 = await makeAgent(agentStore, 'a1@example.test')
      const agent2 = await makeAgent(agentStore, 'a2@example.test')

      const first = await store.insertCredential({ agentId: agent1, ...CREDENTIAL_1 })
      expect(first.ok).toBe(true)

      const second = await store.insertCredential({ agentId: agent2, ...CREDENTIAL_1 })
      expect(second).toEqual({ ok: false, reason: 'credential_taken' })
    })
  })

  // --- FOR UPDATE / counter persistence ---------------------------------------

  describe('getCredentialForUpdateInTx / updateAfterSuccessfulAuth / markCounterRegression', () => {
    it('reads and updates the counter inside a transaction', async () => {
      const { db: testDb, store, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')
      const inserted = await store.insertCredential({ agentId, ...CREDENTIAL_1 })
      if (!inserted.ok) throw new Error('expected ok')

      await testDb.transaction(async (tx) => {
        const locked = await store.getCredentialForUpdateInTx('cred-1', tx)
        expect(locked?.signCount).toBe(0)
        await store.updateAfterSuccessfulAuth(
          inserted.credential.id,
          { signCount: 5, backupState: true },
          tx,
        )
      })

      const after = await store.getCredentialByCredentialId('cred-1')
      expect(after?.signCount).toBe(5)
      expect(after?.backupState).toBe(true)
      expect(after?.lastUsedAt).not.toBeNull()
    })

    it('marks a counter regression, and the marker survives the transaction committing', async () => {
      const { db: testDb, store, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')
      const inserted = await store.insertCredential({ agentId, ...CREDENTIAL_1 })
      if (!inserted.ok) throw new Error('expected ok')

      await testDb.transaction(async (tx) => {
        await store.markCounterRegression(inserted.credential.id, tx)
      })

      const after = await store.getCredentialByCredentialId('cred-1')
      expect(after?.signCountRegressionAt).not.toBeNull()
    })
  })

  // --- listCredentialsForAgent / renameCredential / deleteCredential --------

  describe('listCredentialsForAgent / renameCredential', () => {
    it('lists only the given Agent’s credentials', async () => {
      const { store, agentStore } = await freshStore()
      const agent1 = await makeAgent(agentStore, 'a1@example.test')
      const agent2 = await makeAgent(agentStore, 'a2@example.test')
      await store.insertCredential({ agentId: agent1, ...CREDENTIAL_1, credentialId: 'c1' })
      await store.insertCredential({ agentId: agent2, ...CREDENTIAL_1, credentialId: 'c2' })

      const list = await store.listCredentialsForAgent(agent1)
      expect(list).toHaveLength(1)
      expect(list[0].credentialId).toBe('c1')
    })

    it('renames a credential scoped to its owning Agent; null if the id belongs to someone else', async () => {
      const { store, agentStore } = await freshStore()
      const agent1 = await makeAgent(agentStore, 'a1@example.test')
      const agent2 = await makeAgent(agentStore, 'a2@example.test')
      const inserted = await store.insertCredential({ agentId: agent1, ...CREDENTIAL_1 })
      if (!inserted.ok) throw new Error('expected ok')

      const renamed = await store.renameCredential(inserted.credential.id, agent1, 'New name')
      expect(renamed?.name).toBe('New name')

      const wrongOwner = await store.renameCredential(inserted.credential.id, agent2, 'Nope')
      expect(wrongOwner).toBeNull()
    })
  })

  describe('deleteCredential — the last-credential guard (spec §9.1)', () => {
    it('deletes a credential when the Agent still has a password identity', async () => {
      const { store, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test') // createAgent gives a password identity
      const inserted = await store.insertCredential({ agentId, ...CREDENTIAL_1 })
      if (!inserted.ok) throw new Error('expected ok')

      const result = await store.deleteCredential(inserted.credential.id, agentId)
      expect(result).toBe('ok')
      expect(await store.getCredentialById(inserted.credential.id)).toBeNull()
    })

    it('deletes a credential when the Agent has another credential (even without a password identity)', async () => {
      const { db: testDb, store, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')
      // Strip the password identity to force the "no password" branch.
      await testDb.query('DELETE FROM agent_auth_identities WHERE agent_id = $1', [agentId])
      const first = await store.insertCredential({ agentId, ...CREDENTIAL_1, credentialId: 'c1' })
      const second = await store.insertCredential({ agentId, ...CREDENTIAL_1, credentialId: 'c2' })
      if (!first.ok || !second.ok) throw new Error('expected ok')

      const result = await store.deleteCredential(first.credential.id, agentId)
      expect(result).toBe('ok')
    })

    it("refuses ('last_credential') to delete the Agent's only credential once they have no password identity", async () => {
      const { db: testDb, store, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')
      await testDb.query('DELETE FROM agent_auth_identities WHERE agent_id = $1', [agentId])
      const inserted = await store.insertCredential({ agentId, ...CREDENTIAL_1 })
      if (!inserted.ok) throw new Error('expected ok')

      const result = await store.deleteCredential(inserted.credential.id, agentId)
      expect(result).toBe('last_credential')
      // The row must still exist — refused, not partially deleted.
      expect(await store.getCredentialById(inserted.credential.id)).not.toBeNull()
    })

    it("'not_found' for an id that doesn't belong to this Agent", async () => {
      const { store, agentStore } = await freshStore()
      const agent1 = await makeAgent(agentStore, 'a1@example.test')
      const agent2 = await makeAgent(agentStore, 'a2@example.test')
      const inserted = await store.insertCredential({ agentId: agent1, ...CREDENTIAL_1 })
      if (!inserted.ok) throw new Error('expected ok')

      expect(await store.deleteCredential(inserted.credential.id, agent2)).toBe('not_found')
    })

    // --- The account-lockout TOCTOU (CodeRabbit, PR #94) ---------------------
    //
    // Bug: the original `FOR UPDATE` scoped only to the TARGET row
    // (`id = $1 AND agent_id = $2`); the "does this Agent have another
    // credential" count was a separate, UNLOCKED read. Two concurrent
    // `deleteCredential` calls for DIFFERENT credentials of the same
    // passwordless Agent could each see the other's row as still present,
    // both pass `otherCount === 0` as false, and both commit — leaving the
    // Agent with zero credentials and no password: locked out.
    //
    // Fix: lock EVERY credential row for the Agent (`WHERE agent_id = $1
    // FOR UPDATE`) before computing the guard, so a second, real concurrent
    // Postgres transaction targeting the SAME Agent blocks on this SELECT
    // until the first commits, then re-reads the Agent's CURRENT row set —
    // never a stale one.
    //
    // What CANNOT be proven here: a literal `Promise.all` of two
    // `deleteCredential()` calls does NOT reproduce genuine interleaving
    // against PGlite — verified empirically (a `SELECT ... FOR UPDATE`
    // inside one `db.transaction()` held open while a second
    // `db.transaction()` is kicked off: the second call's callback does not
    // even START running until the first's `db.transaction()` call has
    // fully COMMITTED). PGlite is a single, in-process connection that
    // serializes whole transactions, not just individual row locks — the
    // exact same limitation `src/store/agents.test.ts` already documents
    // for `createFirstAdmin`'s advisory-lock guard ("true concurrency isn't
    // reproducible against single-connection PGlite... waits for a
    // Supabase-backed Db"). A naive concurrent-call test would pass
    // identically against the OLD, buggy code too (PGlite's own
    // serialization already prevents interleaving, independent of this
    // fix), so it would prove nothing about THIS bug specifically.
    //
    // What IS proven instead, matching that same file's own precedent for
    // this exact limitation: (1) an instrumented `Db` asserting the lock
    // SQL actually targets the Agent's WHOLE credential set, not just the
    // target row — the structural fact a real concurrent Postgres session
    // relies on to serialize two deletes on the SAME lock; and (2) that the
    // guard's arithmetic, now computed from that locked row set rather than
    // a separate count query, is correct.
    it('the row lock targets EVERY credential for the Agent, not just the one being deleted (instrumented Db)', async () => {
      const { db: testDb, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')
      await testDb.query('DELETE FROM agent_auth_identities WHERE agent_id = $1', [agentId])
      const first = await createWebAuthnStore(testDb).insertCredential({
        agentId,
        ...CREDENTIAL_1,
        credentialId: 'c1',
      })
      if (!first.ok) throw new Error('expected ok')

      const statements: { sql: string; params: unknown[] }[] = []
      const instrumented: Db = {
        query: (sql, params = []) => {
          statements.push({ sql, params })
          return testDb.query(sql, params)
        },
        transaction: (fn) =>
          testDb.transaction((tx) =>
            fn({
              query: (sql, params = []) => {
                statements.push({ sql, params })
                return tx.query(sql, params)
              },
            }),
          ),
        close: () => testDb.close(),
      }
      const instrumentedStore = createWebAuthnStore(instrumented)

      await instrumentedStore.deleteCredential(first.credential.id, agentId)

      const lockStatement = statements.find((s) => s.sql.includes('FOR UPDATE'))
      expect(lockStatement).toBeDefined()
      // The load-bearing fix: parameterized on agent_id ALONE (locks the
      // whole set) — never additionally scoped to the target credential id.
      expect(lockStatement?.sql).toMatch(/WHERE agent_id = \$1\s+FOR UPDATE/)
      expect(lockStatement?.sql).not.toMatch(/id = \$1 AND agent_id = \$2/)
      expect(lockStatement?.params).toEqual([agentId])
    })

    it('computes the last-credential guard from the SAME locked row set — deleting one of two leaves exactly one, and THAT delete then correctly refuses', async () => {
      const { store, agentStore, db: testDb } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')
      await testDb.query('DELETE FROM agent_auth_identities WHERE agent_id = $1', [agentId])
      const first = await store.insertCredential({ agentId, ...CREDENTIAL_1, credentialId: 'c1' })
      const second = await store.insertCredential({ agentId, ...CREDENTIAL_1, credentialId: 'c2' })
      if (!first.ok || !second.ok) throw new Error('expected ok')

      // Deleting the first while the second still exists succeeds.
      expect(await store.deleteCredential(first.credential.id, agentId)).toBe('ok')

      // The Agent must never reach zero: the SAME store, immediately after,
      // refuses to delete the now-only-remaining credential.
      expect(await store.deleteCredential(second.credential.id, agentId)).toBe('last_credential')
      expect(await store.listCredentialsForAgent(agentId)).toHaveLength(1)
    })
  })

  // --- challenges -------------------------------------------------------------

  describe('mintChallenge / consumeChallenge', () => {
    it('consumes a minted challenge exactly once (single-use)', async () => {
      const { store } = await freshStore()
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
      await store.mintChallenge({
        nonce: 'n1',
        ceremony: 'authentication',
        agentId: null,
        expiresAt,
      })

      expect(await store.consumeChallenge('n1', 'authentication')).toBe(true)
      expect(await store.consumeChallenge('n1', 'authentication')).toBe(false) // already consumed
    })

    it('the ceremony discriminator is enforced at the database layer (spec §7)', async () => {
      const { store } = await freshStore()
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
      await store.mintChallenge({ nonce: 'n2', ceremony: 'registration', agentId: null, expiresAt })

      // A validly-signed token minted for one ceremony must not consume the
      // row under a DIFFERENT caller-hardcoded ceremony expectation.
      expect(await store.consumeChallenge('n2', 'authentication')).toBe(false)
      expect(await store.consumeChallenge('n2', 'step-up')).toBe(false)
      expect(await store.consumeChallenge('n2', 'registration')).toBe(true)
    })

    it('the Agent binding is enforced at the database layer, independently of any caller check', async () => {
      const { store, agentStore } = await freshStore()
      const owner = await makeAgent(agentStore, 'owner@example.test')
      const other = await makeAgent(agentStore, 'other@example.test')
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
      await store.mintChallenge({ nonce: 'n4', ceremony: 'step-up', agentId: owner, expiresAt })

      // The whole point of the `expectedAgentId` clause: a row minted for one
      // Agent is not consumable under another, with NO application-layer check
      // in front of it. `webauthn-ceremony.ts`'s own check short-circuits
      // before the store is ever reached, so without this test the SQL clause
      // would be dead weight no test would notice losing.
      expect(await store.consumeChallenge('n4', 'step-up', other)).toBe(false)
      expect(await store.consumeChallenge('n4', 'step-up', owner)).toBe(true)
    })

    it('a login challenge (agent_id NULL) is still consumable when no Agent is expected', async () => {
      const { store } = await freshStore()
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
      await store.mintChallenge({
        nonce: 'n5',
        ceremony: 'authentication',
        agentId: null,
        expiresAt,
      })

      // Guards the SQL branch: binding unconditionally would emit
      // `AND agent_id = NULL`, which matches nothing, breaking every login.
      expect(await store.consumeChallenge('n5', 'authentication')).toBe(true)
    })

    it('an expired challenge cannot be consumed', async () => {
      const { store } = await freshStore()
      const alreadyExpired = new Date(Date.now() - 1000)
      await store.mintChallenge({
        nonce: 'n3',
        ceremony: 'authentication',
        agentId: null,
        expiresAt: alreadyExpired,
      })
      expect(await store.consumeChallenge('n3', 'authentication')).toBe(false)
    })

    it('a mint opportunistically purges every already-expired row (spec §2.2)', async () => {
      const { db: testDb, store } = await freshStore()
      const alreadyExpired = new Date(Date.now() - 1000)
      await store.mintChallenge({
        nonce: 'stale',
        ceremony: 'authentication',
        agentId: null,
        expiresAt: alreadyExpired,
      })
      const [{ count: before }] = await testDb.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM webauthn_challenges',
      )
      expect(before).toBe(1)

      // The next mint purges the stale row before inserting its own.
      await store.mintChallenge({
        nonce: 'fresh',
        ceremony: 'authentication',
        agentId: null,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      })
      const rows = await testDb.query<{ nonce: string }>('SELECT nonce FROM webauthn_challenges')
      expect(rows.map((r) => r.nonce)).toEqual(['fresh'])
    })
  })

  // --- step-up tokens -----------------------------------------------------

  describe('mintStepUpToken / consumeStepUpToken', () => {
    it('consumes a minted step-up token exactly once', async () => {
      const { store, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
      await store.mintStepUpToken({ nonce: 'su1', agentId, expiresAt })

      expect(await store.consumeStepUpToken('su1')).toBe(true)
      expect(await store.consumeStepUpToken('su1')).toBe(false)
    })

    it('an expired step-up token cannot be consumed', async () => {
      const { store, agentStore } = await freshStore()
      const agentId = await makeAgent(agentStore, 'a@example.test')
      await store.mintStepUpToken({ nonce: 'su2', agentId, expiresAt: new Date(Date.now() - 1000) })
      expect(await store.consumeStepUpToken('su2')).toBe(false)
    })
  })
})
