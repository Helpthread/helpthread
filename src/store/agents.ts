/**
 * `AgentStore` — persistence for `agents` and `agent_auth_identities`
 * (migration 018, `src/db/migrate.ts`; HT-54, specs/auth/agents-and-auth.md).
 *
 * Follows this codebase's standing store convention: an interface + a
 * `create*Store(db)` factory, raw parameterized SQL over the `Db`/`Queryable`
 * seam (`src/db/client.ts`), expected failures signaled as discriminated
 * result unions rather than thrown exceptions (mirrors
 * `ConversationStore.appendThread`'s `AppendResult`) — a duplicate email or a
 * would-be last-admin removal is an ordinary, anticipated outcome of calling
 * this API, not a bug.
 *
 * ## The last-admin invariant (spec §5) and the advisory lock
 *
 * Under Postgres's default READ COMMITTED isolation, two concurrent
 * mutations that each reduce the active-admin set (demote, disable, or
 * delete an admin) can both observe "there are 2 active admins" in their own
 * snapshot and both proceed, silently dropping the count to zero — a
 * guard predicate ALONE does not close this race (spec §5's own worked
 * example). Every mutation here that CAN reduce the active-admin set
 * therefore runs inside a transaction that takes a
 * {@link AGENTS_ADMIN_ADVISORY_LOCK_KEY} `pg_advisory_xact_lock` FIRST, then
 * re-checks the count under that lock — the same tool `src/db/migrate.ts`
 * already uses for its own cross-instance race, applied here to a
 * cross-request one. {@link createFirstAdmin} shares this SAME lock key
 * (spec §6 says so explicitly: "the same `pg_advisory_xact_lock` the
 * last-admin guard uses") — a distinct key from `migrate.ts`'s own
 * {@link MIGRATION_ADVISORY_LOCK_KEY}-equivalent, since these are unrelated
 * critical sections that must never block each other.
 *
 * `updateAgent`/`deleteAgent` only pay the lock's cost when the mutation
 * actually TOUCHES `role`/`status` (i.e., could conceivably matter) — a
 * plain name/timezone edit never takes it. Once a role/status mutation does
 * take the lock, the guard is evaluated unconditionally inside it (rather
 * than trying to skip the count query for "obviously safe" cases like
 * promoting to admin) — the extra count query is cheap, and a single
 * "always guard once locked" code path is far easier to prove correct than
 * a "guard only on the branches that reduce" one; see each method's comment
 * for the exact condition.
 */

import type { Db, SqlValue } from '../db/client.js'

/** An Agent's role (spec §5): `admin` manages Agents/settings and can do everything an `agent` can; `agent` works the inbox and their own profile. */
export type AgentRole = 'admin' | 'agent'

/**
 * An Agent's lifecycle status (spec §3.1). `invited` is produced ONLY by the
 * invite-provisioning path and exits only via invite acceptance or
 * delete/re-create (spec §6's closed status lifecycle) — never settable by
 * `PATCH`. `active` can sign in; `disabled` is a reversible soft-off.
 */
export type AgentStatus = 'invited' | 'active' | 'disabled'

/** An Agent, as read back from storage. Never carries a secret — `secret_hash` lives only in `agent_auth_identities`, a separate table this type has no field for. */
export interface AgentRecord {
  id: string
  email: string
  name: string
  role: AgentRole
  status: AgentStatus
  timezone: string
  createdAt: Date
  updatedAt: Date
}

/** A stored `password` identity, as {@link AgentStore.getPasswordIdentity}/{@link AgentStore.getPasswordIdentityByEmail} return it — exactly the two fields `PasswordAuthProvider` needs. */
export interface PasswordIdentity {
  agentId: string
  secretHash: string
}

/** Fields {@link AgentStore.updateAgent} may change. `email` is deliberately absent — immutable in v1 (spec §3.2, §6); re-create the Agent to change it. */
export interface AgentUpdate {
  name?: string
  timezone?: string
  role?: AgentRole
  status?: 'active' | 'disabled'
}

/** The outcome of {@link AgentStore.createAgent}. */
export type CreateAgentResult =
  | { ok: true; agent: AgentRecord }
  | { ok: false; reason: 'email_taken' }

/** The outcome of {@link AgentStore.updateAgent}. */
export type UpdateAgentResult =
  | { ok: true; agent: AgentRecord }
  | { ok: false; reason: 'not_found' | 'last_admin' }

/** The outcome of {@link AgentStore.deleteAgent}. */
export type DeleteAgentResult = { ok: true } | { ok: false; reason: 'not_found' | 'last_admin' }

/** Persistence operations for `agents` and `agent_auth_identities`. See the module doc for the last-admin locking discipline. */
export interface AgentStore {
  /**
   * Create the FIRST admin (spec §6's zero-Agents-gated `/setup`): an
   * `agents` row (`role='admin'`, `status='active'`) plus its `password`
   * identity, in ONE transaction guarded by
   * {@link AGENTS_ADMIN_ADVISORY_LOCK_KEY} — the same
   * `pg_advisory_xact_lock`-then-check pattern `migrate()` uses, closing the
   * "two concurrent zero-Agents checks both see an empty table" race (module
   * doc). Returns the created {@link AgentRecord}, or `null` if another call
   * won the race (or Agents already existed) — the caller maps `null` to
   * `409`.
   */
  createFirstAdmin(input: {
    name: string
    email: string
    passwordHash: string
  }): Promise<AgentRecord | null>

  /**
   * Create an Agent (admin-authored, spec §6/§8): with `passwordHash`
   * present, also inserts its `password` identity in the SAME transaction
   * (the admin-set-password provisioning path, `status` must be `'active'`);
   * with `passwordHash` omitted, no identity is created (the invite path,
   * `status` must be `'invited'` — no usable credential yet, spec §3.1). The
   * caller (`src/api/agents.ts`) is what enforces "exactly one of
   * `sendInvite`/`password`" and picks the matching `status`; this method
   * does not re-derive that choice.
   *
   * A duplicate email (the `agents_email_key` unique index, case-insensitive)
   * is an `INSERT ... ON CONFLICT (lower(email)) DO NOTHING` — `{ ok: false,
   * reason: 'email_taken' }`, never a thrown constraint-violation error, so
   * the API layer can map it to `409` without parsing a raw pg error.
   */
  createAgent(input: {
    name: string
    email: string
    role: AgentRole
    status: 'invited' | 'active'
    passwordHash?: string
  }): Promise<CreateAgentResult>

  /** Look up an Agent by id. `null` if no row has that id. */
  getAgent(id: string): Promise<AgentRecord | null>

  /** Look up an Agent by email, case-insensitively (`lower(email) = lower($1)`). `null` if no row matches. */
  getAgentByEmail(email: string): Promise<AgentRecord | null>

  /** List every Agent, ordered by `name` — the roster `GET /api/v1/agents` (spec §6) serves to any active Agent (any Agent may assign any Agent, spec §5's role model). */
  listAgents(): Promise<AgentRecord[]>

  /**
   * Apply `patch` to Agent `id`. When `patch.role`/`patch.status` is
   * present, runs inside the advisory-locked last-admin guard (module doc);
   * a bare `{name?, timezone?}` patch (both `role` and `status` omitted)
   * is a plain, unlocked `UPDATE` — it can never reduce the active-admin
   * set. Returns the updated record, `{ ok: false, reason: 'not_found' }`
   * if `id` doesn't exist, or `{ ok: false, reason: 'last_admin' }` if the
   * change would leave the deployment with zero active admins. The
   * **status lifecycle** (PATCH may only target `active`/`disabled`,
   * `AgentUpdate['status']` is typed to exclude `'invited'` entirely) and
   * the "an `invited` Agent's status is immovable via PATCH" rule are both
   * enforced by the API layer (`src/api/agents.ts`), which has the
   * pre-mutation Agent it needs to check "was this Agent `invited`" —
   * this store method only knows the last-admin invariant.
   */
  updateAgent(id: string, patch: AgentUpdate): Promise<UpdateAgentResult>

  /**
   * Hard delete: cascades `agent_auth_identities` (FK `ON DELETE CASCADE`)
   * and un-assigns any conversation this Agent held (FK `ON DELETE SET
   * NULL` on `conversations.assignee_agent_id`) — both handled by the
   * schema, not application code. ALWAYS runs inside the advisory-locked
   * last-admin guard (module doc) — unlike {@link updateAgent}, there is no
   * cheap "obviously safe" fast path worth special-casing here, since a
   * delete's effect on the admin set depends on the row's CURRENT
   * role/status, which this method must read under the lock anyway.
   */
  deleteAgent(id: string): Promise<DeleteAgentResult>

  /**
   * Set (insert or replace) Agent `agentId`'s single `password` identity —
   * `subject` is always written as the Agent's CURRENT email (read from the
   * same `agents` row inside this one statement, never a caller-supplied
   * value that could drift from it). Honors the partial unique index
   * (`agent_auth_identities_one_password_per_agent`) via `ON CONFLICT
   * (agent_id) WHERE provider = 'password' DO UPDATE`. Throws if no Agent
   * exists with `agentId` — every caller (`src/api/agents.ts`) already
   * loaded the Agent to check its status before calling this, so a genuinely
   * missing row here is structurally unreachable in practice, matching
   * `MailboxStore.markDisconnected`'s same throw-on-zero-rows convention.
   */
  setPassword(agentId: string, passwordHash: string): Promise<void>

  /** The Agent's `password` identity, if any — `{ agentId, secretHash }` or `null`. */
  getPasswordIdentity(agentId: string): Promise<PasswordIdentity | null>

  /** The `password` identity for the Agent whose email matches (case-insensitively), joined through `agents` — what `PasswordAuthProvider` looks up on every login attempt. `null` if no Agent has that email, or the Agent has no `password` identity. */
  getPasswordIdentityByEmail(email: string): Promise<PasswordIdentity | null>

  /**
   * Atomically accept an invite: `UPDATE agents SET status = 'active' ...
   * WHERE id = $1 AND status = 'invited'` and set the Agent's `password`
   * identity, in ONE transaction (spec §6/§9 — this is what makes accepting
   * the SAME invite twice, or a replay after the Agent is already `active`,
   * a no-op rather than a second password write). Returns the updated
   * {@link AgentRecord} on success, or `null` if the `UPDATE` matched zero
   * rows (no such Agent, or the Agent was not `invited`) — the caller
   * (`src/api/agents.ts`) maps `null` to the same generic `401` an invalid
   * token gets, so expired/replayed/invalid are indistinguishable (spec
   * §6).
   */
  acceptInvite(agentId: string, passwordHash: string): Promise<AgentRecord | null>

  /** Count every Agent regardless of status — `needsSetup` (`GET /api/v1/auth/providers`, spec §6) is `count === 0`. */
  countAgents(): Promise<number>
}

/**
 * The advisory lock key {@link createFirstAdmin}'s zero-Agents guard and the
 * last-admin guard (`updateAgent`/`deleteAgent`) both serialize on — a
 * DISTINCT constant from `src/db/migrate.ts`'s own
 * `MIGRATION_ADVISORY_LOCK_KEY` (module doc): these are unrelated critical
 * sections (schema migration vs. admin-roster mutation) that must never
 * contend with each other. Chosen larger than `int4`'s max (2^31-1) so it
 * binds unambiguously to `pg_advisory_xact_lock`'s `bigint` overload, same
 * reasoning as `migrate.ts`'s constant.
 */
export const AGENTS_ADMIN_ADVISORY_LOCK_KEY = 7_331_009_881

/** Raw `agents` row shape, before mapping to {@link AgentRecord}. */
interface AgentRow {
  id: string
  email: string
  name: string
  role: string
  status: string
  timezone: string
  created_at: Date | string
  updated_at: Date | string
}

const AGENT_COLUMNS = 'id, email, name, role, status, timezone, created_at, updated_at'

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as AgentRole,
    status: row.status as AgentStatus,
    timezone: row.timezone,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

/** Create an {@link AgentStore} backed by `db`. */
export function createAgentStore(db: Db): AgentStore {
  return {
    async createFirstAdmin(input) {
      const email = input.email.trim().toLowerCase()
      return db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [AGENTS_ADMIN_ADVISORY_LOCK_KEY])
        const existing = await tx.query('SELECT 1 FROM agents LIMIT 1')
        if (existing.length > 0) return null

        const [agentRow] = await tx.query<AgentRow>(
          `INSERT INTO agents (email, name, role, status)
           VALUES ($1, $2, 'admin', 'active')
           RETURNING ${AGENT_COLUMNS}`,
          [email, input.name],
        )
        await tx.query(
          `INSERT INTO agent_auth_identities (agent_id, provider, subject, secret_hash)
           VALUES ($1, 'password', $2, $3)`,
          [agentRow.id, email, input.passwordHash],
        )
        return toAgentRecord(agentRow)
      })
    },

    async createAgent(input) {
      const email = input.email.trim().toLowerCase()
      return db.transaction(async (tx) => {
        const rows = await tx.query<AgentRow>(
          `INSERT INTO agents (email, name, role, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (lower(email)) DO NOTHING
           RETURNING ${AGENT_COLUMNS}`,
          [email, input.name, input.role, input.status],
        )
        if (rows.length === 0) {
          return { ok: false, reason: 'email_taken' }
        }
        const agentRow = rows[0]
        if (input.passwordHash !== undefined) {
          await tx.query(
            `INSERT INTO agent_auth_identities (agent_id, provider, subject, secret_hash)
             VALUES ($1, 'password', $2, $3)`,
            [agentRow.id, email, input.passwordHash],
          )
        }
        return { ok: true, agent: toAgentRecord(agentRow) }
      })
    },

    async getAgent(id) {
      const rows = await db.query<AgentRow>(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [
        id,
      ])
      const row = rows[0]
      return row === undefined ? null : toAgentRecord(row)
    },

    async getAgentByEmail(email) {
      const rows = await db.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS} FROM agents WHERE lower(email) = lower($1)`,
        [email],
      )
      const row = rows[0]
      return row === undefined ? null : toAgentRecord(row)
    },

    async listAgents() {
      const rows = await db.query<AgentRow>(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY name`)
      return rows.map(toAgentRecord)
    },

    async updateAgent(id, patch) {
      // A plain name/timezone-only patch can never reduce the active-admin
      // set — no lock needed, no last-admin re-check, just an ordinary
      // UPDATE (module doc).
      if (patch.role === undefined && patch.status === undefined) {
        const sets: string[] = []
        const params: SqlValue[] = []
        if (patch.name !== undefined) {
          params.push(patch.name)
          sets.push(`name = $${params.length}`)
        }
        if (patch.timezone !== undefined) {
          params.push(patch.timezone)
          sets.push(`timezone = $${params.length}`)
        }
        if (sets.length === 0) {
          // Nothing to change — a no-op patch. Fetch-and-return rather than
          // issue a malformed `UPDATE ... SET , updated_at = now()`; matches
          // ConversationStore.appendThread's "a replay that changes nothing
          // touches the row not at all" convention.
          const rows = await db.query<AgentRow>(
            `SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`,
            [id],
          )
          const row = rows[0]
          return row === undefined
            ? { ok: false, reason: 'not_found' }
            : { ok: true, agent: toAgentRecord(row) }
        }
        params.push(id)
        const rows = await db.query<AgentRow>(
          `UPDATE agents SET ${sets.join(', ')}, updated_at = now()
           WHERE id = $${params.length}
           RETURNING ${AGENT_COLUMNS}`,
          params,
        )
        const row = rows[0]
        return row === undefined
          ? { ok: false, reason: 'not_found' }
          : { ok: true, agent: toAgentRecord(row) }
      }

      // role and/or status is being touched — always take the advisory lock
      // and re-check the guard, even on a branch that plainly can't reduce
      // the admin set (e.g. promoting to admin): one code path, provably
      // correct, cheap enough (module doc).
      return db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [AGENTS_ADMIN_ADVISORY_LOCK_KEY])
        const current = await tx.query<AgentRow>(
          `SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const currentRow = current[0]
        if (currentRow === undefined) {
          return { ok: false, reason: 'not_found' }
        }

        const newRole = patch.role ?? currentRow.role
        const newStatus = patch.status ?? currentRow.status
        const wasActiveAdmin = currentRow.role === 'admin' && currentRow.status === 'active'
        const willBeActiveAdmin = newRole === 'admin' && newStatus === 'active'
        if (wasActiveAdmin && !willBeActiveAdmin) {
          const [{ count }] = await tx.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM agents WHERE role = 'admin' AND status = 'active'",
          )
          if (count <= 1) {
            return { ok: false, reason: 'last_admin' }
          }
        }

        const sets: string[] = ['role = $1', 'status = $2']
        const params: SqlValue[] = [newRole, newStatus]
        if (patch.name !== undefined) {
          params.push(patch.name)
          sets.push(`name = $${params.length}`)
        }
        if (patch.timezone !== undefined) {
          params.push(patch.timezone)
          sets.push(`timezone = $${params.length}`)
        }
        params.push(id)
        const [updatedRow] = await tx.query<AgentRow>(
          `UPDATE agents SET ${sets.join(', ')}, updated_at = now()
           WHERE id = $${params.length}
           RETURNING ${AGENT_COLUMNS}`,
          params,
        )
        return { ok: true, agent: toAgentRecord(updatedRow) }
      })
    },

    async deleteAgent(id) {
      return db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [AGENTS_ADMIN_ADVISORY_LOCK_KEY])
        const rows = await tx.query<{ role: string; status: string }>(
          'SELECT role, status FROM agents WHERE id = $1 FOR UPDATE',
          [id],
        )
        const row = rows[0]
        if (row === undefined) {
          return { ok: false, reason: 'not_found' }
        }
        if (row.role === 'admin' && row.status === 'active') {
          const [{ count }] = await tx.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM agents WHERE role = 'admin' AND status = 'active'",
          )
          if (count <= 1) {
            return { ok: false, reason: 'last_admin' }
          }
        }
        await tx.query('DELETE FROM agents WHERE id = $1', [id])
        return { ok: true }
      })
    },

    async setPassword(agentId, passwordHash) {
      const rows = await db.query<{ agent_id: string }>(
        `INSERT INTO agent_auth_identities (agent_id, provider, subject, secret_hash)
         SELECT id, 'password', email, $2 FROM agents WHERE id = $1
         ON CONFLICT (agent_id) WHERE provider = 'password'
         DO UPDATE SET secret_hash = EXCLUDED.secret_hash, subject = EXCLUDED.subject, updated_at = now()
         RETURNING agent_id`,
        [agentId, passwordHash],
      )
      if (rows.length === 0) {
        throw new Error(`setPassword: no agent with id ${agentId}`)
      }
    },

    async getPasswordIdentity(agentId) {
      const rows = await db.query<{ agent_id: string; secret_hash: string }>(
        `SELECT agent_id, secret_hash FROM agent_auth_identities
         WHERE agent_id = $1 AND provider = 'password'`,
        [agentId],
      )
      const row = rows[0]
      return row === undefined ? null : { agentId: row.agent_id, secretHash: row.secret_hash }
    },

    async getPasswordIdentityByEmail(email) {
      const rows = await db.query<{ agent_id: string; secret_hash: string }>(
        `SELECT ai.agent_id, ai.secret_hash
         FROM agent_auth_identities ai
         JOIN agents a ON a.id = ai.agent_id
         WHERE lower(a.email) = lower($1) AND ai.provider = 'password'`,
        [email],
      )
      const row = rows[0]
      return row === undefined ? null : { agentId: row.agent_id, secretHash: row.secret_hash }
    },

    async acceptInvite(agentId, passwordHash) {
      return db.transaction(async (tx) => {
        const rows = await tx.query<AgentRow>(
          `UPDATE agents SET status = 'active', updated_at = now()
           WHERE id = $1 AND status = 'invited'
           RETURNING ${AGENT_COLUMNS}`,
          [agentId],
        )
        const row = rows[0]
        if (row === undefined) return null

        await tx.query(
          `INSERT INTO agent_auth_identities (agent_id, provider, subject, secret_hash)
           VALUES ($1, 'password', $2, $3)
           ON CONFLICT (agent_id) WHERE provider = 'password'
           DO UPDATE SET secret_hash = EXCLUDED.secret_hash, subject = EXCLUDED.subject, updated_at = now()`,
          [agentId, row.email, passwordHash],
        )
        return toAgentRecord(row)
      })
    },

    async countAgents() {
      const [{ count }] = await db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM agents',
      )
      return count
    },
  }
}
