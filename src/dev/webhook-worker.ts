/**
 * The local harness's stand-in for the scheduled ticks that move webhook
 * deliveries in production (substrate-v1.md §5).
 *
 * Two things have to happen on a timer for a webhook to leave the engine,
 * and `scripts/dev-api.ts` previously ran neither: `drainEventOutbox`
 * turns each committed domain event into one queue job per matching
 * endpoint, and the queue's own drain hands those jobs to
 * `createWebhookDeliveryHandler`, which signs and POSTs them. Without both,
 * events accumulate in `event_outbox` and nothing is ever delivered — the
 * dev API looked healthy while being structurally incapable of firing a
 * webhook, which is exactly the kind of gap only a real end-to-end run
 * finds.
 *
 * This is deliberately a plain `setTimeout` loop rather than anything
 * cleverer: one pass at a time, never overlapping, and the interval is
 * measured from the END of a pass so a slow delivery cannot pile ticks up
 * behind it.
 */

import type { PostgresQueue } from '../providers/adapters/postgres-queue/index.js'
import type { EventOutboxStore } from '../store/event-outbox.js'
import type { WebhookEndpointStore } from '../store/webhook-endpoints.js'
import { createWebhookDeliveryHandler, WEBHOOK_DELIVERY_TOPIC } from '../webhooks/delivery.js'
import { drainEventOutbox } from '../webhooks/outbox-drain.js'

export interface WebhookWorkerDeps {
  eventOutbox: EventOutboxStore
  webhookEndpoints: WebhookEndpointStore
  queue: PostgresQueue
}

export interface WebhookWorkerOptions {
  /** Delay between passes, measured from the end of one to the start of the next. Defaults to 1s — brisk enough that a local end-to-end run feels immediate. */
  intervalMs?: number
  /** Called after any pass that actually did something, for harness logging. */
  onActivity?: (summary: { dispatched: number; delivered: number; failed: number }) => void
  /** Called when a pass throws. Defaults to `console.error`; a pass that fails must never stop the loop. */
  onError?: (err: unknown) => void
}

export interface WebhookWorker {
  /** Run exactly one pass: drain the outbox, then drain the queue. Exposed for tests and for a deterministic single-shot run. */
  runOnce(): Promise<{ dispatched: number; delivered: number; failed: number }>
  /** Stop the loop. Safe to call more than once; resolves once no pass is in flight. */
  stop(): Promise<void>
}

const DEFAULT_INTERVAL_MS = 1_000

export function startWebhookWorker(
  deps: WebhookWorkerDeps,
  options: WebhookWorkerOptions = {},
): WebhookWorker {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const onError = options.onError ?? ((err: unknown) => console.error('[webhook-worker]', err))

  const handlers = {
    [WEBHOOK_DELIVERY_TOPIC]: createWebhookDeliveryHandler({
      webhookEndpoints: deps.webhookEndpoints,
    }),
  }

  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<unknown> = Promise.resolve()

  async function runOnce(): Promise<{ dispatched: number; delivered: number; failed: number }> {
    const drain = await drainEventOutbox({
      eventOutbox: deps.eventOutbox,
      webhookEndpoints: deps.webhookEndpoints,
      queue: deps.queue,
    })
    const delivery = await deps.queue.drainOnce({
      handlers: handlers as Record<
        string,
        Parameters<PostgresQueue['drainOnce']>[0]['handlers'][string]
      >,
    })
    return {
      dispatched: drain.enqueued,
      delivered: delivery.acked,
      failed: delivery.retried + delivery.deadLettered,
    }
  }

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      inFlight = runOnce()
        .then((summary) => {
          if (summary.dispatched > 0 || summary.delivered > 0 || summary.failed > 0) {
            options.onActivity?.(summary)
          }
        })
        .catch(onError)
        .finally(schedule)
    }, intervalMs)
  }

  schedule()

  return {
    runOnce,
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      await inFlight.catch(() => undefined)
    },
  }
}
