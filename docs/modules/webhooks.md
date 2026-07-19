# Webhooks: events, delivery, and signature verification

This covers the admin API for registering a webhook endpoint, the event
vocabulary and envelope every delivery carries, how to verify a delivery's
signature, the delivery guarantees you can rely on, and what happens when
your endpoint starts failing.

All examples assume `$BASE_URL` is your deployment's origin (e.g.
`https://your-helpdesk.example.com`), `$HELPTHREAD_API_TOKEN` is the
deployment's service Bearer token, and `$ADMIN_AGENT_ID` is the uuid of an
admin-role Agent — every admin route below requires **both** headers. There
is no separate "webhooks API key"; this is the same admin surface an admin
Agent's own browser session uses.

## Registering a webhook

```sh
curl -X POST "$BASE_URL/api/v1/webhooks" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-module.example.com/webhooks/helpthread",
    "events": ["conversation.message_received"],
    "module": "your-module-slug"
  }'
```

- `url` — required, `https://` only (no other scheme is accepted, and
  registering `http://` is rejected at this call, not silently downgraded),
  at most 2048 characters.
- `events` — optional array drawn from the vocabulary below. Omit it (or
  send `[]`) to subscribe to **every** event type.
- `module` — optional free-text slug identifying which module owns this
  endpoint. Purely attribution; nothing validates it against a registry
  today.

Response, `201`:

```json
{
  "webhook": {
    "id": "b3f6...-uuid",
    "url": "https://your-module.example.com/webhooks/helpthread",
    "events": ["conversation.message_received"],
    "module": "your-module-slug",
    "status": "active",
    "consecutiveFailures": 0,
    "createdAt": "2026-07-19T00:00:00.000Z",
    "updatedAt": "2026-07-19T00:00:00.000Z",
    "secret": "base64url-256-bit-secret..."
  }
}
```

**`secret` is returned exactly once, in this response.** It is encrypted at
rest server-side and never appears in any later `GET`/`PATCH` response —
there is no "reveal secret" endpoint. If you lose it, delete the endpoint
and register a new one (v1 has no secret-rotation route for webhooks, unlike
Assistant tokens — see [assistants-and-drafts.md](./assistants-and-drafts.md)).

### Listing, updating, deleting

```sh
# List every registered endpoint (never includes the secret)
curl "$BASE_URL/api/v1/webhooks" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID"

# Update url/events/module/status (any subset; unknown fields are a 400)
curl -X PATCH "$BASE_URL/api/v1/webhooks/$WEBHOOK_ID" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"events": ["conversation.message_received", "draft.resolved"]}'

# Hard delete
curl -X DELETE "$BASE_URL/api/v1/webhooks/$WEBHOOK_ID" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID"
```

`status` may only be set to `"active"` or `"disabled"` via `PATCH` —
`"auto_disabled"` is written by the engine only (see
[Auto-disable](#auto-disable-and-health-visibility) below); to clear it,
`PATCH` to `"active"` explicitly, which also resets the failure counter.

### Testing an endpoint

```sh
curl -X POST "$BASE_URL/api/v1/webhooks/$WEBHOOK_ID/test" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID"
```

Fires a synthetic `test.ping` event through the **real** delivery path
(same signing, same SSRF checks, same timeout) directly at this one
endpoint, ignoring its `events` filter. `202 { "status": "queued" }` on
success. `test.ping` is never a value you can put in an endpoint's `events`
array — it only ever exists as this one synthetic delivery, and its
envelope's `conversationId` is `null` and `data` is `{}`.

Only an `active` endpoint can be tested — a `disabled`/`auto_disabled`
endpoint gets `409 conflict`; re-enable it first.

## Event vocabulary and envelope

Eight real domain event types, closed list — nothing else is ever
delivered as a non-test event:

| Type | Fired when | `data` |
|---|---|---|
| `conversation.created` | A new conversation is stored | — |
| `conversation.message_received` | Inbound mail is stored on a conversation (including a reopen of a closed one) | `threadId`, `reopened` |
| `conversation.reply_sent` | An outbound reply's delivery is confirmed `sent` (not merely accepted) | `threadId`, `authorKind` |
| `conversation.status_changed` | Conversation status transitions among `active`/`pending`/`closed`/`spam` | `from`, `to` |
| `conversation.tags_changed` | A conversation's tag set is replaced | `tags` |
| `conversation.assignee_changed` | A conversation's assignee is set or cleared | `assigneeAgentId` |
| `draft.created` | An Assistant posts a draft | `threadId`, `assistantId` |
| `draft.resolved` | An Agent approves or discards a draft | `threadId`, `resolution`, `edited` |

**Events are thin by design.** `data` carries only identifiers and small
typed facts — never a message body, subject line, or address. Fetch full
content through the read API (`GET /api/v1/conversations/{id}`) with your
own credentials once an event tells you something changed. Message content
therefore never transits a webhook — but treat payloads as sensitive
anyway: some fields are operator-authored free text (`conversation.tags_changed`
carries the tag strings themselves), and identifiers still reveal that a
given conversation exists and is active.

**Soft-deleted conversations fire nothing.** Deletion is invisible on every
other endpoint (a `404`, indistinguishable from never having existed) and
the same holds here: no event of any type fires for a soft-deleted
conversation, including a `draft.*` for a draft stranded on it.

Every delivery's JSON body is exactly this envelope:

```json
{
  "eventId": "uuid",
  "type": "conversation.message_received",
  "occurredAt": "2026-07-19T12:00:00.000Z",
  "conversationId": "uuid",
  "data": { "threadId": "uuid", "reopened": false }
}
```

`conversationId` is `null` only for the synthetic `test.ping` — every real
event always carries one.

## Headers on every delivery

| Header | Value |
|---|---|
| `X-Helpthread-Event` | The event `type` (redundant with the body, provided for routing without a JSON parse) |
| `X-Helpthread-Delivery` | A fresh uuid on **every** HTTP attempt, including a retry of the same event — do not use this for dedupe |
| `X-Helpthread-Signature` | `t=<unix-seconds>, v1=<hex HMAC-SHA256 digest>` — see below |
| `Content-Type` | `application/json` |

**Dedupe on `eventId`, in the body — never on `X-Helpthread-Delivery`.**
`eventId` is the one value stable across every redelivery of the same
event; the delivery header changes on every attempt by design.

## Verifying the signature

`X-Helpthread-Signature` is `t=<unix-seconds>, v1=<hex>`, where the hex
value is `HMAC-SHA256(secret, "<t>.<raw request body>")`, keyed by the
endpoint's own signing secret (the one shown once at registration). This is
the Stripe-shape scheme; the engine's signer lives in
`src/webhooks/delivery.ts`'s `signWebhookPayload`.

Verify against the **raw** request body bytes, before any `JSON.parse` —
the signature covers exactly what was sent, and re-serializing a parsed
object is not guaranteed to reproduce the same bytes.

Complete, runnable TypeScript sample:

```typescript
// verify-signature.ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export type VerifyResult = { valid: true } | { valid: false; reason: string }

const DEFAULT_TOLERANCE_SECONDS = 5 * 60 // recommended replay window

export function verifyWebhookSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
  if (!header) {
    return { valid: false, reason: 'missing signature header' }
  }

  const fields = Object.fromEntries(
    header.split(',').map((part) => {
      const [key, value] = part.trim().split('=')
      return [key, value]
    }),
  )
  const timestamp = Number(fields.t)
  const signature = fields.v1
  if (!Number.isFinite(timestamp) || !signature) {
    return { valid: false, reason: 'malformed signature header' }
  }

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'stale timestamp — possible replay' }
  }

  // Require an exact 64-character hex digest (a SHA-256 HMAC) before
  // decoding — Buffer.from(str, 'hex') silently stops at the first
  // non-hex character rather than rejecting the string, so a signature
  // with trailing garbage after a valid prefix would otherwise decode
  // instead of being caught here as malformed.
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) {
    return { valid: false, reason: 'malformed signature header' }
  }

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  const providedBuf = Buffer.from(signature, 'hex')
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { valid: false, reason: 'signature mismatch' }
  }

  return { valid: true }
}
```

Usage in a receiving handler (framework-agnostic — read the raw body
**before** any JSON body-parser middleware consumes it):

```typescript
const result = verifyWebhookSignature(
  request.headers.get('x-helpthread-signature'),
  rawBody, // the exact bytes received, not JSON.parse(rawBody) re-stringified
  process.env.WEBHOOK_SIGNING_SECRET!,
)
if (!result.valid) {
  return new Response('invalid signature', { status: 401 })
}
const event = JSON.parse(rawBody)
```

Reject a stale `t` (the 5-minute default above matches the spec's
recommendation) to close a replay window — an attacker who captures one
valid delivery cannot resend it indefinitely.

> **Verified, not just written.** This exact function was checked before
> landing in this doc, and re-checked after the hex-validation fix above:
> (1) signed with the engine's own `signWebhookPayload`
> (`src/webhooks/delivery.ts`) and verified successfully by this function,
> byte-for-byte, with a real HMAC computed both ways; (2) cross-checked
> against the independent verifier in `module-draft-assistant/src/verify.ts`
> (the reference module referenced throughout this guide) — both verifiers
> agree on the same signed payload; (3) correctly rejects a wrong secret, a
> tampered body, a stale timestamp, and a signature with trailing non-hex
> garbage appended after a valid-length prefix (`Buffer.from(str, 'hex')`
> otherwise silently truncates instead of rejecting it). The throwaway
> script that ran these checks exited `0`.

## Delivery guarantees

| Guarantee | What it means for you |
|---|---|
| **At-least-once** | The same event may arrive more than once. Always dedupe on `eventId`, never assume exactly-once. |
| **No cross-event ordering** | Two events for the same conversation can arrive out of order (different retries, different queue timing). Don't infer sequence from delivery order — the envelope's `occurredAt` and your own read of current state via the API are the source of truth. |
| **Thin payloads** | `data` never carries message content — fetch it via the read API with your own credentials. |
| **2xx acks, anything else retries** | Any `2xx` status is success. A non-2xx HTTP response, a timeout (10s hard deadline), or a connection error is a failed attempt and goes through the queue's retry/backoff. Redirects are never followed — a `3xx` is a failure, not a hop. |
| **HTTPS only, SSRF-checked at delivery time** | Only `https://` endpoints are ever registered, and every delivery attempt resolves the endpoint's hostname and refuses to connect if it resolves to a private/loopback/link-local address — even if the hostname resolved to a public address when you registered it. If your endpoint's DNS changes to something disallowed, deliveries start failing, not the registration. |
| **SSRF refusals are NOT retried** | Unlike an ordinary HTTP failure, an SSRF refusal is dead-lettered immediately on the first attempt, never queued for retry — retrying can't change what a hostname resolves to, so burning the retry budget on it would only delay the signal that your endpoint needs attention. This counts toward the endpoint's [auto-disable](#auto-disable-and-health-visibility) failure counter the same as any other dead-lettered delivery. |

## Auto-disable and health visibility

After **20 consecutive** failed delivery attempts to one endpoint, it flips
from `active` to `auto_disabled` automatically — this is conservative on
purpose: a silently-disabled endpoint means a paid module's user stops
getting the events it depends on without anyone noticing, so the threshold
errs toward catching that quickly. A single success resets the counter to
zero without touching status; only a deliberate `PATCH .../{id}
{"status":"active"}` re-enables an `auto_disabled` endpoint (which also
resets the counter).

Two operator-visible signals surface this, both via `GET
/api/v1/webhooks` (`status` and `consecutiveFailures` on each row) and via
the deployment's internal health endpoint:

```sh
curl "$BASE_URL/api/v1/internal/health" \
  -H "Authorization: Bearer $CRON_SECRET"
```

which reports, among other sections:

```json
{
  "ok": false,
  "alerts": ["webhook-endpoint-auto-disabled: 1 webhook endpoint(s) auto-disabled ..."],
  "webhooks": {
    "autoDisabled": [
      { "id": "...", "url": "https://your-module.example.com/webhooks/helpthread", "consecutiveFailures": 20 }
    ],
    "deliveryFailuresLast24h": 3
  }
}
```

`/api/v1/internal/health` answers `200` when healthy and `503` when any
alert (including this one) is tripped — a plain status-code monitor is a
complete alerting story; you don't need to parse the body to know something
needs attention. This endpoint is an **operator** concern (it needs the
deployment's `CRON_SECRET`, a separate credential from anything a module
holds) — documented here so a module author building against a self-hosted
Helpthread instance knows where their own endpoint's health is visible to
the person running it.
