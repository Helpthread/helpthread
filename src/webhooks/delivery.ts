/**
 * The webhook delivery queue consumer (HT-69; specs/modules/substrate-v1.md
 * §5's "Delivery" bullet) — one `QueueMessageHandler<WebhookDeliveryJob>`
 * that POSTs a signed event envelope to one endpoint and reports the
 * outcome back to `QueueProvider` (`src/providers/queue.ts`) and to the
 * endpoint's own failure/success counters (`WebhookEndpointStore`,
 * `src/store/webhook-endpoints.ts`).
 *
 * ## Where a `WebhookDeliveryJob` comes from
 *
 * Every job on {@link WEBHOOK_DELIVERY_TOPIC} was enqueued either by the
 * outbox drain (`./outbox-drain.ts`, one job per matching active endpoint
 * per real domain event) or by the admin `POST /api/v1/webhooks/{id}/test`
 * handler (`src/api/webhooks.ts`, one synthetic `test.ping` job addressed
 * to the one endpoint under test, bypassing `event_outbox` entirely — spec
 * §4: "test.ping is a synthetic type fired only by the test endpoint"). This
 * handler treats both origins identically: it has no idea which produced
 * the job it's holding, and doesn't need to.
 *
 * ## Envelope, headers, signature (spec §4's JSON shape, §5's headers)
 *
 * The JSON body is exactly spec §4's envelope: `eventId`, `type`,
 * `occurredAt`, `conversationId`, `data`. `conversationId` is `null` only
 * for `test.ping` (not tied to any conversation — see
 * `src/webhooks/event-types.ts`'s doc comment); every real domain event
 * always carries one (`event_outbox.conversation_id` is `NOT NULL`).
 *
 * `X-Helpthread-Delivery` is freshly minted on EVERY invocation of this
 * handler — including a queue-driven redelivery of the SAME
 * `QueueMessage.id` — because spec §5 requires it to "differ per attempt";
 * `eventId` (in the body, and dedupe-key material at enqueue time) is the
 * stable identity a consumer dedupes on, not this header.
 *
 * `X-Helpthread-Signature` is signed over `${unixTimestamp}.${body}` with
 * HMAC-SHA256 under the endpoint's plaintext secret (decrypted per-call via
 * `WebhookEndpointStore.getSecret` — never cached across deliveries, the
 * same "fetch fresh, don't cache a decrypted secret" posture
 * `gmail-oauth.ts`'s token service already uses for OAuth tokens).
 *
 * ## Retry vs. dead-letter is THIS handler's decision, not the queue's
 *
 * `QueueProvider`'s generic retry/backoff (`createPostgresQueue`) has no
 * notion of "endpoint" or "consecutive failure count" — it is
 * topic-agnostic infra. So this handler tracks its own attempt ceiling
 * ({@link WEBHOOK_DELIVERY_MAX_ATTEMPTS}, matching the queue's own factory
 * default so the two layers agree) against `QueueMessage.attempts`: while
 * under the ceiling, a failed attempt returns `{ kind: 'retry' }` with NO
 * store write (spec: "consecutive-failure counter increments... at the
 * threshold" describes `WebhookEndpointStore.recordDeliveryFailure`'s OWN
 * per-EVENT counter, which must not be double-incremented per HTTP attempt);
 * once `attempts` reaches the ceiling, THIS attempt calls
 * `recordDeliveryFailure` and returns `{ kind: 'deadLetter' }` itself,
 * rather than returning a bare `retry` and hoping the queue's own
 * (unrelated) ceiling eventually dead-letters the row without ever touching
 * the store. An SSRF refusal ({@link SsrfRefusedError}) is dead-lettered
 * IMMEDIATELY regardless of `attempts` — retrying can never change what a
 * hostname is configured to resolve to, so burning the retry budget on it
 * only delays the operator-visible signal.
 *
 * A 2xx response is the only success: `recordDeliverySuccess` + `ack`.
 * Everything else — non-2xx (including a 3xx, since redirects are never
 * followed — spec §5), a timeout, a connection error — is a failed
 * attempt, handled by the retry/dead-letter branch above.
 */

import { createHmac, randomUUID } from 'node:crypto'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { QueueHandlerResult, QueueMessage, QueueMessageHandler } from '../providers/queue.js'
import type { WebhookEndpointStore } from '../store/webhook-endpoints.js'
import { resolveSafeAddress, SsrfRefusedError } from './ssrf.js'

/** The queue topic every webhook delivery is enqueued on (both the outbox drain and the admin test endpoint). */
export const WEBHOOK_DELIVERY_TOPIC = 'webhook.delivery'

/**
 * Attempts (`QueueMessage.attempts`, 1-indexed) at which this handler stops
 * retrying and dead-letters the delivery itself (module doc). Matches
 * `createPostgresQueue`'s own `DEFAULT_MAX_ATTEMPTS` (5) — not imported
 * from there (that constant is private to the adapter), chosen to agree
 * with it so the two independent ceilings line up rather than one firing
 * before the other.
 */
export const WEBHOOK_DELIVERY_MAX_ATTEMPTS = 5

/** Hard deadline for the whole HTTP exchange — connect through response — per spec §5. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000

/** The payload every `WEBHOOK_DELIVERY_TOPIC` job carries — enough to rebuild spec §4's envelope and address one endpoint, with nothing else re-fetched from `event_outbox` at delivery time (the outbox row may already be marked dispatched by then). */
export interface WebhookDeliveryJob {
  endpointId: string
  eventId: string
  type: string
  /** ISO-8601 — `StoredOutboxEvent.occurredAt` serialized once at fan-out time (`./outbox-drain.ts`), never re-derived here. */
  occurredAt: string
  /** `null` only for a synthetic `test.ping` (module doc). */
  conversationId: string | null
  data: Record<string, unknown>
}

/** Spec §4's envelope — the exact JSON body of every delivery. */
interface WebhookEnvelope {
  eventId: string
  type: string
  occurredAt: string
  conversationId: string | null
  data: Record<string, unknown>
}

function envelopeFor(job: WebhookDeliveryJob): WebhookEnvelope {
  return {
    eventId: job.eventId,
    type: job.type,
    occurredAt: job.occurredAt,
    conversationId: job.conversationId,
    data: job.data,
  }
}

/**
 * Compute spec §5's `X-Helpthread-Signature` value:
 * `t=<unix-ts>, v1=<hex HMAC-SHA256(secret, t + "." + body)>`. Exported so
 * a test can independently recompute and verify it against a captured
 * delivery (this ticket's brief: "a consumer-side verification in tests").
 */
export function signWebhookPayload(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
  return `t=${timestampSeconds}, v1=${mac}`
}

/** The one piece of information this handler needs back from the wire — never the body (spec has no use for it, and discarding it lets a slow/huge response never block the handler). */
export interface WebhookHttpResponse {
  status: number
}

/** The `node:https.request`-shaped seam {@link sendWebhookRequest} calls — injectable so tests can exercise retry/ack/signature logic against a fake transport with zero real sockets, network, or TLS involved. */
export type HttpsRequestFn = typeof httpsRequest

/**
 * POST `body` to `url` with `headers`, resolve-then-connect SSRF-pinned
 * (`./ssrf.ts`), 10s hard deadline, redirects never followed (`node:https`'
 * low-level `request` never auto-follows a redirect — there is no
 * "disable following" flag to set because there is nothing to disable).
 * Throws {@link SsrfRefusedError} for a non-`https:` URL or an unsafe
 * resolved address; otherwise resolves with the response status only (the
 * body is drained and discarded, never read).
 */
export async function sendWebhookRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
  deps: {
    resolveSafeAddress?: typeof resolveSafeAddress
    requestImpl?: HttpsRequestFn
    timeoutMs?: number
  } = {},
): Promise<WebhookHttpResponse> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') {
    throw new SsrfRefusedError(`webhook url must be https: — got '${parsed.protocol}//...'`)
  }

  const resolve = deps.resolveSafeAddress ?? resolveSafeAddress
  const pinned = await resolve(parsed.hostname)
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_DELIVERY_TIMEOUT_MS
  const bodyBuffer = Buffer.from(body, 'utf8')

  const requestImpl = deps.requestImpl ?? httpsRequest

  const options: RequestOptions = {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Content-Length': bodyBuffer.length,
    },
    signal: AbortSignal.timeout(timeoutMs),
    // Resolve-then-connect pinning (`./ssrf.ts`'s module doc): always hand
    // back the ALREADY-VALIDATED address, ignoring whatever hostname Node's
    // connector re-passes in. Node's http/net internals call this with
    // `options.all: true` and expect an ARRAY-shaped callback in that case
    // — verified live against the installed Node version (this ticket's
    // report); the single-address form is kept too for a caller that asks
    // without `all`.
    lookup: (_hostname, lookupOptions, callback) => {
      if (typeof lookupOptions === 'function') {
        ;(lookupOptions as unknown as (err: null, address: string, family: number) => void)(
          null,
          pinned.address,
          pinned.family,
        )
        return
      }
      if (lookupOptions.all) {
        callback(null, [{ address: pinned.address, family: pinned.family }])
        return
      }
      callback(null, pinned.address, pinned.family)
    },
  }

  return new Promise<WebhookHttpResponse>((resolvePromise, reject) => {
    const req = requestImpl(parsed, options, (res) => {
      // Only the status matters (module doc) — drain the body without
      // parsing it so the socket is released and a large/slow response body
      // can never block or OOM this handler.
      res.resume()
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0 }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(bodyBuffer)
  })
}

/** Dependencies {@link createWebhookDeliveryHandler} needs. */
export interface WebhookDeliveryHandlerDeps {
  webhookEndpoints: WebhookEndpointStore
  /** Overrides for {@link sendWebhookRequest} — tests inject a fake transport here; production leaves it unset (real DNS + `node:https`). */
  send?: Parameters<typeof sendWebhookRequest>[3]
}

/**
 * Build the `QueueMessageHandler<WebhookDeliveryJob>` registered for
 * {@link WEBHOOK_DELIVERY_TOPIC}. See the module doc for the full retry/
 * dead-letter/signature contract.
 */
export function createWebhookDeliveryHandler(
  deps: WebhookDeliveryHandlerDeps,
): QueueMessageHandler<WebhookDeliveryJob> {
  return async (message: QueueMessage<WebhookDeliveryJob>): Promise<QueueHandlerResult> => {
    const job = message.payload

    // Both the endpoint's URL and its secret are read FRESH on every
    // attempt, never cached from an earlier attempt at the same job — an
    // admin editing the URL or rotating the secret mid-retry should have
    // the NEXT attempt reflect that, not a stale value.
    const endpoints = await deps.webhookEndpoints.list()
    const target = endpoints.find((e) => e.id === job.endpointId)
    if (target === undefined) {
      // The endpoint was deleted between fan-out (or the test click) and
      // this delivery attempt — there is no row left to record success or
      // failure against, and there never will be on a later retry either.
      // Not a transient condition: dead-letter immediately.
      return { kind: 'deadLetter', reason: `webhook endpoint ${job.endpointId} no longer exists` }
    }
    if (target.status !== 'active') {
      // The endpoint was disabled (manually, or auto-disabled) between
      // fan-out and this attempt — a harmless drop, not a failure: nobody
      // is harmed by not delivering to an endpoint that no longer wants
      // deliveries, so this both skips the send and leaves the
      // consecutive-failure counter untouched (only a genuine send failure
      // should move it). The admin test endpoint (`src/api/webhooks.ts`)
      // refuses to enqueue against a non-active endpoint in the first
      // place, so this branch is defense against the race window, not the
      // primary gate.
      return { kind: 'ack' }
    }
    const secret = await deps.webhookEndpoints.getSecret(job.endpointId)
    if (secret === null) {
      // Deleted in the gap between the list() above and this read — same
      // "gone, not transient" reasoning as the check above.
      return { kind: 'deadLetter', reason: `webhook endpoint ${job.endpointId} no longer exists` }
    }

    const body = JSON.stringify(envelopeFor(job))
    const timestampSeconds = Math.floor(Date.now() / 1000)
    const headers = {
      'X-Helpthread-Event': job.type,
      'X-Helpthread-Delivery': randomUUID(),
      'X-Helpthread-Signature': signWebhookPayload(secret, body, timestampSeconds),
    }

    try {
      const response = await sendWebhookRequest(target.url, body, headers, deps.send)
      if (response.status >= 200 && response.status < 300) {
        await deps.webhookEndpoints.recordDeliverySuccess(job.endpointId)
        return { kind: 'ack' }
      }
      return failOrRetry(
        deps,
        job.endpointId,
        message.attempts,
        `webhook delivery to ${target.url} failed with HTTP ${response.status}`,
      )
    } catch (err) {
      if (err instanceof SsrfRefusedError) {
        // Never retryable (module doc) — dead-letter on the FIRST occurrence
        // regardless of `message.attempts`.
        await deps.webhookEndpoints.recordDeliveryFailure(job.endpointId)
        return { kind: 'deadLetter', reason: err.message }
      }
      const detail = err instanceof Error ? err.message : String(err)
      return failOrRetry(
        deps,
        job.endpointId,
        message.attempts,
        `webhook delivery to ${target.url} failed: ${detail}`,
      )
    }
  }
}

/** Shared tail of both HTTP-failure branches above: retry under the ceiling, dead-letter (with the one `recordDeliveryFailure` write) at it — module doc's "Retry vs. dead-letter" section. */
async function failOrRetry(
  deps: WebhookDeliveryHandlerDeps,
  endpointId: string,
  attempts: number,
  reason: string,
): Promise<QueueHandlerResult> {
  if (attempts < WEBHOOK_DELIVERY_MAX_ATTEMPTS) {
    return { kind: 'retry' }
  }
  await deps.webhookEndpoints.recordDeliveryFailure(endpointId)
  return { kind: 'deadLetter', reason }
}
