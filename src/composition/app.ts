/**
 * The composition root's unified request handler (HT-43): one
 * `(request: Request) => Promise<Response>` that fronts BOTH the Agent Inbox
 * API (`createInboxApi`, `src/api/index.ts`) and the internal endpoints —
 * the two cron jobs Vercel Cron invokes (specs/deploy/gmail-inbound-
 * runbook.md Part C) plus the pull-based health check an HTTP monitor polls
 * (HT-44, runbook Part G). A single Vercel function (`api/[...path].ts`)
 * delegates every request here; this module decides internal-vs-inbox by
 * pathname.
 *
 * ## Why the cron endpoints live here, not inside `createInboxApi`
 *
 * The runbook (and this ticket's plan) deliberately keep the drain/maintenance
 * endpoints OUT of the Agent Inbox API's route table: they are deploy-infra
 * (cron plumbing), not part of the Agent-inbox product surface
 * (specs/api/agent-inbox-v1.md), and they authenticate with a DIFFERENT
 * credential — the `CRON_SECRET` Vercel attaches as `Authorization: Bearer`
 * (Vercel's own "Securing cron jobs" mechanism), not the service Bearer token
 * every inbox route checks. Handling them here keeps `createInboxApi`'s
 * surface exactly the spec'd one, with no cron-only routes or a second
 * credential leaking into it.
 *
 * ## The cron contract (Vercel Cron)
 *
 * Vercel invokes a cron `path` with an HTTP **GET**, attaching
 * `Authorization: Bearer <CRON_SECRET>` when that env var is set. Vercel does
 * NOT retry a failed invocation and may occasionally miss OR duplicate a run,
 * so both endpoints' work must be idempotent and reconciliation-based — which
 * the drain (lease-based `FOR UPDATE SKIP LOCKED`, `createPostgresQueue`) and
 * the maintenance sweep (re-reads each mailbox's stored cursor; ingest dedups)
 * both already are. A failed run simply retries on the next tick.
 */

import { authenticateRequest } from '../api/auth.js'
import { apiError, json } from '../api/responses.js'
import type { HealthReport } from './health.js'

/** `GET` (Vercel Cron) → drain one bounded batch of the durable job queue (runbook Part C: every minute). */
export const QUEUE_DRAIN_PATH = '/api/v1/internal/queue/drain'

/** `GET` (Vercel Cron) → daily Gmail `watch()` re-arm + reconciliation sweep (runbook Part C: daily at 06:00 UTC). */
export const WATCH_MAINTENANCE_PATH = '/api/v1/internal/cron/watch-maintenance'

/** `GET` (Vercel Cron) → drain one bounded batch of `event_outbox` into `queue_jobs` webhook-delivery fan-out (HT-69; `src/webhooks/outbox-drain.ts`; runbook Part C: every minute, same cadence as {@link QUEUE_DRAIN_PATH}). A SEPARATE endpoint from the queue drain — this one turns outbox rows into queue jobs; the queue drain is what then delivers them. */
export const OUTBOX_DRAIN_PATH = '/api/v1/internal/outbox/drain'

/**
 * `GET` (an HTTP monitor, or an operator's curl) → the point-in-time
 * {@link HealthReport} (`./health.ts`; HT-44, runbook Part G). Same
 * `CRON_SECRET` guard as the cron endpoints, but a different status
 * contract: **200 when healthy, 503 when any alert is tripped**, so a
 * status-code-only poller is a complete alerting stack.
 */
export const HEALTH_PATH = '/api/v1/internal/health'

/** Dependencies {@link createAppHandler} closes over. */
export interface AppHandlerDeps {
  /** The Agent Inbox API handler (`createInboxApi`) — every non-cron request is delegated here unchanged. */
  inboxApi: (request: Request) => Promise<Response>
  /** The `CRON_SECRET` every internal endpoint requires as `Authorization: Bearer <secret>` (constant-time compared). */
  cronSecret: string
  /** Drain one bounded batch of the job queue; returns a JSON-serializable report for the response body + logs. */
  drainQueue: () => Promise<unknown>
  /** Drain one bounded batch of `event_outbox` into webhook-delivery queue jobs (HT-69, {@link OUTBOX_DRAIN_PATH}); returns a JSON-serializable report for the response body + logs. */
  drainOutbox: () => Promise<unknown>
  /** Run one daily watch-renewal + reconciliation-sweep pass; returns a JSON-serializable report. */
  runWatchMaintenance: () => Promise<unknown>
  /** Assemble the health report (`./health.ts`) — the {@link HEALTH_PATH} endpoint's work. */
  runHealthCheck: () => Promise<HealthReport>
}

/**
 * Build the unified handler. Routes the two internal cron paths to their
 * `CRON_SECRET`-guarded handlers and delegates everything else — the whole
 * Agent Inbox API surface, including the Gmail webhook, connect, and callback
 * — to `deps.inboxApi` unchanged.
 */
export function createAppHandler(deps: AppHandlerDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)

    if (pathname === QUEUE_DRAIN_PATH) {
      return handleCronEndpoint(request, deps.cronSecret, 'queue-drain', deps.drainQueue)
    }
    if (pathname === OUTBOX_DRAIN_PATH) {
      return handleCronEndpoint(request, deps.cronSecret, 'outbox-drain', deps.drainOutbox)
    }
    if (pathname === WATCH_MAINTENANCE_PATH) {
      return handleCronEndpoint(
        request,
        deps.cronSecret,
        'watch-maintenance',
        deps.runWatchMaintenance,
      )
    }
    if (pathname === HEALTH_PATH) {
      // The report is the body verbatim (it carries its own `ok`/`alerts`),
      // and the status pivots on it — 503 on any tripped alert so a
      // status-code-only monitor alerts without parsing JSON (HEALTH_PATH's
      // doc comment).
      return handleCronEndpoint(request, deps.cronSecret, 'health', deps.runHealthCheck, (report) =>
        json(report.ok ? 200 : 503, report),
      )
    }

    return deps.inboxApi(request)
  }
}

/**
 * The shared shape of an internal cron endpoint: GET-only, `CRON_SECRET`
 * Bearer-gated, running an idempotent unit of work and returning its report.
 *
 * Auth is checked with `authenticateRequest` (`src/api/auth.ts`) — the exact
 * constant-time `Authorization: Bearer <secret>` comparison the inbox API
 * uses for its service token, reused here against the cron secret since Vercel
 * attaches the `CRON_SECRET` in exactly that header shape. The auth failure is
 * a generic `401` that reveals nothing about which check failed — an
 * unauthenticated caller can't even tell a wrong secret from a wrong method
 * (the method check runs only AFTER auth), so this endpoint is not a probe for
 * whether Gmail push/cron is configured.
 *
 * A thrown error from the work is logged server-side and answered with a
 * generic `500` (never the error's own text — a store/queue/Gmail error could
 * carry internal detail): safe because Vercel Cron retries on the next tick
 * and the work is idempotent + lease-bounded.
 *
 * `respond` maps the successful work's report to its `Response` — the two
 * cron endpoints use the default `200 { ok: true, report }`, while the
 * health endpoint substitutes its own 200-vs-503 pivot ({@link HEALTH_PATH}).
 * Auth, the method check, and the generic-500 catch stay identical across
 * all of them.
 */
async function handleCronEndpoint<T>(
  request: Request,
  cronSecret: string,
  label: string,
  work: () => Promise<T>,
  respond: (report: T) => Response = (report) => json(200, { ok: true, report }),
): Promise<Response> {
  if (!authenticateRequest(request, cronSecret)) {
    return apiError(401, 'unauthorized', 'Missing or invalid credentials.')
  }
  if (request.method !== 'GET') {
    return apiError(405, 'method_not_allowed', 'This method is not supported here.')
  }

  try {
    const report = await work()
    return respond(report)
  } catch (err) {
    console.error(`[composition] internal cron endpoint '${label}' failed`, err)
    return apiError(500, 'server_error', 'Internal server error.')
  }
}
