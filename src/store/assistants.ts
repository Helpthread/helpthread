/**
 * `AssistantStore` — persistence for `assistants` (migration 020, `src/db/
 * migrate.ts`; HT-68, specs/plugins/substrate-v1.md §3 — "module" below
 * always means an out-of-process Helpthread extension, never the legal
 * "plugin exception" phrase CHARTER.md §7 uses).
 *
 * An Assistant is an AI actor principal (never a human — CLAUDE.md's
 * Agents-vs-Assistants vocabulary rule; see `src/store/agents.ts` for the
 * human `AgentStore` this module deliberately mirrors the shape of: an
 * interface + a `create*Store(db)` factory, raw parameterized SQL over the
 * `Db`/`Queryable` seam, `id, ...` RETURNING clauses).
 *
 * ## Token hashing is wave 3's concern, not this module's
 *
 * Spec §3's token format (`ht_asst_<assistantId>_<secret>`) and its
 * constant-time-hash verification are auth-wiring work this ticket's
 * boundary excludes (HT-68 is schema + store only). This store never
 * generates, hashes, or verifies a token — {@link AssistantStore.create}
 * and {@link AssistantStore.updateTokenHash} take an already-hashed
 * `tokenHash: string` from the caller, the same "store persists, a later
 * ticket owns the crypto" split `src/store/token-crypto.ts`'s module doc
 * uses for OAuth tokens (migration 010's precedent, applied here to a
 * different secret shape). {@link AssistantRecord} never carries
 * `tokenHash` — mirroring `AgentRecord`'s "never carries a secret" — the
 * hash lives only in the row this store reads/writes internally.
 */

import type { Db, SqlValue } from '../db/client.js'

/** An Assistant's lifecycle status (spec §3): `active` can authenticate; `disabled` is a reversible soft-off. No `invited` state — an Assistant has no invite flow (unlike `AgentStatus`). */
export type AssistantStatus = 'active' | 'disabled'

/** An Assistant, as read back from storage. Never carries `tokenHash` — see the module doc. */
export interface AssistantRecord {
  id: string
  name: string
  /** The slug of the module operating this Assistant (spec §1's additive-forward rule). */
  module: string
  status: AssistantStatus
  /** The admin Agent who created this Assistant, or `null` — nullable with `ON DELETE SET NULL` (migration 020): deleting that Agent must not delete or orphan a still-live Assistant. */
  createdByAgentId: string | null
  createdAt: Date
  updatedAt: Date
}

/** Input to {@link AssistantStore.create}. */
export interface NewAssistant {
  /**
   * Caller-supplied id (HT-70) — mirrors `NewThread.id` in
   * `src/store/conversations.ts`'s "id/token knot" pattern: the token format
   * (`ht_asst_<assistantId>_<secret>`, spec §3) embeds the assistant's id, so
   * the id must be known BEFORE the row exists in order to mint it
   * (`src/auth/assistant-token.ts`'s `mintAssistantToken`). Omitted lets
   * `gen_random_uuid()` assign one, same as before this field existed.
   */
  id?: string
  name: string
  module: string
  /** The SHA-256 digest of the token's secret part (spec §3) — already hashed by the caller. This store never sees the plaintext token. */
  tokenHash: string
  createdByAgentId?: string | null
}

/** Fields {@link AssistantStore.patch} may change (spec §3's admin API: `PATCH /api/v1/assistants/{id}` — name, status). */
export interface AssistantPatch {
  name?: string
  status?: AssistantStatus
}

/** Persistence operations for `assistants`. See the module doc for the token-hashing boundary. */
export interface AssistantStore {
  /** Insert a new Assistant row, `status: 'active'` (the schema default). Returns the created {@link AssistantRecord}. */
  create(input: NewAssistant): Promise<AssistantRecord>

  /** Look up an Assistant by id. `null` if no row has that id. */
  get(id: string): Promise<AssistantRecord | null>

  /** List every Assistant, ordered by `name` — the roster `GET /api/v1/assistants` (spec §3) serves. */
  list(): Promise<AssistantRecord[]>

  /** Apply `patch` (name and/or status) to Assistant `id`. Returns the updated record, or `null` if `id` doesn't exist. */
  patch(id: string, patch: AssistantPatch): Promise<AssistantRecord | null>

  /** Replace Assistant `id`'s `token_hash` — the store half of `POST /api/v1/assistants/{id}/rotate-token` (spec §3). Throws if no Assistant exists with `id`, matching `AgentStore.setPassword`'s same throw-on-zero-rows convention (every caller already loaded the Assistant before calling this). */
  updateTokenHash(id: string, tokenHash: string): Promise<void>

  /**
   * The raw `token_hash` for Assistant `id` — what wave 3's token verifier
   * compares a presented token's secret part against (constant-time,
   * outside this store). `null` if `id` doesn't exist. Never returned from
   * {@link AssistantRecord} itself (module doc) — this is the one method
   * that reaches the hash, by design, for the one caller that legitimately
   * needs it.
   */
  getTokenHash(id: string): Promise<string | null>
}

/** Raw `assistants` row shape, before mapping to {@link AssistantRecord}. */
interface AssistantRow {
  id: string
  name: string
  module: string
  status: string
  created_by_agent_id: string | null
  created_at: Date | string
  updated_at: Date | string
}

const ASSISTANT_COLUMNS = 'id, name, module, status, created_by_agent_id, created_at, updated_at'

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toAssistantRecord(row: AssistantRow): AssistantRecord {
  return {
    id: row.id,
    name: row.name,
    module: row.module,
    status: row.status as AssistantStatus,
    createdByAgentId: row.created_by_agent_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

/** Create an {@link AssistantStore} backed by `db`. */
export function createAssistantStore(db: Db): AssistantStore {
  return {
    async create(input) {
      const [row] =
        input.id !== undefined
          ? await db.query<AssistantRow>(
              `INSERT INTO assistants (id, name, module, token_hash, created_by_agent_id)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING ${ASSISTANT_COLUMNS}`,
              [input.id, input.name, input.module, input.tokenHash, input.createdByAgentId ?? null],
            )
          : await db.query<AssistantRow>(
              `INSERT INTO assistants (name, module, token_hash, created_by_agent_id)
               VALUES ($1, $2, $3, $4)
               RETURNING ${ASSISTANT_COLUMNS}`,
              [input.name, input.module, input.tokenHash, input.createdByAgentId ?? null],
            )
      return toAssistantRecord(row)
    },

    async get(id) {
      const rows = await db.query<AssistantRow>(
        `SELECT ${ASSISTANT_COLUMNS} FROM assistants WHERE id = $1`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? null : toAssistantRecord(row)
    },

    async list() {
      const rows = await db.query<AssistantRow>(
        `SELECT ${ASSISTANT_COLUMNS} FROM assistants ORDER BY name`,
      )
      return rows.map(toAssistantRecord)
    },

    async patch(id, patch) {
      const sets: string[] = []
      const params: SqlValue[] = []
      if (patch.name !== undefined) {
        params.push(patch.name)
        sets.push(`name = $${params.length}`)
      }
      if (patch.status !== undefined) {
        params.push(patch.status)
        sets.push(`status = $${params.length}`)
      }
      if (sets.length === 0) {
        // No-op patch — fetch-and-return rather than issue a malformed
        // UPDATE, matching AgentStore.updateAgent's same convention.
        const rows = await db.query<AssistantRow>(
          `SELECT ${ASSISTANT_COLUMNS} FROM assistants WHERE id = $1`,
          [id],
        )
        const row = rows[0]
        return row === undefined ? null : toAssistantRecord(row)
      }
      params.push(id)
      const rows = await db.query<AssistantRow>(
        `UPDATE assistants SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${params.length}
         RETURNING ${ASSISTANT_COLUMNS}`,
        params,
      )
      const row = rows[0]
      return row === undefined ? null : toAssistantRecord(row)
    },

    async updateTokenHash(id, tokenHash) {
      const rows = await db.query<{ id: string }>(
        `UPDATE assistants SET token_hash = $2, updated_at = now() WHERE id = $1 RETURNING id`,
        [id, tokenHash],
      )
      if (rows.length === 0) {
        throw new Error(`updateTokenHash: no assistant with id ${id}`)
      }
    },

    async getTokenHash(id) {
      const rows = await db.query<{ token_hash: string }>(
        `SELECT token_hash FROM assistants WHERE id = $1`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? null : row.token_hash
    },
  }
}
