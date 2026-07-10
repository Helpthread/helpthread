# Conversations API v1

Status: draft spec, pre-implementation. Derives the wire contract from Resonant
IQ's existing FreeScout consumer (`src/lib/support/freescout-client.ts`,
`actions.ts`, `validations/support.ts`, `status-utils.ts` in the `resonantiq`
repo) so that Resonant IQ's production app can cut over to Helpthread with a
config-level change — base URL and auth header — and nothing else.

## 1. Purpose & compatibility posture

This is Helpthread's founding public API: the six conversation operations
named in CHARTER.md §4 as the founding surface — list conversations by
customer email, get a conversation with threads, get a conversation's owner,
create a conversation, add a customer reply, look up a customer. Together they
form the entire customer-side contract Resonant IQ's "My Support" surface and
ask-here modal need.

**The wire shapes here are deliberately compatible with the documented REST
subset the current FreeScout consumer already speaks.** Request bodies, query
parameter names, and response envelopes (including the `_embedded` wrapper
shape) are specified to match what `freescout-client.ts` sends and parses
today, field for field. API shapes are functional interfaces, and matching
them means the consumer's parsing code does not need to change — that is the
whole point of the migration.

**Auth is Helpthread-native**, not a FreeScout compatibility shim. The
consumer currently sends a vendor-specific header
(`X-FreeScout-API-Key: <key>`); at cutover its client swaps to
`Authorization: Bearer <api key>` — a one-line change in
`freeScoutFetch`'s header block. Everything else — paths, params, JSON
shapes, status codes — stays byte-for-byte what the consumer already handles.

**Migration story, stated plainly:** change `FREESCOUT_BASE_URL` /
`FREESCOUT_API_KEY` (or their Helpthread equivalents) to point at a Helpthread
deployment, change the auth header line, redeploy. No other line in the
consumer's support module should need to move.

## 2. Conventions

- **Base path:** `/api/v1`. All six operations below hang off this prefix.
- **Format:** JSON request and response bodies, `Content-Type: application/json`.
- **Auth:** `Authorization: Bearer <api key>` on every request. This is a
  service-level credential, analogous to today's `X-FreeScout-API-Key` — it
  authenticates the calling application, not an individual end user. Per-user
  ownership enforcement is the caller's responsibility (see §4), matching the
  pattern already in `actions.ts` today.
- **Cacheability:** every response is per-customer support data and must be
  served `Cache-Control: no-store` — no edge or CDN caching of authenticated
  conversation data, ever.
- **Error envelope:**
  ```ts
  interface ApiError {
    error: {
      code: string;    // machine-readable, e.g. "not_found", "validation_failed"
      message: string; // user-safe; never an upstream body, key, or internal URL
    };
  }
  ```
  Paired with a matching HTTP status (400 for validation, 401 for missing/bad
  auth, 404 for not-found/not-owned, 500 for misconfiguration, 502 for
  upstream/storage failure). Messages must stay as user-safe as the FreeScout
  client's today (`"Could not submit request"`, `"Failed to load support
  request"`) — never leak internals. The exact `code` enum is an
  implementation-level decision, not fixed by this spec.
- **Pagination:** v1 ships **first-page-only**. `pageSize` is accepted but
  capped at 50 (the consumer's only observed value) with no cursor/offset for
  a second page — see §5. Sort is newest-first by default and, in v1, the only
  supported combination.

## 3. The six operations

### a. List conversations by customer email

`GET /api/v1/conversations?customerEmail={email}&pageSize=50&sortField=createdAt&sortOrder=desc&embed=threads`

| param | type | required | notes |
|---|---|---|---|
| `customerEmail` | string | yes | matched case-insensitively (client always lowercases before sending) |
| `pageSize` | number | no | default 50; v1 hard cap 50 |
| `sortField` | string | no | default `createdAt`; **v1 only supports this value** — see OPEN QUESTION below |
| `sortOrder` | string | no | default `desc`; **v1 only supports this value** |
| `embed` | string | no | `threads` embeds each conversation's threads inline, for list-view previews without an N+1 fetch |

```ts
interface ConversationListResponse {
  _embedded: { conversations: Conversation[] };
}
```

### b. Get one conversation with threads

`GET /api/v1/conversations/{id}?embed=threads`

Returns a single `Conversation` (below) with `threads` populated. 404 if the
id doesn't resolve.

### c. Get a conversation's owner (lightweight, no embeds)

`GET /api/v1/conversations/{id}` — **the same route as (b), called without
`embed=threads`.** It is not a distinct endpoint; omitting the embed param is
what makes it lightweight. Callers should read `customer.email` off the
response and not request threads when only the owner is needed. 404 if the id
doesn't resolve.

### d. Create conversation

`POST /api/v1/conversations`

```ts
interface CreateConversationRequest {
  type: 'email';                 // only value the consumer sends
  mailboxId: number;
  subject: string;                // 1–200 chars
  customer: { email: string };
  threads: [{
    type: 'customer';
    text: string;                 // 1–5000 chars
    attachments?: Attachment[];   // ≤10
  }];
}

interface Attachment {
  fileName: string;
  mimeType: string;
  data: string; // base64
}

interface CreateConversationResponse {
  id: number; // the only field the consumer requires present
}
```

Note: the consumer appends a "Submitted from: {page}" footer to the message
**client-side**, before this call is ever made — the API never sees a
separate page-context field, only the final `text`. Footer/breadcrumb
behavior belongs to the client, not this API, and v1 has no field for it.

Errors: 400 `validation_failed` (subject/message/attachment-count violations,
or an unknown `mailboxId`), 502 storage/upstream failure. A client-supplied
bad mailbox is the client's error (400), never a 500.

### e. Add customer reply to a conversation

`POST /api/v1/conversations/{id}/threads`

```ts
interface AddReplyRequest {
  type: 'customer';
  text: string; // 1–5000 chars
}
```

Response: **204 No Content** on success — callers must tolerate an empty
body (the consumer's client explicitly allows this only for this endpoint).
404 if the conversation id doesn't resolve; 400 on validation failure.

### f. Look up a customer by email

`GET /api/v1/customers?email={email}`

```ts
interface CustomerListResponse {
  _embedded: { customers: Customer[] };
}

interface Customer {
  id: number;
  email: string;
  firstName?: string;
  lastName?: string;
}
```

Matched case-insensitively; the consumer takes the first entry whose email
matches after lowercasing both sides. No match is **not** an error — respond
`{ _embedded: { customers: [] } }`, HTTP 200.

### Shared shapes

```ts
interface Conversation {
  id: number;
  number: number;        // human-facing ticket number, distinct from id
  subject: string;
  status: ConversationStatus;
  createdAt: string;      // ISO 8601
  customer: { email: string }; // always present top-level in v1 responses
  threads?: Thread[];          // present when embed=threads was requested
}

type ConversationStatus = 'active' | 'pending' | 'closed' | 'spam';

interface Thread {
  id: number;
  type: ThreadType;
  text: string;
  createdAt: string;
  createdBy?: { id: number; firstName?: string; lastName?: string };
}

type ThreadType = 'customer' | 'message' | 'note';
```

`status` values: `active` (shown as "Open"), `pending`, `closed` are the three
the consumer's UI explicitly labels (`status-utils.ts`); `spam` is a valid
value in the type but has no dedicated label/badge — the UI falls back to an
"Unknown"/outline treatment for anything it doesn't recognize, `spam`
included. Treat that fallback as intentional degrade-gracefully behavior, not
evidence `spam` is unreachable.

`type` values on `Thread`: `customer` (customer-authored, the only type the
consumer ever constructs, via create and reply) and `message`/`note` are
included as the actor-facing types implied by the charter's actor vocabulary
(agent-authored reply and internal note, respectively) — **OPEN QUESTION**:
the consumer code read for this spec never parses or renders a thread by
`type`, so the customer/message/note split above is inferred from field
naming and the charter's actor model, not observed. Also **OPEN QUESTION**:
whether `note` threads must ever be filtered out of a customer-facing read
response — an internal note leaking to `GET /conversations/{id}` would be a
real information leak on the agent's behalf, and nothing in the consumer code
proves FreeScout (or should Helpthread) filters this server-side.

## 4. Semantics notes

- **Email matching is case-insensitive** everywhere an email is a query
  param or comparison key (list, owner check, customer lookup) — the consumer
  always lowercases before sending and compares lowercased on the client too.
- **Default sort is newest-first** (`createdAt` desc) for the list endpoint;
  v1 has no other supported combination.
- **Validation limits are server-enforced, not just client-side hints:**
  subject ≤200 chars, message text ≤5000 chars, ≤10 attachments per create.
  Surprise worth flagging: today these limits are inconsistently enforced —
  subject/message length come from a shared Zod schema
  (`validations/support.ts`) used by both the RHF form and the server action,
  but the **attachment cap is not in that schema at all**; it's enforced by
  silently truncating (`attachments?.slice(0, 10)`) in `actions.ts`, not by
  rejecting. **OPEN QUESTION**: should v1 reject >10 attachments with a 400,
  or silently truncate to match today's actual (if accidental) behavior? Also
  unspecified anywhere in the consumer code: max size per attachment and any
  mime-type allowlist — both **OPEN QUESTION**.
- **Idempotency for create is unaddressed by the consumer** — it calls create
  exactly once per user submit with no client-generated idempotency key or
  dedupe logic visible in `actions.ts`. **OPEN QUESTION**: does v1 need an
  idempotency-key mechanism (e.g., an `Idempotency-Key` header) to protect
  against retry-on-timeout double-creating a conversation? Flagged for design,
  not decided here.
- **Ownership is enforced by the caller, not this API.** `actions.ts` is
  explicit about this today: `getConversationOwnerEmail` / the detail fetch
  resolve the owning email and the caller compares it against the session
  email itself, returning a generic "Not found" on mismatch so existence
  isn't leaked. This API's Bearer key authenticates the *application*, not an
  end user — v1 does not do per-end-user authorization, and callers must keep
  doing what `actions.ts` already does.
- **Actor model note:** v1's surface is entirely customer-side (list, get,
  owner, create, reply, customer lookup) — no agent-side operations exist yet
  — but thread authorship still records actor type per CHARTER.md §4 ("every
  thread records what kind of actor authored it"), which is why `Thread.type`
  above carries the full customer/message/note vocabulary even though only
  `customer` is ever written through this API's create/reply operations.

## 5. What v1 is NOT

- No agent-side operations: no assignment, no status transitions, no note
  authoring, no agent-facing thread reads.
- No mailbox management (mailbox is an opaque `mailboxId` the caller supplies).
- No webhooks.
- No search.
- No pagination beyond the first page — `pageSize` is capped at 50, matching
  the only value the current consumer ever sends; there is no cursor/offset
  for page two. Stated honestly: this is a real gap, not a design choice
  Helpthread is proud of, and it's the first thing the inbox UI's own list
  needs beyond this v1.
- No realtime (no Supabase Realtime push on this surface yet).

These land alongside the agent inbox UI, under the API-first rule in
CHARTER.md §2: no UI capability ships without its public API underneath, and
none of the above has a UI yet.

## 6. Fixture pointers

Acceptance fixtures for these six operations come from black-box testing
against running systems (HT-7).
