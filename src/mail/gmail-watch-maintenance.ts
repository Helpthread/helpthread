/**
 * `runGmailWatchMaintenance` — the daily Gmail maintenance sweep (HT-42;
 * specs/mail/gmail-push.md §6). Two jobs, run per active mailbox:
 *
 * 1. **Re-arm `watch()`.** Gmail push notifications stop — silently, with
 *    no error on either side — once a mailbox's `watch()` registration
 *    expires (~7 days out). This re-arms it and stores the fresh
 *    expiration. Daily (not every-6-days) buys a safety margin against a
 *    missed run; `watch()` is idempotent, so re-arming early is free.
 * 2. **A bounded reconciliation sweep.** Push is best-effort (gmail-push.md
 *    §1): Gmail rate-limits and may drop or delay notifications. This
 *    enqueues one reconcile job per active mailbox — the SAME job the push
 *    webhook enqueues (`../api/gmail-webhook.ts`'s `GMAIL_RECONCILE_TOPIC`,
 *    `GmailReconcileJob`) — so a dropped or delayed *last* notification
 *    before a quiet spell never leaves a mailbox stale indefinitely. The
 *    reconcile consumer (`./gmail-reconcile.ts`, HT-41) re-reads the
 *    mailbox's STORED cursor itself and ignores the job's `historyId`, so a
 *    redundant sweep of an already-current mailbox is free — deduped by
 *    the idempotent ingest pipeline (inbound-ingestion.md §4), never
 *    doubled.
 *
 * ## A plain sweep function, not a queue/cron adapter
 *
 * Exactly like `./delivery-worker.ts` (HT-16): `runGmailWatchMaintenance`
 * is a plain `async function` of injected dependencies, NOT built on a
 * `SchedulerProvider` adapter — no such adapter is wired up yet, and
 * CHARTER.md §4's provider-seam discipline is exactly why this stays a pure
 * function rather than reaching for a platform primitive that doesn't
 * exist yet. Wiring a real daily schedule (Vercel Cron calling this, or a
 * future `SchedulerProvider.registerCron`, `src/providers/scheduler.ts`) is
 * deferred to the composition root (HT-43) — at that point it is a one-line
 * call to this function, not a rewrite of it.
 *
 * ## Failure-isolated per mailbox
 *
 * One mailbox's token failure or `watch()` failure never stops the others
 * (gmail-push.md §6). The whole per-mailbox unit of work
 * ({@link maintainOneMailbox}) is wrapped in its own try/catch inside
 * {@link runGmailWatchMaintenance}'s loop, so even a genuinely unexpected
 * throw (a store or queue failure outside the two expected-failure
 * branches below) only counts that one mailbox `failed` and moves on to
 * the next — never aborting the batch.
 *
 * ## Failure handling — the token layer owns `needs_reconnect`
 *
 * The access token is acquired ONCE per mailbox and reused for the single
 * `watch()` call (see {@link maintainOneMailbox} step 1) — not fetched a
 * second time through the watch client. Beyond saving a redundant token-service
 * call, this keeps token-acquisition failures classified in one place: a
 * token-acquisition failure is resolved by re-reading the mailbox's CURRENT
 * status (never trusting the caught error's content) — `needs_reconnect`
 * means the OAuth
 * token layer (`./gmail-oauth.ts`'s `getAccessToken`, on `invalid_grant`)
 * already found the grant dead and marked it, so this cron counts it and
 * moves on; any other status means the failure is transient (network,
 * timeout), also counted and moved on, retried automatically on tomorrow's
 * run.
 *
 * A `watch()` renewal failure PAST a valid token is different: gmail-
 * push.md §6 is explicit that this cron does NOT itself mark
 * `needs_reconnect` on a generic `watch()` error — only the token layer
 * owns that transition. A valid-token `watch()` failure is treated as
 * TRANSIENT (logged, counted `failed`, retried on the next daily tick —
 * the ~7-day expiry leaves ample margin for a few missed runs) rather than
 * halting a healthy mailbox on a transient Gmail blip.
 *
 * ## Re-arm and sweep are independent
 *
 * A `watch()` renewal failure does NOT skip the sweep for that mailbox
 * (and a sweep is attempted even for a mailbox whose renewal just failed)
 * — the two are unrelated Gmail API calls sharing only the mailbox's
 * access token, so one failing is no reason to skip the other. Both are
 * attempted for every mailbox with a valid token.
 *
 * ## Never overwrite the cursor on renewal
 *
 * `watchStateStore.setWatchExpiration` (`../store/gmail-watch-state.ts`)
 * touches `watch_expiration` ONLY — see that method's own doc comment for
 * the full mail-semantics rationale (charter invariant #1: a renewal's
 * fresh `historyId` is AHEAD of the stored cursor, and overwriting the
 * cursor with it would silently skip un-reconciled mail).
 *
 * ## No reconciliation lease here — deferred to HT-48
 *
 * Push-triggered reconciliation and this sweep both advance the same
 * mailbox's cursor. gmail-push.md §6 calls serializing them a pure
 * efficiency guard (avoiding redundant `history.list`/`messages.get`
 * work), NOT a correctness requirement — the ingest pipeline's own dedup
 * (inbound-ingestion.md §4) already makes either ordering safe. The lease
 * is out of scope for this ticket (HT-48); this sweep enqueues its
 * reconcile job with NO `dedupeKey` on purpose (see
 * {@link maintainOneMailbox}) — a daily sweep of an already-current, quiet
 * mailbox must still run, not be silently suppressed as a duplicate of an
 * earlier job.
 */

import { GMAIL_RECONCILE_TOPIC, type GmailReconcileJob } from '../api/gmail-webhook.js'
// Type-only: engine modules never take a RUNTIME dependency on a concrete
// adapter (src/providers/README.md's rule) — mirrors `./gmail-reconcile.ts`'s
// identical `createHistoryClient` injection and `./gmail-connect.ts`'s own
// `createWatchClient`. The composition root (HT-43) wires in the real
// `createGmailWatchClient` (`../providers/adapters/gmail/watch.ts`); tests
// pass a fake.
import type { GmailWatchClient } from '../providers/adapters/gmail/index.js'
import type { QueueProvider } from '../providers/queue.js'
import type { GmailWatchStateStore } from '../store/gmail-watch-state.js'
import type { MailboxStore } from '../store/mailboxes.js'
import type { GmailOAuthTokenService } from './gmail-oauth.js'

/** Dependencies {@link runGmailWatchMaintenance} needs. */
export interface GmailWatchMaintenanceDeps {
  /** Resolves a live Gmail API access token for one mailbox at a time (`./gmail-oauth.ts`). */
  tokenService: GmailOAuthTokenService

  /** The per-mailbox source (`listActiveMailboxes`) and the status re-read on a token failure (`../store/mailboxes.ts`). */
  mailboxStore: MailboxStore

  /** The per-mailbox `watch_expiration` write and stored-cursor read (`../store/gmail-watch-state.ts`). */
  watchStateStore: GmailWatchStateStore

  /** Where each mailbox's reconcile job is enqueued — the SAME `GMAIL_RECONCILE_TOPIC` the push webhook enqueues onto (`../api/gmail-webhook.ts`). */
  queue: QueueProvider

  /**
   * Builds a {@link GmailWatchClient} bound to a per-mailbox
   * `getAccessToken`. REQUIRED and injected — `src/providers/README.md`'s
   * rule that engine modules never import a concrete adapter; mirrors
   * `./gmail-reconcile.ts`'s `createHistoryClient` and `./gmail-connect.ts`'s
   * own `createWatchClient`. The composition root (HT-43) wires in the real
   * `createGmailWatchClient` (`../providers/adapters/gmail/watch.ts`); tests
   * pass a fake.
   */
  createWatchClient: (getAccessToken: () => Promise<string>) => GmailWatchClient

  /**
   * The Cloud Pub/Sub topic `watch()` arms notifications to
   * (`projects/{project}/topics/{topic}`, HT-43-provisioned) — injected
   * config, the same value `./gmail-connect.ts`'s `topicName` carries for
   * the initial arm. Validated non-empty at entry (see the module doc).
   */
  topicName: string
}

/** What one `runGmailWatchMaintenance` call did, for logging/observability by whatever schedules it (HT-43). */
export interface GmailWatchMaintenanceReport {
  /** Active mailboxes processed this run. */
  total: number
  /** Mailboxes whose `watch()` was successfully re-armed and `watch_expiration` updated. */
  renewed: number
  /** Mailboxes for which a reconcile job was enqueued (had a stored cursor to sweep from). */
  swept: number
  /** Mailboxes found `needs_reconnect` after a token-acquisition failure — the token layer's own transition, not this cron's (see module doc). */
  needsReconnect: number
  /** Mailboxes with a transient token or `watch()` failure this run — retried automatically on tomorrow's run. */
  failed: number
}

/** Throw a clear, field-named error unless `value` is a non-empty string. Matches `./gmail-oauth.ts`/`./gmail-connect.ts`'s own `assertNonEmpty` (duplicated locally per those modules' precedent). */
function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`runGmailWatchMaintenance: ${field} must be a non-empty string`)
  }
}

/**
 * Run one daily watch-renewal + reconciliation-sweep pass. See the module
 * doc for the full behavior. Never throws for an individual mailbox's
 * failure (failure-isolated — see {@link GmailWatchMaintenanceReport}); a
 * genuinely unexpected fault outside the per-mailbox loop (e.g.
 * `listActiveMailboxes` itself failing) propagates to the caller, same as
 * any other unexpected store error in this codebase.
 */
export async function runGmailWatchMaintenance(
  deps: GmailWatchMaintenanceDeps,
): Promise<GmailWatchMaintenanceReport> {
  // Fail loudly on a missing topic BEFORE listing or touching anything —
  // same discipline as delivery-worker.ts's assertLeaseExceedsSenderBound
  // check up front, and gmail-connect.ts's eager config validation.
  assertNonEmpty('topicName', deps.topicName)

  const mailboxes = await deps.mailboxStore.listActiveMailboxes()

  const counts: Omit<GmailWatchMaintenanceReport, 'total'> = {
    renewed: 0,
    swept: 0,
    needsReconnect: 0,
    failed: 0,
  }

  for (const mailbox of mailboxes) {
    try {
      await maintainOneMailbox(mailbox.id, deps, counts)
    } catch (err) {
      // An UNEXPECTED throw — a store/queue failure outside the two
      // expected-failure branches inside maintainOneMailbox. Never let one
      // mailbox stop the batch (module doc's "failure-isolated per
      // mailbox"). Safe to log err's message: everything reachable here
      // (MailboxStore/GmailWatchStateStore/QueueProvider calls) is a plain
      // store/queue error, never a token — see gmail-oauth.ts's and
      // watch.ts's module docs for why the token itself never surfaces in
      // a thrown error message.
      counts.failed++
      logMaintenanceEvent('error', {
        mailboxId: mailbox.id,
        outcome: 'failed',
        reason: 'unexpected-error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { total: mailboxes.length, ...counts }
}

/**
 * Re-arm `watch()` and run the reconciliation sweep for ONE mailbox. See
 * the module doc for the full step-by-step rationale. Increments `counts`
 * directly rather than returning a result, so a partial success (e.g. the
 * re-arm succeeds but the sweep step then throws unexpectedly) is never
 * lost — the caller's outer catch only ADDS to `counts` on top of whatever
 * this function already recorded, never replaces it.
 */
async function maintainOneMailbox(
  mailboxId: string,
  deps: GmailWatchMaintenanceDeps,
  counts: Omit<GmailWatchMaintenanceReport, 'total'>,
): Promise<void> {
  const { tokenService, mailboxStore, watchStateStore, queue, createWatchClient, topicName } = deps

  // --- Step 1: acquire a token ONCE — this both probes the grant (to
  // distinguish a dead grant from a transient failure, the classification
  // ./gmail-reconcile.ts step 2 does) AND is the exact token reused for the
  // single watch() call below. Calling the token service once per mailbox
  // rather than twice also keeps token-acquisition failures classified in
  // ONE place: a watch() failure below is then unambiguously a watch-API
  // failure, never a token refresh that raced revocation mid-call and got
  // mislabeled transient. The token service already refreshed if the cached
  // token was within its expiry skew, so this value is safe to reuse for the
  // one watch() request that follows (unlike ./gmail-reconcile.ts, whose
  // multi-page, long-running client is deliberately handed the getAccessToken
  // CLOSURE so a long run never carries a token that goes stale mid-run). ---
  let accessToken: string
  try {
    accessToken = await tokenService.getAccessToken(mailboxId)
  } catch {
    // Deliberately never logs the caught error's own content here — see
    // gmail-reconcile.ts's identical discipline; the mailbox's CURRENT
    // status (re-read below) is the authoritative signal, not this
    // error's message.
    const current = await mailboxStore.getMailboxById(mailboxId)
    if (current?.status === 'needs_reconnect') {
      counts.needsReconnect++
      logMaintenanceEvent('warn', {
        mailboxId,
        outcome: 'needs_reconnect',
        reason: 'token-acquisition-failed-needs-reconnect',
      })
    } else {
      counts.failed++
      logMaintenanceEvent('warn', {
        mailboxId,
        outcome: 'failed',
        reason: 'token-acquisition-failed-transient',
      })
    }
    return
  }

  // --- Step 2: re-arm watch() — independent of the sweep below. Past a
  // valid token, a failure here is TRANSIENT (module doc: the token layer,
  // not this cron, owns needs_reconnect). Does NOT `return` on failure —
  // the sweep still runs even when renewal fails. ---
  try {
    const watchClient = createWatchClient(() => Promise.resolve(accessToken))
    const { expiration } = await watchClient.watch({ topicName })
    await watchStateStore.setWatchExpiration(mailboxId, expiration)
    counts.renewed++
  } catch (err) {
    counts.failed++
    // Safe to log err's message: watch.ts's module doc documents the
    // access token never touches a thrown error or log line from that
    // client, and setWatchExpiration's own failures are plain DB errors.
    logMaintenanceEvent('warn', {
      mailboxId,
      outcome: 'failed',
      reason: 'watch-renewal-failed-transient',
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // --- Step 3: bounded reconciliation sweep — independent of re-arm
  // above. Skips only when there's no baseline cursor yet (nothing to
  // reconcile from — watch() at connect time, HT-40, seeds it; this cron
  // only renews the expiration). NO dedupeKey (module doc): a daily sweep
  // of an already-current, quiet mailbox must still run, never be
  // suppressed as a duplicate of an earlier job — redundant reconcile work
  // here is exactly what HT-48's lease will optimize away, and is safe
  // today because ingest dedups on (mailboxId, providerMessageId). ---
  const cursor = await watchStateStore.getCursor(mailboxId)
  if (cursor === null) {
    logMaintenanceEvent('info', {
      mailboxId,
      outcome: 'skipped-sweep',
      reason: 'no-baseline-cursor',
    })
    return
  }

  const job: GmailReconcileJob = { mailboxId, historyId: cursor }
  await queue.enqueue(GMAIL_RECONCILE_TOPIC, job, {})
  counts.swept++
}

/**
 * Emit one structured, JSON-parseable log line for a maintenance decision —
 * mirrors `./gmail-reconcile.ts`'s `logReconcileEvent`: no custom logger
 * abstraction exists in this codebase yet (CHARTER.md §4: serverless,
 * platform-log-aggregated), so this is deliberately a plain `console.*` of
 * a JSON-serializable object. NEVER pass an access token or a raw
 * caught-error object into `record` — see the module doc and this file's
 * two catch blocks for what is and isn't safe to include.
 */
function logMaintenanceEvent(
  level: 'info' | 'warn' | 'error',
  record: Record<string, unknown>,
): void {
  const line = JSON.stringify({ event: 'gmail_watch_maintenance', ...record })
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.info(line)
  }
}
