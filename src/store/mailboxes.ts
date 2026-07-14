/**
 * `MailboxStore` — persistence for the `mailboxes` table's lifecycle status
 * (migration 009, `src/db/migrate.ts`).
 *
 * Deliberately narrow: HT-38 (this ticket, OAuth token persistence/refresh)
 * only needs ONE mutation — marking a mailbox `needs_reconnect` when its
 * OAuth refresh token turns out to be revoked or expired
 * (`src/mail/gmail-oauth.ts`'s `getAccessToken`, on an `invalid_grant`
 * response). A full `mailboxes` CRUD surface — creating a row on connect,
 * listing mailboxes, resolving an `emailAddress` to one, transitioning back
 * to `active` — belongs to HT-40 (the connect/consent flow, which is what
 * actually inserts mailbox rows in the first place). `watch()` renewal
 * (HT-42) needs this SAME needs_reconnect transition on a failed renewal
 * (specs/mail/gmail-push.md §6: "mark the mailbox needs-reconnect and
 * surface it") and should call this method rather than duplicate the SQL —
 * that shared reuse is why this is a small store module rather than a raw
 * query buried inline in `gmail-oauth.ts`.
 */

import type { Db } from '../db/client.js'

/** Persistence operations for a mailbox's own lifecycle state. See the module doc for why this is intentionally narrow today. */
export interface MailboxStore {
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

/** Create a {@link MailboxStore} backed by `db`. */
export function createMailboxStore(db: Db): MailboxStore {
  return {
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
