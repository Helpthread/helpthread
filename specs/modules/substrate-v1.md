# Module Substrate v1 — typed events, webhook delivery, assistant actors

Vocabulary (fixed, like Agents/Assistants): the extension artifacts are **modules** —
in schema, code, docs, UI, and prose. The word "plugin" survives only inside the legal
phrase *plugin exception* (the AGPL §7 additional permission, named in the
Classpath-exception tradition) and in charter quotations.

Status: **draft for TJ review**. Governed by docs/history/CHARTER-v1.md §3/§4 (module boundary,
out-of-process preference, zero privileged first-party access) and
`specs/modules/catalog.md`  §4's build sequence. This spec is also raw material
for the §7 plugin-exception text: the exception gets drafted against this real,
shipped API — before the first external contribution merges.

## 1. Purpose & scope

The substrate every out-of-process module rides on — three surfaces, all core-AGPL and
free forever (the substrate is never paid):

1. **Typed event emission** — the engine records domain events reliably.
2. **Webhook delivery** — registered endpoints receive signed event notifications.
3. **Assistant actors** — AI principals that authenticate, read, and produce
   draft-before-send work an Agent approves.

The first consumer is the draft-reply assistant (catalog §3.1), which needs all three
and nothing more: it hears about inbound mail (events → webhook), reads the conversation
(API), and posts a draft (assistant API) that an Agent approves in core UI.

**Non-goals for v1**: the in-process/build-time module API, UI injection points, a
general scopes/permissions system, marketplace plumbing (license keys, registry,
metering), webhook redelivery tooling. Each waits for a real module to need it.

**The additive-forward rule (TJ, 2026-07-18): marketplace attaches, it never
retrofits.** Everything in this spec must remain correct unmodified when the
marketplace phase arrives — commerce is additions on top, never a rebuild of the
substrate. The specific commitments that keep it true:

- **Licensing is distribution-side, never runtime.** A license key authenticates
  registry download and updates; no runtime license check ever enters the substrate,
  and revoking a license can never reach into a running helpdesk. Security credentials
  (§3, §5) and commercial entitlement stay decoupled permanently.
- **Module identity is a first-class attribution from day one**: assistants and webhook
  endpoints both carry a `module` slug, so a later `module_installs` bundle (one-click
  provision/uninstall, per-module health) references existing rows instead of
  backfilling identity.
- **Capability enforcement lives at one point** (§3), so a future scopes system swaps
  in behind the same gate additively.
- **First-party dogfood modules are built product-shaped**: configured only by
  credentials/env, no Resonant-IQ-specific behavior — the repo we dogfood is the
  artifact the marketplace later distributes.

## 2. Completing the actor model (schema)

Charter §4 promises that every thread records its authoring actor kind with
draft-before-send states as "day-one schema shapes." The shipped schema (migrations
001/007) has `direction IN ('inbound','outbound','note')` only — the actor model was
never implemented. **This spec closes that gap**; the contradiction and its resolution
are recorded here deliberately (charter commandment: the contradiction is the
deliverable).

New columns on `threads`:

- `author_kind text NOT NULL CHECK (author_kind IN ('customer','agent','assistant'))` —
  backfilled: `inbound` → `customer`, `outbound`/`note` → `agent`.
- `author_agent_id uuid NULL REFERENCES agents(id)`, `author_assistant_id uuid NULL
  REFERENCES assistants(id)`, tied by CHECK: `customer` rows carry neither; `assistant`
  rows carry `author_assistant_id` and never `author_agent_id`; `agent` rows may carry
  `author_agent_id` and never `author_assistant_id` (NULL stays legal — backfilled
  history and service-token callers are honest about what they don't know).
- **Draft lifecycle**: `draft_status text NULL CHECK (draft_status IN
  ('awaiting_review','approved','discarded'))`, NULL for everything that is not an
  assistant draft, and legal only on `direction = 'outbound'`.
- **Audit**: `approved_by_agent_id uuid NULL REFERENCES agents(id)`,
  `draft_resolved_at timestamptz NULL`, `draft_edited boolean NOT NULL DEFAULT false`
  (did the approving Agent change the body before sending).

**The delivery/draft consistency constraint.** The live constraint being replaced is
migration 007's three-direction `threads_delivery_status_by_direction` (not 002's
original) — its `note` arm must survive. Full replacement predicate, making the illegal
states unrepresentable (an unapproved draft with a delivery status — i.e. reachable by
the delivery worker — must be impossible, not merely avoided):

```sql
CHECK (draft_status IS NULL OR direction = 'outbound');
CHECK (   (direction IN ('inbound','note') AND delivery_status IS NULL)
  OR (direction = 'outbound'
      AND draft_status IS NOT NULL
      AND draft_status IN ('awaiting_review','discarded')
      AND delivery_status IS NULL)
  OR (direction = 'outbound'
      AND (draft_status IS NULL OR draft_status = 'approved')
      AND delivery_status IS NOT NULL
      AND delivery_status IN ('pending','sent','failed'))
);
```

The `IS NOT NULL` guards are load-bearing, not belt: without them, SQL's three-valued
logic lets the illegal row `(outbound, draft_status NULL, delivery_status NULL)` pass —
each `IN` test evaluates to NULL, the OR-chain yields NULL, and a NULL CHECK is
accepted. This is the same NULL-trap migration 002's doc comment warns about, and it
was caught by a failing test during implementation, not by review of this spec.

The deliverable-thread queries (`listDeliverableThreads`, `claimThreadForDelivery`)
additionally gain an explicit `draft_status IS DISTINCT FROM 'awaiting_review'` guard —
belt on top of the CHECK's braces.

**Schema is additive; writers change in the same increment.** `author_kind NOT NULL`
means every insert path (ingestion, `sendReply`, notes) supplies it in the same change,
and `insertThread`'s outbound coercion `deliveryStatus ?? 'pending'` becomes
draft-aware (today it would silently arm a draft for delivery). What stays untouched is
**mail semantics**: parsing, threading, token verification, and the wire shape of sent
mail are unchanged and remain fixture-proven (the charter's "Conversation integrity" rule). A draft is inert
rows until approval (§6).

*Alternative considered*: a separate `drafts` table. Rejected — a draft is a
thread-in-waiting; keeping it in `threads` gives the conversation timeline, soft-delete
semantics, and approval-as-state-transition for free. The wire-contract consequences of
that choice are specified, not inherited — see §7.

## 3. Assistant principals

New `assistants` table: `id`, `name` (display), `module` (slug of the module operating
it), `token_hash`, `status ('active','disabled')`, `created_by_agent_id`, timestamps.

- **Token format & verification**: `ht_asst_<assistantId>_<secret>` — the embedded id
  makes the row lookup direct (no hash scan); verification is constant-time comparison
  of SHA-256 digests of the secret part against `token_hash`. Server-generated, shown
  once at creation. This is a second credential class next to the service Bearer token,
  amending agent-inbox-v1 §3's "only auth model" statement (§7 below).
- **Admin API** (admin-role Agents, same conventions as `/agents`):
  `POST /api/v1/assistants` (returns the token once), `GET /api/v1/assistants`,
  `PATCH /api/v1/assistants/{id}` (name, status), `POST …/{id}/rotate-token`.
- **Fixed capability set, not a scopes system** (v1 simplicity): an assistant may read
  conversations/threads, create drafts, and create notes. It may **not** send, approve,
  change status/tags/assignee, touch admin surfaces, or read soft-deleted conversations
  (which are indistinguishable from nonexistent on this surface too). Any wider
  capability waits for a module that needs it and ships publicly (charter: zero
  privileged first-party access).

**Author identity going forward**: from this increment on, every new thread row carries
`author_kind`, and authoring identity where the caller asserts one — assistant calls
from the token itself; Agent-authored replies, notes, and draft resolutions from the
`X-Helpthread-Agent-Id` acting-agent header ( §8), which the web client extends to
these authoring calls. A service-token caller without the header still writes
`author_kind='agent'` with NULL identity (the pre- posture, preserved rather than
broken).

## 4. Events — vocabulary and envelope

**Thin events**: an event carries identifiers and small typed facts — never message
bodies, subjects, or addresses. Consumers fetch full content through the API with their
own credentials. This keeps webhook payloads free of message content and PII by
construction and matches the charter's "Operator ownership" rule.

v1 vocabulary (closed list; additions are spec amendments):

| Type | Fired when | `data` |
|---|---|---|
| `conversation.created` | new conversation stored | — |
| `conversation.message_received` | inbound thread stored (incl. reopen) | `threadId`, `reopened` |
| `conversation.reply_sent` | outbound delivery reaches `sent` | `threadId`, `authorKind` |
| `conversation.status_changed` | status transition among the four API states | `from`, `to` |
| `conversation.tags_changed` | tag set replaced | `tags` |
| `conversation.assignee_changed` | assignee set/cleared | `assigneeAgentId` |
| `draft.created` | assistant posts a draft | `threadId`, `assistantId` |
| `draft.resolved` | Agent approves/discards | `threadId`, `resolution`, `edited` |

**Soft delete fires nothing, ever** (explicit exclusion): `deleted` is not a status the
API surface acknowledges (agent-inbox-v1 §4d — indistinguishable from nonexistent on
every endpoint, and this one too). Consumers discover deletion as a 404 on fetch, the
same way every other client does. No event of any type fires for a soft-deleted
conversation after its deletion, including `draft.*` for drafts stranded on it.

Envelope (JSON body of every delivery):

```json
{
  "eventId": "uuid",            // dedupe key — stable across redeliveries
  "type": "conversation.message_received",
  "occurredAt": "ISO-8601",
  "conversationId": "uuid",
  "data": { }
}
```

**Emission is a transactional outbox** — the only reliable shape serverless allows: the
event row is written to `event_outbox` in the **same transaction** as the state change
it describes (an event never fires for a change that rolled back, and no committed
change silently drops its event). A drain step — the existing queue/cron drain pattern —
turns outbox rows into `QueueProvider` deliveries. At-least-once end to end; consumers
dedupe on `eventId`; no cross-event ordering guarantee.

## 5. Webhook registration & delivery

`webhook_endpoints` table: `id`, `url` (https only), `secret` (server-generated,
returned once, encrypted at rest via the existing token-crypto AES-256-GCM envelope —
signing needs the plaintext back), `events` (subset filter of §4's list, or all),
`module text NULL` (attribution slug, mirroring `assistants.module` — the
additive-forward rule in §1), `status ('active','disabled','auto_disabled')`,
consecutive-failure counter, timestamps.

- **Admin API**: `POST /api/v1/webhooks`, `GET /api/v1/webhooks`,
  `PATCH …/{id}`, `DELETE …/{id}`, `POST …/{id}/test` (fires a synthetic `test.ping`).
- **Delivery** (a queue topic; handler per delivery): HTTP POST, JSON envelope, 10s
  timeout, redirects not followed. Headers:
  - `X-Helpthread-Event`: type
  - `X-Helpthread-Delivery`: unique delivery id (differs per attempt)
  - `X-Helpthread-Signature`: `t=<unix-ts>, v1=<hex HMAC-SHA256(secret, t + "." + body)>`
    — Stripe-shape; consumers reject stale `t` (recommended window 5 minutes) to kill
    replays.
- Any 2xx acks. Anything else (or timeout) retries on the queue's backoff up to the
  provider policy, then dead-letters against the endpoint: the consecutive-failure
  counter increments, and at the threshold the endpoint flips to `auto_disabled` —
  visible in the admin API and surfaced by `/api/v1/internal/health` (runbook Part G
  gains a section).
- SSRF posture: https only, no redirects, and the delivery handler refuses URLs
  resolving to private/link-local ranges (impl note: resolve-then-connect pinning).

## 6. Assistant-actor API (drafts)

Assistant-authenticated:
- `POST /api/v1/conversations/{id}/drafts` — `{ bodyText, bodyHtml? }` → outbound
  thread, `author_kind='assistant'`, `draft_status='awaiting_review'`,
  `delivery_status NULL`, no envelope, no message id. Fires `draft.created`.
  `Idempotency-Key` required; the engine stores it prefixed (`draft:<key>`) so the
  shared `(conversation_id, idempotency_key)` uniqueness namespace (migration 004)
  can never replay a reply as a draft or vice versa.
- `POST /api/v1/conversations/{id}/notes` — existing notes endpoint, now legal for
  assistants (`author_kind='assistant'`, identity from the token; the handler today
  records no author at all — it starts recording one for every caller per §3).

Agent-authenticated (the core draft-review UI consumes exactly this — API-first rule):
- `GET /api/v1/drafts?status=awaiting_review` — cross-conversation review queue,
  newest first, keyset cursor. **Excludes drafts whose conversation is soft-deleted**
  (§4d indistinguishability holds here too; such drafts are unreachable everywhere and
  simply never surface — no resolution event, no discard needed).
- `POST /api/v1/drafts/{threadId}/approve` — optional `{ bodyText, bodyHtml }` override
  ("approve with edits", recorded as `draft_edited`). Refused (404-shaped, per §4d) on
  soft-deleted conversations; refused (409) on `spam`.
- `POST /api/v1/drafts/{threadId}/discard` — `draft_status='discarded'`, row kept for
  audit. Fires `draft.resolved`.

**What approval actually does** (specified, because `sendReply` cannot be reused — it
mints and INSERTs a *new* thread row, and has no entry point for a pre-existing one):
approval is a state transition on the draft row that performs, in one transaction, the
same derivations `sendReply` performs pre-insert, then joins the existing delivery
machinery:

1. Mint the reply token and Message-ID **for the draft's existing thread id**
   (`specs/mail/threading.md` §2a — same mint, same key rotation).
2. Derive the envelope exactly per agent-inbox-v1 §4a: recipient/subject from the
   conversation, `In-Reply-To`/`References` from the latest inbound thread, with the
   minted id as the **final** `References` entry (the outbound-threading rule).
3. Apply open-tracking pixel injection before persist iff enabled ( semantics
   unchanged — absent config, byte-identical mail).
4. Write envelope snapshot + message id + `draft_status='approved'` +
   `delivery_status='pending'` + approving-Agent audit fields onto the row.
5. Hand off to the **unchanged** delivery path — `attemptDeliveryOfClaimedThread`, the
   delivery worker, its lease and retry semantics. Fires `draft.resolved` (and later
   `conversation.reply_sent` when delivery confirms).

The mail that leaves after approving an unedited draft must be equivalent to the mail
`sendReply` would send with the same body — **fixture-asserted**, per the charter's
mail-semantics equivalence rule.

Invariants, test-asserted: an assistant call can never directly cause outbound mail; a
draft never leaves the system without an approving Agent identity on the row;
**unresolved drafts cause no conversation reopen and no `updated_at` bump** — stronger
than notes, which do bump activity — so the store's append path (which today reopens
closed/spam and bumps for any non-note row) gets an explicit draft carve-out; approval
on a closed conversation follows the normal reply-reopen rule at send time.

## 7. Wire-contract amendments to agent-inbox-v1 (explicit, not inherited)

Keeping drafts in `threads` changes shipped response shapes; these are the amendments,
to land in `specs/api/agent-inbox-v1.md` alongside implementation:

- `ThreadView` gains `authorKind` (`'customer'|'agent'|'assistant'`) and `draftStatus`
  (`'awaiting_review'|'approved'|'discarded'|null`).
- §2's `deliveryStatus` invariant widens: outbound is `null` while a draft is
  unapproved or discarded.
- **Preview and `threadCount` ignore unresolved and discarded drafts** (a draft is not
  conversation content until sent): the latest-body derivation and count exclude rows
  with `draft_status IN ('awaiting_review','discarded')`.
- §3's "this is still the API's only auth model" statement is amended: the service
  Bearer token is joined by per-assistant tokens (§3 above), verified before routing
  under the same constant-time discipline.
- Conversation detail (`GET /conversations/{id}`) includes draft rows for
  Agent/service callers (the timeline shows them); the assistant surface sees its own
  drafts through the same endpoint.

## 8. Delivery-guarantee summary

| Surface | Guarantee | Dedupe |
|---|---|---|
| Event emission | transactional with the state change | — |
| Outbox → queue | at-least-once | `eventId` as dedupeKey |
| Webhook delivery | at-least-once per endpoint, no ordering | consumer dedupes on `eventId` |
| Draft creation | idempotent via `draft:`-scoped Idempotency-Key | key replay returns the original |
| Approval → delivery | existing delivery-worker lease/retry semantics | unchanged |

## 9. Decision points for TJ (called out, not silently taken)

1. **Actor-model migration folded into substrate v1** (§2) vs. split into its own
   ticket. Recommendation: folded — it's the substrate's data model.
2. **Auto-disable threshold** for failing webhooks (§5). Recommendation: 20 consecutive
   failures, admin re-enable; conservative because a disabled endpoint silently stops a
   paid module.
3. **`conversation.reply_sent` timing** — fired at `sent` (delivery confirmed) rather
   than at accept-for-send. Recommendation: `sent`; modules reacting to "we replied"
   want truth, not intent.
4. **Acting-agent header on authoring calls** (§3): the web client starts sending
   `X-Helpthread-Agent-Id` on replies/notes/draft actions so author identity is
   recorded. Recommendation: yes — it applies the existing trust model to authorship;
   absent header degrades to NULL identity, never an error.

## 10. Changelog

- **2026-07-18**: initial draft, following the module-catalog decision. Names
  and resolves the charter-§4-vs-schema actor-model gap. Revised same day after
  adversarial review against the shipped code (13 findings applied: approval-path
  derivation specified instead of claiming `sendReply` reuse; draft/delivery CHECK made
  illegal-state-proof against migration 007's live constraint; thin events stripped of
  PII; soft-delete indistinguishability extended to drafts and events; agent-inbox-v1
  wire amendments made explicit; idempotency namespace scoped; author-identity
  forward-carry specified). Same day: the additive-forward rule added (§1) with
  `module` attribution on webhook endpoints (§5) — marketplace attaches, never
  retrofits (TJ). Same day, during implementation: §2's CHECK predicate corrected
  for the three-valued-logic NULL trap (`IS NOT NULL` guards added; found by a failing
  store test).
