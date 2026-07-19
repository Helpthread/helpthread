import { createHmac, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { QueueMessage } from '../providers/queue.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import {
  createWebhookEndpointStore,
  type WebhookEndpointStore,
} from '../store/webhook-endpoints.js'
import {
  createWebhookDeliveryHandler,
  type HttpsRequestFn,
  sendWebhookRequest,
  signWebhookPayload,
  WEBHOOK_DELIVERY_MAX_ATTEMPTS,
  type WebhookDeliveryJob,
} from './delivery.js'
import type { PinnedAddress } from './ssrf.js'
import { type resolveSafeAddress, SsrfRefusedError } from './ssrf.js'

const ENC_KEY = randomBytes(ENCRYPTION_KEY_BYTES)

// --- signWebhookPayload (consumer-side verification) ------------------------

describe('signWebhookPayload', () => {
  it('produces the Stripe-shape t=<ts>, v1=<hex hmac> string spec §5 requires', () => {
    const sig = signWebhookPayload('shh', '{"a":1}', 1_700_000_000)
    expect(sig).toMatch(/^t=1700000000, v1=[0-9a-f]{64}$/)
  })

  it('a consumer can independently recompute and verify the signature (this ticket brief\'s "consumer-side verification")', () => {
    const secret = 'endpoint-secret-xyz'
    const body = JSON.stringify({ eventId: 'e1', type: 'conversation.created' })
    const timestamp = 1_700_000_123
    const sig = signWebhookPayload(secret, body, timestamp)

    // Independent recomputation — a consumer's own verifier, not a call
    // through this module's own function.
    const expectedMac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
    expect(sig).toBe(`t=${timestamp}, v1=${expectedMac}`)
  })

  it('changing the secret, body, or timestamp changes the signature', () => {
    const base = signWebhookPayload('secret-a', 'body', 1000)
    expect(signWebhookPayload('secret-b', 'body', 1000)).not.toBe(base)
    expect(signWebhookPayload('secret-a', 'other-body', 1000)).not.toBe(base)
    expect(signWebhookPayload('secret-a', 'body', 1001)).not.toBe(base)
  })
})

// --- sendWebhookRequest ------------------------------------------------------

/** A fake `PinnedAddress` resolver that never touches real DNS. */
function fakeResolve(address = '203.0.113.9', family: 4 | 6 = 4): typeof resolveSafeAddress {
  return async () => ({ address, family }) satisfies PinnedAddress
}

/**
 * A minimal fake of `node:https.request`'s shape: an `EventEmitter`-based
 * `ClientRequest`, whose `.end(body)` synchronously records the call and
 * asynchronously invokes the response callback with a fake `IncomingMessage`
 * (also an `EventEmitter`) carrying `statusCode`. Honors `options.signal` so
 * a short injected timeout can be tested for real (no fake timers needed —
 * see the timeout test below). Captures every call for assertions.
 */
function fakeHttpsRequestImpl(
  behavior: (url: URL, options: unknown, body: Buffer) => { status: number } | { hang: true },
): { requestImpl: HttpsRequestFn; calls: { url: URL; options: unknown; body: Buffer }[] } {
  const calls: { url: URL; options: unknown; body: Buffer }[] = []
  const requestImpl = ((url: unknown, options: unknown, callback: unknown) => {
    const req = new EventEmitter() as unknown as {
      on: EventEmitter['on']
      end: (body: Buffer) => void
    }
    const opts = options as { signal?: AbortSignal }
    if (opts.signal !== undefined) {
      opts.signal.addEventListener('abort', () => {
        ;(req as unknown as EventEmitter).emit('error', new Error('The operation was aborted'))
      })
    }
    ;(req as unknown as { end: (body: Buffer) => void }).end = (body: Buffer) => {
      calls.push({ url: url as URL, options, body })
      const outcome = behavior(url as URL, options, body)
      if ('hang' in outcome) return // never calls back — only the abort listener above settles it
      queueMicrotask(() => {
        type FakeResponse = EventEmitter & { statusCode: number; resume: () => void }
        const res = new EventEmitter() as FakeResponse
        res.statusCode = outcome.status
        res.resume = () => {}
        ;(callback as (res: FakeResponse) => void)(res)
        queueMicrotask(() => res.emit('end'))
      })
    }
    return req
  }) as unknown as HttpsRequestFn
  return { requestImpl, calls }
}

describe('sendWebhookRequest', () => {
  it('refuses a non-https URL WITHOUT calling resolveSafeAddress or the transport', async () => {
    const { requestImpl, calls } = fakeHttpsRequestImpl(() => ({ status: 200 }))
    let resolveSafeAddressCalled = false
    await expect(
      sendWebhookRequest(
        'http://example.test/hook',
        '{}',
        {},
        {
          resolveSafeAddress: async () => {
            resolveSafeAddressCalled = true
            return { address: '1.2.3.4', family: 4 }
          },
          requestImpl,
        },
      ),
    ).rejects.toBeInstanceOf(SsrfRefusedError)
    expect(resolveSafeAddressCalled).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('propagates SsrfRefusedError from resolveSafeAddress WITHOUT calling the transport', async () => {
    const { requestImpl, calls } = fakeHttpsRequestImpl(() => ({ status: 200 }))
    await expect(
      sendWebhookRequest(
        'https://evil.test/hook',
        '{}',
        {},
        {
          resolveSafeAddress: async () => {
            throw new SsrfRefusedError('nope')
          },
          requestImpl,
        },
      ),
    ).rejects.toBeInstanceOf(SsrfRefusedError)
    expect(calls).toHaveLength(0)
  })

  it('POSTs the body and returns the response status only', async () => {
    const { requestImpl, calls } = fakeHttpsRequestImpl(() => ({ status: 204 }))
    const result = await sendWebhookRequest(
      'https://example.test/hook',
      '{"hello":"world"}',
      { 'X-Test': 'yes' },
      { resolveSafeAddress: fakeResolve(), requestImpl },
    )
    expect(result).toEqual({ status: 204 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url.hostname).toBe('example.test')
    expect(calls[0].body.toString('utf8')).toBe('{"hello":"world"}')
    const options = calls[0].options as { method: string; headers: Record<string, unknown> }
    expect(options.method).toBe('POST')
    expect(options.headers['X-Test']).toBe('yes')
    expect(options.headers['Content-Type']).toBe('application/json')
  })

  it('pins the connection to the resolved address via the lookup option (resolve-then-connect)', async () => {
    const { requestImpl, calls } = fakeHttpsRequestImpl(() => ({ status: 200 }))
    await sendWebhookRequest(
      'https://pinned.test/hook',
      '{}',
      {},
      {
        resolveSafeAddress: fakeResolve('198.51.100.42', 4),
        requestImpl,
      },
    )
    const options = calls[0].options as {
      lookup: (h: string, o: { all: boolean }, cb: (...a: unknown[]) => void) => void
    }
    const captured: unknown[] = []
    options.lookup('pinned.test', { all: true }, (...args: unknown[]) => captured.push(args))
    expect(captured[0]).toEqual([null, [{ address: '198.51.100.42', family: 4 }]])
  })

  it('a non-2xx status is still a resolved response (the CALLER decides retry, not this function)', async () => {
    const { requestImpl } = fakeHttpsRequestImpl(() => ({ status: 500 }))
    const result = await sendWebhookRequest(
      'https://example.test/hook',
      '{}',
      {},
      {
        resolveSafeAddress: fakeResolve(),
        requestImpl,
      },
    )
    expect(result).toEqual({ status: 500 })
  })

  it('rejects once the timeout elapses (a real, short wait — no fake timers)', async () => {
    const { requestImpl } = fakeHttpsRequestImpl(() => ({ hang: true }))
    await expect(
      sendWebhookRequest(
        'https://slow.test/hook',
        '{}',
        {},
        {
          resolveSafeAddress: fakeResolve(),
          requestImpl,
          timeoutMs: 50,
        },
      ),
    ).rejects.toThrow()
  })
})

// --- createWebhookDeliveryHandler --------------------------------------------

function message(job: WebhookDeliveryJob, attempts = 1): QueueMessage<WebhookDeliveryJob> {
  return { id: 'msg-1', topic: 'webhook.delivery', payload: job, attempts, enqueuedAt: new Date() }
}

function job(overrides: Partial<WebhookDeliveryJob> = {}): WebhookDeliveryJob {
  return {
    endpointId: overrides.endpointId ?? 'missing',
    eventId: 'event-1',
    type: 'conversation.created',
    occurredAt: '2026-07-18T00:00:00.000Z',
    conversationId: 'conv-1',
    data: {},
    ...overrides,
  }
}

describe('createWebhookDeliveryHandler', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<WebhookEndpointStore> {
    db = await createPgliteDb()
    await migrate(db)
    return createWebhookEndpointStore(db, ENC_KEY)
  }

  it('a 2xx response acks and records delivery success', async () => {
    const store = await freshStore()
    const endpoint = await store.create({ url: 'https://ok.test/hook', secret: 's', events: [] })
    const { requestImpl } = fakeHttpsRequestImpl(() => ({ status: 200 }))
    const handler = createWebhookDeliveryHandler({
      webhookEndpoints: store,
      send: { resolveSafeAddress: fakeResolve(), requestImpl },
    })

    const result = await handler(message(job({ endpointId: endpoint.id })))

    expect(result).toEqual({ kind: 'ack' })
    const updated = await store.list()
    expect(updated[0].consecutiveFailures).toBe(0)
  })

  it('a non-2xx response under the attempt ceiling retries WITHOUT touching the failure counter', async () => {
    const store = await freshStore()
    const endpoint = await store.create({ url: 'https://flaky.test/hook', secret: 's', events: [] })
    // Pre-existing failures, to prove this attempt does NOT bump them.
    await store.recordDeliveryFailure(endpoint.id)
    const { requestImpl } = fakeHttpsRequestImpl(() => ({ status: 500 }))
    const handler = createWebhookDeliveryHandler({
      webhookEndpoints: store,
      send: { resolveSafeAddress: fakeResolve(), requestImpl },
    })

    const result = await handler(
      message(job({ endpointId: endpoint.id }), WEBHOOK_DELIVERY_MAX_ATTEMPTS - 1),
    )

    expect(result).toEqual({ kind: 'retry' })
    const updated = await store.list()
    expect(updated[0].consecutiveFailures).toBe(1) // unchanged from the pre-seed
  })

  it('a non-2xx response AT the attempt ceiling dead-letters and records exactly one failure', async () => {
    const store = await freshStore()
    const endpoint = await store.create({ url: 'https://dead.test/hook', secret: 's', events: [] })
    const { requestImpl } = fakeHttpsRequestImpl(() => ({ status: 503 }))
    const handler = createWebhookDeliveryHandler({
      webhookEndpoints: store,
      send: { resolveSafeAddress: fakeResolve(), requestImpl },
    })

    const result = await handler(
      message(job({ endpointId: endpoint.id }), WEBHOOK_DELIVERY_MAX_ATTEMPTS),
    )

    expect(result.kind).toBe('deadLetter')
    const updated = await store.list()
    expect(updated[0].consecutiveFailures).toBe(1)
  })

  it('an SSRF refusal dead-letters IMMEDIATELY (attempt 1) and records a failure — never retried', async () => {
    const store = await freshStore()
    const endpoint = await store.create({ url: 'https://ssrf.test/hook', secret: 's', events: [] })
    const handler = createWebhookDeliveryHandler({
      webhookEndpoints: store,
      send: {
        resolveSafeAddress: async () => {
          throw new SsrfRefusedError('refused')
        },
      },
    })

    const result = await handler(message(job({ endpointId: endpoint.id }), 1))

    expect(result.kind).toBe('deadLetter')
    const updated = await store.list()
    expect(updated[0].consecutiveFailures).toBe(1)
  })

  it('a deleted endpoint dead-letters without touching the store further', async () => {
    const store = await freshStore()
    const handler = createWebhookDeliveryHandler({ webhookEndpoints: store })

    const result = await handler(message(job({ endpointId: 'does-not-exist' })))

    expect(result.kind).toBe('deadLetter')
  })

  it('a non-active endpoint acks WITHOUT sending or touching the failure counter (race defense)', async () => {
    const store = await freshStore()
    const endpoint = await store.create({
      url: 'https://paused.test/hook',
      secret: 's',
      events: [],
    })
    await store.patch(endpoint.id, { status: 'disabled' })
    let sent = false
    const { requestImpl } = fakeHttpsRequestImpl(() => {
      sent = true
      return { status: 200 }
    })
    const handler = createWebhookDeliveryHandler({
      webhookEndpoints: store,
      send: { resolveSafeAddress: fakeResolve(), requestImpl },
    })

    const result = await handler(message(job({ endpointId: endpoint.id })))

    expect(result).toEqual({ kind: 'ack' })
    expect(sent).toBe(false)
  })

  it("signs the envelope with the endpoint's OWN decrypted secret — a consumer can verify it independently", async () => {
    const store = await freshStore()
    const endpoint = await store.create({
      url: 'https://verify.test/hook',
      secret: 'the-real-secret',
      events: [],
    })
    const { requestImpl, calls } = fakeHttpsRequestImpl(() => ({ status: 200 }))
    const handler = createWebhookDeliveryHandler({
      webhookEndpoints: store,
      send: { resolveSafeAddress: fakeResolve(), requestImpl },
    })

    const theJob = job({ endpointId: endpoint.id, type: 'conversation.reply_sent' })
    await handler(message(theJob))

    expect(calls).toHaveLength(1)
    const options = calls[0].options as { headers: Record<string, string> }
    expect(options.headers['X-Helpthread-Event']).toBe('conversation.reply_sent')
    expect(options.headers['X-Helpthread-Delivery']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const sigHeader = options.headers['X-Helpthread-Signature']
    const match = /^t=(\d+), v1=([0-9a-f]{64})$/.exec(sigHeader)
    expect(match).not.toBeNull()
    const [, ts, mac] = match as unknown as [string, string, string]
    const body = calls[0].body.toString('utf8')
    const expectedMac = createHmac('sha256', 'the-real-secret')
      .update(`${ts}.${body}`)
      .digest('hex')
    expect(mac).toBe(expectedMac)

    // Thin envelope, exactly spec §4's shape — no extra keys.
    expect(JSON.parse(body)).toEqual({
      eventId: theJob.eventId,
      type: theJob.type,
      occurredAt: theJob.occurredAt,
      conversationId: theJob.conversationId,
      data: {},
    })
  })

  it('a fresh X-Helpthread-Delivery id is minted on EACH invocation (redelivery), even for the same message', async () => {
    const store = await freshStore()
    const endpoint = await store.create({
      url: 'https://redeliver.test/hook',
      secret: 's',
      events: [],
    })
    const { requestImpl, calls } = fakeHttpsRequestImpl(() => ({ status: 500 }))
    const handler = createWebhookDeliveryHandler({
      webhookEndpoints: store,
      send: { resolveSafeAddress: fakeResolve(), requestImpl },
    })

    await handler(message(job({ endpointId: endpoint.id }), 1))
    await handler(message(job({ endpointId: endpoint.id }), 2))

    const ids = calls.map(
      (c) => (c.options as { headers: Record<string, string> }).headers['X-Helpthread-Delivery'],
    )
    expect(ids[0]).not.toBe(ids[1])
  })

  it('a test.ping job (conversationId: null) delivers with a null conversationId in the envelope', async () => {
    const store = await freshStore()
    const endpoint = await store.create({ url: 'https://ping.test/hook', secret: 's', events: [] })
    const { requestImpl, calls } = fakeHttpsRequestImpl(() => ({ status: 200 }))
    const handler = createWebhookDeliveryHandler({
      webhookEndpoints: store,
      send: { resolveSafeAddress: fakeResolve(), requestImpl },
    })

    await handler(
      message(job({ endpointId: endpoint.id, type: 'test.ping', conversationId: null })),
    )

    const body = JSON.parse(calls[0].body.toString('utf8'))
    expect(body.conversationId).toBeNull()
    expect(body.type).toBe('test.ping')
  })
})
