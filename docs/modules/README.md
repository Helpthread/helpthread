# Helpthread module substrate

This is the operator- and module-author-facing guide to Helpthread's **module
substrate**: the HTTP surface that lets an out-of-process extension — a
draft-writing Assistant, a CRM sync, a notification bot, anything — connect
to a Helpthread deployment without any code living inside the core repo.

It documents the substrate as it is **shipped**, not as it was specified.
Where the two disagree, this guide follows the code and says so.

## Vocabulary (fixed — used the same way everywhere: schema, code, UI, docs)

- **Module** — an out-of-process Helpthread extension. Never called a
  "plugin" (that word survives only inside the legal phrase *plugin
  exception*, the AGPL §7 additional permission — it is not a synonym for
  "module" anywhere in this substrate).
- **Agent** — a human support-staff user. Agents log in, see the inbox UI,
  and approve or discard AI-drafted replies.
- **Assistant** — an AI actor principal. Assistants authenticate with their
  own bearer token, read conversations, and post draft replies — they can
  never send mail directly.

Do not conflate Agents and Assistants; the schema, the API, and the auth
model treat them as two entirely different kinds of caller with different
credentials and different capabilities.

## The three surfaces

| Surface | What it does | Guide |
|---|---|---|
| **Typed events** | The engine records eight kinds of domain event (a new conversation, inbound mail, a status change, a resolved draft, …) reliably — each written in the same database transaction as the state change it describes, so a rolled-back change never emits and a committed one never silently drops its event. (The synthetic `test.ping` is the one exception: it exercises the delivery path directly and never touches the outbox.) | [webhooks.md](./webhooks.md) |
| **Webhook delivery** | Registered HTTPS endpoints receive signed, at-least-once notifications of those events. | [webhooks.md](./webhooks.md) |
| **Assistant actors** | AI principals that authenticate with a bearer token, read conversations through the same read API Agents use, and post draft replies that a human Agent must approve before anything is sent. | [assistants-and-drafts.md](./assistants-and-drafts.md) |

A module typically uses all three: it hears about inbound mail via a
webhook, reads the full conversation via the API, and posts a draft back as
an Assistant. That is exactly the shape of the first real module,
`module-draft-assistant`, referenced throughout these docs as a worked
example.

## Where the substrate lives on the wire

Every route below sits under `/api/v1` on your Helpthread deployment's base
URL (e.g. `https://your-helpdesk.example.com`). There is no separate "module
API" host — it is the same Agent Inbox API a human Agent's browser talks to,
with two additional credential classes layered on top of the original
service-token model.

### Who calls what, authenticated how

| Caller | Credential | Used for |
|---|---|---|
| **Operator / admin tooling** | `Authorization: Bearer <HELPTHREAD_API_TOKEN>` (the deployment's one service token) **plus** `X-Helpthread-Agent-Id: <admin Agent's uuid>` | Registering webhooks, creating/rotating Assistants, approving or discarding drafts — anything an admin Agent does from a script instead of the UI. |
| **A module, at runtime** | `Authorization: Bearer ht_asst_<id>_<secret>` (the Assistant's own token) | Reading conversations, posting drafts, posting notes — nothing else (see [assistants-and-drafts.md](./assistants-and-drafts.md)'s fixed capability set). |
| **A module's webhook receiver** | No inbound credential — instead it *verifies* the `X-Helpthread-Signature` header on every delivery it receives (see [webhooks.md](./webhooks.md)). | Confirming a delivery genuinely came from your Helpthread deployment. |

Every non-2xx response from this API, on every route, uses the same JSON
error envelope:

```json
{ "error": { "code": "validation_failed", "message": "..." } }
```

and every response — success or error — is sent with `Cache-Control:
no-store` (this is authenticated support data; it is never safe to cache).

## Non-goals for v1 (deliberately not built yet)

Carried over honestly from the spec, because a module author should not go
looking for these:

- No in-process/build-time module API — modules are out-of-process only.
- No UI injection points.
- No general scopes/permissions system — an Assistant's capability set is a
  small fixed list (see [assistants-and-drafts.md](./assistants-and-drafts.md)),
  not something you configure.
- No marketplace plumbing — license keys, a module registry, usage metering.
- No webhook redelivery tooling beyond the one-off `POST .../test` ping.

Each of these waits for a real module that needs it.

## Guides

- **[webhooks.md](./webhooks.md)** — registering an endpoint, the event
  vocabulary and envelope, verifying `X-Helpthread-Signature` (complete,
  runnable TypeScript sample), delivery guarantees, auto-disable and health
  visibility.
- **[assistants-and-drafts.md](./assistants-and-drafts.md)** — creating an
  Assistant and handling its token, the fixed capability set, posting a
  draft, and the human Agent approval flow.
