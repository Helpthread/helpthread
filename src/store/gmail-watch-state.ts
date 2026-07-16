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
   * now()) RETURNING claimed_until` — the inbound analogue of
   * `ConversationStore.claimThreadForDelivery` (sending.md §3a, migration
   * 003). Ordinary Postgres row-level locking on the `UPDATE` makes "at
   * most one claimant wins" hold under true concurrency exactly as it does
   * there — no advisory lock needed.
   *
   * Returns an opaque **lease token** (the exact `claimed_until` value THIS
   * call just wrote, as Postgres's own `::text` rendering of it — see below
   * for why text, not a `Date`) iff this call won the claim, or `null` if
   * another holder's lease is still live (or no `gmail_watch_state` row
   * exists yet for this mailbox — `src/mail/gmail-reconcile.ts` only ever
   * calls this after {@link getCursor} has already confirmed a row with a
   * non-null cursor exists, so that case is not expected in practice).
   * Unlike `claimThreadForDelivery`, there is no accompanying status
   * re-check: this lease guards nothing but redundant Gmail API work
   * (gmail-push.md §6), so a `null` return means "another run already holds
   * this mailbox — try again shortly," never "this work already happened
   * elsewhere and must not be repeated" (that correctness property is the
   * ingest pipeline's dedup, inbound-ingestion.md §4, not this lease).
   *
   * The caller MUST pass this token back to {@link releaseReconcileLease}
   * to prove it still owns the lease it is releasing — see that method's
   * doc for the stale-holder scenario this guards against.
   *
   * ## Why the token is `claimed_until` rendered as text, not a `Date`
   *
   * `claimed_until` is `timestamptz`, which Postgres stores with
   * microsecond precision; `now()` routinely produces a non-zero
   * microsecond remainder. A `pg`-wire-protocol driver parses a `timestamptz`
   * column into a JS `Date`, which only carries MILLISECOND precision — the
   * sub-millisecond remainder is silently truncated on the way out. If
   * {@link releaseReconcileLease} compared `claimed_until = $2` against a
   * `Date` round-tripped through JS, the truncated value would almost never
   * bit-for-bit equal what is actually stored, and every legitimate release
   * would silently fail to match (falling into the "already superseded"
   * no-op path below) — reintroducing the exact lock-out this token exists
   * to prevent, but permanently, since the lease would then never be
   * released until natural expiry. Casting to `::text` in the `RETURNING`
   * clause instead hands back Postgres's own full-precision textual
   * rendering; passing that same string back and casting it `::timestamptz`
   * in the release `WHERE` clause compares against the identical value with
   * no lossy JS `Date` round-trip in between. Callers must treat this return
   * value as an opaque token — never parse it as a `Date` or do arithmetic
   * on it.
   */
  claimReconcileLease(mailboxId: string, leaseMs: number): Promise<string | null>

  /**
   * Release `mailboxId`'s reconciliation lease — but ONLY if `leaseToken`
   * (the value {@link claimReconcileLease} returned when it granted this
   * run's claim) still matches the row's CURRENT `claimed_until`: `UPDATE
   * gmail_watch_state SET claimed_until = NULL WHERE mailbox_id = $1 AND
   * claimed_until = $2::timestamptz`.
   *
   * ## Why this must be conditioned on the token, not unconditional
   *
   * An unconditional release (`WHERE mailbox_id = $1` alone) has a
   * stale-holder hole: if THIS run overran `leaseMs` (e.g. a large backlog's
   * `history.list`/`messages.get` batch), the lease already expired and a
   * SUCCESSOR run may have claimed it and be actively working. This run's
   * release would then clear the successor's LIVE lease out from under it,
   * letting a third trigger claim and duplicate the successor's in-flight
   * `history.list`/`messages.get` work — exactly the redundant-work case
   * the lease exists to prevent, and worst under the fat-batch load that
   * makes overrunning `leaseMs` most likely. Scoping the release to the
   * token this call was granted makes it a no-op once that token no longer
   * matches — this run's lease was already superseded, so there is nothing
   * of ITS to release.
   *
   * Zero rows matched (the token doesn't match the current `claimed_until`,
   * because it was already released and reclaimed by a successor, or the
   * `gmail_watch_state` row no longer exists) is therefore a SILENT no-op,
   * not an error — unlike `ConversationStore.releaseThreadLease`'s
   * throw-on-zero-rows contract, which this deliberately does NOT mirror:
   * that method's zero-rows case signals a genuine anomaly (the outbound
   * lease is unconditional, so zero rows there can only mean the row
   * vanished), whereas here zero rows is the routine, expected outcome of
   * "our lease was already superseded" and must not be escalated into a
   * caller-visible failure — the caller (`src/mail/gmail-reconcile.ts`)
   * already wraps this in its own try/catch purely as a backstop for
   * genuine, unexpected DB errors (a connection failure, say), not for this
   * expected case.
   */
  releaseReconcileLease(mailboxId: string, leaseToken: string): Promise<void>
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
      //
      // `claimed_until::text` hands back the FULL-PRECISION value this call
      // just wrote, as a plain string — see the interface doc's "Why the
      // token is text, not a Date" for why the release side must compare
      // against this exact textual round-trip rather than a JS `Date`.
      const rows = await db.query<{ claimed_until: string }>(
        `UPDATE gmail_watch_state
         SET claimed_until = now() + ($2::double precision * interval '1 millisecond')
         WHERE mailbox_id = $1
           AND (claimed_until IS NULL OR claimed_until < now())
         RETURNING claimed_until::text AS claimed_until`,
        [mailboxId, leaseMs],
      )
      return rows.length > 0 ? rows[0].claimed_until : null
    },

    async releaseReconcileLease(mailboxId, leaseToken) {
      // Scoped to the token this call was granted (interface doc's "Why
      // this must be conditioned on the token" section) — zero rows matched
      // means our lease was already superseded (expired and reclaimed by a
      // successor) or the row is gone, and is a silent no-op either way,
      // never a throw (unlike ConversationStore.releaseThreadLease).
      await db.query(
        'UPDATE gmail_watch_state SET claimed_until = NULL WHERE mailbox_id = $1 AND claimed_until = $2::timestamptz',
        [mailboxId, leaseToken],
      )
    },
  }
}
