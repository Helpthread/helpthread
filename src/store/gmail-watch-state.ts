/**
 * `GmailWatchStateStore` — persistence for a mailbox's Gmail push cursor
 * (`gmail_watch_state`, migration 011, `src/db/migrate.ts`; gmail-push.md
 * §4 "the cursor"). One row per mailbox (`mailbox_id` is the PRIMARY KEY —
 * migration 011's doc comment), holding the `history_id` watermark
 * `history.list` resumes from, `watch_expiration` (the `watch()` renewal
 * deadline, gmail-push.md §6), and `claimed_until` (the per-mailbox
 * reconciliation lease, HT-48, migration 016, gmail-push.md §6) —
 * {@link GmailWatchStateStore.claimReconcileLease}/
 * {@link GmailWatchStateStore.releaseReconcileLease} below.
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

import type { Db, Queryable } from '../db/client.js'

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
   *
   * Optionally runs against a caller-supplied `tx` (`Db.transaction`'s
   * `Queryable`) instead of the bound `db`, so the connect flow can commit
   * this seed together with the mailbox row and token write as one atomic
   * unit (gmail-connect.md §4 step 5). Omitted, it runs standalone on `db`.
   */
  seedBaseline(
    mailboxId: string,
    input: { historyId: string; watchExpiration: Date },
    tx?: Queryable,
  ): Promise<void>

  /**
   * Update `mailboxId`'s `watch_expiration` — and ONLY `watch_expiration`
   * — after a successful `watch()` RENEWAL (HT-42, gmail-push.md §6's daily
   * cron; `../mail/gmail-watch-maintenance.ts`). This NEVER touches
   * `history_id`, unlike {@link seedBaseline}, which writes both columns
   * together but only once, at CONNECT time (HT-40).
   *
   * ## Why renewal must never overwrite the cursor (mail semantics, charter invariant #1)
   *
   * A `watch()` renewal call returns a FRESH `historyId` — Gmail's current
   * watermark at the moment of the call, which is AHEAD of wherever this
   * mailbox's stored cursor has actually been reconciled to (push delivery
   * and the reconciliation sweep both lag live traffic by design).
   * Overwriting the stored cursor with the renewal's `historyId` would
   * silently SKIP every message that arrived between the stored cursor and
   * that fresh watermark but hasn't been reconciled past yet — a
   * permanent, silent drop the next `history.list` call would never
   * surface, since it starts AFTER the point it's told to. `seedBaseline`
   * gets to write both columns together specifically because at connect
   * time there is no prior cursor to protect — there is nothing yet for a
   * fresh `historyId` to skip past.
   *
   * Upserts (module doc's `ON CONFLICT` rationale): the ON CONFLICT path
   * updates `watch_expiration` only, leaving `history_id` exactly as it
   * was. The INSERT path — no `gmail_watch_state` row yet, anomalous for a
   * mailbox this cron is renewing `watch()` for — leaves `history_id`
   * `NULL`, which {@link getCursor} already reports as "no cursor" and the
   * reconcile handler (`../mail/gmail-reconcile.ts` step 3) already treats
   * as a safe no-op.
   */
  setWatchExpiration(mailboxId: string, watchExpiration: Date): Promise<void>

  /**
   * Claim `mailboxId`'s reconciliation lease for `leaseMs` (HT-48, gmail-
   * push.md §6): an atomic `UPDATE ... SET claimed_until = now() + leaseMs
   * WHERE mailbox_id = $1 AND (claimed_until IS NULL OR claimed_until <
   * now()) RETURNING mailbox_id` — the inbound analogue of
   * `ConversationStore.claimThreadForDelivery` (sending.md §3a, migration
   * 003). Ordinary Postgres row-level locking on the `UPDATE` makes "at
   * most one claimant wins" hold under true concurrency exactly as it does
   * there — no advisory lock needed.
   *
   * Returns `true` iff THIS call won the claim, `false` if another holder's
   * lease is still live (or no `gmail_watch_state` row exists yet for this
   * mailbox — `src/mail/gmail-reconcile.ts` only ever calls this after
   * {@link getCursor} has already confirmed a row with a non-null cursor
   * exists, so that case is not expected in practice). Unlike
   * `claimThreadForDelivery`, there is no accompanying status re-check: this
   * lease guards nothing but redundant Gmail API work (gmail-push.md §6),
   * so a `false` return means "skip this run — the current holder will
   * advance the cursor," never "this work already happened elsewhere and
   * must not be repeated" (that correctness property is the ingest
   * pipeline's dedup, inbound-ingestion.md §4, not this lease).
   */
  claimReconcileLease(mailboxId: string, leaseMs: number): Promise<boolean>

  /**
   * Release `mailboxId`'s reconciliation lease: `UPDATE gmail_watch_state
   * SET claimed_until = NULL WHERE mailbox_id = $1 RETURNING mailbox_id`,
   * throwing on zero rows updated (mirrors `ConversationStore
   * .releaseThreadLease`'s throw-on-zero-rows contract — a silent no-op
   * here would hide a mailbox row vanishing mid-reconcile). The caller
   * (`src/mail/gmail-reconcile.ts`) wraps this in its own try/catch and logs
   * rather than failing the reconcile outcome on a release failure — see
   * that module's doc comment for why: this lease is a pure efficiency
   * guard (gmail-push.md §6), so a failed release must never be allowed to
   * turn an otherwise-successful reconcile into a reported failure; the
   * lease's own `leaseMs` expiry is the backstop that keeps a mailbox from
   * being locked out if release never runs at all (e.g. the process is
   * killed before this call, rather than merely throwing).
   */
  releaseReconcileLease(mailboxId: string): Promise<void>
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

    async seedBaseline(mailboxId, input, tx) {
      await (tx ?? db).query(
        `INSERT INTO gmail_watch_state (mailbox_id, history_id, watch_expiration)
         VALUES ($1, $2, $3)
         ON CONFLICT (mailbox_id) DO UPDATE SET
           history_id = EXCLUDED.history_id,
           watch_expiration = EXCLUDED.watch_expiration,
           updated_at = now()`,
        [mailboxId, input.historyId, input.watchExpiration],
      )
    },

    async setWatchExpiration(mailboxId, watchExpiration) {
      await db.query(
        `INSERT INTO gmail_watch_state (mailbox_id, watch_expiration)
         VALUES ($1, $2)
         ON CONFLICT (mailbox_id) DO UPDATE SET
           watch_expiration = EXCLUDED.watch_expiration,
           updated_at = now()`,
        [mailboxId, watchExpiration],
      )
    },

    async claimReconcileLease(mailboxId, leaseMs) {
      // A single UPDATE is already atomic with respect to itself under
      // Postgres row-level locking — see ConversationStore
      // .claimThreadForDelivery's identical reasoning. No status re-check
      // here (unlike that method): this lease has no outcome to protect,
      // only redundant Gmail API work to avoid (see the interface doc).
      const rows = await db.query<{ mailbox_id: string }>(
        `UPDATE gmail_watch_state
         SET claimed_until = now() + ($2::double precision * interval '1 millisecond')
         WHERE mailbox_id = $1
           AND (claimed_until IS NULL OR claimed_until < now())
         RETURNING mailbox_id`,
        [mailboxId, leaseMs],
      )
      return rows.length > 0
    },

    async releaseReconcileLease(mailboxId) {
      const updated = await db.query<{ mailbox_id: string }>(
        'UPDATE gmail_watch_state SET claimed_until = NULL WHERE mailbox_id = $1 RETURNING mailbox_id',
        [mailboxId],
      )
      if (updated.length === 0) {
        throw new Error(`releaseReconcileLease: no gmail_watch_state row for mailbox ${mailboxId}`)
      }
    },
  }
}
