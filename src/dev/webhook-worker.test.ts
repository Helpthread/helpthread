/**
 * `startWebhookWorker` — the harness's stand-in for production's scheduled
 * webhook ticks.
 *
 * The property under test is the one whose absence made the dev API
 * structurally incapable of firing a webhook: BOTH passes have to run, in
 * order, in one tick. Draining the outbox without draining the queue
 * enqueues jobs nobody delivers; draining the queue without draining the
 * outbox delivers nothing, because no job was ever created. So these tests
 * go end to end — commit an event, run a pass, and assert the endpoint was
 * actually called.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createPostgresQueue } from '../providers/adapters/postgres-queue/index.js'
import { appendOutboxEventInTx, createEventOutboxStore } from '../store/event-outbox.js'
import { createWebhookEndpointStore } from '../store/webhook-endpoints.js'
import { startWebhookWorker, type WebhookWorker } from './webhook-worker.js'

const ENC_KEY = Buffer.from('helpthread-test-only-enc-key-32b', 'utf8')

/**
 * A fake HTTPS transport plus a fake DNS resolve, so a test can assert the
 * endpoint was ACTUALLY contacted. Without this, "one job left the queue"
 * passes even when delivery failed at DNS, at the SSRF check, or at secret
 * lookup — none of which prove the second drain pass ran at all.
 */
function recordingTransport(status = 200) {
  const requests: { url: URL; headers: Record<string, string>; body: string }[] = []
  const send = {
    resolveSafeAddress: async () => ({ address: '203.0.113.9', family: 4 as const }),
    requestImpl: ((url: unknown, options: unknown, callback: unknown) => {
      const req = new EventEmitter() as unknown as { end: (body: Buffer) => void }
      req.end = (body: Buffer) => {
        requests.push({
          url: url as URL,
          headers: (options as { headers: Record<string, string> }).headers,
          body: body.toString('utf8'),
        })
        queueMicrotask(() => {
          type FakeResponse = EventEmitter & { statusCode: number; resume: () => void }
          const res = new EventEmitter() as FakeResponse
          res.statusCode = status
          res.resume = () => {}
          ;(callback as (r: FakeResponse) => void)(res)
          queueMicrotask(() => res.emit('end'))
        })
      }
      return req
    }) as never,
  }
  return { send, requests }
}

describe('startWebhookWorker', () => {
  let db: Db | undefined
  let worker: WebhookWorker | undefined

  afterEach(async () => {
    await worker?.stop()
    worker = undefined
    await db?.close()
    db = undefined
  })

  async function harness(endpointUrl: string, send?: unknown) {
    db = await createPgliteDb()
    await migrate(db)

    const webhookEndpoints = createWebhookEndpointStore(db, ENC_KEY)
    const eventOutbox = createEventOutboxStore(db)
    const queue = createPostgresQueue(db)

    await webhookEndpoints.create({
      url: endpointUrl,
      secret: 'test-only-webhook-signing-secret-32b',
      events: ['conversation.message_received'],
      module: 'draft-assistant',
    })

    // A real committed domain event, appended the way the ingest pipeline
    // appends one.
    const conversationId = (
      await db.query<{ id: string }>(
        'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
        ['customer@example.test'],
      )
    )[0].id

    await db.transaction(async (tx) => {
      await appendOutboxEventInTx(tx, {
        type: 'conversation.message_received',
        conversationId,
        data: { reopened: false, threadId: 'thread-1' },
      })
    })

    return {
      db,
      webhookEndpoints,
      eventOutbox,
      queue,
      conversationId,
      ...(send === undefined ? {} : { send: send as never }),
    }
  }

  it('actually POSTs the signed event to the endpoint in a single pass', async () => {
    // Asserting on the request itself, not just on a counter: a summary of
    // `delivered + failed === 1` is equally true when delivery died at DNS,
    // at the SSRF check, or at secret lookup — none of which prove the
    // queue-drain half ran.
    const { send, requests } = recordingTransport()
    const h = await harness('https://module.example.com/api/hook', send)

    worker = startWebhookWorker(h, { intervalMs: 60_000 })
    const summary = await worker.runOnce()

    expect(summary).toEqual({ dispatched: 1, delivered: 1, failed: 0 })
    expect(requests).toHaveLength(1)
    expect(requests[0].url.href).toBe('https://module.example.com/api/hook')
    expect(requests[0].headers['X-Helpthread-Event']).toBe('conversation.message_received')
    expect(requests[0].headers['X-Helpthread-Signature']).toMatch(/^t=\d+, v1=[0-9a-f]{64}$/)
    expect(JSON.parse(requests[0].body)).toMatchObject({
      type: 'conversation.message_received',
      conversationId: h.conversationId,
    })
  })

  it('does not re-deliver on a second pass', async () => {
    // The old version of this asserted only `dispatched === 0`, which holds
    // even if the delivery half were removed entirely. Counting requests
    // makes it fail if anything re-sends.
    const { send, requests } = recordingTransport()
    const h = await harness('https://module.example.com/api/hook', send)

    worker = startWebhookWorker(h, { intervalMs: 60_000 })
    await worker.runOnce()
    const second = await worker.runOnce()

    expect(second).toEqual({ dispatched: 0, delivered: 0, failed: 0 })
    expect(requests).toHaveLength(1)
  })

  it('waits for a pass already running before stop() resolves', async () => {
    // The point of stop(): the harness closes the database right after it,
    // so a pass still holding a query would blow up on a closed handle.
    const h = await harness('https://module.example.com/api/hook')
    let release: (() => void) | undefined
    let finished = false
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })

    worker = startWebhookWorker(
      {
        ...h,
        eventOutbox: {
          ...h.eventOutbox,
          claimBatch: async (...args: Parameters<typeof h.eventOutbox.claimBatch>) => {
            await blocked
            const result = await h.eventOutbox.claimBatch(...args)
            finished = true
            return result
          },
        },
      },
      { intervalMs: 60_000 },
    )

    const running = worker.runOnce()
    const stopping = worker.stop()
    // stop() must not resolve while the explicit pass is still mid-query.
    expect(finished).toBe(false)
    release?.()
    await stopping
    expect(finished).toBe(true)
    await running
  })

  it('refuses runOnce() after stop(), rather than working on a shut-down worker', async () => {
    const h = await harness('https://module.example.com/api/hook')
    worker = startWebhookWorker(h, { intervalMs: 60_000 })
    await worker.stop()

    await expect(worker.runOnce()).rejects.toThrow(/after stop/)
  })

  it('runs no further pass after stop(), even past the interval', async () => {
    const { send, requests } = recordingTransport()
    const h = await harness('https://module.example.com/api/hook', send)

    worker = startWebhookWorker(h, { intervalMs: 5 })
    await worker.stop()
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(requests).toHaveLength(0)
  })

  it('is a no-op on a second stop — shutdown paths fire twice more often than anyone plans for', async () => {
    const h = await harness('https://module.example.com/api/hook')
    worker = startWebhookWorker(h, { intervalMs: 10 })
    await worker.stop()
    await expect(worker.stop()).resolves.toBeUndefined()
  })

  it('never overlaps passes, even when runOnce races the scheduled loop', async () => {
    const h = await harness('https://module.example.com/api/hook')
    let concurrent = 0
    let peak = 0

    worker = startWebhookWorker(
      {
        ...h,
        eventOutbox: {
          ...h.eventOutbox,
          claimBatch: async (...args: Parameters<typeof h.eventOutbox.claimBatch>) => {
            concurrent += 1
            peak = Math.max(peak, concurrent)
            await new Promise((resolve) => setTimeout(resolve, 5))
            const result = await h.eventOutbox.claimBatch(...args)
            concurrent -= 1
            return result
          },
        },
      },
      { intervalMs: 1 },
    )

    await Promise.all([worker.runOnce(), worker.runOnce(), worker.runOnce()])
    await worker.stop()

    expect(peak).toBe(1)
  })

  it('keeps looping when the error reporter itself throws', async () => {
    // An onError that throws used to leave a rejected promise with no
    // handler — an unhandled rejection, which on Node's defaults takes the
    // process down and the loop with it.
    const h = await harness('https://module.example.com/api/hook')
    let calls = 0

    worker = startWebhookWorker(
      {
        ...h,
        eventOutbox: {
          ...h.eventOutbox,
          claimBatch: async () => {
            calls += 1
            throw new Error('transient database blip')
          },
        },
      },
      {
        intervalMs: 5,
        onError: () => {
          throw new Error('the reporter is broken too')
        },
      },
    )

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(calls).toBeGreaterThan(1)
  })

  it('survives an onActivity that rejects asynchronously', async () => {
    const { send } = recordingTransport()
    const h = await harness('https://module.example.com/api/hook', send)
    const reported: unknown[] = []

    worker = startWebhookWorker(h, {
      intervalMs: 5,
      onActivity: async () => {
        throw new Error('logging blew up')
      },
      onError: (err) => reported.push(err),
    })

    await new Promise((resolve) => setTimeout(resolve, 60))
    // The rejection reached onError instead of escaping as an unhandled
    // rejection, and the loop is still alive.
    expect(reported.length).toBeGreaterThan(0)
    await expect(worker.runOnce()).resolves.toBeDefined()
  })

  it('keeps looping after a pass throws', async () => {
    const h = await harness('https://module.example.com/api/hook')
    const errors: unknown[] = []
    let calls = 0

    worker = startWebhookWorker(
      {
        ...h,
        eventOutbox: {
          ...h.eventOutbox,
          claimBatch: async (...args: Parameters<typeof h.eventOutbox.claimBatch>) => {
            calls += 1
            if (calls === 1) throw new Error('transient database blip')
            return h.eventOutbox.claimBatch(...args)
          },
        },
      },
      { intervalMs: 5, onError: (err) => errors.push(err) },
    )

    await new Promise((resolve) => setTimeout(resolve, 120))

    // The first pass blew up and was reported; later passes still ran,
    // which is the whole point of catching rather than letting the loop die.
    expect(errors).toHaveLength(1)
    expect(calls).toBeGreaterThan(1)
  })
})
