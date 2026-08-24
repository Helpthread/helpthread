# Agent Inbox API v1

Status: accepted; **amended to v1.1 on 2026-07-11** — the contract additions the Agent
Inbox UI was designed against, adopted as the v1 build target (§7). Helpthread's first
public API, designed **native** — on Helpthread's own domain model, not reverse-engineered
from any other helpdesk's wire format.

## 1. Purpose

This is the **Agent side**: the surface an Agent uses to work the inbox — see what has come
in, read a conversation, and act on it. It is the API under the Agent inbox UI (the
charter's "Public APIs and events" rule), and the loop Helpthread is dogfooded through:
mail lands → Agent sees it → Agent replies.

v1 is deliberately single-Agent: no per-Agent identity, no teams. The Bearer token
authenticates *the deployment's one operator*. The v1.1 `assignee` flag (§4f) is shaped to
need no identity — `'me' | null` — so the inbox's "Mine" folder works without inventing
users. Multi-Agent identity is a later increment.

Read paths and conventions are in §3; write paths in §4.

Rollout note: **the status-model change is the one breaking increment** — existing status
values are renamed and the list filter's meaning changes, so backend and UI adopt it
together in a single deploy. Every other addition is additive with a nullable/empty
default, and the UI degrades per-field, so partial deployment of those is safe.

## 2. Domain model (native)

The API speaks Helpthread's own vocabulary — the same the store (`src/store/`) persists,
surfaced as JSON with ISO-8601 timestamps and no translation layer.

```ts
type ConversationStatus = 'active' | 'pending' | 'closed' | 'spam'
                          // v1.1. 'deleted' is never surfaced (§3a)

interface ConversationSummary {
  id: string                 // uuid — the canonical id, used verbatim in every path
  number: number             // v1.1: sequential per-deployment id, display-only (never a path key)
  subject: string
  customerEmail: string
  status: ConversationStatus
  threadCount: number
  assignee: 'me' | null      // v1.1: null = Anyone; single-Agent shaped (§4f)
  tags: string[]           // v1.1: short lowercase labels, [] default (§4e)
  preview: string            // v1.1: latest bodyText excerpt, '' when none (derivation below)
  snoozedUntil: string | null  // v1.1 : ISO-8601, a timed `pending`; always null for
                                // every other status — see §4b's snooze amendment
  createdAt: string          // ISO-8601
  updatedAt: string          // ISO-8601 — last activity; the inbox sort key
}

interface ConversationDetail extends ConversationSummary {
  threads: ThreadView[]    // oldest-first
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
                             // outbound only; null otherwise. An outbound thread's
                             // deliveryStatus is ALSO null while it is an unapproved or
                             // discarded draft (draftStatus below is 'awaiting_review' or
                             // 'discarded'); a draft becomes eligible for
                             // pending/sent/failed only once approved.
  customerViewedAt: string | null
                             // v1.1: outbound only, and only when open tracking is
                             // enabled (§4g) — first time the customer viewed the reply;
                             // null until then, always null for inbound and notes
  attachments: AttachmentView[]
                             // inbound attachments this thread carries. [] when
                             // there are none, OR when the deployment hasn't wired the
                             // attachment read-path deps (config-gated, absent by default
                             // — same posture as open tracking, §4g)
  createdAt: string          // ISO-8601
  authorKind: 'customer' | 'agent' | 'assistant'
                             // (specs/modules/substrate-v1.md §2, §7): who authored
                             // this thread — 'customer' for inbound mail, 'agent' for
                             // human-authored outbound/notes, 'assistant' for an
                             // AI-authored draft (specs/modules/substrate-v1.md §3, §6)
  draftStatus: 'awaiting_review' | 'approved' | 'discarded' | null
                             // A draft's lifecycle state; null for every non-draft
                             // thread (specs/modules/substrate-v1.md §2, §6)
}

interface AttachmentView {
  id: string                 // uuid
  filename: string | null    // null when the attachment arrived with no filename
  contentType: string
  size: number                // bytes
  url: string                 // a time-limited signed URL (never a stable/public path)
}
```

**Status semantics (v1.1).** `active` is the working state — inbound mail creates
conversations `active` (with one exception below), and v1.0's `open` rows migrate to
`active`. `pending` means an Agent parked the conversation awaiting something outside the
inbox; nothing sets it automatically in v1, and it still counts as open work (§3a).
`closed` is resolved. `spam` is junk an Agent threw out — **or, since 2026-08-02, a
brand-new conversation filed as junk at intake because the transport's own classifier
already called it spam** ([spam-classification.md](../mail/spam-classification.md) §4).
Status pills in the UI: Active = accent, Pending = warn, Closed = dim, Spam = critical.

That intake classification is narrow in two ways. It applies **only when the conversation
is created** — never read for a message threading onto an existing conversation, so it can
neither re-file nor rescue one. And it never decides whether a message is *stored*: junk is
filed under a different status, never dropped (inbound-ingestion.md §1). A conversation
filed `spam` at intake is reopened to `active` by a reply like any other. See
spam-classification.md §4.2.

**Snooze exception to "pending is never cleared automatically" (v1.1).** A snooze is a
TIMED `pending` — `pending` plus a `snoozedUntil` timestamp (§4b) — and it is the ONE case
where `pending` clears itself: a periodic wake pass flips a snoozed conversation `pending` →
`active` (clearing `snoozedUntil`) once `now >= snoozedUntil`, with no Agent action.
Inbound mail on a snoozed conversation ALSO wakes it early, the same way inbound mail
reopens a `closed`/`spam` conversation (§4a). **Plain `pending` — no `snoozedUntil` — is
unaffected: it stays `pending` until an Agent changes it.**

**`number`** is assigned from a per-deployment monotone sequence at conversation creation
(existing rows backfilled in creation order by the relevant migration). It exists for humans
— inbox rows, notifications, "re: #482" — and is display-only: every path parameter remains
the uuid, and `number` is never accepted as an identifier anywhere in this API.

**`preview`** is derived at read time, not stored: the most recent thread with a non-null
`bodyText` (any direction — notes included; this is an Agent-only surface), whitespace
collapsed to single spaces, trimmed, first 120 characters; `''` when no thread has text.
**Draft handling:** `preview` and `threadCount` both ignore an unresolved or discarded draft
(`draftStatus IN ('awaiting_review', 'discarded')`) — a draft is not conversation content
until an Agent approves it. An `'approved'` draft (i.e. sent mail) counts and can become the
preview like any other outbound thread. Conversation detail (§3b) still returns the draft
ROW itself in `threads` regardless of status — only the summary-level derivations exclude
it.

Ids are **UUID strings**, verbatim as the store generates them. There is no `customer`
entity in v1 (a conversation carries a `customerEmail` string) and no mailbox. Each is added
when a real need appears, not preemptively.

## 3. Conventions (apply to every endpoint, reads and writes)

- **Base path:** `/api/v1`.
- **Format:** JSON in and out, `Content-Type: application/json`. (One exception: the
  open-tracking pixel, §4g, responds `image/gif` — it is fetched by mail clients, not API
  consumers.)
- **Auth:** `Authorization: Bearer <token>` on every request, compared against the
  configured service token (`HELPTHREAD_API_TOKEN`) with a **constant-time** comparison
  (length-guarded, as `src/mail/reply-token.ts` already does). A missing, malformed, or
  wrong token is `401 unauthorized` with a generic message — the response never reveals
  which. (The open-tracking pixel, §4g, is the one deliberate exception to Bearer auth.)

  **One genuine second credential class exists** (specs/modules/substrate-v1.md §3): a
  per-Assistant token (`ht_asst_<assistantId>_<secret>`), checked ALONGSIDE the service
  Bearer token, never replacing it — verified before routing under the same constant-time
  discipline (parse the embedded id → single-row lookup → constant-time digest compare). An
  Assistant's capability set is fixed and narrow (read conversations, create drafts, create
  notes) and enforced at one gate, distinct from every Agent-facing endpoint here.

  The Agent Inbox web app also requires a sign-in before it renders any page, but that is a
  web-layer door in front of this same Bearer token, not a second API auth model — see §5.
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
  `unauthorized`, 404 `not_found`, 405 `method_not_allowed`, 409 `retry_in_progress` (§4a —
  a concurrent delivery attempt for the same `Idempotency-Key` already holds the lease), 500
  `server_error`, 502 `send_failed` (§4a, the provider rejected an outbound reply).
- **Unknown routes / methods:** an unmatched path is `404 not_found`; a known path with an
  unsupported method is `405` (with an `Allow` header). Both require auth first — an
  unauthenticated request gets `401` before routing details leak.

## 3a. `GET /api/v1/conversations` — the inbox list

Lists conversations **most-recently-active first** (`updatedAt` desc, `id` desc as a stable
tiebreak).

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

**Pagination is keyset, not offset:** the `cursor` opaquely encodes the `(updatedAt, id)` of
the last item returned, and the next page selects rows ordered before it. This stays correct
and cheap as conversations are added or reordered between page fetches (an offset would skip
or duplicate). The cursor is opaque to the client — echoed back, never parsed.

## 3b. `GET /api/v1/conversations/{id}` — one conversation with its threads

Returns a `ConversationDetail` — the conversation plus its `threads`, oldest-first. `404
not_found` if `{id}` is not a conversation, or is a `deleted` one — a deleted conversation
is indistinguishable from a nonexistent one to this API, on purpose.

**Draft handling:** `threads` includes draft rows (`draftStatus` non-null) at every
lifecycle stage — the timeline shows an `awaiting_review`/`discarded` draft alongside real
mail, distinguishable by `authorKind: 'assistant'` and `draftStatus`. An Assistant caller
reads the same endpoint and sees its own drafts through it (no separate read surface). Only
the summary-level `preview`/`threadCount` derivations exclude an unresolved/discarded draft
(§2); the `threads` array is never filtered by draft status.

## 4. Write paths

### 4a. `POST /api/v1/conversations/{id}/replies` — the Agent replies

**Header:** `Idempotency-Key` is **REQUIRED** — a non-empty, caller-chosen string, scoped
per-conversation. The header is **trimmed of leading/trailing whitespace before any other
check**, so `" key "` and `"key"` are the same key and a client or proxy adding incidental
whitespace does not silently get a second send. The **trimmed** value is what is validated,
stored, and passed to `sendReply`: non-empty and **at most 255 characters**. A missing
header, one empty after trimming, or a trimmed value over 255 characters is `400
validation_failed`, checked before the body is parsed.

Body: `{ text: string; html?: string; thenSetStatus?: 'closed' | 'pending' }` — `text`
1–5000 chars, server-enforced; `html` optional; `thenSetStatus` optional (v1.1, "Send &
Close"). The Agent supplies only the message; every mail header is DERIVED server-side, so
the client never sets recipients or threading headers:

- **`to`** = the conversation's `customerEmail`.
- **`from`** = the deployment's configured support address (`supportAddress` dep).
- **`subject`** = the conversation's `subject`, prefixed with `Re:` plus a space if it isn't
  already (case-insensitive — never double-prefix to `Re: Re:`).
- **`In-Reply-To`** = the `messageId` of the conversation's most-recent INBOUND thread, if it
  has one; omitted when no prior message-id exists.
- **`References`** = the `messageId`s of all prior threads in chronological order that have
  one, followed by this reply's OWN freshly-minted `messageId` as the FINAL entry — appended
  by `sendReply` (`src/mail/send.ts`) unconditionally, even when no prior thread has a
  `messageId` (a first reply gets a one-element `References: [messageId]`, never omitted the
  way `In-Reply-To` can be). These exist for the customer's mail client to thread the reply
  in THEIR inbox — Helpthread's own threading never depends on them (it is
  outbound-token-anchored; threading.md §2). The reply's own minted id riding in `References`
  is load-bearing in one specific way (threading.md §2a): some providers (Gmail, confirmed
  live) rewrite the wire `Message-ID` to their own id, so `References` — which such providers
  do NOT rewrite — is the channel that actually gets the signed token back into the
  customer's reply.

The handler then calls `sendReply`, passing the `Idempotency-Key` through. `sendReply` mints
the reply token into the outbound `Message-ID` (on a genuinely new send), persists the
outbound thread with a snapshot of its envelope (`send_envelope`:
`to`/`cc`/`subject`/`references`, sending.md §3a), and sends via the injected `EmailSender`.

**`thenSetStatus` — "Send & Close" (v1.1).** When present, the conversation's status is ALSO
set to it, applied in the SAME database transaction as the reply's persist, immediately
after it and BEFORE the network send — matching this endpoint's persist→send→mark ordering
(the status change is a property of the PERSIST step, not the delivery outcome). It never
touches the reply's mail content, envelope, or threading headers; the wire message is
byte-identical either way. Applies ONLY on a genuinely new send, never on a replay. Fires
`conversation.status_changed` transactionally through the same store path §4b's `PATCH`
uses, with `from` set to the conversation's status FROM BEFORE THIS WHOLE OPERATION. Any
`snoozed_until` is cleared (this endpoint never accepts a `snoozedUntil` of its own — only
§4b's `PATCH` does).

**Not identical to a two-step reply-then-`PATCH`, deliberately.** A reply to a `closed`/`spam`
conversation reopens it silently, with no event of its own. `thenSetStatus`'s `from` is the
status captured BEFORE that reopen, not the transient `active` it passes through — more
correct than a separate `PATCH` call, which could only see the already-reopened `active`
state. Two consequences: replying to a `closed` conversation with `thenSetStatus: 'closed'`
fires **no** `status_changed` at all (net status unchanged); replying to a `closed`
conversation with `thenSetStatus: 'pending'` fires `status_changed` with `from: 'closed'`,
never `from: 'active'`.

**Replay semantics: same key + same conversation = same logical send, never re-diffed
against the body.** If a call reuses a key already recorded against this conversation, the
NEW body is irrelevant — the response reflects the ORIGINAL attempt's outcome:

- Original already succeeded (`delivery_status: 'sent'`) → `201` with that SAME `ThreadView`,
  WITHOUT invoking the sender again.
- Original is `pending`/`failed` → attempt delivery using the ORIGINAL row's stored
  `messageId` and `send_envelope`, never the replay call's own `to`/`subject`/`references`
  even if they differ (sending.md §3a's snapshot rule), after first claiming that row's
  delivery lease.
- Lease unclaimable (a concurrent replay, or the delivery worker) → send nothing, return
  `409 retry_in_progress`.

Outcomes:
- **`201`** with the created (or, on a replay after success, the ORIGINAL) `ThreadView`. A
  reply to a `closed` or `spam` conversation **reopens** it to `active` (v1.1 — the store's
  append policy), only on the call that actually creates the row, not on a replay.
- **`400 validation_failed`** on a missing/empty `Idempotency-Key`, or a body violating the
  limits.
- **`404 not_found`** if the conversation is missing or `deleted` — no message is sent; a
  reply token minted before the append resolves is discarded (mirrors §3b). This applies
  even to a KEYED REPLAY of a key whose original attempt succeeded: if the conversation has
  since been deleted, the replay returns `404`, not the original `201`. There is no
  mail-safety impact — the original send already happened.
- **`409 retry_in_progress`** — the delivery lease for this `Idempotency-Key` is held by
  another in-flight attempt; nothing was sent. The caller should retry the SAME key later,
  not mint a new one (a new key would create an independent send).
- **`502 send_failed`** if the provider rejects the message — nothing delivered. `sendReply`
  returns a `send-failed` result (it does not throw): the outbound thread is left
  `delivery_status = 'failed'` (retryable by a same-key replay or the delivery worker's
  sweep, with the same Message-ID) — or, if even that mark fails, stuck `pending`. The
  response says only that the reply *could not be delivered* — never a specific persisted
  state, never a raw provider error. Note the asymmetry: once the provider ACCEPTS the
  message it is delivered, so a subsequent failure to record `'sent'` resolves to `201`, not
  `send_failed` — reporting a delivered message as failed would invite a resend.

### 4b. `PATCH /api/v1/conversations/{id}` — set status (+ snooze, v1.1)

Body: `{ status: ConversationStatus; snoozedUntil?: string }` — `status` any of `active`,
`pending`, `closed`, `spam`; `snoozedUntil` an optional ISO-8601 timestamp. Returns the
updated `ConversationSummary` (`200`) and bumps `updatedAt` (a status change is activity —
the conversation resurfaces in its folder). The store's `setConversationStatus(id, status,
options)` **excludes `deleted`**: missing or deleted → `404 not_found`; a `status` outside
the four values (notably `deleted`) → `400 validation_failed`.

**Snooze (`snoozedUntil`).** Legal ONLY alongside `status: 'pending'` — present with any
other status is `400 validation_failed` (a snooze IS a timed `pending`, not an independent
concept). Must parse as a valid timestamp, or `400 validation_failed`. Sending `{status:
'pending'}` WITHOUT `snoozedUntil` is plain pending and CLEARS any existing snooze —
un-snoozing by re-PATCHing plain `pending` is an expected use of this body shape.
`snoozedUntil` is `null` in the response for every status other than a timed `pending`.

A snoozed conversation wakes two ways, both ending in `status: 'active'` and `snoozedUntil:
null` — but they are NOT event-identical, deliberately: each reports through the SAME event
a structurally-equivalent non-timed transition already uses.

- **Timer wake.** A periodic engine-internal pass flips it once `now >= snoozedUntil`, no
  Agent action, via `setConversationStatus` — the same write path (and event) an Agent's own
  `PATCH` to `active` uses. Fires `conversation.status_changed` (`from: 'pending', to:
  'active'`).
- **Inbound wake.** Inbound customer mail wakes it immediately — the same "the customer came
  back" reasoning §4a's closed/spam reopen uses, and reported the same way: through
  `conversation.message_received`'s existing `reopened: true` field, NOT
  `conversation.status_changed`. An inbound reopen has never fired `status_changed`, and a
  snoozed conversation's inbound wake is the same kind of reopen. Scoped to genuinely inbound
  mail only: an Agent's own outbound reply or internal note never wakes it early.

### 4c. `POST /api/v1/conversations/{id}/notes` — internal note (v1.1)

An internal note is Agent-only context on a conversation. **It is never emailed and never
touches the send path**: no reply token is minted, no outbox row created, and the delivery
worker never sees it — a `note` row anywhere near `sendReply` is a bug, asserted by a test
under the charter's "Conversation integrity" rule.

Body: `{ text: string }` — 1–5000 chars, server-enforced; no `html` (notes are plain text in
v1). Outcomes:

- **`201`** with the created `ThreadView`: `direction: 'note'`, `from` = the support address,
  `bodyHtml: null`, `deliveryStatus: null`, `customerViewedAt: null`. Bumps `updatedAt` (a
  note is activity) but **never changes `status`** — noting a closed conversation does not
  reopen it.
- **`400 validation_failed`** on a body violating the limits.
- **`404 not_found`** if the conversation is missing or `deleted`.

### 4d. `DELETE /api/v1/conversations/{id}` — soft delete (v1.1)

Marks the conversation `deleted`. **`204`** with an empty body on success; `404 not_found` if
missing or already deleted. From that point it is indistinguishable from one that never
existed on every endpoint — list, get, replies (including keyed replays, §4a), notes, tags,
assignee, PATCH. Not restorable through this API, and a reply token minted against it starts
a fresh conversation (threading.md's deleted-conversation rule). The UI pairs this with a
two-step arm (press → solid critical "Confirm" → auto-disarm) rather than a modal.

### 4e. `PUT /api/v1/conversations/{id}/tags` — replace the tag set (v1.1)

Body: `{ tags: string[] }` — **replace-set semantics**: the request's array becomes the whole
tag set (send `[]` to clear). Each entry is trimmed, lowercased, then the array is
de-duplicated preserving first-occurrence order. After trimming, each tag must be 1–40
characters; a non-array body, non-string entry, empty-after-trim entry, or over-length entry
is `400 validation_failed`. Returns the updated `ConversationSummary` (`200`). Does **not**
bump `updatedAt` — tagging is metadata, not activity. Missing or deleted → `404 not_found`.
There is no tag-filtered listing in v1.

### 4f. `PUT /api/v1/conversations/{id}/assignee` — claim or release (v1.1)

Body: `{ assignee: 'me' | null }` — `null` means "Anyone". Anything else is `400
validation_failed`. Returns the updated `ConversationSummary` (`200`). Does **not** bump
`updatedAt`. Missing or deleted → `404 not_found`.

This is deliberately NOT identity: `'me'` is the deployment's one operator (the Bearer token
holder), stored as a flag, not a user id. It exists so the UI's "Mine" folder works in v1;
the multi-Agent increment replaces `'me'` with real Agent ids and this body shape is expected
to change then — an acceptable v2 break while dogfood-only.

### 4g. Open tracking — `customerViewedAt` (v1.1; config-gated, default OFF)

Open tracking records the first time a customer's mail client fetched a tracking pixel
embedded in an outbound reply, surfacing it as `customerViewedAt` on that outbound
`ThreadView`.

**It is off by default as a deliberate stance, not an oversight.** Open-tracking pixels are
telemetry on customers, which sits uneasily with the ownership-and-trust positioning this
project exists for. The operator must explicitly enable it in deployment configuration (an
`InboxApiDeps`-level flag plus the deployment's public base URL). While disabled — the
shipped default — no pixel is injected, the field is always `null`, and outbound mail is
**byte-identical** to pre-v1.1 behavior: text bodies, headers, and threading must be proven
unchanged against the existing fixtures (charter's "Conversation integrity" rule), and
enabling it must alter only the HTML body.

When enabled:

- The send path (§4a) injects a pixel URL into the outbound **HTML body only** — a text-only
  reply gets no pixel; never fabricate an HTML part just to track. The URL carries an
  **unguessable, signed credential bound to the outbound thread** — the same keyring/HMAC
  pattern reply tokens use (`src/mail/reply-token.ts`), NEVER the bare thread uuid: a
  guessable identifier would let anyone who learns or enumerates an id forge a "customer
  viewed" signal.
- The pixel endpoint is the API's one **unauthenticated** surface, fetched by customer mail
  clients. Its contract: always respond `200` with `Content-Type: image/gif`, a fixed 1×1 gif
  body, and `Cache-Control: no-store` (a cached pixel would suppress the very fetch it exists
  to observe) — valid token or not, identical either way (no existence or validity leak);
  record only the FIRST view's timestamp for a valid token (idempotent); set no cookies and
  record nothing beyond that timestamp.
- `customerViewedAt` remains `null` until a view is recorded; always `null` for inbound
  threads and notes.

Both §4a write paths grow `InboxApiDeps` with what `sendReply` needs — `sender`
(`EmailSender`), `keyring`, `mailDomain`, and `supportAddress` — injected at deploy time
alongside `store` and `apiToken`, plus the open-tracking configuration above.

### 4h. Saved replies & macros (v1.1)

A saved reply is a per-mailbox, reusable message definition an Agent can post as a reply
body; a "macro" is the same row carrying `actions` — state changes the CLIENT also applies
once the reply is sent. **The engine stores DEFINITIONS ONLY.** Applying a macro's `actions`
— posting the body via §4a, then calling §4b/§4e/§4f as needed — is entirely a client-side
composition of endpoints this API already exposes. Zero new mail or status semantics.

```ts
interface SavedReply {
  id: string                 // uuid
  mailboxId: string           // uuid — every saved reply belongs to exactly one mailbox
  name: string                // 1-200 chars
  bodyText: string             // 1-5000 chars
  bodyHtml: string | null
  actions: {                   // {} default — a plain saved reply has no macro side effects
    setStatus?: 'closed' | 'pending'
    addTags?: string[]       // each 1-40 chars, trimmed + lowercased, deduplicated
    assignToSelf?: boolean
  }
  sortOrder: number            // 0 default — display order within the mailbox's list
  createdAt: string            // ISO-8601
  updatedAt: string            // ISO-8601
}
```

**`GET /api/v1/mailboxes/{id}/saved-replies`** — any ACTIVE acting Agent (the reply
composer's picker needs the list for every Agent, not just admins). Returns `{ savedReplies:
SavedReply[] }`, ordered by `sortOrder` then creation order. Unknown `{id}` → `404
not_found`.

**`POST /api/v1/mailboxes/{id}/saved-replies`** — admin only, v1. Body: `{ name: string;
bodyText: string; bodyHtml?: string; actions?: {...}; sortOrder?: number }` —
`name`/`bodyText` required (limits above); the rest optional. `201` with the created
`SavedReply`. Unknown mailbox → `404 not_found`; a body violating the limits, or an `actions`
object with an unrecognized key or invalid `setStatus`, → `400 validation_failed`.

**`PATCH /api/v1/mailboxes/{id}/saved-replies/{replyId}`** — admin only, v1. Body: any subset
of `{ name, bodyText, bodyHtml, actions, sortOrder }`; only present fields change. `200` with
the updated `SavedReply`. `{replyId}` not found, or found but under a DIFFERENT mailbox than
`{id}`, → `404 not_found` — never a cross-mailbox edit.

**`DELETE /api/v1/mailboxes/{id}/saved-replies/{replyId}`** — admin only, v1. Hard delete (a
saved reply carries no customer data). `204` on success; `404 not_found` for an unknown or
cross-mailbox `{replyId}`.

Writes are admin-only in v1; a future increment may relax authoring to any Agent. `GET` is
open to every Agent so the picker works regardless of who authored the library.

## 5. Security notes

- **`bodyHtml` is untrusted and unsanitized.** The parser stores inbound HTML verbatim,
  `<script>` and all (threading.md §5; a fixture confirmed a stored `<script>`). This API
  returns it as-is — safe as JSON, but **any UI that renders it MUST sanitize first** (e.g.
  DOMPurify), or it is a stored-XSS vector against the Agent. The inbox UI renders sanitized
  HTML in an isolated container; a server-side sanitized variant is a candidate hardening.
  Flagged, not solved, here.
- **No customer API response contains a note. That is the guarantee the code makes — and
  it is narrower than "notes stay internal".** `direction: 'note'` rows ride the same
  `ThreadView` shape as mail. Any customer-side API, webhook, or export MUST exclude them.
  Two independent controls enforce that today: the store's `direction <> 'note'` visibility
  predicate, which the customer read path applies to detail rows, `threadCount`, `preview`
  and the derived `updatedAt`; and the delivery path, where a note never enters `sendReply`
  and the outbox selects only `direction = 'outbound'` (§4c).

  **Reads on THIS endpoint are unfiltered**, and both credential classes that reach it — the
  service token and an Assistant token — receive notes from the list and detail paths.
  `preview` (§2) can carry a note's text whenever a note is the newest thread with a body.

  What the API cannot do is distinguish *who is calling*: the route decides the filter, the
  caller does not. An integrator whose product has a customer-facing surface may therefore
  read notes here, and is responsible for keeping them away from customers. **That
  responsibility is contractual, not enforced.** Scoping integration credentials so it can
  be enforced is issue #215.
- **No existence leak.** Not-found and not-authorized are distinct status codes (404 vs 401),
  but neither body distinguishes "never existed" from "deleted" or from "you can't see it".
  The open-tracking pixel (§4g) extends the same rule to its unauthenticated surface: `200` +
  gif regardless of token validity.
- **The Bearer token is a service credential.** It grants the whole inbox. Compared in
  constant time, read only from server configuration, never logged.
- **Web-app login is a web-layer door in front of this same token, not a second auth model.**
  The API authenticates every request by `HELPTHREAD_API_TOKEN` alone and has no knowledge of
  UI sessions or cookies; anything holding the token can call the API directly, session or
  no. **The current session and identity contract lives in `specs/auth/agents-and-auth.md` §8
  — read it rather than this bullet**, which predates real per-Agent identity.

## 6. What v1 is NOT

- No multi-Agent identity, teams, or per-user authorization (the single-Agent `assignee`
  flag, §4f, is deliberately not identity).
- No customer-side / self-service surface **on this API**. The customer-facing surface is a
  separate API with its own spec (`specs/api/customer-conversations-v1.md`) and its own note
  exclusion (§5).
- No mailbox management, no search, no realtime, no webhooks-out, no tag-filtered listing.
- No attachment upload on reply — the READ side is wired (`ThreadView.attachments`), but an
  Agent still cannot attach a file to an outbound reply.
- Framework-agnostic by construction: handlers are `Request → Response`; a Vercel/Next
  adapter is a thin deploy-time wrapper, not part of this spec.

## 7. Changelog

- **v1.1 (2026-07-19) — "inbox basics".** Three additive features:
  - **Saved replies & macros (§4h).** New `/api/v1/mailboxes/{id}/saved-replies` (+
    `/{replyId}`) surface. Engine stores definitions only; applying a macro's `actions` is a
    client-side composition of §4a/§4b/§4e/§4f.
  - **Snooze (§2, §4b).** `ConversationSummary` gains `snoozedUntil`; `PATCH` gains the
    optional `snoozedUntil`, legal only alongside `status: 'pending'`. A snooze wakes on a
    timer OR on inbound customer mail — both end in `active`/`null`, but report through
    DIFFERENT events: the timer wake fires `conversation.status_changed`; the inbound wake
    reports through `conversation.message_received`'s `reopened: true`, like every other
    inbound reopen.
  - **Send & close (§4a).** `POST .../replies` gains the optional `thenSetStatus: 'closed' |
    'pending'`, applied transactionally alongside the reply's persist, never touching mail
    content, envelope, or threading.
- **v1.1.** Wire-contract amendments from specs/modules/substrate-v1.md §7 (drafts kept in
  `threads` rather than a separate table): `ThreadView` gains `authorKind` and `draftStatus`
  (§2); the `deliveryStatus` invariant widens (outbound stays `null` while a draft is
  unapproved or discarded, §2); `preview`/`threadCount` ignore an unresolved or discarded
  draft (§2); conversation detail (§3b) still returns every draft row; and §3's auth-model
  statement is amended — a per-Assistant credential class now authenticates alongside the
  service Bearer token.
- **v1.1 (2026-07-17).** Documented the Agent Inbox web app's operator login (§3, §5). No API
  behavior changed.
- **v1.1 (2026-07-17).** `InboxApiDeps.selfEchoGuard` (optional, absent by default): when
  present — and when the sender reports a provider message id for a resolvable outbound
  mailbox — the send path best-effort pre-seeds a successful reply's own sent-message echo as
  suppressed in the inbound delivery ledger, so a transport that reflects sent mail back into
  its own mailbox (Gmail, confirmed live) normally does not re-ingest it as a phantom inbound
  message. Best-effort, not a guarantee: reconcile can win the documented pre-seeding race
  and ingest that one echo first (inbound-ingestion.md §5, "Known residual"). See
  `src/mail/send.ts`'s "The reply token's own self-echo" section. A deployment leaving this
  absent behaves exactly as before.
- **v1.1 (2026-07-17).** §4a's `References` derivation now appends the reply's own
  freshly-minted `messageId` as the final entry, after the derived ancestor chain — fixing
  live-observed thread splits where a provider (Gmail, confirmed) rewrites the outbound wire
  `Message-ID`, discarding the token from its one prior channel. See threading.md §2a and
  sending.md §4.
- **v1.1 (2026-07-16).** `ThreadView.attachments`: inbound attachment metadata + a signed
  `BlobStore` URL, `[]` by default and config-gated (absent `attachments` deps at the
  composition root, same posture as open tracking) — a deployment that hasn't wired a
  `ThreadAttachmentStore` + `BlobStore` never surfaces attachments. No attachment upload on
  reply (§6, unchanged).
- **v1.1 (2026-07-11).** Adopted the contract the Agent Inbox UI was designed against (the
  Claude Design prototype's `mock-api.js`, whose additions were each marked `CONTRACT
  ADDITION`). Additions: status model `active/pending/closed/spam` with folder-semantics
  listing and spam-reopen; `preview` + `number` on summaries; internal notes; tags; soft
  delete; single-Agent assignee; config-gated open tracking, default off. One place the
  prototype does NOT govern: its mock simplifies §4a's replay model (no delivery lease, no
  `409 retry_in_progress`) — the shipped semantics stand, and the UI must handle the 409.
- **v1.0.** Accepted: reads + conventions, then writes, then §4a amended with required
  `Idempotency-Key`, lease-based replay, and `409 retry_in_progress`.
