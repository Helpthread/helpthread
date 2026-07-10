/**
 * `SchedulerProvider` — the seam for time-based and durable work.
 *
 * See `src/providers/README.md` for the pattern this fits into. First
 * adapter targets (CHARTER.md §4): Vercel Cron for the recurring-cron
 * half, Vercel Cron plus a Postgres-backed `scheduled_actions` table for
 * the durable-delayed-action half.
 *
 * This interface covers two distinct shapes the charter names together
 * under "scheduled and durable work" — they are related but not the same
 * problem, so they get separate method pairs below.
 */

/**
 * A reference to a handler that can be invoked by name. Cron and scheduled
 * actions both identify "what to run" this way rather than by passing a
 * function value, because the thing that fires the work (a cron tick, a
 * poll of due actions) generally runs in a different invocation/process
 * than the one that registered it — a function reference wouldn't survive
 * that boundary. Resolving a `HandlerRef` to actual code is an adapter
 * concern (e.g. a lookup table the adapter's HTTP entry point dispatches
 * through).
 */
export type HandlerRef = string

/**
 * Provider for time-based and durable work: recurring cron schedules, and
 * durable delayed actions ("do X at/after time T, and don't forget even
 * across redeploys or restarts").
 */
export interface SchedulerProvider {
  /**
   * Register a recurring cron schedule identified by `name`, running on
   * `cronExpr` (standard 5-field cron syntax), invoking `handlerRef` on
   * each tick.
   *
   * IMPORTANT: on most serverless platforms (Vercel included) cron
   * registration is **build/deploy-time configuration** (e.g. entries in
   * `vercel.json`), not a call made at runtime by a running process —
   * there is no long-lived process to make the call. Treat this method as
   * a **declaration surface**: an adapter may implement it by writing to
   * config that takes effect on next deploy, by validating a schedule
   * that's declared elsewhere, or (for platforms that do support dynamic
   * registration) by an actual runtime API call. Callers should not
   * assume a call to `registerCron` takes effect immediately, or at all,
   * without a deploy — the return value/promise resolving only means the
   * registration was accepted, not that the schedule is live.
   */
  registerCron(name: string, cronExpr: string, handlerRef: HandlerRef): Promise<void>

  /**
   * Schedule `action` to run at or after `runAt`, carrying `payload`.
   * Returns the id of the scheduled action so it can later be cancelled.
   *
   * This is the durable-delayed-action pattern the charter names
   * alongside cron (a `scheduled_actions` table, polled by a cron tick the
   * engine owns): the action must survive redeploys, cold starts, and
   * process restarts, because there is no in-memory timer or long-lived
   * process holding it. Delivery is via poll, not push: a recurring cron
   * tick (registered separately, via `registerCron` or equivalent
   * platform config) queries for actions due at-or-before "now" and
   * dispatches each to its `handlerRef`. `runAt` is therefore a lower
   * bound on execution time, not a precise deadline — actual delivery
   * latency is bounded by the polling cron's own interval.
   *
   * Like `QueueProvider`, this is an at-least-once contract: a poll tick
   * that dispatches an action but crashes/times out before marking it
   * delivered may cause the next tick to dispatch it again. Handlers MUST
   * be idempotent for the same action id.
   */
  scheduleAction<T>(runAt: Date, action: HandlerRef, payload: T): Promise<string>

  /**
   * Cancel a previously scheduled action by id. Resolves whether or not
   * the action still existed (already fired, already cancelled, or never
   * existed are all treated as a successful no-op) — callers that need to
   * distinguish those cases should track state themselves rather than
   * relying on this call to report it, since a race between cancellation
   * and delivery is inherent to the poll-based delivery model above.
   */
  cancelAction(id: string): Promise<void>
}
