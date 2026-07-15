import { describe, expect, it, vi } from 'vitest'
import { createAppHandler, QUEUE_DRAIN_PATH, WATCH_MAINTENANCE_PATH } from './app.js'

const CRON_SECRET = 'test-cron-secret-0123456789'
const ORIGIN = 'https://desk.example.test'

/** Build a handler over spy deps; the inbox API spy returns a recognizable 299 so delegation is observable. */
function makeHandler(cronSecret: string = CRON_SECRET) {
  const inboxApi = vi.fn(async () => new Response('inbox', { status: 299 }))
  const drainQueue = vi.fn(async () => ({ claimed: 3, acked: 3 }))
  const runWatchMaintenance = vi.fn(async () => ({ total: 1, renewed: 1 }))
  const handler = createAppHandler({ inboxApi, cronSecret, drainQueue, runWatchMaintenance })
  return { handler, inboxApi, drainQueue, runWatchMaintenance }
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
      runWatchMaintenance,
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
