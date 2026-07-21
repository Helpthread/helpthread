/**
 * `ImapWatchStateStore` — persistence for a mailbox's IMAP fetch cursor
 * (`imap_watch_state`, migration 027, `src/db/migrate.ts`) and its
 * never-double-fetch lease (HT-101 Stage 2a-i). One row per mailbox
 * (`mailbox_id` is the PRIMARY KEY — migration 027's doc comment), holding
 * the {@link ImapCursor} (`uid_validity`/`last_uid`, reused verbatim from
 * `../providers/adapters/imap/fetch.ts` — no second cursor type is defined
 * here) plus `claimed_until` (the fetch lease).
 *
 * ## `setCursor` vs `seedBaseline` — same SQL, different intent
 *
 * Both write the full `{ uidValidity, lastUid }` pair via the identical
 * `INSERT ... ON CONFLICT (mailbox_id) DO UPDATE` upsert — unlike
 * `GmailWatchStateStore`, where `setCursor` and `seedBaseline` genuinely
 * touch different column sets (`setCursor` advances only `history_id`;
 * `seedBaseline` also writes `watch_expiration`), this table has no second,
 * independently-updated column for `seedBaseline` to own alone. The two
 * methods exist as distinct names purely to keep each call site's INTENT
 * legible, matching how `../providers/adapters/imap/fetch.ts`'s own module
 * doc frames the connect-time write ("so the first fetch starts from 'now',
 * not the whole history") as a different event from an ordinary per-tick
 * advance, even though the underlying write is the same statement:
 *
 * - {@link ImapWatchStateStore.seedBaseline} is called ONCE, at connect
 *   time, with the `uidValidity`/`lastUid` an initial `selectInbox` call
 *   reports — establishing "start fetching new mail from here forward,"
 *   never a resync of the mailbox's entire history.
 * - {@link ImapWatchStateStore.setCursor} is called after every subsequent
 *   fetch invocation commits, advancing the same row to the `newCursor`
 *   {@link fetchImapInboundMessages} (`../providers/adapters/imap/fetch.ts`)
 *   returned — mirroring `GmailWatchStateStore.setCursor`'s own "advances
 *   only as far as the highest UID actually fetched" contract.
 *
 * `INSERT ... ON CONFLICT` (rather than a plain `UPDATE`) on BOTH methods
 * for the same reason `GmailWatchStateStore.setCursor`'s module doc gives:
 * it handles "no row yet" and "row exists" with one statement, so advancing
 * never silently no-ops the way a plain `UPDATE ... WHERE mailbox_id = $1`
 * would if it matched zero rows.
 *
 * ## `uid_validity`/`last_uid` are `bigint` — read back via `Number()`
 *
 * `pg`/PGlite may hand a `bigint` column back as a string to avoid an
 * appearance of precision loss (the same convention `webauthn_credentials
 * .sign_count` uses, `src/store/webauthn.ts`'s `toSignCount`). Every value
 * this codebase ever writes is an IMAP UID or UIDVALIDITY — unsigned 32-bit
 * per RFC 3501 §2.3.1 — always well within `Number.MAX_SAFE_INTEGER`, so a
 * plain `Number()` conversion is exact.
 *
 * ## The fetch lease — mirrors `GmailWatchStateStore`'s reconcile lease EXACTLY
 *
 * {@link ImapWatchStateStore.claimFetchLease}/{@link
 * ImapWatchStateStore.releaseFetchLease} are the never-double-fetch guard: an
 * atomic `UPDATE ... WHERE claimed_until IS NULL OR claimed_until < now()`
 * claim, and a token-conditioned release, statement-for-statement identical
 * to `GmailWatchStateStore.claimReconcileLease`/`.releaseReconcileLease`
 * (`./gmail-watch-state.ts`) — INCLUDING that store's `claimed_until::text`
 * rendering. See that module's doc for the full "why text, not a `Date`"
 * rationale: a `pg`-wire-protocol driver parses `timestamptz` into a JS
 * `Date`, which only carries millisecond precision, while `claimed_until` is
 * stored with microsecond precision — comparing a truncated `Date`
 * round-trip against the column in {@link releaseFetchLease}'s `WHERE`
 * clause would make a legitimate release silently fail to match almost
 * every time, permanently stranding the lease until natural expiry. Casting
 * to `::text` in `RETURNING` and back to `::timestamptz` in the release
 * `WHERE` clause compares Postgres's own full-precision textual rendering
 * against itself, with no lossy `Date` round-trip in between. Callers must
 * treat the returned token as opaque — never parse it as a `Date` or do
 * arithmetic on it.
 */

import type { Db, Queryable } from '../db/client.js'
import type { ImapCursor } from '../providers/adapters/imap/fetch.js'

/** Persistence for one mailbox's IMAP fetch cursor and fetch lease. See the module doc. */
export interface ImapWatchStateStore {
  /**
   * The mailbox's current {@link ImapCursor}. Returns `null` when no
   * `imap_watch_state` row exists yet for this mailbox (between connection
   * and {@link seedBaseline}) — unlike `GmailWatchStateStore.getCursor`,
   * there is no partial-row case to consider: both `uid_validity` and
   * `last_uid` are `NOT NULL` (migration 027's doc comment), so a row
   * either fully exists or does not exist at all.
   */
  getCursor(mailboxId: string): Promise<ImapCursor | null>

  /**
   * Advance `mailboxId`'s cursor to `cursor` — an upsert (module doc), so
   * this is safe to call whether or not a baseline row already exists.
   * Called after a fetch invocation's messages have been durably committed
   * by the ingest pipeline, with the `newCursor`
   * {@link fetchImapInboundMessages} returned.
   */
  setCursor(mailboxId: string, cursor: ImapCursor, tx?: Queryable): Promise<void>

  /**
   * Seed `mailboxId`'s BASELINE cursor at connect time — module doc's
   * "start fetching new mail from here forward, never a resync of the
   * mailbox's entire history." Same upsert shape as {@link setCursor}
   * (module doc: the two share SQL and differ only in when/why they're
   * called).
   *
   * Optionally runs against a caller-supplied `tx` (`Db.transaction`'s
   * `Queryable`) instead of the bound `db`, so a connect flow can commit
   * this seed together with the `mailboxes` row, `imap_mailbox_config`, and
   * `imap_mailbox_credentials` writes as ONE atomic unit — the same `tx?`
   * pattern `GmailWatchStateStore.seedBaseline` uses for its own
   * connect-time atomicity. Omitted, it runs standalone on `db`.
   */
  seedBaseline(mailboxId: string, cursor: ImapCursor, tx?: Queryable): Promise<void>

  /**
   * Seed the baseline cursor ONLY if this mailbox has no cursor row yet —
   * `INSERT ... ON CONFLICT (mailbox_id) DO NOTHING`. This is what a connect
   * flow uses so that RECONNECTING an already-connected inbox (to rotate the
   * app password or edit host/port) PRESERVES the existing cursor instead of
   * rewinding it to a fresh baseline — rewinding would skip (silently drop)
   * any mail that arrived since the last fetch but has not yet been ingested
   * (CHARTER §2 never-drop). If the server's UIDVALIDITY has since changed,
   * the preserved (now-stale) cursor makes the next scheduled fetch report a
   * UIDVALIDITY reset, which pauses the mailbox for deliberate rebaseline
   * (`../mail/imap-fetch.ts`) — never a silent reseed here.
   */
  seedBaselineIfAbsent(mailboxId: string, cursor: ImapCursor, tx?: Queryable): Promise<void>

  /**
   * Claim `mailboxId`'s fetch lease for `leaseMs` — the never-double-fetch
   * guard preventing an overlapping cron invocation from fetching the same
   * UID range twice. Returns an opaque **lease token** (module doc) iff
   * this call won the claim, or `null` if another holder's lease is still
   * live, or no `imap_watch_state` row exists yet for this mailbox.
   *
   * The caller MUST pass this token back to {@link releaseFetchLease} to
   * prove it still owns the lease it is releasing.
   */
  claimFetchLease(mailboxId: string, leaseMs: number): Promise<string | null>

  /**
   * Release `mailboxId`'s fetch lease — but ONLY if `leaseToken` (the value
   * {@link claimFetchLease} returned when it granted this run's claim)
   * still matches the row's CURRENT `claimed_until`. Zero rows matched (the
   * token doesn't match — already released and reclaimed by a successor,
   * or the row no longer exists) is a SILENT no-op, not an error — same
   * convention as `GmailWatchStateStore.releaseReconcileLease`, for the
   * identical stale-holder reason: see that method's doc for why an
   * unconditional release would let an overrun run clobber a live
   * successor's lease.
   */
  releaseFetchLease(mailboxId: string, leaseToken: string): Promise<void>
}

/** Raw `imap_watch_state` cursor columns, before mapping to {@link ImapCursor}. */
interface ImapWatchStateRow {
  uid_validity: string | number
  last_uid: string | number
}

/** `bigint` columns may come back as a string from `pg`/PGlite — see the module doc. Every value here is well within `Number.MAX_SAFE_INTEGER`. */
function toBigIntNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number(value)
}

/** Create an {@link ImapWatchStateStore} backed by `db`. */
export function createImapWatchStateStore(db: Db): ImapWatchStateStore {
  async function upsertCursor(mailboxId: string, cursor: ImapCursor, tx?: Queryable) {
    await (tx ?? db).query(
      `INSERT INTO imap_watch_state (mailbox_id, uid_validity, last_uid)
       VALUES ($1, $2, $3)
       ON CONFLICT (mailbox_id) DO UPDATE SET
         uid_validity = EXCLUDED.uid_validity,
         last_uid = EXCLUDED.last_uid,
         updated_at = now()`,
      [mailboxId, cursor.uidValidity, cursor.lastUid],
    )
  }

  return {
    async getCursor(mailboxId) {
      const rows = await db.query<ImapWatchStateRow>(
        'SELECT uid_validity, last_uid FROM imap_watch_state WHERE mailbox_id = $1',
        [mailboxId],
      )
      const row = rows[0]
      if (row === undefined) {
        return null
      }
      return {
        uidValidity: toBigIntNumber(row.uid_validity),
        lastUid: toBigIntNumber(row.last_uid),
      }
    },

    async setCursor(mailboxId, cursor, tx) {
      await upsertCursor(mailboxId, cursor, tx)
    },

    async seedBaseline(mailboxId, cursor, tx) {
      await upsertCursor(mailboxId, cursor, tx)
    },

    async seedBaselineIfAbsent(mailboxId, cursor, tx) {
      // DO NOTHING (not DO UPDATE) — a reconnect must never overwrite an
      // existing cursor and skip un-ingested mail (interface doc).
      await (tx ?? db).query(
        `INSERT INTO imap_watch_state (mailbox_id, uid_validity, last_uid)
         VALUES ($1, $2, $3)
         ON CONFLICT (mailbox_id) DO NOTHING`,
        [mailboxId, cursor.uidValidity, cursor.lastUid],
      )
    },

    async claimFetchLease(mailboxId, leaseMs) {
      // A non-positive or non-finite lease would write an already-expired (or
      // invalid) `claimed_until`, silently defeating the guard so every tick
      // re-claims. The caller always passes a constant, but reject a bad value
      // loudly rather than degrade the lease into a no-op.
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
        throw new Error(
          `createImapWatchStateStore.claimFetchLease: leaseMs must be a positive integer (got ${leaseMs})`,
        )
      }
      // Identical shape to GmailWatchStateStore.claimReconcileLease — see
      // this module's doc for the full "why ::text, not a Date" rationale.
      const rows = await db.query<{ claimed_until: string }>(
        `UPDATE imap_watch_state
         SET claimed_until = now() + ($2::double precision * interval '1 millisecond')
         WHERE mailbox_id = $1
           AND (claimed_until IS NULL OR claimed_until < now())
         RETURNING claimed_until::text AS claimed_until`,
        [mailboxId, leaseMs],
      )
      return rows.length > 0 ? rows[0].claimed_until : null
    },

    async releaseFetchLease(mailboxId, leaseToken) {
      // Scoped to the token this call was granted — zero rows matched means
      // our lease was already superseded (expired and reclaimed by a
      // successor) or the row is gone, and is a silent no-op either way,
      // never a throw. See GmailWatchStateStore.releaseReconcileLease's doc
      // for the full stale-holder rationale this mirrors exactly.
      await db.query(
        'UPDATE imap_watch_state SET claimed_until = NULL WHERE mailbox_id = $1 AND claimed_until = $2::timestamptz',
        [mailboxId, leaseToken],
      )
    },
  }
}
