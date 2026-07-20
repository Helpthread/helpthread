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
 * ## The dedupe key is the bare `mailboxId` — corrected after review
 *
 * The inherited behavior was NO `dedupeKey`, on the reasoning that "a sweep of
 * an already-current, quiet mailbox must still run rather than be suppressed
 * as a duplicate." That reasoning is sound, and it argues against a COMPOSITE
 * key like `mailboxId:historyId` — which would pin suppression to a cursor
 * value and could wedge a quiet mailbox indefinitely. It does not argue
 * against the bare `mailboxId`, because the queue's partial unique index only
 * suppresses against jobs that are still LIVE
 * (`../providers/adapters/postgres-queue/`: `WHERE dedupe_key IS NOT NULL AND
 * dead_lettered_at IS NULL`). Once a mailbox's job completes, the next tick
 * enqueues again. A quiet mailbox is still swept every minute.
 *
 * Carrying "no dedupeKey" from a DAILY cadence to an every-minute one was the
 * actual mistake, and it was not benign:
 *
 * - **The consumer lease does not make contention free.** A failed claim
 *   returns `{ kind: 'retry' }` (`./gmail-reconcile.ts`), and the queue counts
 *   attempts and DEAD-LETTERS at the cap. A reconcile that runs longer than
 *   the retry window (a large history batch, or one multi-MB raw message
 *   through blob write + ingest) causes every tick behind it to burn its
 *   attempts and dead-letter — which then trips the `queue-dead-letter-growth`
 *   health alert. The lease prevents duplicated *work*; it does nothing about
 *   duplicated *rows*.
 * - **There was no backpressure whatsoever.** Enqueue rate was one job per
 *   active mailbox per minute, unconditional; drain capacity is a bounded
 *   batch per tick, shared with webhook delivery. Past roughly that many
 *   mailboxes, `queue_jobs` grew monotonically and intake latency grew without
 *   bound. Keying on `mailboxId` collapses the redundant pending ticks that
 *   caused it.
 *
 * Note this also aligns the sweep with the push path, which has always
 * enqueued with a dedupe key (`../api/gmail-webhook.ts`).
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
  /**
   * Mailboxes an enqueue was ISSUED for (i.e. that had a baseline cursor).
   *
   * Not necessarily rows created: `QueueProvider.enqueue` returns `void`, so a
   * dedupe-suppressed enqueue (a job for this mailbox already pending) is
   * indistinguishable here from one that inserted. On a busy mailbox this
   * counter therefore reads 1 whether or not the tick did anything — the
   * queue's own depth metrics are the place to see that difference.
   */
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
      // Bare mailboxId, NOT `mailboxId:historyId` — see the module doc. This
      // collapses a redundant tick against a still-pending job for the same
      // mailbox, and stops suppressing as soon as that job leaves the live set.
      await queue.enqueue(GMAIL_RECONCILE_TOPIC, job, { dedupeKey: mailbox.id })
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
