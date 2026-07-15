/**
 * The composition root's unified request handler (HT-43): one
 * `(request: Request) => Promise<Response>` that fronts BOTH the Agent Inbox
 * API (`createInboxApi`, `src/api/index.ts`) and the two internal cron
 * endpoints Vercel Cron invokes (specs/deploy/gmail-inbound-runbook.md Part
 * C). A single Vercel function (`api/[...path].ts`) delegates every request
 * here; this module decides internal-cron-vs-inbox by pathname.
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

/** `GET` (Vercel Cron) → drain one bounded batch of the durable job queue (runbook Part C: every minute). */
export const QUEUE_DRAIN_PATH = '/api/v1/internal/queue/drain'

/** `GET` (Vercel Cron) → daily Gmail `watch()` re-arm + reconciliation sweep (runbook Part C: daily at 06:00 UTC). */
export const WATCH_MAINTENANCE_PATH = '/api/v1/internal/cron/watch-maintenance'

/** Dependencies {@link createAppHandler} closes over. */
export interface AppHandlerDeps {
  /** The Agent Inbox API handler (`createInboxApi`) — every non-cron request is delegated here unchanged. */
  inboxApi: (request: Request) => Promise<Response>
  /** The `CRON_SECRET` both internal endpoints require as `Authorization: Bearer <secret>` (constant-time compared). */
  cronSecret: string
  /** Drain one bounded batch of the job queue; returns a JSON-serializable report for the response body + logs. */
  drainQueue: () => Promise<unknown>
  /** Run one daily watch-renewal + reconciliation-sweep pass; returns a JSON-serializable report. */
  runWatchMaintenance: () => Promise<unknown>
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
    if (pathname === WATCH_MAINTENANCE_PATH) {
      return handleCronEndpoint(
        request,
        deps.cronSecret,
        'watch-maintenance',
        deps.runWatchMaintenance,
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
 */
async function handleCronEndpoint(
  request: Request,
  cronSecret: string,
  label: string,
  work: () => Promise<unknown>,
): Promise<Response> {
  if (!authenticateRequest(request, cronSecret)) {
    return apiError(401, 'unauthorized', 'Missing or invalid credentials.')
  }
  if (request.method !== 'GET') {
    return apiError(405, 'method_not_allowed', 'This method is not supported here.')
  }

  try {
    const report = await work()
    return json(200, { ok: true, report })
  } catch (err) {
    console.error(`[composition] internal cron endpoint '${label}' failed`, err)
    return apiError(500, 'server_error', 'Internal server error.')
  }
}
