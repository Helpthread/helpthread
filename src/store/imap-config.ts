/**
 * `ImapConfigStore` — persistence for `imap_mailbox_config` (migration 028,
 * `src/db/migrate.ts`): the non-secret IMAP/SMTP connection parameters for a
 * per-mailbox IMAP/SMTP connection (HT-101 Stage 2a-i). See migration 028's
 * doc comment for why this is a separate table from `imap_mailbox_credentials`
 * (`./imap-credentials.ts`) — this store never reads or writes ciphertext,
 * and never needs to: the password lives entirely in that sibling store.
 *
 * `mailbox_id` is the table's PRIMARY KEY (a per-mailbox singleton — one IMAP
 * connection config per connected mailbox), so "upsert" is `INSERT ... ON
 * CONFLICT (mailbox_id) DO UPDATE`, the same shape `MailboxTokenStore
 * .upsertTokens` (`./mailbox-tokens.ts`) and `GmailWatchStateStore.setCursor`
 * (`./gmail-watch-state.ts`) use for their own per-mailbox singleton tables.
 * `upsertConfig` is a full replace of every column on conflict — there is no
 * optional field here to carry a "leave unchanged" omission semantics for
 * (unlike `UpsertTokensInput`'s optional `accessToken`/`scopes`): every field
 * of {@link ImapConnectionConfig} is required, so every call supplies the
 * whole row.
 */

import type { Db, Queryable } from '../db/client.js'

/**
 * The non-secret parameters of a per-mailbox IMAP/SMTP connection — every
 * field `imap_mailbox_config` (migration 028) carries EXCEPT the password,
 * which lives in `imap_mailbox_credentials` (`./imap-credentials.ts`).
 */
export interface ImapConnectionConfig {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  username: string
  secure: boolean
}

/** Persistence for one mailbox's IMAP/SMTP connection config. See the module doc. */
export interface ImapConfigStore {
  /**
   * Insert or replace `mailboxId`'s connection config — an upsert (module
   * doc): safe to call whether or not a row already exists, and always a
   * FULL replace of every column (no partial-merge semantics; every field
   * of {@link ImapConnectionConfig} is required on every call).
   *
   * Optionally runs against a caller-supplied `tx` (`Db.transaction`'s
   * `Queryable`) instead of the bound `db`, so a connect flow can commit
   * this write alongside the `mailboxes` row and the credential write as
   * ONE atomic unit — the same `tx?` pattern `MailboxTokenStore.upsertTokens`
   * and `MailboxStore.upsertConnectedMailbox` already use for their own
   * connect-time atomicity. Omitted, it runs standalone on `db`.
   */
  upsertConfig(mailboxId: string, config: ImapConnectionConfig, tx?: Queryable): Promise<void>

  /**
   * Read back `mailboxId`'s connection config. Returns `null` if no row
   * exists (this mailbox has never been configured for IMAP/SMTP, or is a
   * different provider entirely).
   */
  getConfig(mailboxId: string): Promise<ImapConnectionConfig | null>
}

/** Raw `imap_mailbox_config` row shape, before mapping to {@link ImapConnectionConfig}. */
interface ImapConfigRow {
  imap_host: string
  imap_port: number
  smtp_host: string
  smtp_port: number
  username: string
  secure: boolean
}

const CONFIG_COLUMNS = 'imap_host, imap_port, smtp_host, smtp_port, username, secure'

/** Create an {@link ImapConfigStore} backed by `db`. */
export function createImapConfigStore(db: Db): ImapConfigStore {
  return {
    async upsertConfig(mailboxId, config, tx) {
      await (tx ?? db).query(
        `INSERT INTO imap_mailbox_config (mailbox_id, imap_host, imap_port, smtp_host, smtp_port, username, secure, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (mailbox_id) DO UPDATE SET
           imap_host = EXCLUDED.imap_host,
           imap_port = EXCLUDED.imap_port,
           smtp_host = EXCLUDED.smtp_host,
           smtp_port = EXCLUDED.smtp_port,
           username = EXCLUDED.username,
           secure = EXCLUDED.secure,
           updated_at = now()`,
        [
          mailboxId,
          config.imapHost,
          config.imapPort,
          config.smtpHost,
          config.smtpPort,
          config.username,
          config.secure,
        ],
      )
    },

    async getConfig(mailboxId) {
      const rows = await db.query<ImapConfigRow>(
        `SELECT ${CONFIG_COLUMNS} FROM imap_mailbox_config WHERE mailbox_id = $1`,
        [mailboxId],
      )
      const row = rows[0]
      if (row === undefined) {
        return null
      }
      return {
        imapHost: row.imap_host,
        imapPort: row.imap_port,
        smtpHost: row.smtp_host,
        smtpPort: row.smtp_port,
        username: row.username,
        secure: row.secure,
      }
    },
  }
}
