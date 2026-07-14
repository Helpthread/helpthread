/**
 * `MailboxStore` — the minimal read seam onto `mailboxes` (migration 009,
 * `src/db/migrate.ts`) that the Gmail push webhook needs (HT-39;
 * specs/mail/inbound-ingestion.md §2, gmail-push.md §3).
 *
 * Deliberately narrow: gmail-push.md §3 resolves a push notification's
 * `emailAddress` to "a known, active connected mailbox" and rejects the
 * notification otherwise — {@link MailboxStore.getMailboxByAddress} is
 * exactly the lookup that resolution needs, nothing more. It returns the row
 * regardless of `status` (the same "store returns the row, caller applies
 * the policy" split `ConversationStore.getConversation`'s `includeDeleted`
 * option uses) — the webhook handler (`src/api/gmail-webhook.ts`) is what
 * decides `status !== 'active'` means "reject," not this store. Mailbox
 * WRITES (connecting a mailbox, HT-40; flipping status on a failed
 * `watch()`/expired cursor, gmail-push.md §5-§6) are out of this ticket's
 * scope and land with whichever ticket first needs them.
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
