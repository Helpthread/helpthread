/**
 * `MailboxStore` — the `mailboxes` (migration 009, `src/db/migrate.ts`) seam:
 * the lookups and lifecycle-status mutations the inbound path needs so far.
 *
 * Deliberately narrow. Two operations exist today, each added by the ticket
 * that first needed it:
 *
 * - {@link MailboxStore.getMailboxByAddress} (HT-39): resolve a Gmail push
 *   notification's `emailAddress` to a connected mailbox (gmail-push.md §3).
 *   It returns the row regardless of `status` — the same "store returns the
 *   row, caller applies the policy" split `ConversationStore.getConversation`'s
 *   `includeDeleted` option uses — so the webhook handler
 *   (`src/api/gmail-webhook.ts`) is what decides `status !== 'active'` means
 *   "reject," not this store.
 * - {@link MailboxStore.markNeedsReconnect} (HT-38): mark a mailbox
 *   `needs_reconnect` when its OAuth grant turns out revoked/expired
 *   (`src/mail/gmail-oauth.ts`'s `getAccessToken`, on an `invalid_grant`
 *   response). `watch()` renewal (HT-42) needs the SAME transition on a failed
 *   renewal (gmail-push.md §6) and should call this rather than duplicate the
 *   SQL — that shared reuse is why this is a store module, not a raw query
 *   inline.
 *
 * A fuller `mailboxes` CRUD surface — creating a row on connect, listing,
 * transitioning back to `active` — belongs to HT-40 (the connect/consent flow
 * that actually inserts mailbox rows in the first place).
 */

import type { Db } from '../db/client.js'

/** A mailbox's lifecycle state (migration 009's CHECK constraint). */
export type MailboxStatus = 'active' | 'paused' | 'needs_reconnect'

/** A connected mailbox, as read back from storage. */
export interface MailboxRecord {
  id: string
  address: string
  provider: string
  status: MailboxStatus
}

/** Persistence operations for the `mailboxes` table. See the module doc for why this is intentionally narrow today. */
export interface MailboxStore {
  /**
   * Look up a mailbox by its exact connected address (migration 009's
   * `UNIQUE` constraint on `address` guarantees at most one match). Returns
   * `null` when no mailbox has that address — the caller's job to treat that
   * as "unknown mailbox, reject" (gmail-push.md §3); this method does not
   * apply that policy itself, and does NOT filter by `status` — a `paused`
   * or `needs_reconnect` row is still returned, with its real status, so the
   * caller can distinguish "no such mailbox" from "a mailbox, but not
   * currently active."
   */
  getMailboxByAddress(address: string): Promise<MailboxRecord | null>

  /**
   * Mark `mailboxId` `needs_reconnect` — the operator-visible, resolvable
   * state gmail-push.md §5/§6 puts a mailbox into when its OAuth grant is
   * revoked/expired or a `watch()` renewal fails. A single `UPDATE ...
   * RETURNING id`; idempotent (marking an already-`needs_reconnect` mailbox
   * again is a harmless no-op write, still bumping `updated_at`).
   *
   * Throws if no mailbox exists with this id. Every caller reaches this
   * method with a `mailboxId` it just read a `mailbox_oauth_tokens` row for,
   * and `mailbox_oauth_tokens.mailbox_id` is a `REFERENCES mailboxes(id)`
   * foreign key (migration 010), so a missing mailbox row here is
   * structurally unreachable in practice — thrown rather than silently
   * no-op'd, matching `ConversationStore.setThreadDeliveryStatus`'s same
   * throw-on-zero-rows convention (`src/store/conversations.ts`).
   */
  markNeedsReconnect(mailboxId: string): Promise<void>
}

/** Raw `mailboxes` row shape, before mapping to {@link MailboxRecord}. */
interface MailboxRow {
  id: string
  address: string
  provider: string
  status: string
}

/** Create a {@link MailboxStore} backed by `db`. */
export function createMailboxStore(db: Db): MailboxStore {
  return {
    async getMailboxByAddress(address) {
      const rows = await db.query<MailboxRow>(
        'SELECT id, address, provider, status FROM mailboxes WHERE address = $1',
        [address],
      )
      const row = rows[0]
      return row === undefined ? null : toMailboxRecord(row)
    },

    async markNeedsReconnect(mailboxId) {
      const updated = await db.query<{ id: string }>(
        "UPDATE mailboxes SET status = 'needs_reconnect', updated_at = now() WHERE id = $1 RETURNING id",
        [mailboxId],
      )
      if (updated.length === 0) {
        throw new Error(`markNeedsReconnect: no mailbox with id ${mailboxId}`)
      }
    },
  }
}

function toMailboxRecord(row: MailboxRow): MailboxRecord {
  return {
    id: row.id,
    address: row.address,
    provider: row.provider,
    status: row.status as MailboxStatus,
  }
}
