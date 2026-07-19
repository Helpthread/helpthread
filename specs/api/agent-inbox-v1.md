# Agent Inbox API v1

Status: accepted (HT-17 reads, HT-18 writes, HT-16 send idempotency); **amended to v1.1**
(HT-25, 2026-07-11) — the contract additions the Agent Inbox UI was designed against,
adopted as the v1 build target (§7 changelog). Helpthread's first public API, designed
**native** — on Helpthread's own domain model, not reverse-engineered from any other
helpdesk's wire format. (It supersedes the earlier `conversations-v1.md` draft, which was
shaped for a FreeScout-consumer cutover that no longer applies — see the project history.)

## 1. Purpose

This is the **Agent side**: the surface an Agent (today, a single operator) uses to work
the inbox — see what has come in, read a conversation, and act on it. It is the API under
the Agent inbox UI (API-first, CHARTER.md §2), and the loop Helpthread is dogfooded
through: mail lands → Agent sees it → Agent replies.

v1 is deliberately single-Agent: there is no per-Agent identity, no teams. The Bearer
token authenticates *the deployment's one operator*, not a user among many. The v1.1
`assignee` flag (§4f) is deliberately shaped to need no identity — `'me' | null` — so the
inbox's "Mine" folder works without inventing users. Multi-Agent identity is a later
increment, added when there is a second Agent.

This document covers the whole v1 surface. **HT-17 implemented §3's read paths and the
conventions below; HT-18 implemented §4a–4b; HT-16 amended §4a with send idempotency; HT-49
amended §4a's `References` derivation to append the reply's own minted id (a provider —
Gmail, confirmed live — can rewrite `Message-ID` on send; threading.md §2a).**
The v1.1 additions land per-ticket: HT-26 (status model), HT-27 (`preview` + `number`),
HT-28 (notes), HT-29 (tags), HT-30 (delete), HT-31 (assignee), HT-32 (open tracking).

Rollout note: **HT-26 is the one BREAKING increment** — existing status values are
renamed and the list filter's meaning changes, so backend and UI adopt it together (a
coordinated rollout, deliberately first in the sequence; dogfood-only means the
coordination is a single deploy, per HT-16's same reasoning). Every OTHER addition is
additive with a nullable/empty default, and the UI degrades per-field for those —
partial deployment of the additive increments is safe.

## 2. Domain model (native)

The API speaks Helpthread's own vocabulary — the same the store (`src/store/`) persists,
surfaced as JSON with ISO-8601 timestamps and no translation layer.

```ts
type ConversationStatus = 'active' | 'pending' | 'closed' | 'spam'
                          // v1.1 (HT-26). 'deleted' is never surfaced (§3a)

interface ConversationSummary {
  id: string                 // uuid — the canonical id, used verbatim in every path
  number: number             // v1.1: sequential per-deployment id, display-only (never a path key)
  subject: string
  customerEmail: string
  status: ConversationStatus
  threadCount: number
  assignee: 'me' | null      // v1.1: null = Anyone; single-Agent shaped (§4f)
  tags: string[]             // v1.1: short lowercase labels, [] default (§4e)
  preview: string            // v1.1: latest bodyText excerpt, '' when none (derivation below)
  createdAt: string          // ISO-8601
  updatedAt: string          // ISO-8601 — last activity; the inbox sort key
}

interface ConversationDetail extends ConversationSummary {
  threads: ThreadView[]      // oldest-first
}

interface ThreadView {
  id: string                 // uuid
  direction: 'inbound' | 'outbound' | 'note'
                             // inbound = from the customer; outbound = the Agent's sent
                             // reply; note = internal, Agent-only (v1.1, §4c)
  from: string               // the message's From address; the support address for notes
  bodyText: string | null
  bodyHtml: string | null    // ⚠ UNTRUSTED, UNSANITIZED — see §5
  deliveryStatus: 'pending' | 'sent' | 'failed' | null
                             // outbound only; null otherwise. HT-70: the invariant widens
                             // — an outbound thread's deliveryStatus is ALSO null while it
                             // is an unapproved or discarded draft (draftStatus below is
                             // 'awaiting_review' or 'discarded'); a draft becomes eligible
                             // for pending/sent/failed only once approved.
  customerViewedAt: string | null
                             // v1.1: outbound only, and only when open tracking is
                             // enabled (§4g) — first time the customer viewed the reply;
                             // null until then, always null for inbound and notes
  attachments: AttachmentView[]
                             // HT-46: inbound attachments this thread carries. [] when
                             // there are none, OR when the deployment hasn't wired the
                             // attachment read-path deps (config-gated, absent by default
                             // — same posture as open tracking, §4g)
  createdAt: string          // ISO-8601
  authorKind: 'customer' | 'agent' | 'assistant'
                             // HT-70 (specs/plugins/substrate-v1.md §2, §7): who authored
                             // this thread — 'customer' for inbound mail, 'agent' for
                             // human-authored outbound/notes, 'assistant' for an
                             // AI-authored draft (specs/plugins/substrate-v1.md §3, §6)
  draftStatus: 'awaiting_review' | 'approved' | 'discarded' | null
                             // HT-70: a draft's lifecycle state; null for every non-draft
                             // thread (specs/plugins/substrate-v1.md §2, §6)
}

interface AttachmentView {
  id: string                 // uuid
  filename: string | null    // null when the attachment arrived with no filename
  contentType: string
  size: number                // bytes
  url: string                 // a time-limited signed URL (never a stable/public path)
}
```

**Status semantics (v1.1, HT-26).** `active` is the working state — inbound mail creates
conversations `active`, and v1.0's `open` rows migrate to `active`. `pending` is an Agent
statement that the conversation is parked awaiting something outside the inbox (a
customer, a third party, a release); nothing sets it automatically in v1, and it still
counts as open work (§3a). `closed` is resolved. `spam` is junk an Agent has thrown out
of the inbox; nothing classifies spam automatically in v1. Status pills in the UI:
Active = accent, Pending = warn, Closed = dim, Spam = critical.

**`number`** is assigned from a per-deployment monotone sequence at conversation
creation (existing rows are backfilled in creation order by the HT-27 migration). It
exists for humans — inbox rows, notifications, "re: #482" in conversation — and is
display-only: every path parameter remains the uuid, and `number` is never accepted as
an identifier anywhere in this API.

**`preview`** is derived at read time, not stored: the most recent thread with a
non-null `bodyText` (any direction — notes included; this is an Agent-only surface),
whitespace collapsed to single spaces, trimmed, first 120 characters; `''` when no
thread has text. **HT-70:** `preview` and `threadCount` both IGNORE an unresolved or
discarded draft (`draftStatus IN ('awaiting_review', 'discarded')`) — a draft is not
conversation content until an Agent approves it, so it contributes to neither the
count nor the latest-body derivation. An `'approved'` draft (i.e. sent mail) counts and
can become the preview like any other outbound thread. Conversation detail (§3b) still
returns the draft ROW itself in `threads` regardless of its status — only the
summary-level `preview`/`threadCount` derivations exclude it.

Ids are **UUID strings**, verbatim as the store generates them — the uuid is canonical
and `number` is a human-facing convenience, not a surrogate key. There is no `customer`
entity in v1 (a conversation carries a `customerEmail` string) and no mailbox. Each is
added when a real need appears, not preemptively.

## 3. Conventions (apply to every endpoint, reads and writes)

- **Base path:** `/api/v1`.
- **Format:** JSON in and out, `Content-Type: application/json`. (One exception: the
  open-tracking pixel, §4g, responds `image/gif` — it is fetched by mail clients, not
  API consumers.)
- **Auth:** `Authorization: Bearer <token>` on every request, compared against the
  configured service token (`HELPTHREAD_API_TOKEN`) with a **constant-time** comparison
  (length-guarded, as `src/mail/reply-token.ts` already does). A missing, malformed, or
  wrong token is `401 unauthorized` with a generic message — the response never reveals
  which of those it was. (The open-tracking pixel, §4g, is the one deliberate exception
  to Bearer auth — it is fetched by customer mail clients and carries its own rules.)
  **This is still the API's only auth model — with one addition (HT-70).** The Agent
  Inbox web app now requires an operator to sign in before it will render any page, but
  that is a web-layer door in front of this same Bearer token, not a second API auth
  mechanism — see §5 for the full justification. HT-70 (specs/plugins/substrate-v1.md
  §3) DOES add a genuine second credential class, checked ALONGSIDE the service Bearer
  token, never replacing it: a per-Assistant token (`ht_asst_<assistantId>_<secret>`),
  verified before routing under the same constant-time discipline (parse the embedded
  id → single-row lookup → constant-time digest compare). An Assistant's capability set
  is fixed and narrow (read conversations, create drafts, create notes — spec §3) and
  enforced at one gate, distinct from every Agent-facing endpoint this document
  describes.
- **Never cache:** every response carries `Cache-Control: no-store`. This is authenticated
  support data; no edge or CDN copy, ever.
- **Error envelope:**
  ```ts
  interface ApiError { error: { code: string; message: string } }
  ```
  `code` is a machine-readable slug (`unauthorized`, `not_found`, `validation_failed`,
  `method_not_allowed`, `send_failed`, `retry_in_progress`, `server_error`); `message` is
  user-safe and MUST NEVER contain an internal detail — no stack, no SQL, no upstream body,
  no id it wasn't given. HTTP status pairs with `code`: 400 `validation_failed`, 401
  `unauthorized`, 404 `not_found`, 405 `method_not_allowed`, 409 `retry_in_progress` (§4a,
  HT-16 — a concurrent delivery attempt for the same `Idempotency-Key` already holds the
  lease), 500 `server_error`, 502 `send_failed` (§4a, the provider rejected an outbound
  reply).
- **Unknown routes / methods:** an unmatched path is `404 not_found`; a known path with an
  unsupported method is `405` (with an `Allow` header). Both still require auth first — an
  unauthenticated request gets `401` before routing details leak.

## 3a. `GET /api/v1/conversations` — the inbox list

Lists conversations for the inbox, **most-recently-active first** (`updatedAt` desc, `id`
desc as a stable tiebreak).

| query param | type | default | notes |
|---|---|---|---|
| `status` | `open` \| `closed` \| `spam` | `open` | **folder semantics (v1.1):** `open` returns `active` + `pending` rows — the inbox defaults to open work, and pending still needs eventual attention. `closed` and `spam` return exactly that status. `active`/`pending` are NOT accepted filter values (folders are the reading grain; pills disambiguate within the open folder), and `deleted` is not an accepted value — deleted rows are never returned under any filter |
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

**HT-70:** `threads` includes draft rows (`draftStatus` non-null) for Agent/service
callers, at every lifecycle stage — the timeline shows an `awaiting_review`/`discarded`
draft alongside real mail, distinguishable by `authorKind: 'assistant'` and
`draftStatus`. An Assistant caller reads the same endpoint and sees its own drafts
through it too (no separate read surface). Only the summary-level `preview`/
`threadCount` derivations exclude an unresolved/discarded draft (§2) — the full
`threads` array is never filtered by draft status.

## 4. Write paths

### 4a. `POST /api/v1/conversations/{id}/replies` — the Agent replies

**Header:** `Idempotency-Key` is **REQUIRED** on every call (HT-16) — a non-empty,
caller-chosen string, scoped per-conversation. This is a deliberate breaking change from
the HT-15 shape of this endpoint; it has no external consumer yet (this API is
dogfood-only — CHARTER.md "dogfooded first"), so tightening the contract here has no
compatibility cost. The header is **trimmed of leading/trailing whitespace before any
other check**, so `" key "` and `"key"` are the same idempotency key — a caller whose
client or proxy adds incidental whitespace does not silently get a second send. The
**trimmed** value is what is validated, stored, and passed through to `sendReply`: it
must be non-empty and **at most 255 characters** after trimming. A missing header, a
header that is empty (or all whitespace) after trimming, or a trimmed value over 255
characters is `400 validation_failed`, checked before the body is parsed.

Body: `{ text: string; html?: string }` — `text` 1–5000 chars, server-enforced; `html`
optional. The Agent supplies only the message; every mail header is DERIVED server-side
from the conversation, so the client never sets recipients or threading headers:

- **`to`** = the conversation's `customerEmail`.
- **`from`** = the deployment's configured support address (`supportAddress` dep).
- **`subject`** = the conversation's `subject`, prefixed with `Re:` plus a space if it
  isn't already (case-insensitive check — never double-prefix to `Re: Re:`).
- **`In-Reply-To`** = the `messageId` of the conversation's most-recent INBOUND thread (the
  customer message being answered), if it has one; omitted when no prior message-id exists
  (e.g. an inbound message that arrived without a `Message-ID`).
- **`References`** = the `messageId`s of all prior threads in chronological order that have
  one, followed by this reply's OWN freshly-minted `messageId` as the FINAL entry — appended
  by `sendReply` itself (`src/mail/send.ts`), unconditionally, even when no prior thread has a
  `messageId` at all (a first reply then gets a one-element `References: [messageId]`, never
  omitted the way `In-Reply-To` can be). These are for the customer's mail client to thread
  the reply in THEIR inbox — Helpthread's own threading never depends on them (it is
  outbound-token-anchored; threading.md §2) — but the reply's own minted id riding in
  `References` is now load-bearing in one specific way (HT-49, threading.md §2a): some
  providers (Gmail, confirmed live) rewrite the wire `Message-ID` to their own generated id,
  so `References` — which such providers do NOT rewrite — is the channel that actually gets
  the signed token back into the customer's reply when that happens.

The handler then calls `sendReply` (`src/mail/send.ts`), passing the `Idempotency-Key` value
through. `sendReply` mints the reply token into the outbound `Message-ID` (on a genuinely
new send), persists the outbound thread with a snapshot of its envelope
(`send_envelope`: `to`/`cc`/`subject`/`references`, `sending.md` §3a), and sends via the
injected `EmailSender`.

**Replay semantics: same key + same conversation = same logical send, never re-diffed
against the body.** If a call reuses a key already recorded against this conversation, the
NEW request's body is irrelevant — the response reflects the ORIGINAL attempt's outcome:

- If the original attempt already succeeded (`delivery_status: 'sent'`), this call returns
  `201` with that SAME `ThreadView` again, WITHOUT invoking the sender a second time.
- If the original attempt is `pending`/`failed`, this call attempts delivery using the
  ORIGINAL row's stored `messageId` and `send_envelope` — never the replay call's own
  `to`/`subject`/`references`, even if they differ (sending.md §3a's snapshot rule) — after
  first claiming that row's delivery lease.
- If the lease could not be claimed (another attempt — a concurrent replay, or the delivery
  worker, sending.md §3a — currently holds it), this call sends nothing and returns
  `409 retry_in_progress`.

Outcomes:
- **`201`** with the created (or, on a replay after success, the ORIGINAL) `ThreadView`. A
  reply to a `closed` or `spam` conversation **reopens** it to `active` (v1.1, HT-26 — the
  store's append policy) — only on the call that actually creates the row, not on a replay.
- **`400 validation_failed`** on a missing/empty `Idempotency-Key` header, or a body that
  violates the limits.
- **`404 not_found`** if the conversation is missing or `deleted` — no message is sent; a
  reply token minted before the append resolves is simply discarded (mirrors §3b). This
  applies even to a KEYED REPLAY of a key whose original attempt already succeeded: if the
  conversation has since been deleted, the replay call returns `404`, not the original
  `201`. Replay-of-original-outcome does not survive a conversation delete — there is no
  mail-safety impact, since the original send already happened regardless of what a later
  replay call observes.
- **`409 retry_in_progress`** (HT-16) — the delivery lease for this `Idempotency-Key` is
  currently held by another in-flight attempt; nothing was sent by this call. The caller
  should retry the SAME key later, not mint a new one (a new key would create an
  independent send, defeating the point of the dedup key).
- **`502 send_failed`** if the provider rejects the message — nothing was delivered.
  `sendReply` returns a `send-failed` result (it does not throw): the outbound thread is
  left `delivery_status = 'failed'` (retryable — by a replay with the same key, or the
  delivery worker's sweep, sending.md §3a — with the same Message-ID) — or, if even that
  mark fails, stuck `pending`. The response therefore says only that the reply *could not
  be delivered* — never a specific persisted state, never a raw provider error. This is the
  one outcome where an undelivered reply is surfaced to the caller distinctly from an
  internal error. (Note the asymmetry: once the provider ACCEPTS the message it is
  delivered, so a subsequent failure to record `'sent'` is NOT a `send_failed` — it resolves
  to `201`, since reporting a delivered message as failed would invite a resend.)

### 4b. `PATCH /api/v1/conversations/{id}` — set status

Body: `{ status: ConversationStatus }` — any of `active`, `pending`, `closed`, `spam`
(v1.1, HT-26). Returns the updated `ConversationSummary` (`200`) and bumps `updatedAt`
(a status change is activity — the conversation resurfaces in its folder). The store's
`setConversationStatus(id, status)` **excludes `deleted`** (a deleted conversation is not
reachable through this endpoint): missing or deleted → `404 not_found`; a body whose
`status` is not one of the four values (notably `deleted`, which is not settable here) →
`400 validation_failed`.

### 4c. `POST /api/v1/conversations/{id}/notes` — internal note (v1.1, HT-28)

An internal note is Agent-only context on a conversation. **It is never emailed and
never touches the send path**: no reply token is minted, no outbox row is created, and
the delivery worker never sees it — a `note` row existing anywhere near `sendReply` is a
bug, and HT-28 adds a test asserting the boundary (charter invariant #5 adjacency).

Body: `{ text: string }` — 1–5000 chars, server-enforced; no `html` (notes are plain
text in v1). Outcomes:

- **`201`** with the created `ThreadView`: `direction: 'note'`, `from` = the support
  address, `bodyHtml: null`, `deliveryStatus: null`, `customerViewedAt: null`. Bumps
  `updatedAt` (a note is activity; the conversation resurfaces in the inbox) but **never
  changes `status`** — noting a closed conversation does not reopen it.
- **`400 validation_failed`** on a body that violates the limits.
- **`404 not_found`** if the conversation is missing or `deleted`.

### 4d. `DELETE /api/v1/conversations/{id}` — soft delete (v1.1, HT-30)

Marks the conversation `deleted`. **`204`** with an empty body on success; `404
not_found` if the conversation is missing or already deleted. From that point the
conversation is indistinguishable from one that never existed, on every endpoint —
list, get, replies (including keyed replays, §4a), notes, tags, assignee, PATCH. A
deleted conversation is not restorable through this API, and a reply token minted
against it starts a fresh conversation (threading.md's existing deleted-conversation
rule). The UI pairs this with a two-step arm (press → solid critical "Confirm" →
auto-disarm) rather than a modal.

### 4e. `PUT /api/v1/conversations/{id}/tags` — replace the tag set (v1.1, HT-29)

Body: `{ tags: string[] }` — **replace-set semantics**: the request's array becomes the
conversation's whole tag set (send `[]` to clear). Each entry is trimmed, lowercased,
then the array is de-duplicated preserving first-occurrence order. After trimming, each
tag must be 1–40 characters; a non-array body, a non-string entry, an empty-after-trim
entry, or an over-length entry is `400 validation_failed`. Returns the updated
`ConversationSummary` (`200`). Does **not** bump `updatedAt` — tagging is metadata, not
activity. Missing or deleted conversation → `404 not_found`. There is no tag-filtered
listing in v1 — tags are display and organization until a real query need appears.

### 4f. `PUT /api/v1/conversations/{id}/assignee` — claim or release (v1.1, HT-31)

Body: `{ assignee: 'me' | null }` — `null` means "Anyone". Anything else is
`400 validation_failed`. Returns the updated `ConversationSummary` (`200`). Does **not**
bump `updatedAt`. Missing or deleted conversation → `404 not_found`.

This is deliberately NOT identity: `'me'` is the deployment's one operator (the Bearer
token holder), stored as a flag, not a user id. It exists so the UI's "Mine" folder
works in v1; the multi-Agent increment replaces `'me'` with real Agent ids and this
endpoint's body shape is expected to change then (that is an acceptable v2 break —
dogfood-only, same reasoning as HT-16's).

### 4g. Open tracking — `customerViewedAt` (v1.1, HT-32; config-gated, default OFF)

Open tracking records the first time a customer's mail client fetched a tracking pixel
embedded in an outbound reply, surfacing it as `customerViewedAt` on that outbound
`ThreadView`.

**It is off by default, as a deliberate stance, not an oversight.** Open-tracking pixels
are telemetry on customers, which sits uneasily with the ownership-and-trust positioning
this project exists for. The operator must explicitly enable it in deployment
configuration (an `InboxApiDeps`-level flag plus the deployment's public base URL, pinned
by HT-32). While disabled — the shipped default — no pixel is injected, the field is
always `null`, and outbound mail is **byte-identical** to pre-v1.1 behavior: HT-32 must
prove text bodies, headers, and threading unchanged against the existing fixtures
(charter invariant #5), and that enabling it alters only the HTML body.

When enabled:

- The send path (§4a) injects a pixel URL into the outbound **HTML body only** (a
  text-only reply gets no pixel — never fabricate an HTML part just to track). The URL
  carries an **unguessable, signed credential bound to the outbound thread** — the same
  keyring/HMAC pattern reply tokens already use (`src/mail/reply-token.ts`), NEVER the
  bare thread uuid: a guessable identifier would let anyone who learns (or enumerates)
  an id forge a "customer viewed" signal. The exact route and token format are pinned by
  HT-32 against that requirement.
- The pixel endpoint is the API's one **unauthenticated** surface, fetched by customer
  mail clients. Its contract: always respond `200` with `Content-Type: image/gif`, a
  fixed 1×1 gif body, and `Cache-Control: no-store` (a cached pixel would suppress the
  very fetch it exists to observe) — valid token or not, identical either way (no
  existence or validity leak); record only the FIRST view's timestamp for a valid token
  (idempotent — later hits change nothing); set no cookies and record nothing beyond
  that single timestamp.
- `customerViewedAt` remains `null` until a view is recorded; it is always `null` for
  inbound threads and notes.

Both §4a write paths grow `InboxApiDeps` with what `sendReply` needs — `sender`
(`EmailSender`), `keyring`, `mailDomain`, and `supportAddress` — injected at deploy time
alongside `store` and `apiToken`; HT-32 adds the open-tracking configuration described
above.

## 5. Security notes

- **`bodyHtml` is untrusted and unsanitized.** The parser stores inbound HTML verbatim,
  `<script>` and all (specs/mail/threading.md §5; a fixture confirmed a stored `<script>`).
  This API returns it as-is — which is safe as JSON, but **any UI that renders it MUST
  sanitize first** (e.g. DOMPurify), or it is a stored-XSS vector against the Agent. This
  contract carries to the inbox UI (HT-23), whose design renders sanitized HTML in an
  isolated container; a server-side sanitized variant is a candidate hardening. Flagged,
  not solved, here.
- **Notes are Agent-only, permanently.** `direction: 'note'` rows ride the same
  `ThreadView` shape as mail, but they must never leave the Agent surface: any future
  customer-side API, webhook, or export MUST exclude them. Stated here so the boundary
  is on record before any such surface exists.
- **No existence leak.** Not-found and not-authorized are distinct status codes (404 vs
  401) but neither response body distinguishes "never existed" from "deleted" or from "you
  can't see it" — messages are generic. The open-tracking pixel (§4g) extends the same
  rule to its unauthenticated surface: `200` + gif regardless of token validity.
- **The Bearer token is a service credential.** It grants the whole inbox. It is compared
  in constant time and read only from server configuration, never logged.
- **UI session auth (HT-51) is a web-layer door in front of this same token, not a second
  auth model.** Before HT-51, the Agent Inbox web app had no login at all — every request
  it made carried the deployment's `HELPTHREAD_API_TOKEN` and nothing distinguished one
  browser tab from another. HT-51 adds an operator password (`HELPTHREAD_UI_PASSWORD`)
  and a signed session cookie (`web/src/lib/session.ts`, checked by `web/src/middleware.ts`
  on every route) that the browser must hold before the UI will render anything. This
  changes nothing about the API described in this document:
  - The API still authenticates every request by `HELPTHREAD_API_TOKEN` alone (constant-time
    Bearer comparison, above) and has no knowledge of UI sessions, passwords, or cookies —
    `web/src/lib/api.ts` still reads the token from server env and sends it exactly as
    before. Anything holding the token can still call the API directly, session or no
    session; that was already true (the token is a service credential, not tied to a
    browser) and HT-51 doesn't change it.
  - The session cookie carries no identity beyond "an operator signed in" (`{v, iat}`,
    nothing else) — v1 is still single-Agent (§1, §6), so there is nothing for it to be an
    identity FOR yet. It answers "is anyone allowed to look at this browser tab's inbox",
    which is a strictly web-layer question the API was never positioned to answer (a
    server-to-server Bearer token can't gate "is a human currently present").
  - Multi-Agent identity (§6, "No multi-Agent identity, teams, or per-user authorization")
    remains out of scope and unaffected. When it lands, it is expected to REPLACE this
    single shared password with real per-Agent accounts, not extend it — HT-51 is
    deliberately the smallest thing that closes the "anyone with the URL sees the inbox"
    gap for a single operator, not a first draft of multi-user auth.

## 6. What v1 is NOT

- No multi-Agent identity, teams, or per-user authorization (the single-Agent `assignee`
  flag, §4f, is deliberately not identity).
- No customer-side / self-service surface (a separate future API, designed native when
  there are customers to serve).
- No mailbox management, no search, no realtime, no webhooks-out, no tag-filtered listing.
- No attachment upload on reply yet (HT-46 wired the READ side — inbound attachments
  surfaced via `ThreadView.attachments` — but an Agent still cannot attach a file to an
  outbound reply).
- Framework-agnostic by construction: handlers are `Request → Response`; a Vercel/Next
  adapter is a thin deploy-time wrapper, not part of this spec.

## 7. Changelog

- **v1.1 (HT-70).** Wire-contract amendments from specs/plugins/substrate-v1.md §7
  (drafts kept in `threads` rather than a separate table): `ThreadView` gains
  `authorKind` and `draftStatus` (§2); the `deliveryStatus` invariant widens (outbound
  stays `null` while a draft is unapproved or discarded, §2); `preview`/`threadCount`
  ignore an unresolved or discarded draft (§2); conversation detail (§3b) still returns
  every draft row regardless of status; and §3's auth-model statement is amended — a
  second, per-Assistant credential class now authenticates alongside the service Bearer
  token, for the fixed, narrow Assistant capability set specs/plugins/substrate-v1.md §3
  defines.
- **v1.1 (2026-07-17, HT-51).** Documented the Agent Inbox web app's new operator login
  (§3, §5) — a session cookie the UI now requires before rendering any page. No API
  behavior changed: this is a web-layer addition in front of the unchanged
  `HELPTHREAD_API_TOKEN` Bearer auth, recorded here only because §5's prior security notes
  implied the UI itself had no auth story of its own. See §5's HT-51 bullet for the full
  justification.
- **v1.1 (2026-07-17, HT-49 review fix).** `InboxApiDeps.selfEchoGuard` (optional, absent
  by default): when present — and when the sender reports a provider message id for a
  resolvable outbound mailbox — the send path best-effort pre-seeds a successful reply's
  own sent-message echo as suppressed in the inbound delivery ledger, so a transport that
  reflects sent mail back into its own mailbox (Gmail, confirmed live) normally does not
  re-ingest it as a phantom inbound message — a consequence of the `References` change
  below now carrying a verifiable token into that self-echo too. Best-effort, not a
  guarantee: reconcile can win the documented pre-seeding race and ingest that one echo
  first (`inbound-ingestion.md` §5's HT-49 amendment, "Known residual"). See
  `src/mail/send.ts`'s "The reply token's own self-echo" section for the full mechanism.
  No other §4a behavior changed; a deployment that leaves this absent behaves exactly as
  before.
- **v1.1 (2026-07-17, HT-49).** §4a's `References` derivation now appends the reply's own
  freshly-minted `messageId` as the final entry, after the derived ancestor chain — fixing
  live-observed thread splits where a provider (Gmail, confirmed) rewrites the outbound
  wire `Message-ID`, discarding the token from its one prior channel. See
  threading.md §2a and sending.md §4 for the full mechanism; no other §4a behavior changed.
- **v1.1 (2026-07-16, HT-46).** `ThreadView.attachments`: inbound attachment metadata +
  a signed `BlobStore` URL, `[]` by default and config-gated (absent `attachments` deps
  at the composition root, §4's `InboxApiDeps`, same posture as open tracking) — a
  deployment that hasn't wired a `ThreadAttachmentStore` + `BlobStore` never surfaces
  attachments. No attachment upload on reply (§6, unchanged).
- **v1.1 (2026-07-11, HT-25).** Adopted the contract the Agent Inbox UI was designed
  against (the Claude Design prototype's `mock-api.js`, whose additions were each marked
  `CONTRACT ADDITION`), after review of the drift between the designed surface and v1.0.
  Additions, each with its implementation ticket: status model
  `active/pending/closed/spam` with folder-semantics listing and spam-reopen (HT-26);
  `preview` + `number` on summaries (HT-27); internal notes (HT-28); tags (HT-29); soft
  delete endpoint (HT-30); single-Agent assignee (HT-31); config-gated open tracking,
  default off (HT-32). One place the prototype does NOT govern: its mock simplifies §4a's
  replay model (no delivery lease, no `409 retry_in_progress`) — the shipped HT-16
  semantics stand, and the UI must handle the 409.
- **v1.0.** Accepted; HT-17 (reads + conventions), HT-18 (writes), then HT-16 amended
  §4a with required `Idempotency-Key`, lease-based replay, and `409 retry_in_progress`.
