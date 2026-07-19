/**
 * `WebAuthnStore` — persistence for `webauthn_credentials`,
 * `webauthn_challenges`, and `webauthn_stepup_tokens` (migration 026, HT-75;
 * specs/auth/passkeys.md §2). Three tables, one store file — the same
 * "closely-related tables share a store module" precedent
 * `src/store/agents.ts` already sets (`agents` + `agent_auth_identities` +
 * `agent_mailbox_access`).
 *
 * Follows this codebase's standing store convention: an interface + a
 * `create*Store(db)` factory, raw parameterized SQL over the `Db`/`Queryable`
 * seam, expected failures as discriminated outcomes rather than thrown
 * exceptions.
 *
 * ## The TOCTOU fix lives here, not in the caller (spec §6.2, §8)
 *
 * {@link WebAuthnStore.getCredentialForUpdateInTx} REQUIRES a `tx` — it is
 * only ever meaningful inside a transaction, since its whole purpose is the
 * `SELECT ... FOR UPDATE` re-read spec §6.2 mandates: the counter/clone
 * comparison and the write that updates it must happen against the SAME
 * locked row, not the earlier, unlocked read used for cryptographic
 * verification. `src/auth/webauthn-service.ts` is the one caller.
 *
 * ## Opportunistic purge, no cron (spec §2.2)
 *
 * {@link WebAuthnStore.mintChallenge}/{@link WebAuthnStore.mintStepUpToken}
 * each precede their INSERT with `DELETE ... WHERE expires_at < now()` in
 * the SAME transaction — the only cleanup mechanism either table gets.
 */

import type { WebAuthnCeremony } from '../auth/webauthn-token.js'
import type { Db, Queryable, SqlValue } from '../db/client.js'

// --- webauthn_credentials ----------------------------------------------

/** A stored WebAuthn credential, as read back from `webauthn_credentials`. Never exposes anything beyond what `GET .../webauthn-credentials` is allowed to return PLUS what verification needs — `publicKey`/`credentialId` are present here (verification needs them) but the API layer (`src/api/webauthn.ts`) never serializes them onto the wire (spec §9, §10: "no secret ever leaves the server"). */
export interface WebAuthnCredentialRecord {
  id: string
  agentId: string
  credentialId: string
  publicKey: Uint8Array
  signCount: number
  transports: string[]
  backupEligible: boolean
  backupState: boolean
  name: string
  signCountRegressionAt: Date | null
  createdAt: Date
  lastUsedAt: Date | null
  updatedAt: Date
}

/** Input to {@link WebAuthnStore.insertCredential} — everything `registrationInfo` (`@simplewebauthn/server`) plus the client-reported `transports` and the (already-defaulted) `name` yield. */
export interface InsertCredentialInput {
  agentId: string
  credentialId: string
  publicKey: Uint8Array
  signCount: number
  transports: string[]
  backupEligible: boolean
  backupState: boolean
  name: string
}

/** The outcome of {@link WebAuthnStore.insertCredential}. `'credential_taken'` covers BOTH a different Agent's credential and a same-Agent re-registration (spec §6.1: the UNIQUE index enforces it server-side either way; `excludeCredentials` is what stops the same-Agent case client-side). */
export type InsertCredentialResult =
  | { ok: true; credential: WebAuthnCredentialRecord }
  | { ok: false; reason: 'credential_taken' }

/** The outcome of {@link WebAuthnStore.deleteCredential} (spec §9.1's revoke-last-credential guard). */
export type DeleteCredentialResult = 'ok' | 'not_found' | 'last_credential'

// --- webauthn_challenges / webauthn_stepup_tokens ------------------------

/** Input to {@link WebAuthnStore.mintChallenge}. */
export interface MintChallengeInput {
  nonce: string
  ceremony: WebAuthnCeremony
  agentId: string | null
  expiresAt: Date
}

/** Input to {@link WebAuthnStore.mintStepUpToken}. */
export interface MintStepUpTokenInput {
  nonce: string
  agentId: string
  expiresAt: Date
}

export interface WebAuthnStore {
  /**
   * Insert a new credential row. `'credential_taken'` on a `credential_id`
   * unique-index conflict (spec §6.1) — never a thrown constraint-violation
   * error, so the API layer maps it to `409` without parsing a raw pg error.
   */
  insertCredential(input: InsertCredentialInput): Promise<InsertCredentialResult>

  /** Look up a credential by its OWN row id (the API-facing rename/revoke handle, spec §9). `null` if no row has that id. */
  getCredentialById(id: string): Promise<WebAuthnCredentialRecord | null>

  /** Look up a credential by the WebAuthn authenticator's own `credential_id` — the authentication ceremony's discoverable-credential lookup key (spec §6.2, §4.3). Unlocked: safe for the pre-verification read. `null` if none matches. */
  getCredentialByCredentialId(credentialId: string): Promise<WebAuthnCredentialRecord | null>

  /**
   * The SAME lookup as {@link getCredentialByCredentialId}, but
   * `SELECT ... FOR UPDATE` inside `tx` — the locked re-read spec §6.2
   * requires BEFORE the counter/clone comparison and the write that
   * updates it (module doc). Only meaningful inside a transaction; `tx` is
   * required, not optional.
   */
  getCredentialForUpdateInTx(
    credentialId: string,
    tx: Queryable,
  ): Promise<WebAuthnCredentialRecord | null>

  /** After a successful, non-regressing authentication (spec §6.2): persist the new counter, refreshed `backup_state`, and `last_used_at = now()`. Must run in the SAME transaction as the `FOR UPDATE` read that authorized it. */
  updateAfterSuccessfulAuth(
    id: string,
    patch: { signCount: number; backupState: boolean },
    tx: Queryable,
  ): Promise<void>

  /** Stamp `sign_count_regression_at = now()` — the HT-44 health-check signal (spec §8). Must run in the SAME transaction as the `FOR UPDATE` read that detected the regression. */
  markCounterRegression(id: string, tx: Queryable): Promise<void>

  /** Every credential belonging to `agentId`, ordered by `created_at` — `GET .../webauthn-credentials` (spec §9). */
  listCredentialsForAgent(agentId: string): Promise<WebAuthnCredentialRecord[]>

  /** Rename credential `id`, scoped to `agentId` (the row must belong to that Agent) — `null` if no such row for that Agent. Not step-up-gated (spec §5.4). */
  renameCredential(
    id: string,
    agentId: string,
    name: string,
  ): Promise<WebAuthnCredentialRecord | null>

  /**
   * Delete credential `id`, scoped to `agentId`. `'not_found'` if no such
   * row for that Agent. `'last_credential'` — the spec §9.1 defensive
   * guard — if the Agent would be left with neither a `password` identity
   * nor any OTHER `webauthn_credentials` row (normally unreachable given
   * the "passkeys are additive" invariant §1 establishes; added anyway,
   * same reasoning as the last-admin guard in `src/store/agents.ts`).
   */
  deleteCredential(id: string, agentId: string): Promise<DeleteCredentialResult>

  /**
   * Mint a `webauthn_challenges` row, preceded (same transaction) by the
   * opportunistic purge of every expired row (spec §2.2) — the ONLY
   * cleanup mechanism this table gets.
   */
  mintChallenge(input: MintChallengeInput): Promise<void>

  /**
   * Consume a `webauthn_challenges` row: `UPDATE ... SET consumed_at =
   * now() WHERE nonce = $1 AND ceremony = $2 AND consumed_at IS NULL AND
   * expires_at > now()`. Returns whether the row was found and consumed —
   * `false` covers "never existed / already consumed / expired / wrong
   * ceremony" uniformly (spec §7: the database-level half of the ceremony
   * discriminator, and the actual single-use enforcement for
   * `authentication`).
   */
  consumeChallenge(nonce: string, ceremony: WebAuthnCeremony): Promise<boolean>

  /** Mint a `webauthn_stepup_tokens` row, same opportunistic-purge discipline as {@link mintChallenge} (spec §2.2). */
  mintStepUpToken(input: MintStepUpTokenInput): Promise<void>

  /**
   * Consume a `webauthn_stepup_tokens` row (spec §5.2): `UPDATE ... SET
   * consumed_at = now() WHERE nonce = $1 AND consumed_at IS NULL AND
   * expires_at > now()`. Called ONLY at `registration/options` time —
   * `registration/verify` re-validates the token's signature/TTL/agent
   * match but does NOT call this again (spec §5.2's "two independent
   * layers, not duplicated logic" — a second consume attempt would always
   * fail, which is not the property wanted there).
   */
  consumeStepUpToken(nonce: string): Promise<boolean>
}

/** Raw `webauthn_credentials` row shape, before mapping to {@link WebAuthnCredentialRecord}. */
interface CredentialRow {
  id: string
  agent_id: string
  credential_id: string
  public_key: Uint8Array
  sign_count: string | number
  transports: string[]
  backup_eligible: boolean
  backup_state: boolean
  name: string
  sign_count_regression_at: Date | string | null
  created_at: Date | string
  last_used_at: Date | string | null
  updated_at: Date | string
}

const CREDENTIAL_COLUMNS =
  'id, agent_id, credential_id, public_key, sign_count, transports, backup_eligible, backup_state, name, sign_count_regression_at, created_at, last_used_at, updated_at'

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value)
}

/** `sign_count` is a `bigint` column — `pg`/PGlite may hand it back as a string to avoid an appearance of precision loss. Every value this codebase ever writes is a WebAuthn authenticator counter (a 32-bit field per the WebAuthn spec), always well within `Number.MAX_SAFE_INTEGER`, so a plain `Number()` conversion is exact. */
function toSignCount(value: string | number): number {
  return typeof value === 'number' ? value : Number(value)
}

function toCredentialRecord(row: CredentialRow): WebAuthnCredentialRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    signCount: toSignCount(row.sign_count),
    transports: row.transports,
    backupEligible: row.backup_eligible,
    backupState: row.backup_state,
    name: row.name,
    signCountRegressionAt: toNullableDate(row.sign_count_regression_at),
    createdAt: toDate(row.created_at),
    lastUsedAt: toNullableDate(row.last_used_at),
    updatedAt: toDate(row.updated_at),
  }
}

/** Is `err` the `webauthn_credentials.credential_id` unique-index violation (SQLSTATE 23505)? Total over non-object input, same shape as `src/store/agents.ts`'s FK-violation guards. */
function isCredentialIdConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  return (err as { code?: unknown }).code === '23505'
}

/** Create a {@link WebAuthnStore} backed by `db`. */
export function createWebAuthnStore(db: Db): WebAuthnStore {
  return {
    async insertCredential(input) {
      try {
        const rows = await db.query<CredentialRow>(
          `INSERT INTO webauthn_credentials
             (agent_id, credential_id, public_key, sign_count, transports, backup_eligible, backup_state, name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${CREDENTIAL_COLUMNS}`,
          [
            input.agentId,
            input.credentialId,
            input.publicKey,
            input.signCount,
            input.transports as unknown as SqlValue,
            input.backupEligible,
            input.backupState,
            input.name,
          ],
        )
        return { ok: true, credential: toCredentialRecord(rows[0]) }
      } catch (err) {
        if (isCredentialIdConflict(err)) return { ok: false, reason: 'credential_taken' }
        throw err
      }
    },

    async getCredentialById(id) {
      const rows = await db.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM webauthn_credentials WHERE id = $1`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? null : toCredentialRecord(row)
    },

    async getCredentialByCredentialId(credentialId) {
      const rows = await db.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM webauthn_credentials WHERE credential_id = $1`,
        [credentialId],
      )
      const row = rows[0]
      return row === undefined ? null : toCredentialRecord(row)
    },

    async getCredentialForUpdateInTx(credentialId, tx) {
      const rows = await tx.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM webauthn_credentials WHERE credential_id = $1 FOR UPDATE`,
        [credentialId],
      )
      const row = rows[0]
      return row === undefined ? null : toCredentialRecord(row)
    },

    async updateAfterSuccessfulAuth(id, patch, tx) {
      await tx.query(
        `UPDATE webauthn_credentials
         SET sign_count = $2, backup_state = $3, last_used_at = now(), updated_at = now()
         WHERE id = $1`,
        [id, patch.signCount, patch.backupState],
      )
    },

    async markCounterRegression(id, tx) {
      await tx.query(
        `UPDATE webauthn_credentials SET sign_count_regression_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      )
    },

    async listCredentialsForAgent(agentId) {
      const rows = await db.query<CredentialRow>(
        `SELECT ${CREDENTIAL_COLUMNS} FROM webauthn_credentials WHERE agent_id = $1 ORDER BY created_at`,
        [agentId],
      )
      return rows.map(toCredentialRecord)
    },

    async renameCredential(id, agentId, name) {
      const rows = await db.query<CredentialRow>(
        `UPDATE webauthn_credentials SET name = $3, updated_at = now()
         WHERE id = $1 AND agent_id = $2
         RETURNING ${CREDENTIAL_COLUMNS}`,
        [id, agentId, name],
      )
      const row = rows[0]
      return row === undefined ? null : toCredentialRecord(row)
    },

    async deleteCredential(id, agentId) {
      return db.transaction(async (tx) => {
        const rows = await tx.query<{ id: string }>(
          'SELECT id FROM webauthn_credentials WHERE id = $1 AND agent_id = $2 FOR UPDATE',
          [id, agentId],
        )
        if (rows.length === 0) return 'not_found'

        // Spec §9.1: refuse if this Agent would be left with neither a
        // password identity nor any OTHER webauthn credential.
        const [{ has_password }] = await tx.query<{ has_password: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM agent_auth_identities WHERE agent_id = $1 AND provider = 'password'
           ) AS has_password`,
          [agentId],
        )
        if (!has_password) {
          const [{ other_count }] = await tx.query<{ other_count: number }>(
            `SELECT count(*)::int AS other_count FROM webauthn_credentials
             WHERE agent_id = $1 AND id <> $2`,
            [agentId, id],
          )
          if (other_count === 0) return 'last_credential'
        }

        await tx.query('DELETE FROM webauthn_credentials WHERE id = $1', [id])
        return 'ok'
      })
    },

    async mintChallenge(input) {
      await db.transaction(async (tx) => {
        await tx.query('DELETE FROM webauthn_challenges WHERE expires_at < now()')
        await tx.query(
          `INSERT INTO webauthn_challenges (nonce, ceremony, agent_id, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [input.nonce, input.ceremony, input.agentId, input.expiresAt],
        )
      })
    },

    async consumeChallenge(nonce, ceremony) {
      const rows = await db.query<{ nonce: string }>(
        `UPDATE webauthn_challenges
         SET consumed_at = now()
         WHERE nonce = $1 AND ceremony = $2 AND consumed_at IS NULL AND expires_at > now()
         RETURNING nonce`,
        [nonce, ceremony],
      )
      return rows.length > 0
    },

    async mintStepUpToken(input) {
      await db.transaction(async (tx) => {
        await tx.query('DELETE FROM webauthn_stepup_tokens WHERE expires_at < now()')
        await tx.query(
          `INSERT INTO webauthn_stepup_tokens (nonce, agent_id, expires_at)
           VALUES ($1, $2, $3)`,
          [input.nonce, input.agentId, input.expiresAt],
        )
      })
    },

    async consumeStepUpToken(nonce) {
      const rows = await db.query<{ nonce: string }>(
        `UPDATE webauthn_stepup_tokens
         SET consumed_at = now()
         WHERE nonce = $1 AND consumed_at IS NULL AND expires_at > now()
         RETURNING nonce`,
        [nonce],
      )
      return rows.length > 0
    },
  }
}
