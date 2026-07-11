# Agent Inbox API v1

Status: accepted (HT-17 reads, HT-18 writes). Helpthread's first public API, designed
**native** — on Helpthread's own domain model, not reverse-engineered from any other
helpdesk's wire format. (It supersedes the earlier `conversations-v1.md` draft, which was
shaped for a FreeScout-consumer cutover that no longer applies — see the project history.)

## 1. Purpose

This is the **Agent side**: the surface an Agent (today, a single operator) uses to work
the inbox — see what has come in, read a conversation, and act on it. It is the API under
the eventual Agent inbox UI (API-first, CHARTER.md §2), and the loop Helpthread is
dogfooded through: mail lands → Agent sees it → Agent replies.

v1 is deliberately single-Agent: there is no assignment, no per-Agent identity, no teams.
The Bearer token authenticates *the deployment's one operator*, not a user among many.
Multi-Agent identity is a later increment, added when there is a second Agent.

This document covers the whole v1 surface; **HT-17 implements §3's read paths and all of
the conventions below; HT-18 implements §4's write paths.**

## 2. Domain model (native)

The API speaks Helpthread's own vocabulary — the same the store (`src/store/`) persists,
surfaced as JSON with ISO-8601 timestamps and no translation layer.

```ts
type ConversationStatus = 'open' | 'closed'          // 'deleted' is never surfaced (§3a)

interface ConversationSummary {
  id: string                 // uuid — the canonical id, used verbatim in every path
  subject: string
  customerEmail: string
  status: ConversationStatus
  threadCount: number
  createdAt: string          // ISO-8601
  updatedAt: string          // ISO-8601 — last activity; the inbox sort key
}

interface ConversationDetail extends ConversationSummary {
  threads: ThreadView[]      // oldest-first
}

interface ThreadView {
  id: string                 // uuid
  direction: 'inbound' | 'outbound'   // inbound = from the customer; outbound = the Agent's sent reply
  from: string               // the message's From address
  bodyText: string | null
  bodyHtml: string | null    // ⚠ UNTRUSTED, UNSANITIZED — see §5
  deliveryStatus: 'pending' | 'sent' | 'failed' | null   // outbound only; null for inbound
  createdAt: string          // ISO-8601
}
```

Ids are **UUID strings**, verbatim as the store generates them — no integer surrogates,
no separate ticket number. There is no `customer` entity in v1 (a conversation carries a
`customerEmail` string); no mailbox; no internal notes. Each is added when a real need
appears, not preemptively.

## 3. Conventions (apply to every endpoint, reads and writes)

- **Base path:** `/api/v1`.
- **Format:** JSON in and out, `Content-Type: application/json`.
- **Auth:** `Authorization: Bearer <token>` on every request, compared against the
  configured service token (`HELPTHREAD_API_TOKEN`) with a **constant-time** comparison
  (length-guarded, as `src/mail/reply-token.ts` already does). A missing, malformed, or
  wrong token is `401 unauthorized` with a generic message — the response never reveals
  which of those it was.
- **Never cache:** every response carries `Cache-Control: no-store`. This is authenticated
  support data; no edge or CDN copy, ever.
- **Error envelope:**
  ```ts
  interface ApiError { error: { code: string; message: string } }
  ```
  `code` is a machine-readable slug (`unauthorized`, `not_found`, `validation_failed`,
  `server_error`); `message` is user-safe and MUST NEVER contain an internal detail — no
  stack, no SQL, no upstream body, no id it wasn't given. HTTP status pairs with `code`:
  400 validation, 401 auth, 404 not-found, 405 method-not-allowed, 500 server error.
- **Unknown routes / methods:** an unmatched path is `404 not_found`; a known path with an
  unsupported method is `405` (with an `Allow` header). Both still require auth first — an
  unauthenticated request gets `401` before routing details leak.

## 3a. `GET /api/v1/conversations` — the inbox list

Lists conversations for the inbox, **most-recently-active first** (`updatedAt` desc, `id`
desc as a stable tiebreak).

| query param | type | default | notes |
|---|---|---|---|
| `status` | `open` \| `closed` | `open` | the inbox defaults to open work; `deleted` is not an accepted value and deleted rows are never returned under any filter |
| `limit` | number | 25 | hard cap 50; values above are clamped, not rejected |
| `cursor` | string | — | opaque keyset cursor from a previous response's `nextCursor` |

```ts
interface ConversationListResponse {
  conversations: ConversationSummary[];
  nextCursor: string | null;   // null when this is the last page
}
```

**Pagination is keyset, not offset:** the `cursor` opaquely encodes the `(updatedAt, id)`
of the last item returned, and the next page selects rows ordered before it. This stays
correct and cheap even as conversations are added or reordered between page fetches (an
offset would skip or duplicate). The cursor is opaque to the client — treated as a token to
echo back, never parsed.

## 3b. `GET /api/v1/conversations/{id}` — one conversation with its threads

Returns a `ConversationDetail` — the conversation plus its `threads`, oldest-first. `404
not_found` if `{id}` is not a conversation (or is a `deleted` one — a deleted conversation
is indistinguishable from a nonexistent one to this API, on purpose).

## 4. Write paths (HT-18 — specified here so reads and writes share one contract)

- **`POST /api/v1/conversations/{id}/replies`** — the Agent posts a reply. Body:
  `{ text: string; html?: string }` (text 1–5000 chars, server-enforced). Calls
  `sendReply` (`src/mail/send.ts`): mints the reply token, persists the outbound thread,
  sends. Returns `201` with the created `ThreadView`. A reply to a `closed` conversation
  reopens it (the store's existing policy); to a `deleted`/missing one is `404`.
- **`PATCH /api/v1/conversations/{id}`** — `{ status: 'open' | 'closed' }` to close or
  reopen. Returns the updated `ConversationSummary`. Needs `setConversationStatus` on the
  store. `deleted` is not settable through this endpoint.

## 5. Security notes

- **`bodyHtml` is untrusted and unsanitized.** The parser stores inbound HTML verbatim,
  `<script>` and all (specs/mail/threading.md §5; a fixture confirmed a stored `<script>`).
  This API returns it as-is — which is safe as JSON, but **any UI that renders it MUST
  sanitize first** (e.g. DOMPurify), or it is a stored-XSS vector against the Agent. This
  contract MUST carry to the inbox-UI increment; a server-side sanitized variant is a
  candidate hardening. Flagged, not solved, here.
- **No existence leak.** Not-found and not-authorized are distinct status codes (404 vs
  401) but neither response body distinguishes "never existed" from "deleted" or from "you
  can't see it" — messages are generic.
- **The Bearer token is a service credential.** It grants the whole inbox. It is compared
  in constant time and read only from server configuration, never logged.

## 6. What v1 is NOT

- No multi-Agent identity, assignment, teams, or per-user authorization.
- No customer-side / self-service surface (a separate future API, designed native when
  there are customers to serve).
- No internal notes, no mailbox management, no search, no realtime, no webhooks-out.
- No attachment upload on reply yet (the blob seam exists; wiring is later).
- Framework-agnostic by construction: handlers are `Request → Response`; a Vercel/Next
  adapter is a thin deploy-time wrapper, not part of this spec.
