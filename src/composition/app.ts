/**
 * The composition root's unified request handler (HT-43): one
 * `(request: Request) => Promise<Response>` that fronts the Agent Inbox
 * API (`createInboxApi`, `src/api/index.ts`), the internal endpoints —
 * the two cron jobs Vercel Cron invokes (specs/deploy/gmail-inbound-
 * runbook.md Part C) plus the pull-based health check an HTTP monitor polls
 * (HT-44, runbook Part G) — and the bare root's friendly response (its own
 * section below). A single Vercel function (`api/index.ts`) delegates every
 * request here; this module decides the route by pathname.
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
 *
 * ## The bare root path (`/`)
 *
 * `vercel.json` also rewrites `/` — exactly `/`, no other non-API path — to
 * this function: without it, an operator who types the engine host into a
 * browser gets Vercel's raw `NOT_FOUND` page, which reads as "the deployment
 * is dead" while the engine is in fact healthy. `GET /` (and `HEAD`, which
 * RFC 9110 §9.3.2 defines as identical to GET minus the response body)
 * answers with a 302 to the operator UI when
 * {@link AppHandlerDeps.uiBaseUrl} is configured, else a tiny
 * service-identifying JSON. Deliberately unauthenticated: the response
 * reveals only the service's name / the UI's public origin.
 */

import { authenticateRequest } from '../api/auth.js'
import { apiError, json } from '../api/responses.js'
import type { HealthReport } from './health.js'

/** `GET` (Vercel Cron) → drain one bounded batch of the durable job queue (runbook Part C: every minute). */
export const QUEUE_DRAIN_PATH = '/api/v1/internal/queue/drain'

/** `GET` (Vercel Cron) → daily Gmail `watch()` re-arm + reconciliation sweep (runbook Part C: daily at 06:00 UTC). */
export const WATCH_MAINTENANCE_PATH = '/api/v1/internal/cron/watch-maintenance'

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
  /** Run one daily watch-renewal + reconciliation-sweep pass; returns a JSON-serializable report. */
  runWatchMaintenance: () => Promise<unknown>
  /** Assemble the health report (`./health.ts`) — the {@link HEALTH_PATH} endpoint's work. */
  runHealthCheck: () => Promise<HealthReport>
  /**
   * The operator UI's bare origin (`AppConfig.uiBaseUrl`,
   * `HELPTHREAD_UI_BASE_URL`) — when configured, `GET /` 302-redirects
   * there; absent, `GET /` answers a tiny service-identifying JSON instead.
   * Optional exactly like the config field: spread in only when configured,
   * never present-with-undefined (root.ts's optional-field convention).
   */
  uiBaseUrl?: string
}

/**
 * Build the unified handler. Routes the two internal cron paths to their
 * `CRON_SECRET`-guarded handlers, answers `GET`/`HEAD` on the bare root with
 * the friendly response (module doc above), and delegates everything else —
 * the whole Agent Inbox API surface, including the Gmail webhook, connect,
 * and callback — to `deps.inboxApi` unchanged.
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
    if (pathname === HEALTH_PATH) {
      // The report is the body verbatim (it carries its own `ok`/`alerts`),
      // and the status pivots on it — 503 on any tripped alert so a
      // status-code-only monitor alerts without parsing JSON (HEALTH_PATH's
      // doc comment).
      return handleCronEndpoint(request, deps.cronSecret, 'health', deps.runHealthCheck, (report) =>
        json(report.ok ? 200 : 503, report),
      )
    }

    // The bare root — a human checking "is this thing up?" in a browser
    // (module doc's "The bare root path" section). GET plus HEAD (RFC 9110
    // §9.3.2: identical to GET minus the response body); any other method
    // falls through to the inbox API's standard 404 envelope like every
    // other unknown path.
    if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
      if (deps.uiBaseUrl !== undefined) {
        return new Response(null, {
          status: 302,
          headers: { Location: deps.uiBaseUrl, 'Cache-Control': 'no-store' },
        })
      }
      return json(200, { service: 'helpthread-engine', docs: '/api/v1' })
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
