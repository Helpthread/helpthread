# Assistants: identity, capabilities, drafts, and approval

> **Status note.** This document covers the Assistants and Drafts APIs
> (HT-70), which land on `main` via PR #80. The code referenced here lives on
> branch `feat/ht-70-drafts-approval` until that PR merges; everything below
> was verified against that branch's shipped code, not the spec alone.

An **Assistant** is an AI actor principal — never a human (that's an
**Agent**; see [README.md](./README.md)'s vocabulary section). A module that
wants to read conversations and propose replies authenticates as an
Assistant, using a bearer token an admin Agent mints for it. An Assistant
can never send mail directly: everything it writes is a draft, and a human
Agent must approve it before anything reaches the customer.

Examples below use the same `$BASE_URL`, `$HELPTHREAD_API_TOKEN`, and
`$ADMIN_AGENT_ID` as [webhooks.md](./webhooks.md) for the **admin**
endpoints (creating/managing Assistants, approving/discarding drafts — all
Agent actions). The Assistant's own token, once minted, is a completely
separate credential used only by the module itself.

## Creating an assistant

```sh
curl -X POST "$BASE_URL/api/v1/assistants" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"name": "Draft Assistant", "module": "your-module-slug"}'
```

Both `name` (1–200 characters) and `module` (1–100 characters, free text —
nothing validates it against a registry) are required; either missing or
out of range is `400 validation_failed`.

Response, `201`:

```json
{
  "assistant": {
    "id": "c7a1...-uuid",
    "name": "Draft Assistant",
    "module": "your-module-slug",
    "status": "active",
    "createdByAgentId": "<admin Agent's uuid>",
    "createdAt": "2026-07-19T00:00:00.000Z",
    "updatedAt": "2026-07-19T00:00:00.000Z"
  },
  "token": "ht_asst_c7a1...-uuid_<secret>"
}
```

## Token handling

**`token` is shown exactly once, in the create (or rotate) response.** Only
a SHA-256 digest of its secret half is ever persisted — there is no "reveal
token" endpoint and no way to recover a lost one. Copy it immediately into
wherever your module reads its configuration (an environment variable is
the normal choice) and treat it like any other high-entropy secret: never
commit it, never log it.

The token has the shape `ht_asst_<assistantId>_<secret>`. Use it as-is on
every Assistant-authenticated request:

```sh
curl "$BASE_URL/api/v1/conversations/$CONVERSATION_ID" \
  -H "Authorization: Bearer $ASSISTANT_TOKEN"
```

Note there is **no** `X-Helpthread-Agent-Id` header on Assistant-
authenticated calls — the token itself carries the Assistant's identity;
that header is only for Agent-authenticated calls (creating/managing
Assistants, approving/discarding drafts — see below).

**Rotation** mints a fresh secret for the *same* assistant id (so any
`author_assistant_id` a past draft already recorded stays valid) and
returns the new token once; the old one stops verifying immediately —
there is no overlap window:

```sh
curl -X POST "$BASE_URL/api/v1/assistants/$ASSISTANT_ID/rotate-token" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID"
```

Also available, both admin-only: `GET /api/v1/assistants` (roster, never
includes any token) and `PATCH /api/v1/assistants/{id}` with `{"name":
...}` and/or `{"status": "active" | "disabled"}` — a `disabled` Assistant's
token stops authenticating immediately, without needing rotation.

## The fixed capability set

An Assistant's token authenticates it, but that alone doesn't authorize
every route — there is exactly one capability-enforcement point
(`src/api/index.ts`), and it allows an Assistant through to only:

- `GET /api/v1/conversations` and `GET /api/v1/conversations/{id}` — the
  same read surface an Agent's UI uses, so a module can pull full thread
  content once a webhook tells it something changed.
- `POST /api/v1/conversations/{id}/drafts` — propose a reply (below).
- `POST /api/v1/conversations/{id}/notes` — leave an internal note.

Every other route — including anything under `/api/v1/webhooks`,
`/api/v1/assistants`, sending a reply, changing status/tags/assignee, or
approving/discarding a draft — answers `403 forbidden` to an Assistant
caller, even though the token itself is valid. There is no scopes system to
configure this differently; a wider capability set waits for a real module
that needs one.

Soft-deleted conversations are invisible to an Assistant exactly as they
are to everyone else: a `404`, indistinguishable from never having existed.

## Posting a draft

```sh
curl -X POST "$BASE_URL/api/v1/conversations/$CONVERSATION_ID/drafts" \
  -H "Authorization: Bearer $ASSISTANT_TOKEN" \
  -H "Idempotency-Key: $EVENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"bodyText": "Thanks for reaching out — here is how to reset your password..."}'
```

- `bodyText` is required, 1–5000 characters. `bodyHtml` is optional (no
  length bound, but must be a string if present).
- `Idempotency-Key` is **required** — use the triggering webhook delivery's
  `eventId` (the pattern this guide recommends throughout): if the same
  `conversation.message_received` delivery is retried, replaying the same
  `Idempotency-Key` against the same conversation returns the original
  draft instead of creating a second one. This is enforced server-side, not
  just a convention — draft creation is idempotent by construction.

Response, `201`, a `ThreadView` (the same shape the conversation-detail
endpoint returns for any thread):

```json
{
  "id": "d4e2...-uuid",
  "direction": "outbound",
  "from": "support@your-helpdesk.example.com",
  "bodyText": "Thanks for reaching out — here is how to reset your password...",
  "bodyHtml": null,
  "deliveryStatus": null,
  "customerViewedAt": null,
  "attachments": [],
  "createdAt": "2026-07-19T00:00:05.000Z",
  "authorKind": "assistant",
  "draftStatus": "awaiting_review"
}
```

Note `deliveryStatus: null` — a draft is inert until an Agent approves it;
nothing about posting a draft can cause mail to leave the system. Posting a
draft fires a `draft.created` event ([webhooks.md](./webhooks.md)'s
vocabulary) with `{ threadId, assistantId }`. An unresolved draft also does
**not** reopen a closed conversation or bump its activity timestamp — a
draft sitting in the review queue is not, by itself, evidence that a human
looked at anything.

## The Agent approval flow

Everything past this point is an **Agent** action — the core Helpthread
inbox UI does this for a human clicking "approve" or "discard," and it
consumes exactly the same API, so these are also the calls a module author
would use to build their own review tooling or to understand what the UI is
doing. All three require `Authorization: Bearer $HELPTHREAD_API_TOKEN` +
`X-Helpthread-Agent-Id: <acting Agent's uuid>` — missing either is `401`.

**List the review queue** (every conversation's drafts, across the whole
deployment, newest first):

```sh
curl "$BASE_URL/api/v1/drafts?status=awaiting_review" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID"
```

`status=awaiting_review` is required and is the only legal value — resolved
drafts show up in their conversation's own detail view, not here. Supports
`limit` (default 25, max 50) and keyset `cursor` pagination via the
returned `nextCursor`.

**Approve**, optionally editing the body first:

```sh
# Approve as-written
curl -X POST "$BASE_URL/api/v1/drafts/$THREAD_ID/approve" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID"

# Approve with edits (recorded as draftEdited: true)
curl -X POST "$BASE_URL/api/v1/drafts/$THREAD_ID/approve" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID" \
  -H "Content-Type: application/json" \
  -d '{"bodyText": "Edited reply text..."}'
```

Approval is a state transition, not a resend: it mints the reply's
threading token and Message-ID, derives the envelope (recipient, subject,
`In-Reply-To`/`References`) exactly the way a normal Agent reply does, and
hands off to the same delivery worker — the mail that goes out is
equivalent to what a human typing the same body and hitting reply would
send. Fires `draft.resolved` immediately (`{ threadId, resolution:
'approved', edited }`), and `conversation.reply_sent` once delivery actually
confirms `sent` (not at accept-for-send time — modules reacting to "we
replied" get truth, not intent).

Refused `404` (indistinguishable-from-nonexistent) if the conversation is
missing/soft-deleted or `$THREAD_ID` doesn't name a draft currently
`awaiting_review`; refused `409 conflict` if the conversation is `spam`.

**Discard** (no send, row kept for audit):

```sh
curl -X POST "$BASE_URL/api/v1/drafts/$THREAD_ID/discard" \
  -H "Authorization: Bearer $HELPTHREAD_API_TOKEN" \
  -H "X-Helpthread-Agent-Id: $ADMIN_AGENT_ID"
```

Sets `draftStatus: 'discarded'` and fires `draft.resolved` (`{ threadId,
resolution: 'discarded', edited: false }`). No `spam` restriction — discarding
a draft on a spam conversation is harmless, unlike approving one.

Both approve and discard return the updated `ThreadView` on success, the
same shape draft-creation returns above.

## Invariants worth knowing, test-asserted in the engine

- An Assistant call can never, by itself, cause outbound mail — the only
  path to a sent message is an Agent's explicit approval.
- A draft never leaves the system without an approving Agent's identity
  recorded on the row (`approved_by_agent_id`).
- An unresolved or discarded draft is excluded from a conversation's
  preview text and thread count — it isn't conversation content until it
  sends.
