/**
 * `QueueProvider` — the seam for at-least-once background work.
 *
 * See `src/providers/README.md` for the pattern this fits into. First
 * adapter target (CHARTER.md §4): Vercel Queues.
 *
 * ## Delivery model
 *
 * Serverless queue consumers are **push-delivered**, not pulled: the
 * platform invokes an HTTP handler with a queued message, rather than the
 * engine running a resident loop that polls for work (the charter's "no
 * daemons, no long-running processes" principle — a bounded invocation that
 * reads and exits is permitted; a process that stays up is not). This
 * interface models that shape directly —
 * there is no `dequeue`/`poll` method. The handler side of the contract is
 * `QueueMessageHandler`, invoked by adapter glue that receives the
 * platform's webhook/invocation and adapts it into a `QueueMessage`.
 *
 * ## At-least-once and idempotency
 *
 * Every implementation of this interface delivers **at least once**: a
 * message may be redelivered after a successful handler run (e.g. if the
 * platform's ack arrives late, or after a retry racing a late ack) and
 * will be redelivered after a failed or timed-out run. Handlers MUST be
 * idempotent — safe to process the same `QueueMessage.id` (or the same
 * `dedupeKey`, when supplied at enqueue time) more than once without
 * duplicating side effects. This interface does not — and cannot —
 * guarantee exactly-once delivery.
 */

/** Options controlling how a message is enqueued. */
export interface EnqueueOptions {
  /**
   * Delay delivery by this many seconds after enqueue. Omit or `0` for
   * immediate (best-effort) delivery.
   */
  delaySeconds?: number

  /**
   * Caller-supplied idempotency key. Implementations SHOULD suppress
   * duplicate enqueues that share the same `topic` and `dedupeKey` within
   * the platform's dedupe window, so that a retried enqueue call (e.g.
   * after a caller timeout) does not produce duplicate work. This is a
   * best-effort de-duplication aid, not a substitute for idempotent
   * handlers — see the at-least-once note above.
   */
  dedupeKey?: string
}

/**
 * A message as delivered to a consumer. `T` is the payload shape the
 * producer enqueued.
 */
export interface QueueMessage<T> {
  /** Provider-assigned unique id for this delivery attempt's message. */
  id: string

  /** The topic/queue name this message was enqueued on. */
  topic: string

  /** The payload as originally enqueued. */
  payload: T

  /**
   * How many times delivery of this message has been attempted, starting
   * at `1` for the first delivery. Handlers can use this to implement
   * their own retry-count-aware logic (e.g. escalate to dead-letter after
   * N attempts) independent of what the platform's own retry policy does.
   */
  attempts: number

  /** When this message was originally enqueued (producer-observed time). */
  enqueuedAt: Date
}

/**
 * The outcome a handler returns after processing a `QueueMessage`.
 * Modeled as an explicit result rather than throw/catch so that retry
 * intent (and backoff) is a typed decision the handler makes, not an
 * accident of which exceptions happen to propagate.
 */
export type QueueHandlerResult =
  | { kind: 'ack' }
  | { kind: 'retry'; backoffSeconds?: number }
  | { kind: 'deadLetter'; reason: string }

/**
 * Consumer contract: a handler processes one `QueueMessage` and returns a
 * `QueueHandlerResult` describing what should happen next.
 *
 * - `ack` — processing succeeded; the message is done and will not be
 *   redelivered (subject to the at-least-once caveat above).
 * - `retry` — processing failed in a way that should be retried;
 *   `backoffSeconds`, if given, is a hint for how long to wait before the
 *   next attempt. Omit it to defer to the provider's default backoff.
 * - `deadLetter` — processing failed in a way that should NOT be retried
 *   (e.g. payload is permanently malformed); `reason` is recorded for
 *   operator visibility.
 *
 * A handler that throws is treated as equivalent to `retry` by adapters,
 * but handlers SHOULD prefer returning `retry`/`deadLetter` explicitly so
 * retry intent is visible in the return type rather than inferred from an
 * uncaught exception.
 */
export type QueueMessageHandler<T> = (message: QueueMessage<T>) => Promise<QueueHandlerResult>

/**
 * Provider for enqueueing at-least-once background work. See the module
 * doc comment above for the delivery and idempotency model.
 */
export interface QueueProvider {
  /**
   * Enqueue `payload` on `topic` for later, at-least-once delivery to
   * whatever consumer is registered for that topic.
   *
   * Enqueue itself is fire-and-forget from the caller's perspective: this
   * resolves once the message is durably accepted by the provider, not
   * once it has been processed.
   */
  enqueue<T>(topic: string, payload: T, opts?: EnqueueOptions): Promise<void>
}
