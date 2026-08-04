/**
 * `ImapCredentialStore` — persistence for `imap_mailbox_credentials`
 * (migration 028, `src/db/migrate.ts`): the per-mailbox IMAP/SMTP app
 * password, always encrypted at rest (HT-101 Stage 2a-i).
 *
 * This module is the encrypt/decrypt boundary migration 028's doc comment
 * calls out — the same "reserve the column, a dedicated store owns the
 * crypto" split `mailbox-tokens.ts` established for `mailbox_oauth_tokens`
 * (migration 010). Every write goes through `token-crypto.ts`'s
 * {@link encrypt} before it reaches the database; every read goes through
 * {@link decrypt} before a plaintext password leaves this module. This is
 * the SAME `token-crypto.ts` AES-256-GCM envelope `mailbox-tokens.ts`
 * already depends on — one crypto module, two callers, no second envelope
 * format to reason about.
 *
 * ## Write-only contract — never returned over any HTTP API
 *
 * {@link ImapCredentialStore.getPassword} exists ONLY for internal
 * fetch/send use (the IMAP fetch adapter and SMTP sender authenticating
 * against the operator's mail server, `src/providers/adapters/imap/*` /
 * `smtp/*`) — never for a "get mailbox config" style read a settings screen
 * or API response would serve. Exactly like `MailboxTokenStore.getTokens`'s
 * plaintext OAuth tokens, a decrypted app password must never cross an HTTP
 * response boundary; the config half of a mailbox connection
 * (`./imap-config.ts`) is the only piece ever meant to be displayed back to
 * an operator, and it deliberately carries no password field at all.
 *
 * ## Never logged
 *
 * Neither the plaintext password nor its ciphertext bytes are ever passed to
 * a logger, thrown into an error message, or otherwise surfaced outside this
 * module's own read/write pair — matching `token-crypto.ts`'s own "never
 * include the ciphertext or key material in the thrown message" discipline
 * for its `decrypt` failure path.
 */

import type { Db, Queryable } from '../db/client.js'
import { decrypt, encrypt } from './token-crypto.js'

/** Persistence for one mailbox's IMAP/SMTP app password. See the module doc for the encrypt/decrypt and write-only-internal-use contracts. */
/**
 * The stored ciphertext for `mailboxId` could not be decrypted — a wrong
 * `HELPTHREAD_TOKEN_ENC_KEY`, or a tampered/corrupt row. Distinct from a
 * database fault, deliberately: callers contain THIS (one mailbox is
 * misconfigured; the others are fine) while letting a store fault propagate,
 * because a transient database problem must be retried, not recorded as a
 * permanent per-mailbox failure (2026-07-31).
 *
 * Carries no ciphertext and no key material — only which mailbox.
 */
export class ImapCredentialDecryptError extends Error {
  readonly mailboxId: string

  constructor(mailboxId: string, options?: { cause?: unknown }) {
    super(`imap credential for mailbox ${mailboxId} could not be decrypted`, options)
    this.name = 'ImapCredentialDecryptError'
    this.mailboxId = mailboxId
  }
}

export interface ImapCredentialStore {
  /**
   * Insert or replace `mailboxId`'s password — encrypted with this store's
   * configured key before the write (module doc). An upsert (`INSERT ...
   * ON CONFLICT (mailbox_id) DO UPDATE`), the same per-mailbox-singleton
   * shape `MailboxTokenStore.upsertTokens` uses for `mailbox_oauth_tokens`.
   *
   * Optionally runs against a caller-supplied `tx` (`Db.transaction`'s
   * `Queryable`) instead of the bound `db`, so a connect flow can commit
   * this alongside the `mailboxes` row and the `imap_mailbox_config` write
   * as ONE atomic unit — the same `tx?` pattern `MailboxTokenStore
   * .upsertTokens` and `ImapConfigStore.upsertConfig` already use for their
   * own connect-time atomicity. Omitted, it runs standalone on `db`.
   *
   * NEVER log `password` or the ciphertext this method derives from it —
   * see the module doc.
   */
  upsertPassword(mailboxId: string, password: string, tx?: Queryable): Promise<void>

  /**
   * Read back `mailboxId`'s password, decrypted. Returns `null` if no row
   * exists (this mailbox has never had an app password configured). Throws
   * if decryption fails (wrong key, or the stored ciphertext is
   * corrupted/tampered — see `token-crypto.ts`'s `decrypt`) rather than
   * returning a silently-wrong value.
   *
   * Internal use ONLY — the IMAP fetch adapter and SMTP sender authenticating
   * against the operator's mail server. NEVER return this value over any
   * HTTP API — see the module doc's write-only contract.
   */
  getPassword(mailboxId: string): Promise<string | null>
}

/** Raw `imap_mailbox_credentials` row shape. */
interface ImapCredentialRow {
  password_ciphertext: Uint8Array
}

/**
 * Create an {@link ImapCredentialStore} backed by `db`, encrypting/decrypting
 * with `encryptionKey`. `encryptionKey` must be a 32-byte `Buffer` — decode
 * it once at the composition root via `token-crypto.ts`'s
 * `decodeEncryptionKey` and pass the result in here, exactly as
 * `createMailboxTokenStore` already documents. Never hardcode a key or read
 * an env var inside this module.
 */
export function createImapCredentialStore(db: Db, encryptionKey: Buffer): ImapCredentialStore {
  return {
    async upsertPassword(mailboxId, password, tx) {
      const passwordCiphertext = encrypt(password, encryptionKey)
      await (tx ?? db).query(
        `INSERT INTO imap_mailbox_credentials (mailbox_id, password_ciphertext, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (mailbox_id) DO UPDATE SET
           password_ciphertext = EXCLUDED.password_ciphertext,
           updated_at = now()`,
        [mailboxId, passwordCiphertext],
      )
    },

    async getPassword(mailboxId) {
      const rows = await db.query<ImapCredentialRow>(
        'SELECT password_ciphertext FROM imap_mailbox_credentials WHERE mailbox_id = $1',
        [mailboxId],
      )
      const row = rows[0]
      if (row === undefined) {
        return null
      }
      // Typed at the crypto boundary so callers can tell "this one mailbox's
      // credential is unreadable" from "the database is unwell". The `await`
      // above has already resolved, so anything thrown here is decryption,
      // never a store fault.
      try {
        return decrypt(row.password_ciphertext, encryptionKey)
      } catch (cause) {
        throw new ImapCredentialDecryptError(mailboxId, { cause })
      }
    },
  }
}
