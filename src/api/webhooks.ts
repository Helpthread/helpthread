/**
 * The webhook admin API (HT-69; specs/modules/substrate-v1.md §5) —
 * `POST`/`GET /api/v1/webhooks`, `PATCH`/`DELETE /api/v1/webhooks/{id}`,
 * `POST /api/v1/webhooks/{id}/test`.
 *
 * Same shape and conventions as `src/api/agents.ts` (this ticket's exact
 * brief): each handler is a pure function of an already-authenticated
 * (service Bearer), already-routed `Request` plus its dependencies —
 * `src/api/index.ts` authenticates and routes; nothing here re-checks
 * either. Every response goes through `src/api/responses.ts`'s helpers.
 * Admin-only, acting-Agent header REQUIRED on every route — mirroring
 * `agents.ts`'s mailbox-access endpoints (a security-sensitive admin
 * surface with no self-service carve-out), not the Agent-roster endpoints
 * (which allow any active Agent).
 *
 * ## Secret handling
 *
 * A fresh secret is server-generated on `POST` (never accepted from the
 * caller — spec §5: "server-generated") and returned EXACTLY ONCE, in the
 * `201` response body — `WebhookEndpointStore.list`'s rows (and hence
 * every OTHER response this module ever sends) never carry it, mirroring
 * `agents.ts`'s "never a secret_hash, a password, or a token anywhere in a
 * response body" discipline for everything except that one creation
 * response.
 *
 * ## `POST .../test` requires an ACTIVE endpoint
 *
 * Refused (`409 conflict`) against a `disabled`/`auto_disabled` endpoint —
 * re-enable it first (`PATCH .../{id}` with `status: 'active'`). This
 * keeps the invariant "only active endpoints ever receive a delivery"
 * true by construction at the enqueue boundary; `src/webhooks/delivery.ts`'s
 * handler ALSO re-checks status at send time (defense against the race
 * where an endpoint is disabled between this enqueue and the delivery
 * attempt), but this refusal is the primary gate and the honest response
 * to an operator who tried to test a disabled endpoint, rather than a
 * silent no-op.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import type { QueueProvider } from '../providers/queue.js'
import type { AgentRecord } from '../store/agents.js'
import type {
  CreatedWebhookEndpoint,
  StoredWebhookEndpoint,
  WebhookEndpointStore,
} from '../store/webhook-endpoints.js'
import { WEBHOOK_DELIVERY_TOPIC, type WebhookDeliveryJob } from '../webhooks/delivery.js'
import { isEventType, TEST_PING_EVENT_TYPE } from '../webhooks/event-types.js'
import { apiError, json, noContent } from './responses.js'
import { isUuid } from './uuid.js'

/** Dependencies every handler in this module needs. */
export interface WebhooksApiDeps {
  store: WebhookEndpointStore
  queue: QueueProvider
}

/** Length (bytes, before base64url encoding) of a freshly generated webhook secret — 256 bits, matching this codebase's other high-entropy secret sizes (`src/auth/invite-token.ts`'s `NONCE_BYTES`-scale reasoning: enough that guessing is infeasible, no further tuning needed). */
const SECRET_BYTES = 32

/** `https://` only, and a sane upper bound so a pathological value can't bloat the row or a log line — matching migration 022's own `LIKE 'https://%'` CHECK, re-validated at the API layer for a clean `400` instead of a raw constraint-violation `500`. */
const MAX_URL_LENGTH = 2048

function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** `https://...`, ≤ {@link MAX_URL_LENGTH} chars, and a syntactically valid URL. `null` on any violation. */
function validateUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null
  if (!raw.startsWith('https://')) return null
  try {
    // Rejects anything `new URL` itself can't parse (e.g. no host at all);
    // does NOT resolve DNS or apply the SSRF/private-range check — that is
    // `src/webhooks/ssrf.ts`'s job, applied at DELIVERY time (spec §5's
    // "resolve-then-connect pinning" — a hostname's resolved address can
    // change after registration, so checking it once here would be a stale
    // guarantee, not a real one).
    new URL(raw)
    return raw
  } catch {
    return null
  }
}

/** `body.events` must be an array of known {@link isEventType} strings, or omitted (defaults to `[]`, spec §5's "or all"). `null` on any violation. */
function validateEvents(raw: unknown): string[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const events: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !isEventType(entry)) return null
    events.push(entry)
  }
  return events
}

/** `body.module`, if present, must be a non-empty string. `undefined` (field absent) is distinct from `null` (explicit clear) — both legal; only a present-but-wrong-typed value is a violation (`'invalid'`). */
function validateModule(
  raw: unknown,
): { ok: true; value: string | null | undefined } | { ok: false } {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: null }
  if (typeof raw === 'string' && raw.trim().length > 0) return { ok: true, value: raw }
  return { ok: false }
}

// --- wire shape --------------------------------------------------------------

interface WebhookJson {
  id: string
  url: string
  events: string[]
  module: string | null
  status: StoredWebhookEndpoint['status']
  consecutiveFailures: number
  createdAt: string
  updatedAt: string
}

function toWebhookJson(endpoint: StoredWebhookEndpoint): WebhookJson {
  return {
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    module: endpoint.module,
    status: endpoint.status,
    consecutiveFailures: endpoint.consecutiveFailures,
    createdAt: endpoint.createdAt.toISOString(),
    updatedAt: endpoint.updatedAt.toISOString(),
  }
}

/** {@link toWebhookJson} plus the plaintext secret — `POST`'s response ONLY (module doc). */
function toCreatedWebhookJson(endpoint: CreatedWebhookEndpoint): WebhookJson & { secret: string } {
  return { ...toWebhookJson(endpoint), secret: endpoint.secret }
}

const UNAUTHORIZED = () => apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
const FORBIDDEN = () => apiError(403, 'forbidden', 'Admin role required.')
const NOT_FOUND = () => apiError(404, 'not_found', 'No webhook endpoint with that id.')

/** The one authz check every handler below starts with: acting Agent present AND admin. Returns the error `Response` to short-circuit with, or `null` if the caller may proceed. */
function requireAdmin(actingAgent: AgentRecord | null): Response | null {
  if (actingAgent === null) return UNAUTHORIZED()
  if (actingAgent.role !== 'admin') return FORBIDDEN()
  return null
}

// --- GET/POST /api/v1/webhooks ------------------------------------------------

/** `GET /api/v1/webhooks` — admin only. The full roster, never including any secret. */
export async function handleListWebhooks(
  actingAgent: AgentRecord | null,
  deps: Pick<WebhooksApiDeps, 'store'>,
): Promise<Response> {
  const denied = requireAdmin(actingAgent)
  if (denied !== null) return denied

  const webhooks = await deps.store.list()
  return json(200, { webhooks: webhooks.map(toWebhookJson) })
}

/** `POST /api/v1/webhooks` — admin only. `{ url, events?, module? }`. Returns the secret ONCE (module doc). */
export async function handleCreateWebhook(
  actingAgent: AgentRecord | null,
  request: Request,
  deps: Pick<WebhooksApiDeps, 'store'>,
): Promise<Response> {
  const denied = requireAdmin(actingAgent)
  if (denied !== null) return denied

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  const url = validateUrl(body.url)
  if (url === null) {
    return apiError(
      400,
      'validation_failed',
      `url is required, must start with https://, and be at most ${MAX_URL_LENGTH} characters.`,
    )
  }
  const events = validateEvents(body.events)
  if (events === null) {
    return apiError(
      400,
      'validation_failed',
      'events must be an array of known event type strings, or omitted for all events.',
    )
  }
  const module = validateModule(body.module)
  if (!module.ok) {
    return apiError(400, 'validation_failed', 'module must be a non-empty string or null.')
  }

  const created = await deps.store.create({
    url,
    secret: generateSecret(),
    events,
    ...(module.value !== undefined ? { module: module.value } : {}),
  })
  return json(201, { webhook: toCreatedWebhookJson(created) })
}

// --- PATCH/DELETE /api/v1/webhooks/{id} ---------------------------------------

const PATCHABLE_FIELDS = ['url', 'events', 'module', 'status']

/** `PATCH /api/v1/webhooks/{id}` — admin only. `status` may only be set to `'active'`/`'disabled'` — `'auto_disabled'` is engine-written only (`WebhookEndpointStore`'s own module doc), never admin-settable directly. */
export async function handlePatchWebhook(
  id: string,
  actingAgent: AgentRecord | null,
  request: Request,
  deps: Pick<WebhooksApiDeps, 'store'>,
): Promise<Response> {
  const denied = requireAdmin(actingAgent)
  if (denied !== null) return denied
  if (!isUuid(id)) return NOT_FOUND()

  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  const body = asRecord(parsed.value)
  if (body === null)
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')

  for (const key of Object.keys(body)) {
    if (!PATCHABLE_FIELDS.includes(key)) {
      return apiError(400, 'validation_failed', `Unknown field '${key}'.`)
    }
  }

  const patch: {
    url?: string
    events?: string[]
    module?: string | null
    status?: 'active' | 'disabled'
  } = {}
  if ('url' in body) {
    const url = validateUrl(body.url)
    if (url === null) {
      return apiError(
        400,
        'validation_failed',
        `url must start with https:// and be at most ${MAX_URL_LENGTH} characters.`,
      )
    }
    patch.url = url
  }
  if ('events' in body) {
    const events = validateEvents(body.events)
    if (events === null) {
      return apiError(
        400,
        'validation_failed',
        'events must be an array of known event type strings.',
      )
    }
    patch.events = events
  }
  if ('module' in body) {
    const module = validateModule(body.module)
    if (!module.ok) {
      return apiError(400, 'validation_failed', 'module must be a non-empty string or null.')
    }
    patch.module = module.value ?? null
  }
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'disabled') {
      return apiError(
        400,
        'validation_failed',
        "status must be 'active' or 'disabled' (auto_disabled is engine-managed).",
      )
    }
    patch.status = body.status
  }

  const updated = await deps.store.patch(id, patch)
  if (updated === null) return NOT_FOUND()
  return json(200, { webhook: toWebhookJson(updated) })
}

/** `DELETE /api/v1/webhooks/{id}` — admin only, hard delete. */
export async function handleDeleteWebhook(
  id: string,
  actingAgent: AgentRecord | null,
  deps: Pick<WebhooksApiDeps, 'store'>,
): Promise<Response> {
  const denied = requireAdmin(actingAgent)
  if (denied !== null) return denied
  if (!isUuid(id)) return NOT_FOUND()

  const deleted = await deps.store.delete(id)
  if (!deleted) return NOT_FOUND()
  return noContent()
}

// --- POST /api/v1/webhooks/{id}/test ------------------------------------------

/** `POST /api/v1/webhooks/{id}/test` — admin only. Fires a synthetic `test.ping` through the real delivery queue (`src/webhooks/delivery.ts`), addressed to exactly this endpoint regardless of its `events` filter. Refused (`409`) against a non-active endpoint (module doc). */
export async function handleTestWebhook(
  id: string,
  actingAgent: AgentRecord | null,
  deps: WebhooksApiDeps,
): Promise<Response> {
  const denied = requireAdmin(actingAgent)
  if (denied !== null) return denied
  if (!isUuid(id)) return NOT_FOUND()

  const endpoints = await deps.store.list()
  const target = endpoints.find((e) => e.id === id)
  if (target === undefined) return NOT_FOUND()
  if (target.status !== 'active') {
    return apiError(
      409,
      'conflict',
      'Cannot test a disabled endpoint — set status to active first.',
    )
  }

  const job: WebhookDeliveryJob = {
    endpointId: target.id,
    eventId: randomUUID(),
    type: TEST_PING_EVENT_TYPE,
    occurredAt: new Date().toISOString(),
    conversationId: null,
    data: {},
  }
  await deps.queue.enqueue(WEBHOOK_DELIVERY_TOPIC, job, {
    dedupeKey: `${job.eventId}:${target.id}`,
  })
  return json(202, { status: 'queued' })
}
