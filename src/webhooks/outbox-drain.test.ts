import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { EnqueueOptions, QueueProvider } from '../providers/queue.js'
import {
  appendOutboxEventInTx,
  createEventOutboxStore,
  type EventOutboxStore,
} from '../store/event-outbox.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import {
  createWebhookEndpointStore,
  type WebhookEndpointStore,
} from '../store/webhook-endpoints.js'
import { WEBHOOK_DELIVERY_TOPIC, type WebhookDeliveryJob } from './delivery.js'
import { drainEventOutbox } from './outbox-drain.js'

const KEY = randomBytes(ENCRYPTION_KEY_BYTES)

/** A `QueueProvider` fake that records every enqueue call, never touching a real queue. */
function fakeQueue(): {
  queue: QueueProvider
  enqueued: { topic: string; payload: unknown; opts?: EnqueueOptions }[]
} {
  const enqueued: { topic: string; payload: unknown; opts?: EnqueueOptions }[] = []
  return {
    queue: {
      async enqueue(topic, payload, opts) {
        enqueued.push({ topic, payload, opts })
      },
    },
    enqueued,
  }
}

describe('drainEventOutbox', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function fresh(): Promise<{
    db: Db
    eventOutbox: EventOutboxStore
    webhookEndpoints: WebhookEndpointStore
  }> {
    db = await createPgliteDb()
    await migrate(db)
    return {
      db,
      eventOutbox: createEventOutboxStore(db),
      webhookEndpoints: createWebhookEndpointStore(db, KEY),
    }
  }

  async function insertConversation(database: Db): Promise<string> {
    const rows = await database.query<{ id: string }>(
      "INSERT INTO conversations (customer_email) VALUES ('customer@example.test') RETURNING id",
    )
    return rows[0].id
  }

  it('an empty outbox drains to a report of all zeros', async () => {
    const { eventOutbox, webhookEndpoints } = await fresh()
    const { queue } = fakeQueue()

    const report = await drainEventOutbox({ eventOutbox, webhookEndpoints, queue })

    expect(report).toEqual({ claimed: 0, enqueued: 0, dispatched: 0 })
  })

  it('fans one event out to every matching ACTIVE endpoint, dedupeKey = eventId:endpointId, and marks the event dispatched', async () => {
    const { db, eventOutbox, webhookEndpoints } = await fresh()
    const conversationId = await insertConversation(db)
    await db.transaction((tx) =>
      appendOutboxEventInTx(tx, {
        type: 'conversation.created',
        conversationId,
        data: {},
      }),
    )
    const matchAll = await webhookEndpoints.create({
      url: 'https://all.example.test/hook',
      secret: 's1',
      events: [], // [] means "all" (spec §5)
    })
    const matchType = await webhookEndpoints.create({
      url: 'https://match.example.test/hook',
      secret: 's2',
      events: ['conversation.created', 'conversation.reply_sent'],
    })
    await webhookEndpoints.create({
      url: 'https://nomatch.example.test/hook',
      secret: 's3',
      events: ['conversation.reply_sent'], // does NOT include conversation.created
    })
    const { queue, enqueued } = fakeQueue()

    const report = await drainEventOutbox({ eventOutbox, webhookEndpoints, queue })

    expect(report).toEqual({ claimed: 1, enqueued: 2, dispatched: 1 })
    expect(enqueued).toHaveLength(2)
    const endpointIds = enqueued.map((e) => (e.payload as WebhookDeliveryJob).endpointId).sort()
    expect(endpointIds).toEqual([matchAll.id, matchType.id].sort())
    for (const e of enqueued) {
      expect(e.topic).toBe(WEBHOOK_DELIVERY_TOPIC)
      const payload = e.payload as WebhookDeliveryJob
      expect(payload.type).toBe('conversation.created')
      expect(payload.conversationId).toBe(conversationId)
      expect(e.opts?.dedupeKey).toBe(`${payload.eventId}:${payload.endpointId}`)
    }

    // Claimed row is dispatched — a second drain finds nothing left to claim.
    const secondReport = await drainEventOutbox({ eventOutbox, webhookEndpoints, queue })
    expect(secondReport).toEqual({ claimed: 0, enqueued: 0, dispatched: 0 })
  })

  it('an endpoint that is disabled or auto_disabled never receives a fan-out, even if its events filter matches', async () => {
    const { db, eventOutbox, webhookEndpoints } = await fresh()
    const conversationId = await insertConversation(db)
    await db.transaction((tx) =>
      appendOutboxEventInTx(tx, { type: 'conversation.created', conversationId, data: {} }),
    )
    const disabled = await webhookEndpoints.create({
      url: 'https://disabled.example.test/hook',
      secret: 's',
      events: [],
    })
    await webhookEndpoints.patch(disabled.id, { status: 'disabled' })
    const { queue, enqueued } = fakeQueue()

    const report = await drainEventOutbox({ eventOutbox, webhookEndpoints, queue })

    // Still claimed and dispatched — there was simply nothing to fan out to
    // (module doc: "the outbox's job is complete either way").
    expect(report).toEqual({ claimed: 1, enqueued: 0, dispatched: 1 })
    expect(enqueued).toHaveLength(0)
  })

  it('an event with zero matching endpoints is still marked dispatched (never re-claimed)', async () => {
    const { db, eventOutbox, webhookEndpoints } = await fresh()
    const conversationId = await insertConversation(db)
    await db.transaction((tx) =>
      appendOutboxEventInTx(tx, {
        type: 'conversation.tags_changed',
        conversationId,
        data: { tags: [] },
      }),
    )
    // No endpoints registered at all.
    const { queue } = fakeQueue()

    const first = await drainEventOutbox({ eventOutbox, webhookEndpoints, queue })
    expect(first).toEqual({ claimed: 1, enqueued: 0, dispatched: 1 })

    const second = await drainEventOutbox({ eventOutbox, webhookEndpoints, queue })
    expect(second).toEqual({ claimed: 0, enqueued: 0, dispatched: 0 })
  })

  it('multiple events each fan out independently, respecting the batch size', async () => {
    const { db, eventOutbox, webhookEndpoints } = await fresh()
    const conversationId = await insertConversation(db)
    for (const type of [
      'conversation.created',
      'conversation.message_received',
      'conversation.reply_sent',
    ]) {
      await db.transaction((tx) => appendOutboxEventInTx(tx, { type, conversationId, data: {} }))
    }
    await webhookEndpoints.create({ url: 'https://all.example.test/hook', secret: 's', events: [] })
    const { queue, enqueued } = fakeQueue()

    const report = await drainEventOutbox(
      { eventOutbox, webhookEndpoints, queue },
      { batchSize: 2 },
    )

    expect(report).toEqual({ claimed: 2, enqueued: 2, dispatched: 2 })
    expect(enqueued).toHaveLength(2)

    const rest = await drainEventOutbox({ eventOutbox, webhookEndpoints, queue }, { batchSize: 2 })
    expect(rest).toEqual({ claimed: 1, enqueued: 1, dispatched: 1 })
  })
})
