/**
 * `VercelConnectionStore` — persistence for `vercel_connections` (migration
 * 030, `src/db/migrate.ts`; HT-119). See that migration's doc comment for
 * the full reasoning — this module is deliberately thin over it, the same
 * "reserve the column, a dedicated store owns the crypto" split
 * `imap-credentials.ts` and `mailbox-tokens.ts` already establish for
 * `token-crypto.ts`.
 *
 * ## Why a connection, not a token, is the unit of storage
 *
 * The operator connects ONE Vercel account to their own engine (CHARTER.md's
 * never-hold-operator-credentials invariant — the credential lives in the
 * operator's own database, encrypted, never in Resonant IQ's hands). This
 * store models that connection as a first-class row rather than a bare env
 * var precisely so the non-negotiable conditions from the two adversarial
 * design constraints have somewhere to attach: an immutable `team_id` every
 * `module_installs` row can trust, a `connected_by_agent_id` for provenance,
 * and a `token_fingerprint` an operator can recognize without the engine
 * ever re-exposing the reversible secret.
 *
 * ## The plaintext token NEVER leaves {@link VercelConnectionStore.getToken}
 *
 * Exactly like `ImapCredentialStore.getPassword`'s write-only-into-outbound-
 * fetches contract: {@link VercelConnectionStore.getToken} exists ONLY for
 * the deploy adapter to authenticate its own outbound calls to Vercel's API.
 * No method on this interface returns it inside a value shaped like an API
 * response ({@link VercelConnectionRecord} never carries a `token` field),
 * and nothing in this module logs it or embeds it in a thrown error —
 * matching condition 1's "never return the plaintext token from any API,
 * log, or error" verbatim.
 *
 * ## This connection gets its OWN encryption key, not the mailbox key
 *
 * `imap-credentials.ts` and `mailbox-tokens.ts` share `HELPTHREAD_TOKEN_ENC_
 * KEY` because they protect the same class of secret (credentials to the
 * operator's OWN mail infrastructure) — a compromise of one already implies
 * the other is exposed to the same blast radius. A Vercel connection token
 * is not that class: per `../modules/deploy/vercel-adapter.ts`'s module doc,
 * it is team-admin-equivalent over the operator's ENTIRE Vercel account —
 * project creation/deletion, every env var (including other members'
 * secrets), domains, membership. `module-license.ts` makes exactly this
 * argument for its own key and this store follows its precedent verbatim:
 * the caller (composition root) MUST decode a key from a var dedicated to
 * this store — `HELPTHREAD_VERCEL_TOKEN_ENC_KEY`, never the shared mailbox
 * key — via `token-crypto.ts`'s `decodeEncryptionKey`, exactly as
 * `createModuleLicenseStore` and `createImapCredentialStore` already do for
 * their own keys. A leaked mailbox key must not also decrypt the most
 * powerful credential this engine holds, and vice versa.
 *
 * Stated honestly (same caveat `module-license.ts` states for itself):
 * at-rest encryption protects exactly one thing — a stolen COPY of the
 * database does not hand over a usable token along with it. It does NOT
 * protect against a compromised RUNNING engine process, which already holds
 * the decryption key in memory and can call {@link
 * VercelConnectionStore.getToken} itself. The threat model here is a
 * database dump, not a compromised running process.
 *
 * ## `team_id` immutability is enforced twice, on purpose
 *
 * Migration 030's `vercel_connections_team_id_immutable` trigger is the
 * real enforcement (a database-level guarantee no application bug can
 * bypass). This store additionally never exposes an `updateTeamId` (or any
 * general-purpose `update`) method at all — {@link
 * VercelConnectionStore.connect} only INSERTs, {@link
 * VercelConnectionStore.recordVerification} only touches
 * `last_verified_at`, and {@link VercelConnectionStore.revoke} only touches
 * `revoked_at`. Belt-and-suspenders deliberately: the trigger is the
 * invariant the schema guarantees; the narrow interface is what makes it
 * obvious from reading this file alone that nothing here could even attempt
 * to violate it.
 */

import type { Db } from '../db/client.js'
import { decrypt, encrypt } from './token-crypto.js'

/** A `vercel_connections` row, minus the ciphertext — see the module doc for why the token itself is never part of this shape. */
export interface VercelConnectionRecord {
  id: string
  teamId: string
  tokenFingerprint: string
  connectedByAgentId: string
  connectedAt: Date
  lastVerifiedAt: Date | null
  revokedAt: Date | null
}

/** Input to {@link VercelConnectionStore.connect}. */
export interface NewVercelConnection {
  teamId: string
  /** The bearer token to encrypt and store. Never logged, never echoed back — see the module doc. */
  token: string
  /** A short, ONE-WAY display value the caller has already derived from `token` (e.g. a truncated hex digest) — this store persists it as-is and never derives it itself, so it never has to touch the plaintext beyond the one `encrypt` call. */
  tokenFingerprint: string
  connectedByAgentId: string
}

/** Raw `vercel_connections` row shape, before mapping to {@link VercelConnectionRecord}. */
interface VercelConnectionRow {
  id: string
  team_id: string
  token_fingerprint: string
  connected_by_agent_id: string
  connected_at: Date | string
  last_verified_at: Date | string | null
  revoked_at: Date | string | null
}

const CONNECTION_COLUMNS =
  'id, team_id, token_fingerprint, connected_by_agent_id, connected_at, last_verified_at, revoked_at'

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value)
}

function toConnectionRecord(row: VercelConnectionRow): VercelConnectionRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    tokenFingerprint: row.token_fingerprint,
    connectedByAgentId: row.connected_by_agent_id,
    connectedAt: toDate(row.connected_at),
    lastVerifiedAt: toNullableDate(row.last_verified_at),
    revokedAt: toNullableDate(row.revoked_at),
  }
}

/**
 * Thrown by {@link VercelConnectionStore.connect} when an active connection
 * already exists — surfaces migration 030's `vercel_connections_one_active`
 * partial unique index as a typed error rather than a raw Postgres unique-
 * violation the caller has to sniff for. v1 supports exactly one connected
 * Vercel account (condition 1); revoke the existing one first.
 */
export class VercelConnectionAlreadyActiveError extends Error {
  constructor() {
    super(
      'vercel-connection: an active Vercel connection already exists — revoke it before connecting another',
    )
    this.name = 'VercelConnectionAlreadyActiveError'
  }
}

/** Persistence for `vercel_connections`. See the module doc for the token-secrecy and team_id-immutability contracts. */
export interface VercelConnectionStore {
  /**
   * Encrypt `input.token` and insert a new active connection row. Throws
   * {@link VercelConnectionAlreadyActiveError} if an active (non-revoked)
   * connection already exists — migration 030's partial unique index is
   * what actually enforces this; this call surfaces that as a typed error
   * rather than a raw unique-violation.
   */
  connect(input: NewVercelConnection): Promise<VercelConnectionRecord>

  /** Look up a connection by id, active or revoked. `null` if no row has that id. */
  get(id: string): Promise<VercelConnectionRecord | null>

  /** The current active (non-revoked) connection, or `null` if none is connected. At most one can ever exist (migration 030's partial unique index). */
  getActive(): Promise<VercelConnectionRecord | null>

  /**
   * Decrypt and return `id`'s bearer token. Internal use ONLY — the deploy
   * adapter authenticating its own outbound calls to Vercel's API. NEVER
   * return this value over any HTTP API, log it, or embed it in a thrown
   * error — see the module doc. Throws if `id` doesn't exist or decryption
   * fails (wrong key, or the stored ciphertext is corrupted/tampered).
   */
  getToken(id: string): Promise<string>

  /** Stamp `last_verified_at = now()` on `id` — called after the adapter successfully re-verifies the connection is still live against Vercel's API. Throws if `id` doesn't exist. */
  recordVerification(id: string): Promise<void>

  /**
   * Stamp `revoked_at = now()` on `id`, freeing migration 030's partial
   * unique index to accept a new active connection. Idempotent: revoking an
   * already-revoked connection is a no-op (its `revoked_at` is left as
   * originally recorded, not bumped to `now()` again). Throws if `id`
   * doesn't exist.
   */
  revoke(id: string): Promise<void>
}

/**
 * Create a {@link VercelConnectionStore} backed by `db`, encrypting/
 * decrypting with `encryptionKey`. `encryptionKey` must be a 32-byte
 * `Buffer` decoded from `HELPTHREAD_VERCEL_TOKEN_ENC_KEY` specifically — see
 * the module doc's "This connection gets its OWN encryption key" section
 * for why that must be a key dedicated to this store, never the shared
 * `HELPTHREAD_TOKEN_ENC_KEY` mailbox key or `HELPTHREAD_MODULE_LICENSE_ENC_
 * KEY`. Decode it once at the composition root via `token-crypto.ts`'s
 * `decodeEncryptionKey`, exactly as `createModuleLicenseStore` and
 * `createImapCredentialStore` already document for their own keys. Never
 * hardcode a key or read an env var inside this module.
 */
export function createVercelConnectionStore(db: Db, encryptionKey: Buffer): VercelConnectionStore {
  return {
    async connect(input) {
      const tokenCiphertext = encrypt(input.token, encryptionKey)
      try {
        const rows = await db.query<VercelConnectionRow>(
          `INSERT INTO vercel_connections (team_id, token_ciphertext, token_fingerprint, connected_by_agent_id)
           VALUES ($1, $2, $3, $4)
           RETURNING ${CONNECTION_COLUMNS}`,
          [input.teamId, tokenCiphertext, input.tokenFingerprint, input.connectedByAgentId],
        )
        return toConnectionRecord(rows[0])
      } catch (cause) {
        // PGlite/Postgres report a unique-violation as error code 23505.
        // Narrow to that code so an unrelated failure (e.g. the
        // connected_by_agent_id FK) still propagates as itself.
        if (isUniqueViolation(cause)) {
          throw new VercelConnectionAlreadyActiveError()
        }
        throw cause
      }
    },

    async get(id) {
      const rows = await db.query<VercelConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM vercel_connections WHERE id = $1`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? null : toConnectionRecord(row)
    },

    async getActive() {
      const rows = await db.query<VercelConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM vercel_connections WHERE revoked_at IS NULL`,
      )
      const row = rows[0]
      return row === undefined ? null : toConnectionRecord(row)
    },

    async getToken(id) {
      const rows = await db.query<{ token_ciphertext: Uint8Array }>(
        'SELECT token_ciphertext FROM vercel_connections WHERE id = $1',
        [id],
      )
      const row = rows[0]
      if (row === undefined) {
        throw new Error(`vercel-connection: no connection with id ${id}`)
      }
      // Never include id-adjacent secret material in a thrown message —
      // token-crypto.ts's own decrypt() already keeps ciphertext/key out of
      // its error; this call site adds nothing that could leak either.
      return decrypt(row.token_ciphertext, encryptionKey)
    },

    async recordVerification(id) {
      const rows = await db.query<{ id: string }>(
        'UPDATE vercel_connections SET last_verified_at = now() WHERE id = $1 RETURNING id',
        [id],
      )
      if (rows.length === 0) {
        throw new Error(`vercel-connection: no connection with id ${id}`)
      }
    },

    async revoke(id) {
      const rows = await db.query<{ id: string }>(
        `UPDATE vercel_connections SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [id],
      )
      if (rows.length === 0) {
        // Distinguish "already revoked" (a legitimate idempotent no-op)
        // from "doesn't exist" (a caller bug) so the latter isn't silently
        // swallowed.
        const existing = await db.query<{ id: string }>(
          'SELECT id FROM vercel_connections WHERE id = $1',
          [id],
        )
        if (existing.length === 0) {
          throw new Error(`vercel-connection: no connection with id ${id}`)
        }
      }
    },
  }
}

/** Testable helper stored outside the closure so it can also be unit-covered directly if needed. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  )
}
