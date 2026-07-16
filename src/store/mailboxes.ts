/**
 * `MailboxStore` — the `mailboxes` (migration 009, `src/db/migrate.ts`) seam:
 * the lookups and lifecycle-status mutations the inbound path needs so far.
 *
 * Deliberately narrow. Operations exist today, each added by the ticket
 * that first needed it:
 *
 * - {@link MailboxStore.getMailboxByAddress} (HT-39): resolve a Gmail push
 *   notification's `emailAddress` to a connected mailbox (gmail-push.md §3).
 *   It returns the row regardless of `status` — the same "store returns the
 *   row, caller applies the policy" split `ConversationStore.getConversation`'s
 *   `includeDeleted` option uses — so the webhook handler
 *   (`src/api/gmail-webhook.ts`) is what decides `status !== 'active'` means
 *   "reject," not this store.
 * - {@link MailboxStore.getMailboxById} (HT-41): the same lookup, keyed by
 *   id rather than address — the reconcile handler
 *   (`src/mail/gmail-reconcile.ts`) already has a `mailboxId` (from the
 *   queue job) and must re-check the mailbox's CURRENT status before/while
 *   reconciling (gmail-push.md §3, §5), never trusting the enqueue-time
 *   snapshot. Same "returns the row regardless of status" split as
 *   `getMailboxByAddress`.
 * - {@link MailboxStore.markNeedsReconnect} (HT-38): mark a mailbox
 *   `needs_reconnect` when its OAuth grant turns out revoked/expired
 *   (`src/mail/gmail-oauth.ts`'s `getAccessToken`, on an `invalid_grant`
 *   response). `watch()` renewal (HT-42) needs the SAME transition on a failed
 *   renewal (gmail-push.md §6) and should call this rather than duplicate the
 *   SQL — that shared reuse is why this is a store module, not a raw query
 *   inline.
 * - {@link MailboxStore.markPaused} (HT-41): mark a mailbox `paused` — the
 *   deliberate dogfood response to an expired (404) Gmail history cursor
 *   (gmail-push.md §5): "pause the mailbox and flag it for manual
 *   rebaseline," rather than an automatic full-mailbox resync.
 * - {@link MailboxStore.upsertConnectedMailbox} (HT-40; gmail-connect.md
 *   §4-§5): the connect/consent flow's own write — creates the `mailboxes`
 *   row on a first-ever connect, or reactivates an existing `paused`/
 *   `needs_reconnect` row to `active` on a reconnect. Upsert BY `address`
 *   (migration 009's `UNIQUE` constraint) is what makes a reconnect
 *   idempotent: re-running connect for the same account never collides with
 *   its own prior row.
 * - {@link MailboxStore.listActiveMailboxes} (HT-42): list every `active`
 *   mailbox, ordered by `created_at` — the per-mailbox source the daily
 *   watch-renewal + reconciliation-sweep cron (`../mail/gmail-watch-
 *   maintenance.ts`, gmail-push.md §6) iterates. `paused`/`needs_reconnect`
 *   mailboxes are excluded by the query itself, not filtered by the caller
 *   (unlike `getMailboxByAddress`/`getMailboxById` above): neither needs
 *   `watch()` re-armed (a `paused` mailbox isn't being ingested; a
 *   `needs_reconnect` one has a dead grant `watch()` can't fix) nor a
 *   reconcile job enqueued, for the same reason.
 * - {@link MailboxStore.markDisconnected} (HT-47; specs/mail/gmail-connect.md's
 *   disconnect section): mark a mailbox `disconnected` — the terminal,
 *   operator-initiated state the disconnect admin action puts a mailbox into
 *   (migration 017 widens the `status` CHECK to allow it). Distinct from
 *   `paused`/`needs_reconnect` (both are states the PIPELINE puts a mailbox
 *   into automatically); `disconnected` only ever follows an explicit
 *   operator disconnect (`../mail/gmail-disconnect.ts`), which runs this
 *   alongside deleting the mailbox's `mailbox_oauth_tokens`/
 *   `gmail_watch_state` rows in ONE transaction — same `tx?` pattern as
 *   {@link upsertConnectedMailbox}.
 *
 * A fuller `mailboxes` CRUD surface (beyond the operations above) is still
 * narrower than a general CRUD module — add operations as the ticket that
 * needs them requires.
 */

import type { Db, Queryable } from '../db/client.js'

/** A mailbox's lifecycle state (migration 009's CHECK constraint, widened by migration 017 to add `'disconnected'`). */
export type MailboxStatus = 'active' | 'paused' | 'needs_reconnect' | 'disconnected'

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
   * Look up a mailbox by id. Returns `null` when no mailbox has that id.
   * Same "store returns the row regardless of status, caller applies
   * policy" split as {@link getMailboxByAddress} — see the module doc.
   */
  getMailboxById(mailboxId: string): Promise<MailboxRecord | null>

  /**
   * Mark `mailboxId` `needs_reconnect` — the operator-visible, resolvable
   * state gmail-push.md §5/§6 puts a mailbox into when its OAuth grant is
   * revoked/expired or a `watch()` renewal fails. A single `UPDATE ...
   * RETURNING id`; idempotent (marking an already-`needs_reconnect` mailbox
   * again is a harmless no-op write, still bumping `updated_at`).
   *
   * Guarded with `AND status <> 'disconnected'`: `disconnected` is terminal
   * (§8c) and only an explicit operator disconnect
   * (`../mail/gmail-disconnect.ts`) may leave it — an automatic pipeline
   * transition (a dead OAuth grant, a failed `watch()` renewal) must never
   * silently overwrite it. This is exactly the race an HT-47 disconnect can
   * trigger: revoking the grant is what makes a concurrent in-flight
   * refresh fail with `invalid_grant`, so without the guard that failure's
   * `markNeedsReconnect` call would immediately undo the operator's
   * disconnect. When the guard holds (the row exists but is already
   * `disconnected`), this is a silent no-op — NOT the missing-row case
   * below, which still throws.
   *
   * Throws if no mailbox exists with this id at all. Every caller reaches
   * this method with a `mailboxId` it just read a `mailbox_oauth_tokens` row
   * for, and `mailbox_oauth_tokens.mailbox_id` is a `REFERENCES
   * mailboxes(id)` foreign key (migration 010), so a genuinely missing
   * mailbox row here is structurally unreachable in practice — thrown
   * rather than silently no-op'd, matching
   * `ConversationStore.setThreadDeliveryStatus`'s same throw-on-zero-rows
   * convention (`src/store/conversations.ts`). Distinguishing "no such row"
   * from "row exists but guard held" costs one extra `SELECT`, taken only
   * when the `UPDATE` matches zero rows (the uncommon path).
   */
  markNeedsReconnect(mailboxId: string): Promise<void>

  /**
   * Mark `mailboxId` `paused` — gmail-push.md §5's dogfood response to an
   * expired (404) Gmail history cursor: "pause the mailbox and flag it for
   * manual rebaseline," rather than an automatic full-mailbox resync. Same
   * shape as {@link markNeedsReconnect}, INCLUDING its `AND status <>
   * 'disconnected'` guard and the same "guard held → silent no-op, row
   * missing entirely → throw" split — see that method's doc for the full
   * rationale (a reconcile job's cursor-expiry pause is just as capable of
   * racing an operator disconnect as a token-refresh failure is).
   */
  markPaused(mailboxId: string): Promise<void>

  /**
   * Mark `mailboxId` `disconnected` — the terminal state HT-47's disconnect
   * admin action puts a mailbox into (see the module doc). Same shape as
   * {@link markNeedsReconnect}/{@link markPaused}: a single `UPDATE ...
   * RETURNING id`, idempotent, throws if no mailbox exists with this id.
   *
   * Optionally runs against a caller-supplied `tx` (`Db.transaction`'s
   * `Queryable`) instead of the bound `db`, so the disconnect service can
   * commit this alongside deleting the mailbox's token and watch-state rows
   * as ONE atomic unit (`../mail/gmail-disconnect.ts`) — the same reason
   * {@link upsertConnectedMailbox} takes `tx`. Omitted, it runs standalone on
   * `db`.
   */
  markDisconnected(mailboxId: string, tx?: Queryable): Promise<void>

  /**
   * Insert a new connected mailbox, or — on a **reconnect** for an address
   * that already exists — reactivate it to `active` (gmail-connect.md §4
   * step 5, §5's idempotent-by-address reconnect). `provider` is written on
   * every call (including a reconnect), matching `EXCLUDED.provider`, so a
   * reconnect always leaves the row's `provider` in sync with the fresh
   * grant rather than whatever the row previously held.
   *
   * `INSERT ... ON CONFLICT (address) DO UPDATE` — never a plain `INSERT`,
   * which would violate migration 009's `UNIQUE(address)` constraint on a
   * reconnect, and never a plain `UPDATE`, which would silently no-op on a
   * genuinely new address. One statement handles both "never connected
   * before" and "reconnecting a `paused`/`needs_reconnect` mailbox" — the
   * latter is exactly the "transitioning back to `active`" this store's
   * module doc used to reserve for this ticket.
   *
   * Optionally runs against a caller-supplied `tx` (`Db.transaction`'s
   * `Queryable`) instead of the bound `db`, so the connect flow can commit
   * this insert, the token write, and the watch-state seed as ONE atomic
   * unit (gmail-connect.md §4 step 5) — a partial connect (an `active`
   * mailbox with no cursor, silently un-ingesting) is worse than none.
   * Omitted, it runs standalone on `db` exactly as before.
   */
  upsertConnectedMailbox(
    input: { address: string; provider: string },
    tx?: Queryable,
  ): Promise<MailboxRecord>

  /**
   * List every mailbox currently `active`, ordered by `created_at` — the
   * per-mailbox source the daily watch-renewal + reconciliation-sweep cron
   * (HT-42, `../mail/gmail-watch-maintenance.ts`, gmail-push.md §6)
   * iterates. `paused`/`needs_reconnect` mailboxes are excluded by the
   * query itself, not filtered by the caller (see the module doc). Returns
   * `[]` when no mailbox is currently active.
   */
  listActiveMailboxes(): Promise<MailboxRecord[]>
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

    async getMailboxById(mailboxId) {
      const rows = await db.query<MailboxRow>(
        'SELECT id, address, provider, status FROM mailboxes WHERE id = $1',
        [mailboxId],
      )
      const row = rows[0]
      return row === undefined ? null : toMailboxRecord(row)
    },

    async markNeedsReconnect(mailboxId) {
      const updated = await db.query<{ id: string }>(
        "UPDATE mailboxes SET status = 'needs_reconnect', updated_at = now() " +
          "WHERE id = $1 AND status <> 'disconnected' RETURNING id",
        [mailboxId],
      )
      if (updated.length === 0) {
        await assertMailboxExists(db, mailboxId, 'markNeedsReconnect')
      }
    },

    async markPaused(mailboxId) {
      const updated = await db.query<{ id: string }>(
        "UPDATE mailboxes SET status = 'paused', updated_at = now() " +
          "WHERE id = $1 AND status <> 'disconnected' RETURNING id",
        [mailboxId],
      )
      if (updated.length === 0) {
        await assertMailboxExists(db, mailboxId, 'markPaused')
      }
    },

    async markDisconnected(mailboxId, tx) {
      const updated = await (tx ?? db).query<{ id: string }>(
        "UPDATE mailboxes SET status = 'disconnected', updated_at = now() WHERE id = $1 RETURNING id",
        [mailboxId],
      )
      if (updated.length === 0) {
        throw new Error(`markDisconnected: no mailbox with id ${mailboxId}`)
      }
    },

    async upsertConnectedMailbox(input, tx) {
      const rows = await (tx ?? db).query<MailboxRow>(
        `INSERT INTO mailboxes (address, provider)
         VALUES ($1, $2)
         ON CONFLICT (address) DO UPDATE SET
           status = 'active',
           provider = EXCLUDED.provider,
           updated_at = now()
         RETURNING id, address, provider, status`,
        [input.address, input.provider],
      )
      return toMailboxRecord(rows[0])
    },

    async listActiveMailboxes() {
      const rows = await db.query<MailboxRow>(
        "SELECT id, address, provider, status FROM mailboxes WHERE status = 'active' ORDER BY created_at",
      )
      return rows.map(toMailboxRecord)
    },
  }
}

/**
 * Throws `<label>: no mailbox with id <mailboxId>` unless a `mailboxes` row
 * with that id exists — called only when `markNeedsReconnect`/`markPaused`'s
 * guarded `UPDATE` matched zero rows, to tell "no such mailbox" (throw) apart
 * from "the row exists but its `AND status <> 'disconnected'` guard held"
 * (silent no-op — see those methods' docs). One extra `SELECT`, only on that
 * already-uncommon path.
 */
async function assertMailboxExists(db: Db, mailboxId: string, label: string): Promise<void> {
  const rows = await db.query<{ id: string }>('SELECT id FROM mailboxes WHERE id = $1', [mailboxId])
  if (rows.length === 0) {
    throw new Error(`${label}: no mailbox with id ${mailboxId}`)
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
