import { describe, expect, it, vi } from 'vitest'
import {
  createAppHandler,
  HEALTH_PATH,
  OUTBOX_DRAIN_PATH,
  QUEUE_DRAIN_PATH,
  SNOOZE_WAKE_PATH,
  WATCH_MAINTENANCE_PATH,
} from './app.js'
import type { HealthReport } from './health.js'

const CRON_SECRET = 'test-cron-secret-0123456789'
const ORIGIN = 'https://desk.example.test'

/** A fully-healthy {@link HealthReport} — tests mutate/override from here. */
const HEALTHY_REPORT: HealthReport = {
  ok: true,
  alerts: [],
  generatedAt: '2026-07-18T00:00:00.000Z',
  queue: { ready: 0, oldestReadyAgeSeconds: null, deadLettered: 0, deadLetteredLast24h: 0 },
  ingest: {
    last24hByStatus: { received: 0, stored: 0, suppressed: 0, failed: 0, 'dead-letter': 0 },
    deadLetterTotal: 0,
  },
  forgedTokens: { deliveriesLast24h: 0, tokensLast24h: 0, alertThreshold: 5 },
  mailboxes: [],
  webhooks: { autoDisabled: [], deliveryFailuresLast24h: 0 },
  webauthn: { counterRegressionsLast24h: 0 },
}

/** Build a handler over spy deps; the inbox API spy returns a recognizable 299 so delegation is observable. */
function makeHandler(opts: { cronSecret?: string; uiBaseUrl?: string } = {}) {
  const inboxApi = vi.fn(async () => new Response('inbox', { status: 299 }))
  const drainQueue = vi.fn(async () => ({ claimed: 3, acked: 3 }))
  const drainOutbox = vi.fn(async () => ({ claimed: 2, enqueued: 2, dispatched: 2 }))
  const runSnoozeWake = vi.fn(async () => ({ due: 1, woken: 1 }))
  const runWatchMaintenance = vi.fn(async () => ({ total: 1, renewed: 1 }))
  const runReconcileSweep = vi.fn(async () => ({ total: 1, swept: 1, skipped: 0, failed: 0 }))
  const runHealthCheck = vi.fn(async (): Promise<HealthReport> => HEALTHY_REPORT)
  const handler = createAppHandler({
    inboxApi,
    cronSecret: opts.cronSecret ?? CRON_SECRET,
    ...(opts.uiBaseUrl !== undefined ? { uiBaseUrl: opts.uiBaseUrl } : {}),
    drainQueue,
    drainOutbox,
    runSnoozeWake,
    runWatchMaintenance,
    runReconcileSweep,
    runHealthCheck,
  })
  return {
    handler,
    inboxApi,
    drainQueue,
    drainOutbox,
    runSnoozeWake,
    runWatchMaintenance,
    runReconcileSweep,
    runHealthCheck,
  }
}

/** A request to `path`; attaches `Authorization: Bearer <secret>` unless `secret` is null. */
function req(
  path: string,
  {
    method = 'GET',
    secret = CRON_SECRET as string | null,
  }: { method?: string; secret?: string | null } = {},
): Request {
  const headers: Record<string, string> = {}
  if (secret !== null) headers.Authorization = `Bearer ${secret}`
  return new Request(`${ORIGIN}${path}`, { method, headers })
}

describe('createAppHandler — non-cron delegation', () => {
  it('delegates a normal inbox path to the inbox API unchanged', async () => {
    const { handler, inboxApi, drainQueue, runWatchMaintenance } = makeHandler()
    const request = req('/api/v1/conversations', { secret: null })

    const res = await handler(request)

    expect(res.status).toBe(299)
    expect(inboxApi).toHaveBeenCalledOnce()
    expect(inboxApi).toHaveBeenCalledWith(request)
    expect(drainQueue).not.toHaveBeenCalled()
    expect(runWatchMaintenance).not.toHaveBeenCalled()
  })

  it('delegates the Gmail webhook path (also under /api/v1/inbound) to the inbox API', async () => {
    const { handler, inboxApi } = makeHandler()
    const res = await handler(req('/api/v1/inbound/gmail', { method: 'POST', secret: null }))
    expect(res.status).toBe(299)
    expect(inboxApi).toHaveBeenCalledOnce()
  })
})

describe('createAppHandler — queue drain endpoint', () => {
  it('runs the drain and returns its report on a GET with the correct cron secret', async () => {
    const { handler, drainQueue, inboxApi } = makeHandler()

    const res = await handler(req(QUEUE_DRAIN_PATH))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, report: { claimed: 3, acked: 3 } })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(drainQueue).toHaveBeenCalledOnce()
    expect(inboxApi).not.toHaveBeenCalled()
  })

  it('rejects a wrong cron secret with 401 and never runs the work', async () => {
    const { handler, drainQueue } = makeHandler()
    const res = await handler(req(QUEUE_DRAIN_PATH, { secret: 'wrong-secret-9999999999' }))
    expect(res.status).toBe(401)
    expect(drainQueue).not.toHaveBeenCalled()
  })

  it('rejects a missing Authorization header with 401', async () => {
    const { handler, drainQueue } = makeHandler()
    const res = await handler(req(QUEUE_DRAIN_PATH, { secret: null }))
    expect(res.status).toBe(401)
    expect(drainQueue).not.toHaveBeenCalled()
  })

  it('checks auth BEFORE method — a wrong-secret POST is 401, not 405 (no method oracle for an unauthenticated caller)', async () => {
    const { handler, drainQueue } = makeHandler()
    const res = await handler(req(QUEUE_DRAIN_PATH, { method: 'POST', secret: 'wrong-9999999999' }))
    expect(res.status).toBe(401)
    expect(drainQueue).not.toHaveBeenCalled()
  })

  it('rejects a non-GET method (authenticated) with 405', async () => {
    const { handler, drainQueue } = makeHandler()
    const res = await handler(req(QUEUE_DRAIN_PATH, { method: 'POST' }))
    expect(res.status).toBe(405)
    expect(drainQueue).not.toHaveBeenCalled()
  })

  it('answers a generic 500 (never the error text) when the work throws', async () => {
    const inboxApi = vi.fn(async () => new Response(null, { status: 299 }))
    const drainQueue = vi.fn(async () => {
      throw new Error('secret-internal-detail-should-not-leak')
    })
    const runWatchMaintenance = vi.fn(async () => ({}))
    const handler = createAppHandler({
      inboxApi,
      cronSecret: CRON_SECRET,
      drainQueue,
      drainOutbox: vi.fn(async () => ({})),
      runSnoozeWake: vi.fn(async () => ({})),
      runWatchMaintenance,
      runReconcileSweep: vi.fn(async () => ({})),
      runHealthCheck: vi.fn(async () => HEALTHY_REPORT),
    })

    const res = await handler(req(QUEUE_DRAIN_PATH))
    const bodyText = await res.text()

    expect(res.status).toBe(500)
    expect(bodyText).not.toContain('secret-internal-detail-should-not-leak')
    expect(JSON.parse(bodyText)).toEqual({
      error: { code: 'server_error', message: 'Internal server error.' },
    })
  })
})

describe('createAppHandler — outbox drain endpoint (HT-69)', () => {
  it('runs the outbox drain and returns its report on a GET with the correct cron secret — a SEPARATE endpoint from the queue drain', async () => {
    const { handler, drainOutbox, drainQueue, inboxApi } = makeHandler()

    const res = await handler(req(OUTBOX_DRAIN_PATH))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      report: { claimed: 2, enqueued: 2, dispatched: 2 },
    })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(drainOutbox).toHaveBeenCalledOnce()
    expect(drainQueue).not.toHaveBeenCalled()
    expect(inboxApi).not.toHaveBeenCalled()
  })

  it('rejects a wrong cron secret with 401 and never runs the work', async () => {
    const { handler, drainOutbox } = makeHandler()
    const res = await handler(req(OUTBOX_DRAIN_PATH, { secret: 'wrong-secret-9999999999' }))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it('rejects a non-GET method (authenticated) with 405', async () => {
    const { handler, drainOutbox } = makeHandler()
    const res = await handler(req(OUTBOX_DRAIN_PATH, { method: 'POST' }))
    expect(res.status).toBe(405)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it('answers a generic 500 (never the error text) when the work throws', async () => {
    const inboxApi = vi.fn(async () => new Response(null, { status: 299 }))
    const handler = createAppHandler({
      inboxApi,
      cronSecret: CRON_SECRET,
      drainQueue: vi.fn(async () => ({})),
      drainOutbox: vi.fn(async () => {
        throw new Error('secret-internal-detail-should-not-leak')
      }),
      runSnoozeWake: vi.fn(async () => ({})),
      runWatchMaintenance: vi.fn(async () => ({})),
      runReconcileSweep: vi.fn(async () => ({})),
      runHealthCheck: vi.fn(async () => HEALTHY_REPORT),
    })

    const res = await handler(req(OUTBOX_DRAIN_PATH))
    const bodyText = await res.text()

    expect(res.status).toBe(500)
    expect(bodyText).not.toContain('secret-internal-detail-should-not-leak')
    expect(JSON.parse(bodyText)).toEqual({
      error: { code: 'server_error', message: 'Internal server error.' },
    })
  })
})

describe('createAppHandler — snooze wake endpoint (HT-77)', () => {
  it('runs the wake pass and returns its report on a GET with the correct cron secret — a SEPARATE endpoint from the other crons', async () => {
    const { handler, runSnoozeWake, drainQueue, drainOutbox, inboxApi } = makeHandler()

    const res = await handler(req(SNOOZE_WAKE_PATH))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, report: { due: 1, woken: 1 } })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(runSnoozeWake).toHaveBeenCalledOnce()
    expect(drainQueue).not.toHaveBeenCalled()
    expect(drainOutbox).not.toHaveBeenCalled()
    expect(inboxApi).not.toHaveBeenCalled()
  })

  it('rejects a wrong cron secret with 401 and never runs the work', async () => {
    const { handler, runSnoozeWake } = makeHandler()
    const res = await handler(req(SNOOZE_WAKE_PATH, { secret: 'wrong-secret-9999999999' }))
    expect(res.status).toBe(401)
    expect(runSnoozeWake).not.toHaveBeenCalled()
  })

  it('rejects a non-GET method (authenticated) with 405', async () => {
    const { handler, runSnoozeWake } = makeHandler()
    const res = await handler(req(SNOOZE_WAKE_PATH, { method: 'POST' }))
    expect(res.status).toBe(405)
    expect(runSnoozeWake).not.toHaveBeenCalled()
  })

  it('answers a generic 500 (never the error text) when the work throws', async () => {
    const inboxApi = vi.fn(async () => new Response(null, { status: 299 }))
    const handler = createAppHandler({
      inboxApi,
      cronSecret: CRON_SECRET,
      drainQueue: vi.fn(async () => ({})),
      drainOutbox: vi.fn(async () => ({})),
      runSnoozeWake: vi.fn(async () => {
        throw new Error('secret-internal-detail-should-not-leak')
      }),
      runWatchMaintenance: vi.fn(async () => ({})),
      runReconcileSweep: vi.fn(async () => ({})),
      runHealthCheck: vi.fn(async () => HEALTHY_REPORT),
    })

    const res = await handler(req(SNOOZE_WAKE_PATH))
    const bodyText = await res.text()

    expect(res.status).toBe(500)
    expect(bodyText).not.toContain('secret-internal-detail-should-not-leak')
    expect(JSON.parse(bodyText)).toEqual({
      error: { code: 'server_error', message: 'Internal server error.' },
    })
  })
})

describe('createAppHandler — watch-maintenance endpoint', () => {
  it('runs the maintenance sweep and returns its report on an authenticated GET', async () => {
    const { handler, runWatchMaintenance } = makeHandler()

    const res = await handler(req(WATCH_MAINTENANCE_PATH))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, report: { total: 1, renewed: 1 } })
    expect(runWatchMaintenance).toHaveBeenCalledOnce()
  })

  it('rejects a wrong cron secret with 401', async () => {
    const { handler, runWatchMaintenance } = makeHandler()
    const res = await handler(req(WATCH_MAINTENANCE_PATH, { secret: 'nope-9999999999999' }))
    expect(res.status).toBe(401)
    expect(runWatchMaintenance).not.toHaveBeenCalled()
  })
})

describe('createAppHandler — health endpoint (HT-44)', () => {
  it('answers 200 with the report VERBATIM (not {ok, report}-wrapped) when healthy', async () => {
    const { handler, runHealthCheck, inboxApi } = makeHandler()

    const res = await handler(req(HEALTH_PATH))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(HEALTHY_REPORT)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(runHealthCheck).toHaveBeenCalledOnce()
    expect(inboxApi).not.toHaveBeenCalled()
  })

  it('answers 503 (still with the full report body) when any alert is tripped — the status-code-only monitor contract', async () => {
    const { handler, runHealthCheck } = makeHandler()
    const unhealthy: HealthReport = {
      ...HEALTHY_REPORT,
      ok: false,
      alerts: ['queue-drain-stalled: oldest ready job has waited 900s (threshold 300s)'],
    }
    runHealthCheck.mockResolvedValueOnce(unhealthy)

    const res = await handler(req(HEALTH_PATH))

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual(unhealthy)
  })

  it('rejects a wrong secret with 401 and never runs the check', async () => {
    const { handler, runHealthCheck } = makeHandler()
    const res = await handler(req(HEALTH_PATH, { secret: 'wrong-secret-9999999999' }))
    expect(res.status).toBe(401)
    expect(runHealthCheck).not.toHaveBeenCalled()
  })

  it('rejects a non-GET method (authenticated) with 405', async () => {
    const { handler, runHealthCheck } = makeHandler()
    const res = await handler(req(HEALTH_PATH, { method: 'POST' }))
    expect(res.status).toBe(405)
    expect(runHealthCheck).not.toHaveBeenCalled()
  })
})

describe('createAppHandler — bare root path (friendly response for GET /)', () => {
  it('302-redirects GET / to the UI origin when uiBaseUrl is configured, without touching the inbox API', async () => {
    const { handler, inboxApi } = makeHandler({ uiBaseUrl: 'https://inbox.example.test' })

    const res = await handler(req('/', { secret: null }))

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://inbox.example.test')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(inboxApi).not.toHaveBeenCalled()
  })

  it('answers GET / with the tiny service JSON when uiBaseUrl is not configured (no auth required)', async () => {
    const { handler, inboxApi } = makeHandler()

    const res = await handler(req('/', { secret: null }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ service: 'helpthread-engine', docs: '/api/v1' })
    expect(inboxApi).not.toHaveBeenCalled()
  })

  it('answers HEAD / like GET / (RFC 9110 §9.3.2)', async () => {
    const { handler } = makeHandler({ uiBaseUrl: 'https://inbox.example.test' })
    const res = await handler(req('/', { method: 'HEAD', secret: null }))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('https://inbox.example.test')
  })

  it("answers HEAD / with GET's status and headers but NO body (§9.3.2's MUST NOT, at the handler layer)", async () => {
    const { handler } = makeHandler()
    const res = await handler(req('/', { method: 'HEAD', secret: null }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.text()).toBe('')
  })

  it('delegates a non-GET / to the inbox API (its standard 404 envelope), not the friendly response', async () => {
    const { handler, inboxApi } = makeHandler({ uiBaseUrl: 'https://inbox.example.test' })
    const request = req('/', { method: 'POST', secret: null })

    const res = await handler(request)

    expect(res.status).toBe(299)
    expect(inboxApi).toHaveBeenCalledOnce()
    expect(inboxApi).toHaveBeenCalledWith(request)
  })
})
