/**
 * `runGmailReconcileSweep` — the bounded scheduled fetch that is Helpthread's
 * PRIMARY inbound transport (CHARTER.md §2 as amended 2026-07-20:
 * "push-based delivery where providers offer it, bounded scheduled fetches
 * where they don't — and no resident process either way").
 *
 * One pass enqueues a reconcile job per active mailbox that has a baseline
 * cursor. The job is the SAME `GMAIL_RECONCILE_TOPIC` job the push webhook
 * enqueues (`../api/gmail-webhook.ts`) and `./gmail-reconcile.ts` consumes —
 * this module changes *what triggers* reconciliation, never how it works.
 * That equivalence is the point: a deployment without Pub/Sub ingests mail
 * through exactly the code path a deployment with it does, triggered by a
 * clock instead of a notification.
 *
 * ## Why this is its own entry point, not a flag on watch renewal
 *
 * This logic once lived inside `./gmail-watch-maintenance.ts`'s daily
 * per-mailbox pass, framed as a backstop for push. Two reasons it cannot
 * share a cron with renewal:
 *
 * 1. **Cadence.** A backstop runs daily; the primary transport runs every
 *    minute. A mailbox whose only intake is a daily sweep is not a helpdesk.
 * 2. **Cost, the load-bearing one.** Watch renewal must acquire an access
 *    token per mailbox, because it calls `users.watch()`. The sweep must not:
 *    all it needs is a stored cursor and a queue write, and no Gmail API call
 *    happens here at all. Welding them together would mean a token refresh
 *    per mailbox per MINUTE against Google's token endpoint, for a call the
 *    sweep never makes. The reconcile CONSUMER acquires its own token when it
 *    actually talks to Gmail.
 *
 * ## The dedupe key is the bare `mailboxId`
 *
 * Not a composite like `mailboxId:historyId`, which would pin suppression to
 * a cursor value and could wedge a quiet mailbox indefinitely. And not
 * omitted: the queue's partial unique index only suppresses against jobs
 * still LIVE (`../providers/adapters/postgres-queue/`: `WHERE dedupe_key IS
 * NOT NULL AND dead_lettered_at IS NULL`), so once a mailbox's job completes
 * the next tick enqueues again and a quiet mailbox is still swept every
 * minute.
 *
 * Omitting the key would be safe at a daily cadence and is not at an
 * every-minute one, for two reasons:
 *
 * - **The consumer lease does not make contention free.** A failed claim
 *   returns `{ kind: 'retry' }` (`./gmail-reconcile.ts`), and the queue counts
 *   attempts and DEAD-LETTERS at the cap. A reconcile running longer than the
 *   retry window — a large history batch, or one multi-MB raw message through
 *   blob write plus ingest — makes every tick behind it burn its attempts and
 *   dead-letter, which then trips the `queue-dead-letter-growth` health alert.
 *   The lease prevents duplicated *work*; it does nothing about duplicated
 *   *rows*.
 * - **There would be no backpressure at all.** Enqueue rate is one job per
 *   active mailbox per minute, unconditional; drain capacity is a bounded
 *   batch per tick, shared with webhook delivery. Past roughly that many
 *   mailboxes `queue_jobs` grows monotonically and intake latency grows
 *   without bound. Keying on `mailboxId` collapses the redundant pending
 *   ticks.
 *
 * This also aligns the sweep with the push path, which has always enqueued
 * with a dedupe key.
 *
 * ## Failure isolation
 *
 * Per-mailbox failures never stop the batch — one mailbox with an unreadable
 * cursor must not stall intake for every other. A fault outside the
 * per-mailbox loop (`listActiveMailboxes` itself failing) propagates,
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
