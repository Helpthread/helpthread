/**
 * `ImapWatchStateStore` — persistence for a mailbox's IMAP fetch cursor
 * (`imap_watch_state`, migration 027, `src/db/migrate.ts`) and its
 * never-double-fetch lease (HT-101 Stage 2a-i). One row per mailbox
 * (`mailbox_id` is the PRIMARY KEY — migration 027's doc comment), holding
 * the {@link ImapCursor} (`uid_validity`/`last_uid`, reused verbatim from
 * `../providers/adapters/imap/fetch.ts` — no second cursor type is defined
 * here) plus `claimed_until` (the fetch lease).
 *
 * ## `setCursor` vs `seedBaseline` — different SQL, different intent
 *
 * - {@link ImapWatchStateStore.seedBaseline} is called ONCE, at connect
 *   time, with the `uidValidity`/`lastUid` an initial `selectInbox` call
 *   reports — establishing "start fetching new mail from here forward,"
 *   never a resync of the mailbox's entire history. It is an `INSERT ... ON
 *   CONFLICT (mailbox_id) DO UPDATE` upsert: at connect time there may be no
 *   row yet, and creating one is exactly the point.
 * - {@link ImapWatchStateStore.setCursor} is called after every subsequent
 *   fetch invocation commits, advancing the same row to the `newCursor`
 *   {@link fetchImapInboundMessages} (`../providers/adapters/imap/fetch.ts`)
 *   returned. It is a lease-fenced plain `UPDATE`, and it returns whether the
 *   write landed.
 *
 * That asymmetry is deliberate and is the opposite of what an earlier
 * revision did. `setCursor` matching zero rows is not a bug to be papered
 * over by an upsert — it is the FENCE WORKING: either the caller's lease was
 * superseded while it was ingesting, or there is no cursor row to advance.
 * Both cases must leave the stored cursor exactly where the live holder put
 * it. See {@link ImapWatchStateStore.setCursor}'s own SACRED section for the
 * quarantine escape this closes.
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
 * ## The fetch lease — a uuid token, NOT Gmail's timestamp token
 *
 * {@link ImapWatchStateStore.claimFetchLease}/{@link
 * ImapWatchStateStore.releaseFetchLease} are the never-double-fetch guard: an
 * atomic `UPDATE ... WHERE claimed_until IS NULL OR claimed_until < now()`
 * claim, and a token-conditioned release.
 *
 * The claim mints a fresh `gen_random_uuid()` into `lease_token` and returns
 * THAT as the token. `claimed_until` answers "has this lease expired?";
 * `lease_token` answers "is this lease still mine?" — two different questions
 * that a single column cannot answer.
 *
 * This deliberately DIVERGES from `GmailWatchStateStore
 * .claimReconcileLease`, which returns the rendered `claimed_until::text`.
 * An earlier revision mirrored that statement-for-statement, and an
 * adversarial review (2026-07-25) showed it too weak: two claims landing in
 * the same clock tick mint the SAME timestamp, so a stale holder's token
 * compares equal to the live holder's and passes the check. A test written
 * to prove the fence instead reproduced the collision. Gmail's lease has the
 * same weakness (filed separately) but a smaller blast radius — its token
 * guards only release, never a cursor advance.
 *
 * Callers must treat the token as opaque.
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
   * Advance `mailboxId`'s cursor to `cursor`, **only if `leaseToken` is still
   * the live lease**. Called after a fetch invocation's messages have been
   * durably committed by the ingest pipeline, with the `newCursor`
   * {@link fetchImapInboundMessages} returned. Returns `true` when the write
   * landed, `false` when the lease had already been superseded.
   *
   * ## SACRED — a stale holder must not write a cursor
   *
   * Fencing here is not defensive tidiness; without it the UIDVALIDITY-reset
   * quarantine is escapable (found by an adversarial review, 2026-07-25).
   * Run A claims a lease and fetches under `uidValidity: 7`, then spends
   * longer than `leaseMs` ingesting. Run B reclaims the expired lease,
   * observes `uidValidity: 8`, and pauses the mailbox — the SACRED "pause,
   * never ingest, never advance" path in `../mail/imap-fetch.ts`. Run A is
   * still alive, finishes its batch, and writes `{uidValidity: 7, lastUid:
   * 150}` over the paused mailbox's state. `releaseFetchLease` is already
   * token-scoped so A cannot clear B's lease, but that alone never fenced
   * A's *cursor write*.
   *
   * The condition is part of the `UPDATE`'s `WHERE`, never a read-then-write:
   * a separate ownership check would reopen the same race one statement
   * lower. An `UPDATE` rather than the upsert used elsewhere in this store —
   * {@link claimFetchLease} returns `null` when no row exists, so a caller
   * holding a token is guaranteed a row to update.
   */
  setCursor(
    mailboxId: string,
    cursor: ImapCursor,
    leaseToken: string,
    tx?: Queryable,
  ): Promise<boolean>

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

    async setCursor(mailboxId, cursor, leaseToken, tx) {
      // `claimed_until = $4::timestamptz` is the fence (interface doc's SACRED
      // section) — the same token-scoped predicate `releaseFetchLease` uses,
      // applied to the write that actually matters. Zero rows means our lease
      // was superseded while we were ingesting; the caller reports it and
      // leaves the cursor where the live holder put it.
      const rows = await (tx ?? db).query<{ mailbox_id: string }>(
        `UPDATE imap_watch_state
         SET uid_validity = $2, last_uid = $3, updated_at = now()
         WHERE mailbox_id = $1 AND lease_token = $4::uuid
         RETURNING mailbox_id`,
        [mailboxId, cursor.uidValidity, cursor.lastUid, leaseToken],
      )
      return rows.length > 0
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
      // The token is a FRESH uuid per claim, not the rendered `claimed_until`
      // Gmail's lease uses: two claims inside one clock tick mint the same
      // timestamp, so a timestamp token cannot distinguish a stale holder from
      // the live one (migration 027's doc records the collision a test forced).
      // `claimed_until` still decides expiry; `lease_token` decides ownership.
      const rows = await db.query<{ lease_token: string }>(
        `UPDATE imap_watch_state
         SET claimed_until = now() + ($2::double precision * interval '1 millisecond'),
             lease_token = gen_random_uuid()
         WHERE mailbox_id = $1
           AND (claimed_until IS NULL OR claimed_until < now())
         RETURNING lease_token`,
        [mailboxId, leaseMs],
      )
      return rows.length > 0 ? rows[0].lease_token : null
    },

    async releaseFetchLease(mailboxId, leaseToken) {
      // Scoped to the token this call was granted — zero rows matched means
      // our lease was already superseded (expired and reclaimed by a
      // successor) or the row is gone, and is a silent no-op either way,
      // never a throw. See GmailWatchStateStore.releaseReconcileLease's doc
      // for the full stale-holder rationale this mirrors exactly.
      await db.query(
        'UPDATE imap_watch_state SET claimed_until = NULL, lease_token = NULL WHERE mailbox_id = $1 AND lease_token = $2::uuid',
        [mailboxId, leaseToken],
      )
    },
  }
}
