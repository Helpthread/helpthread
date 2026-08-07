# Customer conversations API v1

Status: proposed (HT-126)

## 1. Purpose

The surface an integrating product calls to create, read, and reply to conversations **on
behalf of one identified customer** — the counterpart to
[agent-inbox-v1.md](agent-inbox-v1.md), which serves the operator.

It exists because a product that already knows who its user is needs to offer support
inside its own interface: a help form that opens a conversation, a list of that user's
past requests, a thread view, a reply box. Email alone cannot back those surfaces — there
is nothing to read back from.

This is a **server-to-server** API. The calling server authenticates as itself and asserts
which customer it is acting for. It is never called from a browser (§5).

## 2. Domain model

Native to Helpthread, and a **subset** of [agent-inbox-v1 §2](agent-inbox-v1.md) — same
vocabulary, same field names, same ISO-8601 timestamps, fewer fields. Anything the
operator sees that a customer must not (§4) is absent from the type, not nulled.

```ts
interface CustomerConversationSummary {
  id: string                 // uuid — canonical, used verbatim in every path
  number: number             // display-only; never a path key
  subject: string
  status: 'active' | 'pending' | 'closed'   // 'spam' and 'deleted' never surface (§3a)
  threadCount: number        // excludes notes and unapproved drafts (§4)
  preview: string            // latest visible bodyText excerpt, '' when none
  createdAt: string
  updatedAt: string
}

interface CustomerConversationDetail extends CustomerConversationSummary {
  threads: CustomerThreadView[]    // oldest-first
}

interface CustomerThreadView {
  id: string                 // uuid
  direction: 'inbound' | 'outbound'   // never 'note' (§4)
  from: string
  bodyText: string | null
  bodyHtml: string | null    // ⚠ UNTRUSTED, UNSANITIZED — see §5
  attachments: AttachmentView[]      // as agent-inbox-v1 §2
  createdAt: string
  authorKind: 'customer' | 'agent'   // 'assistant' collapses to 'agent' once approved (§4)
}

interface Customer {
  id: string                 // uuid
  email: string
  name: string | null
}
```

Deliberately absent, each because it is operator-only: `assignee`, `tags`, `snoozedUntil`,
`deliveryStatus`, `customerViewedAt`, `draftStatus`.

## 3. Conventions

Identical to [agent-inbox-v1 §3](agent-inbox-v1.md) — `/api/v1` base, JSON in and out,
`Cache-Control: no-store` on every response, the `ApiError` envelope, keyset pagination,
404 on unmatched paths and 405 (with `Allow`) on wrong methods, auth checked before
routing. Two additions specific to this surface:

- **Base path:** `/api/v1/customer`. A distinct prefix so the exclusion rules in §4 attach
  to a routing boundary rather than to the discipline of each handler.
- **Customer identity header:** `X-Helpthread-Customer-Email` on every request. Required;
  a missing or unparseable value is `400 validation_failed`. Matched case-insensitively
  against the stored address.

### 3a. Status mapping

`spam` and `deleted` conversations are invisible here — they return `404 not_found` by id
and never appear in a list. A customer is never told their message was filed as junk.

## 4. The exclusion rules

Three classes of data reach the operator and must never reach the customer. Each is
enforced at the query layer, not by response shaping, and each is test-enforced.

1. **Internal notes.** `direction: 'note'` rows are excluded from `threads`, from
   `threadCount`, and from `preview` derivation. Pre-existing requirement —
   [agent-inbox-v1 §5](agent-inbox-v1.md) put it on record before this surface existed:
   *"any future customer-side API, webhook, or export MUST exclude them."*

2. **Unapproved and discarded drafts.** A thread with `draftStatus` of `awaiting_review`
   or `discarded` is excluded on the same terms. An approved draft is ordinary outbound
   mail and appears normally, reported as `authorKind: 'agent'` — the customer is told a
   reply came from the organization, not which internal actor composed it.

   Agent-inbox-v1 §3b deliberately *includes* draft rows for Agent and service callers.
   That is correct there and would be a disclosure of unsent internal drafting here. This
   spec is where the boundary is stated.

3. **Operator metadata.** The fields listed as absent in §2. Assignment, tags, snooze
   state, delivery status, and open-tracking timestamps describe how the organization
   works a conversation, not what was said in it.

## 5. Auth and the trust model

**Two credentials, both required on every request.**

- `Authorization: Bearer <token>` — the same deployment service token
  (`HELPTHREAD_API_TOKEN`) the agent API uses, compared constant-time, read only from
  server configuration, never logged. Grants access to the API, not to a customer.
- `X-Helpthread-Customer-Email` — which customer the caller is acting for. Scopes every
  read and write to that customer's own rows.

**The integrator asserts customer identity, and Helpthread trusts that assertion.** The
service token grants the ability to act for *any* customer; the header chooses which. That
is a real and deliberate trust boundary, and it has two consequences the integrator owns:

- **The token must never reach a browser.** A client holding it could pass any email and
  read any customer's conversations. This API is callable only from a server that
  authenticated the user by its own means and derived the email from that session — never
  from user input.
- **Helpthread cannot detect a compromised integrator.** This defends against integrator
  *bugs* — a wrong id, a missing scope, a leaked conversation between two of its own users
  — not against a hostile caller holding the token.

**Why not per-customer tokens.** A credential class scoped to one customer (as
`specs/plugins/substrate-v1.md` §3 does per Assistant) is the right answer when a customer
authenticates to Helpthread directly. No such surface exists: the integrator has already
authenticated the user, and minting a second credential per customer would add an issuance,
rotation, and revocation path serving no additional guarantee. When a browser-facing
customer surface ships, it needs that credential class, and it is additive to this spec.

**No existence leak.** A conversation that exists but belongs to another customer returns
exactly what a nonexistent id returns: `404 not_found`, generic message. Ownership is
checked before any field is read, so response timing does not distinguish the two either.

**`bodyHtml` is untrusted and unsanitized**, carried verbatim from inbound mail exactly as
[agent-inbox-v1 §5](agent-inbox-v1.md) describes. Any UI rendering it MUST sanitize first.
The hazard is worse here than on the agent surface: the reader is a customer in the
integrator's own application, so an unsanitized render is stored XSS against that product.

## 6. Endpoints

### 6a. `POST /api/v1/customer/conversations` — open a conversation

Creates a conversation and its first inbound thread, attributed to the header's customer.
Creates the customer record if no row matches the email.

```ts
interface CreateRequest {
  subject: string                  // 1–500 chars after trim
  bodyText: string                 // 1–100_000 chars after trim
  mailboxId: string                // uuid
  attachments?: AttachmentUpload[] // max 10; total max 25 MB
}

interface AttachmentUpload {
  filename: string
  contentType: string
  data: string                     // base64
}
```

Responds `201` with `CustomerConversationDetail`. The conversation is created `active` and
unassigned. Intake spam classification ([spam-classification.md](../mail/spam-classification.md)
§4) does **not** apply — the transport classifier reads mail headers, and there is no
inbound message here; a conversation opened by an authenticated product user is not junk.

`Idempotency-Key` is honored as in [agent-inbox-v1 §4a](agent-inbox-v1.md): a repeat with
the same key returns the original conversation rather than a duplicate.

### 6b. `GET /api/v1/customer/conversations` — the customer's own list

Their conversations, most-recently-active first (`updatedAt` desc, `id` desc tiebreak).

| query param | type | default | notes |
|---|---|---|---|
| `status` | `open` \| `closed` | `open` | `open` returns `active` + `pending`, matching the agent API's folder semantics |
| `limit` | number | 25 | hard cap 50; clamped, not rejected |
| `cursor` | string | — | opaque keyset cursor from `nextCursor` |

```ts
interface CustomerConversationListResponse {
  conversations: CustomerConversationSummary[];
  nextCursor: string | null;
}
```

### 6c. `GET /api/v1/customer/conversations/{id}` — one conversation

`CustomerConversationDetail`, threads oldest-first, §4 exclusions applied. `404 not_found`
for an unknown id, another customer's conversation, or a `spam`/`deleted` row.

### 6d. `POST /api/v1/customer/conversations/{id}/replies` — the customer replies

```ts
interface ReplyRequest { bodyText: string }   // 1–100_000 chars after trim
```

Appends an inbound thread and returns `201` with the created `CustomerThreadView`. Bumps
`updatedAt`, so the conversation resurfaces in the operator's inbox. A reply to a `closed`
conversation reopens it to `active` — a customer writing back is unresolved work, and
silently appending to a closed thread would hide it from the operator.

Ownership is checked exactly as `6c` does; a mismatch is `404` and nothing is written.

### 6e. `GET /api/v1/customer/customers/me` — resolve the customer

Returns the `Customer` for the header's email, or `404 not_found` when no row exists yet.
Lets an integrator distinguish "no history" from "call failed" without listing.

There is deliberately no endpoint returning a conversation's owner: the owner is always the
header's customer, or the conversation is `404`.

## 7. What v1 is NOT

- No browser-facing auth. §5 is server-to-server only.
- No status changes by the customer — no close, no reopen except implicitly by replying
  (§6d), no tags, no assignment.
- No attachment upload on reply (`6a` only), mirroring the agent API's own gap.
- No search, no realtime, no webhooks-out, no read receipts.
- No customer profile writes. Name and email are set by the integrator's own records and
  reach Helpthread through mail and `6a`, not through a profile endpoint.

## 8. Acceptance

1. Every §4 exclusion is proven absent by a test that seeds the excluded row and asserts it
   is missing from `threads`, `threadCount`, and `preview` — not by inspection of the
   handler.
2. A conversation belonging to another customer is indistinguishable from a nonexistent one
   across `6c` and `6d`.
3. A `spam` conversation is invisible to its own customer across list and get.
4. A reply to a `closed` conversation reopens it and appears in the operator's inbox.
5. Requests missing either credential fail closed: no `X-Helpthread-Customer-Email` is
   `400`, a bad Bearer token is `401`, and neither response reveals which.
6. A conversation created through `6a` threads correctly with subsequent email replies —
   the mail engine's threading treats it as the root, per
   [threading.md](../mail/threading.md).
