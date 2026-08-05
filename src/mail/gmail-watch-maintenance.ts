/**
 * `runGmailWatchMaintenance` — the daily Gmail `watch()` renewal
 * (specs/mail/gmail-push.md §6), run per active mailbox.
 *
 * Gmail push notifications stop — silently, with no error on either side —
 * once a mailbox's `watch()` registration expires (~7 days out). This
 * re-arms it and stores the fresh expiration. Daily rather than
 * every-6-days buys margin against a missed run; `watch()` is idempotent,
 * so re-arming early is free.
 *
 * ## Renewal only
 *
 * This module also used to run a bounded reconciliation sweep as a daily
 * backstop for push being best-effort. That sweep is now the engine's
 * PRIMARY inbound transport and lives in `./gmail-reconcile-sweep.ts`,
 * running every minute (CHARTER.md §2, amended 2026-07-20). Two reasons it
 * could not stay here, both in that module's doc: the cadences differ by
 * three orders of magnitude, and renewal needs a per-mailbox access token
 * while the sweep needs none — welding them would mean refreshing a token
 * every minute for a Gmail call the sweep never makes.
 *
 * So this module is meaningful ONLY when push is configured. With no
 * Pub/Sub topic there is no `watch()` to re-arm, the composition root does
 * not construct its deps at all, and the cron endpoint stays routed and
 * reports a skip (`../composition/root.ts`).
 *
 * ## A plain function, not a queue/cron adapter
 *
 * Like `./delivery-worker.ts`, this is a plain `async function` of injected
 * dependencies, NOT built on a `SchedulerProvider` adapter — no such adapter
 * is wired up yet, and CHARTER.md §4's provider-seam discipline is why this
 * stays a pure function rather than reaching for a platform primitive that
 * does not exist. Wiring a real schedule (Vercel Cron, or a future
 * `SchedulerProvider.registerCron`) is the composition root's job, and is a
 * one-line call to this function.
 *
 * ## Failure-isolated per mailbox
 *
 * One mailbox's token or `watch()` failure never stops the others
 * (gmail-push.md §6). The whole per-mailbox unit ({@link maintainOneMailbox})
 * is wrapped in its own try/catch inside the loop, so even an unexpected
 * throw — a store failure outside the two expected branches below — counts
 * that one mailbox `failed` and moves on, never aborting the batch.
 *
 * ## Failure handling — the token layer owns `needs_reconnect`
 *
 * The access token is acquired ONCE per mailbox and reused for the single
 * `watch()` call, not fetched again through the watch client. Beyond saving
 * a redundant call, this keeps token-acquisition failures classified in one
 * place: such a failure is resolved by re-reading the mailbox's CURRENT
 * status, never by trusting the caught error's content. `needs_reconnect`
 * means the OAuth layer (`./gmail-oauth.ts`'s `getAccessToken`, on
 * `invalid_grant`) already found the grant dead and marked it, so this cron
 * counts it and moves on; any other status means a transient failure
 * (network, timeout), also counted and retried on tomorrow's run.
 *
 * A `watch()` failure PAST a valid token is different: gmail-push.md §6 is
 * explicit that this cron does NOT itself mark `needs_reconnect` on a
 * generic `watch()` error — only the token layer owns that transition. Such
 * a failure is treated as TRANSIENT (logged, counted `failed`, retried on
 * the next daily tick, with the ~7-day expiry leaving ample margin for a few
 * missed runs) rather than halting a healthy mailbox on a Gmail blip.
 *
 * ## Never overwrite the cursor on renewal
 *
 * `watchStateStore.setWatchExpiration` (`../store/gmail-watch-state.ts`)
 * touches `watch_expiration` ONLY — see that method's own doc for the
 * mail-semantics rationale (charter invariant #1: a renewal's fresh
 * `historyId` is AHEAD of the stored cursor, and overwriting the cursor with
 * it would silently skip un-reconciled mail).
 *
 * ## The reconciliation lease is entirely the sweep's concern
 *
 * The lease serializing overlapping reconciliation lives in the reconcile
 * job's CONSUMER (`./gmail-reconcile.ts`'s
 * `claimReconcileLease`/`releaseReconcileLease` around `history.list`), never
 * in a producer. Since this module no longer produces reconcile jobs, that
 * discussion moved with the sweep — see `./gmail-reconcile-sweep.ts`, where
 * at every-minute cadence the lease stops being an efficiency guard and
 * becomes structural.
 */

// Type-only: engine modules never take a RUNTIME dependency on a concrete
// adapter (src/providers/README.md's rule) — mirrors `./gmail-reconcile.ts`'s
// identical `createHistoryClient` injection and `./gmail-connect.ts`'s own
// `createWatchClient`. The composition root (HT-43) wires in the real
// `createGmailWatchClient` (`../providers/adapters/gmail/watch.ts`); tests
// pass a fake.
import type { GmailWatchClient } from '../providers/adapters/gmail/index.js'
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
      // (MailboxStore/GmailWatchStateStore calls) is a plain
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
  const { tokenService, mailboxStore, watchStateStore, createWatchClient, topicName } = deps

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

  // The bounded reconciliation sweep that used to be step 3 here moved to
  // `./gmail-reconcile-sweep.ts` (HT-94). It is no longer a daily backstop for
  // push but the primary inbound transport, running every minute — and it
  // needs no access token, unlike the renewal above, so keeping the two welded
  // would have meant a token refresh per mailbox per minute for a Gmail call
  // the sweep never makes. See that module's doc for the full rationale.
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
