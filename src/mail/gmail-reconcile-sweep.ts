/**
 * `runGmailReconcileSweep` — the bounded scheduled fetch that is Helpthread's
 * PRIMARY inbound transport (HT-94; CHARTER.md §2 as amended 2026-07-20:
 * "push-based delivery where providers offer it, bounded scheduled fetches
 * where they don't — and no resident process either way").
 *
 * One pass enqueues a reconcile job per active mailbox that has a baseline
 * cursor. The job is the SAME `GMAIL_RECONCILE_TOPIC` job the push webhook
 * enqueues (`../api/gmail-webhook.ts`) and the same one `./gmail-reconcile.ts`
 * consumes — this module changes *what triggers* reconciliation, never how
 * reconciliation works. That equivalence is the whole point: a deployment
 * without Pub/Sub ingests mail through exactly the code path a deployment with
 * it does, just triggered by a clock instead of a notification.
 *
 * ## Split out of `./gmail-watch-maintenance.ts` (HT-94)
 *
 * This logic previously lived as "step 3" inside that module's daily
 * per-mailbox pass, where it was framed as a *backstop* for push. Two reasons
 * it had to become its own entry point rather than a flag on that one:
 *
 * 1. **Cadence.** As a backstop it ran daily. As the primary transport it runs
 *    every minute — a mailbox whose only intake is a daily sweep is not a
 *    helpdesk. Those cadences cannot share a cron.
 * 2. **Cost, and this is the load-bearing one.** Watch renewal must acquire an
 *    access token per mailbox (it calls `users.watch()`); the sweep must not.
 *    All the sweep needs is a stored cursor and a queue write — no Gmail API
 *    call happens here at all. Keeping them welded together would have meant a
 *    token refresh per mailbox per MINUTE against Google's token endpoint, for
 *    a call the sweep never makes. The reconcile CONSUMER acquires its own
 *    token when it actually talks to Gmail.
 *
 * What remains in `./gmail-watch-maintenance.ts` is renewal alone, still
 * daily, and now only scheduled when push is configured.
 *
 * ## No dedupe key, deliberately
 *
 * Enqueues carry NO `dedupeKey`, matching the behavior this inherited. A sweep
 * of an already-current, quiet mailbox must still run rather than be
 * suppressed as a duplicate of an earlier job. Redundant reconcile work is
 * already optimized away downstream by the consumer's lease (HT-48,
 * `./gmail-reconcile.ts`), which skips when another reconcile of the same
 * mailbox is in flight — and is harmless regardless, because ingest dedups on
 * `(mailboxId, providerMessageId)`.
 *
 * At every-minute cadence that lease stops being an optimization and becomes
 * structural: ticks WILL overlap a still-running reconcile on a busy mailbox,
 * and the lease is what makes that a no-op instead of duplicated fetching.
 *
 * ## Failure isolation
 *
 * Per-mailbox failures never stop the batch — one mailbox with an unreadable
 * cursor must not stall intake for every other mailbox. A fault outside the
 * per-mailbox loop (e.g. `listActiveMailboxes` itself failing) propagates,
 * matching `./gmail-watch-maintenance.ts`'s discipline.
 */

import { GMAIL_RECONCILE_TOPIC, type GmailReconcileJob } from '../api/gmail-webhook.js'
import type { QueueProvider } from '../providers/queue.js'
import type { GmailWatchStateStore } from '../store/gmail-watch-state.js'
import type { MailboxStore } from '../store/mailboxes.js'

export interface GmailReconcileSweepDeps {
  /** The per-mailbox source (`listActiveMailboxes`, `../store/mailboxes.ts`). */
  mailboxStore: MailboxStore

  /** The stored-cursor read (`../store/gmail-watch-state.ts`). */
  watchStateStore: GmailWatchStateStore

  /** Where each mailbox's reconcile job is enqueued — the SAME `GMAIL_RECONCILE_TOPIC` the push webhook enqueues onto. */
  queue: QueueProvider
}

/** What one {@link runGmailReconcileSweep} pass did, for platform-log observability. */
export interface GmailReconcileSweepReport {
  /** Active mailboxes considered this pass. */
  total: number
  /** Mailboxes a reconcile job was enqueued for (had a baseline cursor). */
  swept: number
  /** Mailboxes skipped for having no baseline cursor yet — connect seeds it, so this means a mailbox that never completed connect. */
  skipped: number
  /** Mailboxes whose enqueue or cursor read threw this pass — retried on the next tick, a minute later. */
  failed: number
}

/**
 * Emit one structured, JSON-parseable log line — mirrors
 * `./gmail-watch-maintenance.ts`'s `logMaintenanceEvent` and
 * `./gmail-reconcile.ts`'s `logReconcileEvent`. Plain `console.*` of a
 * JSON-serializable object is this codebase's logging convention (CHARTER.md
 * §4: serverless, platform-log-aggregated). Never pass a raw caught error
 * object; only its message, and only where that message is known token-free.
 */
function logSweepEvent(level: 'info' | 'warn' | 'error', record: Record<string, unknown>): void {
  const line = JSON.stringify({ event: 'gmail_reconcile_sweep', ...record })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

/**
 * Run one bounded reconciliation sweep across every active mailbox. Never
 * throws for an individual mailbox (see the module doc's failure isolation);
 * a fault outside the per-mailbox loop propagates to the caller.
 */
export async function runGmailReconcileSweep(
  deps: GmailReconcileSweepDeps,
): Promise<GmailReconcileSweepReport> {
  const { mailboxStore, watchStateStore, queue } = deps

  const mailboxes = await mailboxStore.listActiveMailboxes()
  const report: GmailReconcileSweepReport = {
    total: mailboxes.length,
    swept: 0,
    skipped: 0,
    failed: 0,
  }

  for (const mailbox of mailboxes) {
    try {
      const cursor = await watchStateStore.getCursor(mailbox.id)
      if (cursor === null) {
        // No baseline yet. Connect (HT-40) seeds this, so reaching here means
        // a mailbox row exists without a completed connect — worth a line,
        // but not an error, and never a reason to stall the rest of the batch.
        report.skipped++
        logSweepEvent('info', {
          mailboxId: mailbox.id,
          outcome: 'skipped',
          reason: 'no-baseline-cursor',
        })
        continue
      }

      const job: GmailReconcileJob = { mailboxId: mailbox.id, historyId: cursor }
      await queue.enqueue(GMAIL_RECONCILE_TOPIC, job, {})
      report.swept++
    } catch (err) {
      // Safe to log the message: everything reachable here is a plain
      // store/queue error. No access token is in scope in this module at all
      // — the sweep makes no Gmail API call (module doc).
      report.failed++
      logSweepEvent('error', {
        mailboxId: mailbox.id,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return report
}
