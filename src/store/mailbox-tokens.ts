/**
 * `MailboxTokenStore` — persistence for `mailbox_oauth_tokens` (migration
 * 010, `src/db/migrate.ts`): the per-mailbox OAuth refresh/access token
 * pair, always encrypted at rest.
 *
 * This module is the encrypt/decrypt boundary migration 010's doc comment
 * calls out as HT-38's to own ("this migration only reserves the column
 * shape a ciphertext value will live in... HT-38 owns the encrypt/decrypt").
 * Every write goes through {@link encrypt} before it reaches the database;
 * every read goes through {@link decrypt} before a plaintext token value
 * leaves this module. Callers (`src/mail/gmail-oauth.ts`) only ever see
 * plaintext strings in and out — the `bytea` ciphertext shape is entirely an
 * implementation detail of this store.
 *
 * ## `upsertTokens` writes the whole row, verbatim
 *
 * `mailbox_id` is the table's PRIMARY KEY (a per-mailbox singleton — one
 * OAuth grant per connected mailbox), so "upsert" is `INSERT ... ON CONFLICT
 * (mailbox_id) DO UPDATE`. Every optional field (`accessToken`,
 * `accessTokenExpiresAt`, `scopes`) that is OMITTED is written as `NULL` —
 * this is a full replace of the row's optional columns, not a partial
 * merge with whatever was there before (the same "persisted verbatim, no
 * second-guessing" convention `ConversationStore.setConversationTags` uses
 * for its own replace-set write). `refreshToken` has no such omit case: the
 * column is `NOT NULL`, and the type requires it on every call.
 *
 * In practice this module has exactly one caller-side calling convention
 * that matters: `gmail-oauth.ts`'s refresh path always passes the (possibly
 * unchanged) `refreshToken` together with a freshly-fetched `accessToken` +
 * `accessTokenExpiresAt`, so the full-replace semantics never surprise it.
 * A future caller that wants to update ONLY the refresh token while
 * preserving a still-valid cached access token would need to read the
 * current row first and pass its access fields back through — this store
 * does not do that merge on a caller's behalf, on purpose (see the
 * module-level open question in the HT-38 implementation report).
 */

import type { Db } from '../db/client.js'
import { decrypt, encrypt } from './token-crypto.js'

/** Input to {@link MailboxTokenStore.upsertTokens}. */
export interface UpsertTokensInput {
  /** The OAuth refresh token, plaintext — encrypted by this method before it is written. Required: the column is `NOT NULL`. */
  refreshToken: string
  /** The current OAuth access token, plaintext — encrypted before it is written. Omitted (or `undefined`) writes `NULL` (no cached access token). */
  accessToken?: string
  /** Wall-clock expiry of `accessToken`. Omitted writes `NULL`. Meaningless without `accessToken` — see {@link MailboxTokenStore.getTokens}'s doc on how a caller should treat that combination. */
  accessTokenExpiresAt?: Date
  /** The token endpoint's raw space-delimited OAuth `scope` string (RFC 6749 §5.1), stored verbatim. Omitted writes `NULL`. */
  scopes?: string
}

/** A mailbox's OAuth tokens as read back from storage — plaintext (already decrypted), camelCase, timestamps as `Date`. */
export interface StoredMailboxTokens {
  mailboxId: string
  refreshToken: string
  /** `null` when no access token has ever been cached for this mailbox. */
  accessToken: string | null
  /** `null` exactly when {@link accessToken} is `null` (in normal operation — see {@link UpsertTokensInput.accessTokenExpiresAt}'s doc for the degenerate case where a caller wrote one without the other). */
  accessTokenExpiresAt: Date | null
  scopes: string | null
  updatedAt: Date
}

/** Persistence for per-mailbox OAuth tokens. See the module doc for the encrypt/decrypt and upsert-replace contracts. */
export interface MailboxTokenStore {
  /**
   * Insert or replace `mailboxId`'s token row. `input.refreshToken` and
   * `input.accessToken` (when given) are encrypted with this store's
   * configured key before the write — see the module doc for the
   * full-row-replace semantics of the optional fields.
   */
  upsertTokens(mailboxId: string, input: UpsertTokensInput): Promise<void>

  /**
   * Read back `mailboxId`'s tokens, decrypted. Returns `null` if no row
   * exists (the mailbox has never completed an OAuth grant). Throws if
   * decryption fails (wrong key, or the stored ciphertext is corrupted/
   * tampered — see `token-crypto.ts`'s `decrypt`) rather than returning a
   * silently-wrong value.
   */
  getTokens(mailboxId: string): Promise<StoredMailboxTokens | null>
}

/** Raw `mailbox_oauth_tokens` row shape, before mapping to {@link StoredMailboxTokens}. */
interface MailboxTokenRow {
  mailbox_id: string
  refresh_token_ciphertext: Uint8Array
  access_token_ciphertext: Uint8Array | null
  access_token_expires_at: Date | string | null
  scopes: string | null
  updated_at: Date | string
}

const TOKEN_COLUMNS =
  'mailbox_id, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, scopes, updated_at'

/**
 * Create a {@link MailboxTokenStore} backed by `db`, encrypting/decrypting
 * with `encryptionKey`. `encryptionKey` must be a 32-byte `Buffer` — decode
 * it once at the composition root via `token-crypto.ts`'s
 * `decodeEncryptionKey` (e.g. from the `HELPTHREAD_TOKEN_ENC_KEY` env var)
 * and pass the result in here. Never hardcode a key or read an env var
 * inside this module — see `token-crypto.ts`'s module doc.
 */
export function createMailboxTokenStore(db: Db, encryptionKey: Buffer): MailboxTokenStore {
  return {
    async upsertTokens(mailboxId, input) {
      const refreshTokenCiphertext = encrypt(input.refreshToken, encryptionKey)
      const accessTokenCiphertext =
        input.accessToken !== undefined ? encrypt(input.accessToken, encryptionKey) : null

      await db.query(
        `INSERT INTO mailbox_oauth_tokens (mailbox_id, refresh_token_ciphertext, access_token_ciphertext, access_token_expires_at, scopes, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (mailbox_id) DO UPDATE SET
           refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
           access_token_ciphertext = EXCLUDED.access_token_ciphertext,
           access_token_expires_at = EXCLUDED.access_token_expires_at,
           scopes = EXCLUDED.scopes,
           updated_at = now()`,
        [
          mailboxId,
          refreshTokenCiphertext,
          accessTokenCiphertext,
          input.accessTokenExpiresAt ?? null,
          input.scopes ?? null,
        ],
      )
    },

    async getTokens(mailboxId) {
      const rows = await db.query<MailboxTokenRow>(
        `SELECT ${TOKEN_COLUMNS} FROM mailbox_oauth_tokens WHERE mailbox_id = $1`,
        [mailboxId],
      )
      const row = rows[0]
      if (row === undefined) {
        return null
      }

      return {
        mailboxId: row.mailbox_id,
        refreshToken: decrypt(row.refresh_token_ciphertext, encryptionKey),
        accessToken:
          row.access_token_ciphertext === null
            ? null
            : decrypt(row.access_token_ciphertext, encryptionKey),
        accessTokenExpiresAt:
          row.access_token_expires_at === null ? null : toDate(row.access_token_expires_at),
        scopes: row.scopes,
        updatedAt: toDate(row.updated_at),
      }
    },
  }
}

/** Coerce a `timestamptz` column value into a `Date` — same defensive coercion as `src/store/conversations.ts`'s `toDate`. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}
