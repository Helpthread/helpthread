/**
 * The outbox drain (HT-69; specs/modules/substrate-v1.md §4: "A drain step
 * — the existing queue/cron drain pattern — turns outbox rows into
 * `QueueProvider` deliveries"). Mirrors `createPostgresQueue.drainOnce`'s
 * own shape (`src/providers/adapters/postgres-queue/index.ts`): a periodic
 * cron tick calls {@link drainEventOutbox} to pull and process one bounded
 * batch, the same "Postgres itself has no way to push, so a cron tick
 * drains" reasoning that adapter's module doc already states.
 *
 * ## Fan-out, not forward
 *
 * `EventOutboxStore.claimBatch` (`src/store/event-outbox.ts`) hands back
 * one row per domain event — but a single event may have MULTIPLE
 * subscribers (every `webhook_endpoints` row whose `events` filter matches,
 * spec §5: "subset filter... or all"). This function fans each claimed
 * event out to one `QueueProvider.enqueue` call PER matching active
 * endpoint, `dedupeKey = ` `` `${eventId}:${endpointId}` `` — per-pair, not
 * per-event, because the SAME event fans to several endpoints and each
 * needs its own independent delivery/retry lifecycle in `queue_jobs`. (The
 * schema doc on `event_outbox`, migration 023, describes the hand-off as
 * "keyed by dedupe_key = event_id" in the singular — written before this
 * fan-out shape was finalized; this per-pair key is the actual, correct
 * behavior implemented here, since a single `dedupeKey` shared across
 * every endpoint would collide the first enqueue against all the others
 * for the same event and silently drop delivery to every endpoint but the
 * first.)
 *
 * An event with ZERO matching active endpoints (no subscriber cares, or
 * every matching endpoint is `disabled`/`auto_disabled`) is still marked
 * dispatched — the outbox's job (handing off to the queue) is complete
 * either way; there is no queue work left to do for it, and leaving it
 * undispatched would only make the next drain re-fetch and re-decide the
 * same "nobody's listening" outcome forever.
 *
 * ## `test.ping` never touches this module
 *
 * The admin `POST /api/v1/webhooks/{id}/test` handler (`src/api/webhooks.ts`)
 * enqueues its synthetic delivery directly, bypassing `event_outbox`
 * entirely (spec §4: "test.ping is a synthetic type fired only by the test
 * endpoint") — this module only ever drains REAL domain events.
 */

import type { QueueProvider } from '../providers/queue.js'
import type { EventOutboxStore, StoredOutboxEvent } from '../store/event-outbox.js'
import type { WebhookEndpointStore } from '../store/webhook-endpoints.js'
import { WEBHOOK_DELIVERY_TOPIC, type WebhookDeliveryJob } from './delivery.js'

/** Default cap on undispatched outbox rows claimed per {@link drainEventOutbox} call — a bound on one invocation's work, mirroring `createPostgresQueue`'s own `DEFAULT_BATCH_SIZE`. */
const DEFAULT_BATCH_SIZE = 50

/** Default lease held on a claimed-but-not-yet-dispatched outbox row (`EventOutboxStore.claimBatch`'s `leaseMs`) — generous relative to how long fan-out + N enqueues should ever take, mirroring `EventOutboxStore`'s own module doc precedent (`markDispatched` is the terminal write; nothing here needs a short lease). */
const DEFAULT_LEASE_MS = 60_000

/** Dependencies {@link drainEventOutbox} needs for one drain pass. */
export interface OutboxDrainDeps {
  eventOutbox: EventOutboxStore
  webhookEndpoints: WebhookEndpointStore
  queue: QueueProvider
}

/** Tuning knobs for one drain pass; both default, so `drainEventOutbox(deps)` alone is a complete, reasonable call. */
export interface OutboxDrainOptions {
  batchSize?: number
  leaseMs?: number
}

/** What one {@link drainEventOutbox} call did, for logging/observability by whatever schedules it (mirrors `DrainReport`'s shape, `src/providers/adapters/postgres-queue/index.ts`). */
export interface OutboxDrainReport {
  /** Outbox rows claimed (leased) this pass. */
  claimed: number
  /** `(event, endpoint)` pairs enqueued onto {@link WEBHOOK_DELIVERY_TOPIC} — may exceed `claimed` (fan-out) or be `0` (every claimed event had no matching active endpoint). */
  enqueued: number
  /** Claimed events marked dispatched — always equals `claimed` (module doc: every claimed row is marked, whether it fanned to 0 or many endpoints). */
  dispatched: number
}

/** Does `endpoint`'s `events` filter (spec §5: "subset filter... or all", `[]` meaning all) match `eventType`? */
function endpointMatches(endpointEvents: string[], eventType: string): boolean {
  return endpointEvents.length === 0 || endpointEvents.includes(eventType)
}

/**
 * Fan `event` out to every ACTIVE endpoint whose `events` filter matches
 * it, one `queue.enqueue` call per match. Returns how many were enqueued
 * (for {@link OutboxDrainReport.enqueued}).
 */
async function fanOutEvent(
  event: StoredOutboxEvent,
  endpoints: { id: string; events: string[]; status: string }[],
  queue: QueueProvider,
): Promise<number> {
  const matches = endpoints.filter(
    (e) => e.status === 'active' && endpointMatches(e.events, event.type),
  )
  for (const endpoint of matches) {
    const job: WebhookDeliveryJob = {
      endpointId: endpoint.id,
      eventId: event.eventId,
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      conversationId: event.conversationId,
      data: event.data,
    }
    await queue.enqueue(WEBHOOK_DELIVERY_TOPIC, job, {
      dedupeKey: `${event.eventId}:${endpoint.id}`,
    })
  }
  return matches.length
}

/**
 * Run one outbox drain pass: claim a batch of undispatched `event_outbox`
 * rows, fan each out to its matching active endpoints (module doc), then
 * mark every claimed row dispatched. See the module doc for the full
 * fan-out and dispatched-regardless-of-match-count contract.
 *
 * The endpoint roster is fetched ONCE per call, up front, and reused for
 * every claimed event in this batch — not re-fetched per event. Endpoint
 * registration is expected to be low-cardinality (v1 has no marketplace
 * scale yet, spec §1's non-goals), so this is simplicity-first, matching
 * this substrate's own "v1 simplicity" posture (`WebhookEndpointStore`'s
 * own module doc uses the same "fixed... not a scopes system" reasoning
 * for assistants). A registration change mid-drain is picked up on the
 * NEXT drain tick, one minute later at most on the deployed cron cadence.
 */
export async function drainEventOutbox(
  deps: OutboxDrainDeps,
  options?: OutboxDrainOptions,
): Promise<OutboxDrainReport> {
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS

  const claimed = await deps.eventOutbox.claimBatch({ batchSize, leaseMs })
  if (claimed.length === 0) {
    return { claimed: 0, enqueued: 0, dispatched: 0 }
  }

  const endpoints = await deps.webhookEndpoints.list()

  let enqueued = 0
  for (const event of claimed) {
    enqueued += await fanOutEvent(event, endpoints, deps.queue)
    await deps.eventOutbox.markDispatched(event.eventId)
  }

  return { claimed: claimed.length, enqueued, dispatched: claimed.length }
}
