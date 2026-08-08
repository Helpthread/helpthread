# Customer conversations API v1

Status: implemented (HT-126) — §6a create, §6b list, §6c get, §6d reply. §6a's
`Idempotency-Key` handling is specified and not yet built; a create without one behaves as
described.

## 1. Purpose

The surface an integrating product calls to create, read, and reply to conversations **on
behalf of one identified customer** — the counterpart to
[agent-inbox-v1.md](agent-inbox-v1.md), which serves the operator.

It exists because a product that already knows who its user is needs to offer support
inside its own interface: a help form that opens a conversation, a list of that user's past
requests, a thread view, a reply box. Email alone cannot back those surfaces — there is
nothing to read back from.

This is a **server-to-server** API. The calling server authenticates as itself and asserts
which customer it is acting for. It is never called from a browser (§5).

**There is no customer entity.** A conversation carries a `customerEmail` string
([agent-inbox-v1 §2](agent-inbox-v1.md)); this API scopes by that string and introduces no
new persisted identity. "The customer" means "conversations whose `customerEmail` matches
the asserted address under §3b."

`customerEmail` is **immutable for the life of the conversation**. It is set at creation
and no path in this API changes it. Ownership therefore cannot silently transfer, and it is
not affected by who authors later threads (§4c). A person who changes address gets new
conversations under the new address; merging histories is out of scope.

## 2. Domain model

Native to Helpthread, and a **subset** of [agent-inbox-v1 §2](agent-inbox-v1.md) — same
vocabulary, same field names, fewer fields. Anything operator-only (§4) is absent from the
type, not nulled.

```ts
interface CustomerConversationSummary {
  id: string                 // uuid — canonical, used verbatim in every path
  number: number             // display-only; never a path key
  subject: string
  status: 'active' | 'pending' | 'closed'   // 'spam'/'deleted' never surface (§3c)
  threadCount: number        // visible threads only (§4a)
  preview: string            // newest visible thread's bodyText excerpt, '' when none
  previewAuthorKind: 'customer' | 'agent' | 'assistant' | null
                             // who wrote the previewed thread; null when none. Lets a list
                             // row label its excerpt without fetching threads per row.
  createdAt: string          // ISO-8601
  updatedAt: string          // ISO-8601 — derived, see §4b
}

interface CustomerConversationDetail extends CustomerConversationSummary {
  threads: CustomerThreadView[]    // visible threads only, oldest-first by (createdAt, id)
}

interface CustomerThreadView {
  id: string                 // uuid
  direction: 'inbound' | 'outbound'   // never 'note' (§4a)
  from: string               // always the conversation's customerEmail or the support
                             // address — never a third party's, see §4c
  bodyText: string | null
  bodyHtml: string | null    // ⚠ UNTRUSTED, UNSANITIZED — see §5
  createdAt: string          // ISO-8601
  authorKind: 'customer' | 'agent' | 'assistant'   // as persisted — see §4d
}
```

Deliberately absent, each operator-only: `assignee`, `tags`, `snoozedUntil`,
`deliveryStatus`, `customerViewedAt`, `draftStatus`, `authorAgentId`, `authorAssistantId`.

**`attachments` is not on the read surface in v1.** A customer can attach files when opening
a conversation (§6a) but cannot see them listed back. Serving them means minting signed URLs,
and a URL is bearer-equivalent — it has to be provably unmintable for an excluded thread
(§4a), which is a stricter obligation than filtering an array. Deferred rather than shipped
half-right; §7 records it.

## 3. Conventions

Identical to [agent-inbox-v1 §3](agent-inbox-v1.md) — `/api/v1` base, JSON in and out,
`Cache-Control: no-store` on every response, the `ApiError` envelope, 404 on unmatched
paths, 405 (with `Allow`) on wrong methods. Four additions specific to this surface.

### 3a. Base path and credential order

Base path is `/api/v1/customer`, a distinct prefix so §4's exclusions attach to a routing
boundary rather than to the discipline of each handler.

Two credentials, **checked in this order, always**:

1. `Authorization: Bearer <token>` — the deployment service token (`HELPTHREAD_API_TOKEN`),
   constant-time compared. Missing, malformed, or wrong is `401 unauthorized`.
2. `X-Helpthread-Customer-Email` — which customer the caller acts for. Missing, empty, or
   failing §3b is `400 validation_failed`.

The order is normative: a bad token with a missing header is `401`, never `400`. A `400`
therefore confirms the token was valid; that discloses nothing to an unauthenticated party.

**Duplicate or folded headers are rejected**, each under its own credential's rule. More
than one `X-Helpthread-Customer-Email`, or a comma-folded value in it, is
`400 validation_failed`: HTTP runtimes combine repeats inconsistently, and the same wire
request must never select different customers on different stacks. A duplicated or folded
`Authorization` is simply not a valid token and is `401` like any other — reporting `400`
there would confirm to an unauthenticated caller that its header parsed. A deployment whose
`HELPTHREAD_API_TOKEN` is unset or empty rejects every request `401`; it never treats an
empty configured token as matching an empty supplied one.

### 3b. Email normalization and the existing-rows contract

The comparison key is: trim surrounding whitespace → Unicode NFC → lowercase the whole
address, local part included. Whole-address lowercasing treats local parts as
case-insensitive. That is a deliberate simplification — RFC 5321 permits case-sensitive
local parts, effectively no operator implements them, and matching case-sensitively would
strand customers whose client varied capitalization between messages.

**Accepted grammar in v1 is deliberately narrow:** exactly one `@`; a non-empty local part
of printable ASCII excluding whitespace, control characters, `"`, `(`, `)`, `[`, `]`, `,`,
`:`, `;`, `<`, `>`, `\`, and consecutive or leading/trailing dots; a non-empty all-ASCII
domain of dot-separated LDH labels; total length ≤ 254. Anything outside it — quoted local
parts, comments, domain literals, non-ASCII in either part — is `400 validation_failed`.
Rejected rather than guessed at; widening is additive and needs its own fixtures.

**Existing rows are not normalized in place.** The store persists `customerEmail` verbatim
(`createConversationInTx`, `src/store/conversations.ts`), and mail ingestion has no
equivalent normalization step, so conversations already exist whose stored address differs
from its comparison key by case or Unicode form. This API therefore matches on a
**normalized expression of the stored column**, not on raw equality, and that expression
must be backed by an index — an unindexed functional comparison over the conversation table
is not an acceptable implementation. Normalizing the column itself, and normalizing at
every ingestion path, is the better end state and is tracked separately; it is not a
prerequisite for this API and this API must not assume it has happened.

### 3c. Status visibility

`spam` and `deleted` conversations do not exist on this surface: `404 not_found` by id,
absent from every list. A customer is never told their message was filed as junk.

**This diverges from what the store does, deliberately, and the divergence is load-bearing.**
`appendThread` reopens a conversation to `active` when its pre-append status is `closed`
**or `spam`** (`src/store/conversations.ts`), and
[spam-classification.md](../mail/spam-classification.md) makes an emailed customer reply
reopen spam on purpose. A reply through this API must therefore **not** route through that
path unguarded: it is refused at `404` before any append, or the refusal leaks by
side-effect. The cost is that an integrator receiving `404` on a reply must preserve the
user's typed text and surface a generic failure (§6d). Mail's reopen behavior is unchanged;
it is simply not exposed here.

### 3d. Pagination

Keyset, as [agent-inbox-v1 §3a](agent-inbox-v1.md), over `(updatedAt, id)` where
`updatedAt` is §4b's derived value. Two requirements that section leaves open:

- The cursor **binds the normalized customer email and the `status` filter** alongside the
  sort tuple. A cursor that is malformed, or whose bound customer or filter does not match
  the current request, is `400 validation_failed`.
- **Traversal is weakly consistent.** The sort key changes when a conversation gains a
  visible thread, so a conversation active mid-traversal may be seen twice or skipped. This
  is accepted, not solved: snapshot pagination would need a watermark this surface does not
  carry. Clients that must not double-render deduplicate by `id`.

## 4. Visibility

### 4a. The thread predicate

A thread is customer-visible **iff all three hold**:

1. `direction` is `inbound` or `outbound` — never `note`.
2. `draftStatus` is `null` or `approved` — never `awaiting_review` or `discarded`.
3. `direction` is `inbound`, **or** `deliveryStatus` is `sent`.

Enforced at the query layer, not by response shaping, and test-enforced (§8). A row whose
persisted state satisfies no valid combination — an inbound row carrying a non-null
`deliveryStatus`, which the schema's direction↔status CHECK forbids but imported or
repaired data could still present — is **hidden**, not surfaced and not an error. The
predicate is a whitelist over data this API does not exclusively write.

Condition 1 is pre-existing: [agent-inbox-v1 §5](agent-inbox-v1.md) put it on record before
this surface existed — *"any future customer-side API, webhook, or export MUST exclude
them."*

Conditions 2 and 3 are stated here for the first time, and 3 is the one that is easy to get
wrong. `agent-inbox-v1 §3b` deliberately includes draft rows for Agent and service callers;
correct there, a disclosure of unsent internal drafting here. Excluding drafts alone is not
sufficient: the store persists an outbound row **before** the network send, and approval
writes `draftStatus = 'approved'` before delivery completes. An approved row with
`deliveryStatus` of `pending` or `failed` is text the organization composed and never
successfully sent.

**`sent` means Helpthread's send path completed, not that the message reached a mailbox.**
The store has no delivered state — only `pending`, `sent`, `failed`. Condition 3 withholds
text the organization is not yet committed to having sent; it does not and cannot assert
receipt.

`threadCount` and `preview` derive from visible threads only.

### 4b. `updatedAt` is derived, not passed through

The conversation's stored `updatedAt` bumps on operator-only activity — an internal note
bumps it ([agent-inbox-v1 §4c](agent-inbox-v1.md)). Surfacing it would reorder the
customer's list and disclose that unseen internal activity occurred, defeating §4a through
a side channel.

`updatedAt` here is **the `createdAt` of the newest visible thread by `(createdAt, id)`
descending**, falling back to the conversation's `createdAt` when none is visible. The same
`(createdAt, id)` ordering picks the thread supplying `preview`, so two threads sharing a
timestamp can never yield one implementation's `updatedAt` beside another's `preview`.

Because it is also the list sort key (§3d, §6b), ordering carries no hidden signal.

**This is a query contract, not a formatting note.** A conforming implementation derives
`updatedAt`, `preview`, and `threadCount` from the visible-thread relation in the same
statement that filters and orders the list — a per-row follow-up query is not conforming.
Deriving it requires either a maintained denormalized column updated whenever thread
visibility changes, or an index supporting the filtered aggregate; which one is an
implementation choice, having neither is not.

### 4c. Third-party inbound threads are hidden

A conversation's threads are not all guaranteed to come from its `customerEmail`. Threading
authority is the signed token ([threading.md](../mail/threading.md) §3.5) — *"The signed
token is the sole threading authority"* — so a forwarded token, a shared mailbox, or a
changed address can append an inbound thread whose `fromAddress` is someone else's.

**An inbound thread whose `fromAddress` does not match the conversation's `customerEmail`
under §3b is not visible on this surface.** It is a fourth exclusion, enforced with the
others at the query layer.

Token possession decides *where mail is stored*. It does not establish that the sender
consented to disclose their message to the address in `customerEmail`, and this API will
not infer one from the other. The charter's conversation-fidelity commitment requires that
Helpthread preserve participants and provenance; it does not require showing every stored
message to every participant.

The cost is real and accepted: a customer can see an operator reply that answers a message
they cannot see. That is the safer failure. Widening this — showing third-party threads,
or showing them with the address redacted — is additive and reversible; having disclosed
them is not.

Outbound threads are unaffected: they come from the support address by construction.

### 4d. AI-authored replies are attributed as authored

`CHARTER.md` ("Actor model") requires that *"Human staff, external participants, automated
systems, and AI assistants are never silently conflated."* An approved assistant-authored
draft is delivered as an ordinary outbound reply, and this surface reports its author as
persisted: `authorKind` carries `'assistant'`, not `'agent'`.

Two alternatives were weighed and rejected. Reporting an assistant as `'agent'` tells the
customer a human wrote what an AI wrote — the conflation the charter names. Coarsening
every organization-side author to a single `'organization'` value avoids naming the AI but
maps human staff and automated systems onto one token, which is the same conflation at a
coarser grain.

What this does **not** expose is *which* actor: `authorAgentId` and `authorAssistantId` stay
absent (§2). The customer learns the kind of author, never the individual.

An operator who needs a different disclosure posture needs a policy layer over this field —
additive, and out of scope here.

*(Provenance: INFERRED. No maintainer decision on record; this reading follows from the
charter's actor model rather than from an instruction.)*

## 5. Trust model

**The integrator asserts customer identity, and Helpthread trusts that assertion.** The
service token grants the ability to act for *any* customer; the header chooses which. Two
consequences the integrator owns:

- **The token must never reach a browser.** A client holding it could pass any address and
  read any customer's conversations. This API is callable only from a server that
  authenticated the user by its own means and derived the address from that session, never
  from user input.
- **Helpthread cannot distinguish a buggy integrator from a hostile one.** A wrong value in
  `X-Helpthread-Customer-Email` returns that address's conversations, correctly and
  silently. There is no cryptographic binding between the header and the integrator's
  authenticated user. Read that plainly: **this model protects customers from each other
  only to the extent the integrator's own session handling is correct.**

**Why not per-customer tokens.** A credential scoped to one customer (as
`specs/plugins/substrate-v1.md` §3 does per Assistant) is the right answer when a customer
authenticates to Helpthread directly. No such surface exists: the integrator has already
authenticated the user, and minting a second credential per customer adds issuance,
rotation, and revocation paths without changing the guarantee above. When a browser-facing
customer surface ships it needs that credential class, and it is additive to this spec.

**Mailbox scope.** `customerEmail` matching is deployment-global, so one address's
conversations across several mailboxes list together. Constraining reads to a mailbox is
deferred: v1 deployments serve one product. An integration serving several products from
one deployment must not use this API until that scope exists.

**No existence leak.** A conversation that exists but belongs to another customer returns
what an unknown id returns: `404 not_found`, generic message, same headers. The contract is
**response-content indistinguishability** — status, error code, body. Authorization is a
single query predicated on both id and normalized customer email, so no handler branch
distinguishes the two cases.

Two honest limits. This spec makes **no timing claim**; equalizing response time against
index-hit and cache differences is not achievable by handler discipline. And headers
injected below the handler — tracing ids, cache annotations, middleware — are outside its
control; the requirement binds what the handler produces.

**`bodyHtml` is untrusted and unsanitized**, carried verbatim from inbound mail exactly as
[agent-inbox-v1 §5](agent-inbox-v1.md) describes. Any UI rendering it MUST sanitize first.
The hazard is worse here: the reader is a customer inside the integrator's own application,
so an unsanitized render is stored XSS against that product. Sanitization must also address
remote resource loads and tracking pixels, which a script-only filter leaves intact.

## 6. Endpoints

### 6a. `POST /api/v1/customer/conversations` — open a conversation

Creates a conversation and its first inbound thread, attributed to the header's customer.

```ts
interface CreateRequest {
  subject: string                  // 1–500 chars after trim
  bodyText: string                 // 1–100_000 chars after trim
  mailboxId: string                // uuid; must exist and be active, else 400
  attachments?: AttachmentUpload[] // max 10; max 25 MB total AFTER base64 decode
}

interface AttachmentUpload {
  filename: string                 // 1–255 chars
  contentType: string              // 1–255 chars
  data: string                     // base64; invalid encoding is 400
}
```

Responds `201` with a create receipt — `{ id, number, subject, status, createdAt }` — not a
full `CustomerConversationDetail`. A freshly created conversation has exactly the one
thread the caller just supplied, so returning a thread array would restate the request,
and `CustomerThreadView` carries `authorKind`, still an open decision (§4d). The full
representation arrives with §6c. The conversation is created `active` and unassigned.

Intake spam classification ([spam-classification.md](../mail/spam-classification.md) §4)
does **not** apply — that classifier reads transport headers, and there is no inbound
message here.

**Attachments are all-or-nothing.** Every supplied attachment is durably stored before the
conversation is visible, or the request fails `502` and no conversation exists. The charter
commits to never losing a message; returning `201` for a request whose attachments silently
vanished would break that, and the caller cannot tell what to retry. This is stricter than
[inbound-ingestion.md](../mail/inbound-ingestion.md)'s orphan posture, correctly: that
governs mail already accepted from a provider and never re-sendable, where partial storage
beats rejection. Here the caller is still holding the bytes.

**Threading boundary — read before relying on email interop.** A conversation created here
has no outbound message, so no Helpthread-signed token exists for a mail client to quote.
Under [threading.md](../mail/threading.md) §3.4 — *"If no valid token is found in any
header, this is a NEW conversation — regardless of subject"* — a customer email carrying no
valid token **opens a second, separate conversation**. Nothing merges them; subject is
never used to thread. (Threading turns on token presence alone, not on whether this
conversation has been replied to: an email carrying a token forwarded from some *other*
conversation appends *there*, which is that contract's behavior, not this one's.)

In practice email interop begins at the first operator reply, which is what puts a token in
the customer's hands. Until then the integrator's own UI (§6d) is the only reply path that
appends. This is a real seam, stated rather than papered over; closing it means minting a
token at API-create time and is deferred to its own decision.

**Idempotency.** `Idempotency-Key` is optional here and does **not** inherit
[agent-inbox-v1 §4a](agent-inbox-v1.md)'s semantics, which are scoped to a conversation and
to a send this endpoint does not perform. Where supplied: max 255 chars after trim, scoped
to `(normalized customer email, mailboxId)`, retained 24 hours.

- The key and the conversation id are recorded **in the transaction that creates the
  conversation**. A process that dies before committing leaves the key unused; one that
  dies after has already associated it. There is no window in which a key is reserved
  against a conversation that does not exist.
- A replay within the window re-reads and returns `200` with the current
  `CustomerConversationDetail` — a live read, not a stored response snapshot, so later
  replies and freshly minted attachment URLs are included. Differences in the replayed body
  are ignored.
- A replay while the original is still in flight is `409 retry_in_progress`.
- A replay whose conversation has since become `spam`, `deleted`, or otherwise invisible
  under §3c/§4 is `404 not_found`. The key stays consumed — retrying must not mint a
  duplicate — and §3c's non-disclosure holds.
- A request that fails validation consumes no key.

### 6b. `GET /api/v1/customer/conversations` — the customer's own list

Their conversations, newest visible activity first — `updatedAt` (§4b) desc, `id` desc as a
stable tiebreak. A conversation with no visible thread still lists, ordered by its
`createdAt`.

| query param | type | default | notes |
|---|---|---|---|
| `status` | `open` \| `closed` | `open` | `open` returns `active` + `pending`, matching the agent API's folder semantics |
| `limit` | number | 25 | hard cap 50; clamped, not rejected |
| `cursor` | string | — | opaque keyset cursor from `nextCursor`; bound per §3d |

```ts
interface CustomerConversationListResponse {
  conversations: CustomerConversationSummary[];
  nextCursor: string | null;   // null on the last page
}
```

### 6c. `GET /api/v1/customer/conversations/{id}` — one conversation

`CustomerConversationDetail`, visible threads oldest-first. `404 not_found` for an unknown
id, another customer's conversation, or a `spam`/`deleted` row — indistinguishable per §5.

### 6d. `POST /api/v1/customer/conversations/{id}/replies` — the customer replies

```ts
interface ReplyRequest { bodyText: string }   // 1–100_000 chars after trim
```

Appends an inbound thread and returns `201` with the created `CustomerThreadView`.
Ownership is checked exactly as §6c; a mismatch is `404` and nothing is written.

Status transitions:

| Before | After | Notes |
|---|---|---|
| `active` | `active` | — |
| `pending` with `snoozedUntil` set | `active`, `snoozedUntil` cleared | a timed park is woken by customer activity ([agent-inbox-v1 §2](agent-inbox-v1.md)) |
| `pending` with no snooze | `pending` | an untimed park is an operator statement; a reply does not override it |
| `closed` | `active` | a customer writing back is unresolved work; silently appending would hide it |
| `spam` / `deleted` | — | `404`, nothing written (§3c) |

For the four rows that write, this matches what inbound mail does, and the write emits
`conversation.message_received` with the same `reopened` provenance the store's append
returns. **The event is emitted in the same transaction that appends the thread** — an
append that commits without its event, or an event emitted before a rollback, is a defect,
not an accepted race.

It **diverges** from mail ingestion in two places, both deliberate: a reply to a `spam`
conversation is refused here and reopens there (§3c), and a reply targeting a `deleted`
conversation is `404` here where ingestion falls back to creating a new conversation
([inbound-ingestion.md](../mail/inbound-ingestion.md)). Silently creating a conversation
the customer did not ask to open, in response to a reply to one they can no longer see,
would be worse than the refusal. A customer reply is inbound mail in every respect except
transport and these two cases.

**On `404`:** the conversation may have been filed as spam or deleted between the read and
the reply. The integrator MUST preserve the user's typed text and surface a generic
failure. This surface cannot say more without disclosing the spam verdict (§3c).

## 7. What v1 is NOT

- No browser-facing auth. §5 is server-to-server only.
- No customer entity, no profile read or write, no `/customers/me`. §1.
- No mailbox scoping of reads. §5.
- No visibility of third-party inbound threads. §4c.
- No status changes by the customer — no close, no tags, no assignment; reopen happens only
  implicitly by replying (§6d).
- No attachment upload on reply (§6a only), mirroring the agent API's own gap.
- No search, no realtime, no webhooks-out, no read receipts.
- No attachments on the read surface (§2). Upload works; listing back does not.
- No index behind the derived list ordering (§4b). Migration 034 indexes the ownership
  filter only; the visible-thread aggregate is unindexed, which is acceptable at the row
  counts v1 deployments carry and is the first thing to revisit if the list slows.
- No merging of an emailed message with an API-created conversation that has no token yet
  (§6a).
- No snapshot-consistent pagination. §3d.

## 8. Acceptance

Every criterion is a test, and several are deliberately narrower than the prose they check
— where that is so, it is said.

Visibility (§4a, §4c) — each seeded, then asserted absent from `threads`, `threadCount`,
**and** `preview`:

1. a `note`;
2. a draft at `awaiting_review`, and one at `discarded`;
3. an **approved** draft with `deliveryStatus` `pending`, and one with `failed`;
4. an inbound thread whose `fromAddress` is a third party (§4c);
5. combinations seeded together — an approved-but-failed row, a note carrying attachments,
   and a third-party inbound row — none surfacing through any derivation;
6. an inbound row carrying a non-null `deliveryStatus` (a state the CHECK forbids, seeded
   directly) is hidden rather than surfaced or erroring;
7. no signed attachment URL is minted for any excluded thread — asserted at the query
   layer, not by scanning the response.

Boundaries:

8. a conversation belonging to another customer returns the same status, error code, and
   body as an unknown id across §6c and §6d. *Proves response content only; §5 makes no
   timing claim, and this cannot prove the single-query structure it also requires — that
   is a review obligation, not a test one.*
9. a `spam` conversation is invisible to its own customer across list, get, **and** reply,
   and the refused reply leaves its status `spam` — proving the append path was not entered
   (§3c);
10. an internal note bumps the stored conversation `updatedAt` without changing the
    customer's `updatedAt` or list position (§4b);
11. two visible threads sharing a `createdAt` yield an `updatedAt` and a `preview` drawn
    from the same thread (§4b);
12. every row of §6d's transition table, including that an unsnoozed `pending` stays
    `pending` and a snoozed one wakes, each asserting the emitted event and its `reopened`
    value;
13. a bad Bearer token with a missing customer header returns `401`, not `400`; duplicated
    or comma-folded credential headers return `400` (§3a);
14. a cursor minted for customer A, or under `status=open`, is rejected `400` when replayed
    by customer B or under `status=closed` (§3d);
15. a stored `customerEmail` differing from the asserted address only by case or Unicode
    form still matches (§3b);
16. an address with a quoted local part, a non-ASCII domain, or two `@` is `400` (§3b).

Create (§6a):

17. concurrent creates with the same `Idempotency-Key` yield one conversation; one caller
    receives `409` or both receive the same id, never two conversations;
18. a replay whose conversation has since become `spam` is `404`, and a further replay does
    not create a duplicate;
19. two concurrent first-time creates for the same address yield two conversations with the
    same `customerEmail` and no uniqueness failure — there is no customer row to race on
    (§1);
20. an attachment whose blob write fails leaves **no** conversation and returns `502`
    (§6a).

Threading (§6a) — asserting the documented seam rather than around it:

21. a customer email carrying **no valid token in any header** creates a **separate**
    conversation, whatever its subject;
22. after an operator reply, a customer email whose `In-Reply-To` carries that reply's token
    appends to the original; a second case carries the token in `References` instead.
    *Both construct headers directly and therefore prove the threading algorithm, not that
    a real provider preserves the token end to end — [threading.md](../mail/threading.md)
    §2 documents the Gmail rewrite that makes the latter a fixture concern, not a unit one.*

Criterion 21 encodes a known limitation. It exists so the seam is visible in the suite
rather than discovered in production.
