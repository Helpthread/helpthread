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

import type { DrainDeps, PostgresQueue } from '../providers/adapters/postgres-queue/index.js'
import type { EventOutboxStore } from '../store/event-outbox.js'
import type { WebhookEndpointStore } from '../store/webhook-endpoints.js'
import {
  createWebhookDeliveryHandler,
  WEBHOOK_DELIVERY_TOPIC,
  type WebhookDeliveryHandlerDeps,
  type WebhookDeliveryJob,
} from '../webhooks/delivery.js'
import { drainEventOutbox } from '../webhooks/outbox-drain.js'

export interface WebhookWorkerDeps {
  eventOutbox: EventOutboxStore
  webhookEndpoints: WebhookEndpointStore
  queue: PostgresQueue
  /** Overrides the HTTP transport `createWebhookDeliveryHandler` uses. Tests inject a fake here so they can assert a request was actually attempted; the harness leaves it unset (real DNS + `node:https`). */
  send?: WebhookDeliveryHandlerDeps['send']
}

export interface WebhookWorkerOptions {
  /** Delay between passes, measured from the end of one to the start of the next. Defaults to 1s — brisk enough that a local end-to-end run feels immediate. */
  intervalMs?: number
  /** Called after any pass that actually did something, for harness logging. Its own failure is reported, never propagated. */
  onActivity?: (summary: WorkerPassSummary) => void | Promise<void>
  /** Called when a pass throws. Defaults to `console.error`. Neither a failing pass nor a failing `onError` may stop the loop. */
  onError?: (err: unknown) => void
}

export interface WorkerPassSummary {
  dispatched: number
  delivered: number
  failed: number
}

export interface WebhookWorker {
  /**
   * Run exactly one pass: drain the outbox, then drain the queue. Exposed
   * for tests and for a deterministic single-shot run.
   *
   * Serialized against the scheduled loop and tracked by {@link stop}, so a
   * caller cannot end up closing the database out from under a pass it
   * started itself. Rejects once the worker has been stopped, rather than
   * quietly starting work on a shut-down worker.
   */
  runOnce(): Promise<WorkerPassSummary>
  /** Stop the loop. Safe to call more than once; resolves once no pass — scheduled or explicit — is still running. */
  stop(): Promise<void>
}

type DrainHandlers = DrainDeps['handlers']

const DEFAULT_INTERVAL_MS = 1_000

export function startWebhookWorker(
  deps: WebhookWorkerDeps,
  options: WebhookWorkerOptions = {},
): WebhookWorker {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const onError = options.onError ?? ((err: unknown) => console.error('[webhook-worker]', err))

  // Typed as the queue's own handler map rather than cast into it. The
  // delivery handler is written against `QueueMessage<WebhookDeliveryJob>`
  // while `drainOnce` hands it a `QueueMessage<unknown>`; a cast would
  // silence that mismatch, and the queue does no runtime payload check, so
  // a corrupted row on this topic would arrive as if it were typed.
  // Narrowing the payload here is the honest place to notice.
  const deliver = createWebhookDeliveryHandler({
    webhookEndpoints: deps.webhookEndpoints,
    send: deps.send,
  })
  const handlers: DrainHandlers = {
    [WEBHOOK_DELIVERY_TOPIC]: (message) =>
      deliver({ ...message, payload: message.payload as WebhookDeliveryJob }),
  }

  let stopped = false
  let timer: NodeJS.Timeout | undefined
  // Every pass — scheduled or explicit — is chained onto this, so passes
  // never overlap and `stop()` has exactly one thing to wait on. Tracking
  // only the scheduled ones would let an explicit `runOnce()` still be
  // querying while the caller closes the database.
  let inFlight: Promise<unknown> = Promise.resolve()

  async function pass(): Promise<WorkerPassSummary> {
    const drain = await drainEventOutbox({
      eventOutbox: deps.eventOutbox,
      webhookEndpoints: deps.webhookEndpoints,
      queue: deps.queue,
    })
    const delivery = await deps.queue.drainOnce({ handlers })
    return {
      dispatched: drain.enqueued,
      delivered: delivery.acked,
      failed: delivery.retried + delivery.deadLettered,
    }
  }

  /** Queue `work` behind whatever is already running, and track it for `stop()`. */
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = inFlight.then(work, work)
    // `inFlight` must never be a rejected promise nobody handles — that is
    // an unhandled rejection, which on Node's default settings takes the
    // process down and with it the loop this exists to keep alive.
    inFlight = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Report through an observer without ever letting the observer's own failure escape. */
  async function notify(fn: (() => void | Promise<void>) | undefined): Promise<void> {
    if (fn === undefined) return
    try {
      await fn()
    } catch (err) {
      try {
        onError(err)
      } catch {
        // An `onError` that itself throws has nowhere left to report to.
        // Swallowing is the only option that keeps the loop running.
      }
    }
  }

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(() => {
      void serialize(pass)
        .then(async (summary) => {
          if (summary.dispatched > 0 || summary.delivered > 0 || summary.failed > 0) {
            await notify(() => options.onActivity?.(summary))
          }
        })
        .catch((err) => notify(() => onError(err)))
        .finally(schedule)
    }, intervalMs)
  }

  schedule()

  return {
    async runOnce() {
      if (stopped) {
        throw new Error('webhook worker: runOnce() called after stop()')
      }
      return serialize(pass)
    },
    async stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      await inFlight
    },
  }
}
