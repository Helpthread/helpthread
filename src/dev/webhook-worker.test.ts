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

import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createPostgresQueue } from '../providers/adapters/postgres-queue/index.js'
import { appendOutboxEventInTx, createEventOutboxStore } from '../store/event-outbox.js'
import { createWebhookEndpointStore } from '../store/webhook-endpoints.js'
import { startWebhookWorker, type WebhookWorker } from './webhook-worker.js'

const ENC_KEY = Buffer.from('helpthread-test-only-enc-key-32b', 'utf8')

describe('startWebhookWorker', () => {
  let db: Db | undefined
  let worker: WebhookWorker | undefined

  afterEach(async () => {
    await worker?.stop()
    worker = undefined
    await db?.close()
    db = undefined
  })

  async function harness(endpointUrl: string) {
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

    return { db, webhookEndpoints, eventOutbox, queue, conversationId }
  }

  it('drains the outbox and delivers the queued job in a single pass', async () => {
    // A public-looking hostname: the delivery path refuses private and
    // loopback addresses outright (src/webhooks/ssrf.ts), so pointing this
    // at 127.0.0.1 would test the SSRF guard rather than the worker.
    const h = await harness('https://module.example.com/api/hook')

    worker = startWebhookWorker(h, { intervalMs: 60_000 })
    const summary = await worker.runOnce()

    // The event fanned out to the one matching endpoint, and the delivery
    // attempt was made. It does not succeed — example.com is not listening
    // — which is exactly why `failed` is the assertion that proves the
    // second pass ran at all.
    expect(summary.dispatched).toBe(1)
    expect(summary.delivered + summary.failed).toBe(1)
  })

  it('marks the outbox row dispatched, so a second pass has nothing left to fan out', async () => {
    const h = await harness('https://module.example.com/api/hook')

    worker = startWebhookWorker(h, { intervalMs: 60_000 })
    await worker.runOnce()
    const second = await worker.runOnce()

    expect(second.dispatched).toBe(0)
  })

  it('stops cleanly, leaving no pass in flight', async () => {
    const h = await harness('https://module.example.com/api/hook')

    worker = startWebhookWorker(h, { intervalMs: 10 })
    await worker.stop()
    // A second stop is a no-op rather than an error — shutdown paths get
    // called twice (SIGINT then SIGTERM) more often than anyone plans for.
    await expect(worker.stop()).resolves.toBeUndefined()
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
