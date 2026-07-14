/**
 * `GmailWatchStateStore` — persistence for a mailbox's Gmail push cursor
 * (`gmail_watch_state`, migration 011, `src/db/migrate.ts`; gmail-push.md
 * §4 "the cursor"). One row per mailbox (`mailbox_id` is the PRIMARY KEY —
 * migration 011's doc comment), holding the `history_id` watermark
 * `history.list` resumes from, plus `watch_expiration` (the `watch()`
 * renewal deadline, gmail-push.md §6).
 *
 * ## Why {@link GmailWatchStateStore.setCursor} upserts rather than a plain `UPDATE`
 *
 * The baseline `gmail_watch_state` row is seeded by {@link
 * GmailWatchStateStore.seedBaseline} (HT-40, specs/mail/gmail-connect.md §4
 * step 5) at mailbox-connect time — HT-42 only *renews* `watch()` and
 * re-arms the same row thereafter (gmail-push.md §6; see gmail-connect.md
 * §1 for the authoritative HT-40/HT-42 split). But the reconcile handler
 * (`src/mail/gmail-reconcile.ts`, HT-41) must still be able to ADVANCE a
 * cursor correctly even in the pathological case of a push arriving before
 * that baseline row exists (e.g. a connect whose `seedBaseline` write
 * hasn't landed yet). `INSERT ... ON CONFLICT (mailbox_id) DO UPDATE`
 * handles "no row yet" and "row exists" with one statement, so advancing
 * never silently no-ops the way a plain `UPDATE ... WHERE mailbox_id = $1`
 * would if it matched zero rows.
 */

import type { Db } from '../db/client.js'

/** Persistence for one mailbox's Gmail history cursor. See the module doc. */
export interface GmailWatchStateStore {
  /**
   * The mailbox's current `history_id` cursor. Returns `null` in BOTH of
   * two cases — no `gmail_watch_state` row exists yet for this mailbox, OR
   * a row exists but its `history_id` is still null (between mailbox
   * connection and the first successful `watch()`/cursor advance,
   * migration 011's doc comment). Callers cannot distinguish these two
   * cases from this return value alone, and per gmail-push.md §3 don't
   * need to: either way there is no cursor to reconcile from yet.
   */
  getCursor(mailboxId: string): Promise<string | null>

  /**
   * Advance `mailboxId`'s cursor to `historyId` — an upsert (module doc),
   * so this is safe to call whether or not a baseline row already exists.
   */
  setCursor(mailboxId: string, historyId: string): Promise<void>

  /**
   * Seed (or re-seed, on reconnect) `mailboxId`'s BASELINE watch state:
   * both `history_id` and `watch_expiration` together, from a single
   * `watch()` response (specs/mail/gmail-connect.md §4 step 5 — `watch()`'s
   * `historyId`, NOT `getProfile`'s, is the baseline cursor; see
   * gmail-connect.md §4's rationale). Upserts (module doc), so a reconnect
   * (gmail-connect.md §5) correctly REBASELINES both columns from the
   * fresh `watch()` call rather than leaving a stale expiration paired with
   * a new cursor, or vice versa — the two values always land together, from
   * the same `watch()` call, in one write.
   */
  seedBaseline(
    mailboxId: string,
    input: { historyId: string; watchExpiration: Date },
  ): Promise<void>
}

/** Create a {@link GmailWatchStateStore} backed by `db`. */
export function createGmailWatchStateStore(db: Db): GmailWatchStateStore {
  return {
    async getCursor(mailboxId) {
      const rows = await db.query<{ history_id: string | null }>(
        'SELECT history_id FROM gmail_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      const row = rows[0]
      return row === undefined ? null : row.history_id
    },

    async setCursor(mailboxId, historyId) {
      await db.query(
        `INSERT INTO gmail_watch_state (mailbox_id, history_id)
         VALUES ($1, $2)
         ON CONFLICT (mailbox_id) DO UPDATE SET history_id = EXCLUDED.history_id, updated_at = now()`,
        [mailboxId, historyId],
      )
    },

    async seedBaseline(mailboxId, input) {
      await db.query(
        `INSERT INTO gmail_watch_state (mailbox_id, history_id, watch_expiration)
         VALUES ($1, $2, $3)
         ON CONFLICT (mailbox_id) DO UPDATE SET
           history_id = EXCLUDED.history_id,
           watch_expiration = EXCLUDED.watch_expiration,
           updated_at = now()`,
        [mailboxId, input.historyId, input.watchExpiration],
      )
    },
  }
}
