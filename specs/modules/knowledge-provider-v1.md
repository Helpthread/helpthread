# Knowledge Provider Interface v1 — connecting any knowledge base

Vocabulary (fixed, like Agents/Assistants/modules): a **knowledge provider** is any system
that can answer "what do you know about this?" — a first-party knowledge-base module, a
third-party product, or an operator's own wiki. A **document** is one retrievable unit of
knowledge in one language. A **chunk** is an addressable passage of a document. Helpthread
is always the **consumer**; the provider is always the **source**.

Status: **draft for maintainer review.** Governed by the Founding Charter (v2, adopted
2026-07-23) — principally *Extensibility without privilege*, *Public APIs and events*,
*Infrastructure before applications*, and *Operator ownership*. Builds on
`substrate-v1.md`, which stays unchanged.

## 1. Purpose & scope

Helpthread can consult knowledge, and is not tied to any particular knowledge base to do
it. This spec defines the public contract that makes that true.

**The originating decision (maintainer, 2026-08-02):**

> "we are not going to limit Helpthread to using our KB module only - Helpthread should be
> able to connect to any knowledgebase as a source of knowledge."

Three surfaces, all core-AGPL and free forever:

1. **Provider registration** — an operator registers one or more knowledge providers.
2. **Retrieval** — Helpthread asks a registered provider for relevant knowledge, at
   request time, and receives passages with citations.
3. **A consumer-facing search API** — one documented endpoint that fans out across
   registered providers, so every consumer (the agent inbox, the embeddable widget, an AI
   module) speaks to knowledge the same way regardless of who provides it.

**This interface is free core and carries no commercial gate of any kind.** A first-party
paid knowledge-base module is one implementation of this contract and receives no
privileged path — the charter's *Extensibility without privilege* is the reason this spec
exists rather than a direct integration.

### 1.1 Pull, not push — and why

Helpthread **queries providers at request time**. It does not ingest, index, mirror, or
cache provider content as a matter of course.

The alternative — providers push content into a core-side index — was rejected on three
grounds. It would put a second authoritative copy of operator knowledge inside the
helpdesk, which is a synchronization problem with no correct answer once documents are
edited, unpublished, or have their visibility changed. It would make the core responsible
for reindexing on every provider-side change, requiring a resident indexing process the
*Founding deployment posture* rules out. And it would make relevance a core concern, which
would advantage whichever provider best matched the core's indexing assumptions — the
opposite of an equally-available mechanism.

Pull keeps the provider authoritative over its own content, its own relevance, and its own
permissions, and keeps the core's obligation narrow: ask well, filter defensively, cite
honestly.

The cost is real and is accepted: retrieval latency sits in the request path, and a
provider that is down means no results. §6 specifies the degradation.

### 1.2 Non-goals for v1

Each waits for a real consumer to need it.

- **No core-side indexing, ingestion, or content storage.** §1.1.
- **No write path.** The core never creates, edits, or publishes provider content.
  Authoring is a provider capability (charter, *Application and module model*).
- **No answer generation.** This interface returns passages and citations. Composing an
  answer belongs to the consumer — for conversation-facing answers, the separate
  auto-answers module.
- **No cross-provider deduplication or unified ranking beyond §5.4's stated merge.**
- **No knowledge events.** Whether article lifecycle changes should be observable through
  the core's event vocabulary is deliberately open (§9.3).
- **No provider-to-provider federation.** A provider that itself aggregates other sources
  is free to do so; the core does not orchestrate it.

## 2. The safety property this spec exists to protect

**Internal knowledge must never reach a customer.** Every other requirement here is
ordinary engineering; this one is the invariant.

It is protected by **two independent gates**, deliberately redundant:

1. **The provider filters.** Every retrieval request carries an explicit `audience`
   (§4.2). A provider must return only documents permitted for that audience.
2. **The core filters again.** Every result carries an `audience` classification (§4.3).
   The core **drops** any result whose classification is not permitted in the requesting
   context, before ranking, before returning, before any consumer sees it.

Gate 2 exists because gate 1 is implemented by software the project does not control. A
third-party provider with a permissions bug must not be able to leak internal content
through Helpthread.

**Classification is a property of the concrete document**, never inherited from a
collection, a category, a translation sibling, or any parent. The failure this forbids is
concrete: an English article is public while its German translation is still in internal
review; if classification were inherited from a shared parent, a German-language customer
query would surface unapproved internal content.

**Caching (§6.3) is keyed on audience** together with locale and the authorization scope of
the caller. A cache that ignores audience reintroduces the leak that gates 1 and 2 removed.

**Test-asserted invariants:**

- A result classified `internal` is never returned in a `customer` context, at any layer,
  under any provider response.
- A malformed or missing `audience` field on a result is treated as `internal` — fail
  closed, never open.
- A cache entry populated for one audience is never served to another.

## 3. Provider registration

`knowledge_providers` table: `id`, `name`, `base_url` (https only), `secret`
(server-generated, returned once, encrypted at rest via the existing token-crypto
AES-256-GCM envelope — signing needs the plaintext back), `module text NULL` (attribution
slug, mirroring `assistants.module` / `webhook_endpoints.module` per substrate-v1 §1's
additive-forward rule), `capabilities jsonb` (§3.2, refreshed at registration and on
demand), `status ('active','disabled','auto_disabled')`, consecutive-failure counter,
timestamps.

**Admin API** (Agent-authenticated, mirroring `substrate-v1.md` §5's webhook admin shape):
`POST /api/v1/knowledge/providers`, `GET /api/v1/knowledge/providers`, `PATCH …/{id}`,
`DELETE …/{id}`, `POST …/{id}/test` (performs a synthetic retrieval and reports what came
back, so an operator can prove a provider works before relying on it).

### 3.1 Outbound authentication and SSRF posture

Requests from Helpthread to a provider carry:

- `X-Helpthread-Signature: t=<unix-ts>, v1=<hex HMAC-SHA256(secret, t + "." + body)>` —
  the same Stripe-shape construction webhook delivery already uses (`substrate-v1.md` §5),
  so a provider author implements one signature scheme for both directions. Providers
  should reject a stale `t` (recommended window: 5 minutes).
- `X-Helpthread-Request`: unique request id, for correlation in provider logs.

**SSRF posture, identical to webhook delivery**: https only, redirects not followed, and
the retrieval client refuses URLs resolving to private or link-local ranges
(resolve-then-connect pinning). A `base_url` is operator-supplied and therefore untrusted.

### 3.2 Capability declaration and graceful degradation

A provider declares what it supports. The core adapts rather than requiring parity, because
requiring parity would make the contract satisfiable only by providers built like ours.

| Capability | If absent, the core… |
|---|---|
| `semanticSearch` | still sends the query; the provider does whatever matching it can |
| `localeFallback` | does not request cross-language fallback (§4.2) |
| `freshness` | receives no staleness signal and must not infer one (§4.3) |
| `translationGroups` | receives no grouping data and does not synthesize any |
| `chunking` | treats each result as a whole document; `chunkId` may be absent |

**Only `retrieve` (§4) is mandatory.** Everything else is optional. A provider that
implements one endpoint and returns whole documents with URLs is a valid, fully-supported
knowledge provider. This is the concrete test of *Extensibility without privilege*: the
minimum viable provider must be genuinely small.

## 4. Retrieval

`POST {base_url}/retrieve` — the one endpoint every provider implements.

### 4.1 Timeouts and blast radius

10-second timeout, matching webhook delivery. Retrieval is request-scoped work in a
serverless request path; there is no retry, because a retry doubles the latency an agent is
staring at. A provider that times out contributes no results and increments its
consecutive-failure counter; at the threshold it flips to `auto_disabled`, visible in the
admin API and surfaced by `/api/v1/internal/health` — the same lifecycle
`webhook_endpoints` already has.

**Providers are queried concurrently**, and the overall call returns when all have answered
or the timeout expires, whichever is first. One slow provider degrades that provider, never
the search.

### 4.2 Request

```json
{
  "query": "customer can't reset their password",
  "audience": "customer",
  "locale": "de-DE",
  "localeFallback": true,
  "limit": 10,
  "context": { "conversationId": "uuid" }
}
```

- **`audience`** — `customer` or `agent`. Required. Gate 1 of §2.
- **`locale`** — BCP 47. Optional; absent means the operator's default.
- **`localeFallback`** — whether a provider may answer in another language when it has
  nothing in the requested one. Only sent to providers declaring `localeFallback`.
- **`context`** — optional, and deliberately thin. `conversationId` lets a provider that
  also holds a Helpthread credential fetch more context itself. **The core never sends
  conversation content, customer identity, or message bodies to a provider.** A knowledge
  provider is a third-party system in the general case; shipping conversation data to it by
  default would put operator data somewhere the operator did not choose to put it. Anything
  richer is the provider's own authenticated call, on the operator's explicit configuration.

### 4.3 Response

```json
{
  "results": [
    {
      "documentId": "provider-defined-stable-id",
      "revision": "opaque-version-token",
      "chunkId": "optional-passage-id",
      "title": "Resetting your password",
      "snippet": "…the passage that matched…",
      "url": "https://help.example.com/de/passwort-zuruecksetzen",
      "locale": "de-DE",
      "audience": "public",
      "score": 0.87,
      "freshness": { "state": "current", "reviewDueAt": "2026-11-01T00:00:00Z" },
      "translationGroupId": "optional-provider-defined-key"
    }
  ],
  "requestedLocale": "de-DE",
  "returnedLocale": "de-DE"
}
```

Required on every result: `documentId`, `title`, `url`, `audience`. Everything else is
optional and its absence is meaningful rather than an error.

- **`audience`** — `public` or `internal`. Gate 2 of §2. **Missing or unrecognized is
  treated as `internal`.**
- **`revision`** — opaque to the core, compared only for equality. It exists so a citation
  can name the version that was actually read, which the charter's *Actor model* requires
  of AI work that must stay "attributable, reviewable."
- **`locale`, `requestedLocale`, `returnedLocale`** — together these tell a consumer whether
  it got an exact-language match or a deliberate cross-language fallback. **This distinction
  is not cosmetic**: without it an AI consumer can translate an outdated English policy into
  German and present it as current German guidance. Consumers are required to surface the
  difference; §5.3 states how.
- **`freshness`** — `current` | `stale` | `unknown`, with an optional review date. A
  document flagged for re-review may legitimately remain published; the signal exists so a
  consumer can decline to *auto-answer* from it while a human reading it sees it fine.
  Absent for providers not declaring `freshness`, and absence means `unknown`, never
  `current`.
- **`translationGroupId`** — optional, provider-defined, opaque. Present only from providers
  declaring `translationGroups`. **The core never requires it and never infers it.** A
  third-party knowledge base may model translations however it likes; requiring our model
  would hand a first-party module the privileged path this whole spec exists to prevent.

### 4.4 Retrieved content is untrusted input

A result's `title` and `snippet` are authored content from a system the project does not
control, and they flow onward into agent-facing UI and — through the auto-answers module —
into AI prompts.

- Rendered anywhere in core UI, they are treated as untrusted text and escaped. No HTML
  from a provider is rendered as markup by the core.
- Passed to any model, they are data, never instructions. Consumers must not act on
  directives appearing inside retrieved passages. This is stated in the contract because a
  compromised or careless provider is otherwise a prompt-injection path straight into an
  operator's outgoing customer mail.
- `url` is validated as https before it is offered as a link.

## 5. The consumer-facing search API

One endpoint, so every consumer speaks to knowledge identically.

`GET /api/v1/knowledge/search?q=…&audience=…&locale=…&limit=…`

Authenticated as either an Agent (the inbox, per `docs/modules/README.md`'s credential
table) or an Assistant (a module, using its existing bearer token — this extends
`substrate-v1.md` §3's fixed capability set by one read-only capability, `knowledge:read`,
and is the only substrate change this spec requires).

### 5.1 Audience is derived, never trusted from the caller

An Agent-authenticated call may request either audience. **An unauthenticated or
customer-facing surface may only ever produce `audience=customer`** — the widget path (§5.5)
derives it server-side and there is no parameter a browser can set to obtain internal
content.

### 5.2 What it returns

The merged, filtered result set — each entry carrying its originating provider's id and
name alongside the §4.3 fields, so a consumer can always show where an answer came from.

### 5.3 Locale honesty is mandatory for consumers

When `returnedLocale` differs from `requestedLocale`, the response marks the result
`localeFallback: true`. Consumers must not silently present it as if it were in the
requested language:

- Agent-facing UI labels it ("English — no German article").
- The auto-answers module must not generate a customer-facing answer in the requested
  language from a fallback-language source without that fact reaching the human reviewing
  the draft.

### 5.4 Merging across providers

Ordering is by provider-reported `score` where present, with results from providers
reporting no score interleaved round-robin after the top scored results. **This is
deliberately simple and deliberately documented as simple.** Cross-provider relevance
normalization is not solvable without either scoring content the core does not hold (§1.1)
or privileging providers whose scores resemble ours. Operators can order providers
explicitly; that ordering is the tie-break.

If real multi-provider use shows this is inadequate, the fix is a documented ordering
policy the operator controls — not a core ranking model.

### 5.5 The embeddable widget

The widget consumes this endpoint through the core, which means **KB search in the free
widget works with any registered provider and is never gated on buying a first-party
module.** The widget remains free with Helpthread branding; branding removal remains the
paid capability. Nothing here changes that line, and this interface is what keeps it
honest.

## 6. Failure, degradation, and caching

### 6.1 A provider being down is not an error

Search returns the results it has, plus a per-provider status list. A consumer showing zero
results because the only provider timed out must be able to say so rather than implying the
knowledge base is empty. The agent inbox never blocks on knowledge retrieval.

### 6.2 Auto-disable

Consecutive failures increment; at the threshold the provider flips to `auto_disabled` and
stops being queried until an operator re-enables it. Identical in shape to
`webhook_endpoints`, and surfaced the same way, so operators learn one lifecycle.

### 6.3 Caching

Optional, short-lived, and **keyed on `(providerId, query, audience, locale, callerScope)`**
— every element load-bearing. A cache omitting `audience` or `callerScope` is a §2
violation. Recommended default TTL is short (single-digit minutes): knowledge changes, and
an operator who unpublishes an article expects it gone.

Cached entries are invalidated by nothing in v1 — there is no push channel from provider to
core (§1.2). Short TTL is the whole mechanism, and that is stated rather than implied.

## 7. What this does not require of the core

Recorded so the boundary stays legible, per *Infrastructure before applications*:

The core gains provider registration, an outbound retrieval client, a merge-and-filter
step, one endpoint, and one Assistant capability. It gains **no** content model, no
authoring, no publishing, no editor, no taxonomy, no versioning, and no article schema.
Those are provider concerns, exactly as the charter's *Application and module model*
assigns them: "authoring, publishing, presentation, and management remain module
capabilities."

## 8. Test posture

Beyond §2's invariants:

- A minimum-viable provider — one `retrieve` endpoint, no declared capabilities, whole
  documents, no scores — is exercised end to end in tests. If that fixture ever needs more
  than the mandatory fields, the contract has stopped being equally available and the test
  is the alarm.
- A provider returning malformed results, wrong content types, oversized payloads, or
  results missing `audience` is exercised, and none of it reaches a consumer.
- A provider that times out, and one that 500s, both degrade to a per-provider status
  without failing the search.
- Fallback-locale results are asserted to carry `localeFallback: true` through to the
  consumer response.

## 9. Open questions for the maintainer

1. **Provider ordering as operator configuration** (§5.4) — confirm that explicit operator
   ordering plus provider-reported scores is the right v1 answer, rather than any core-side
   relevance model. Recommendation: yes; a core ranking model over content the core does not
   hold cannot be made fair across providers.
2. **`context.conversationId` in the retrieval request** (§4.2) — it lets a provider fetch
   its own context, but it also tells a third-party system that a specific conversation
   exists. Recommendation: keep it, because the id alone carries no content and the
   alternative is providers guessing; confirm the trade is acceptable.
3. **Knowledge events** (§1.2) — should the core's event vocabulary learn about knowledge
   changes, so modules can react to a published or expired article? A provider can already
   publish its own events through its own contract. A core vocabulary amendment is warranted
   only if the core must broker knowledge events across multiple providers. Deliberately
   left open; no v1 dependency.
4. **Whether `freshness` should ever be advisory to the core itself** — for example, the
   core declining to offer a `stale` result to a customer-facing surface by default rather
   than leaving that entirely to consumers. Recommendation: leave it to consumers in v1,
   because a core-side policy would apply unevenly across providers that do not report
   freshness at all.

## 10. Changelog

- **2026-08-02**: initial draft. Written after the maintainer's decision that Helpthread
  connects to any knowledge base rather than only a first-party module. Pull-based retrieval
  chosen over core-side indexing (§1.1); the internal-content-leak invariant and its two
  independent gates specified (§2); capability declaration added so a minimum-viable
  provider is genuinely small (§3.2); locale-fallback honesty made a contract requirement
  after an adversarial review identified stale-translation answers as a concrete
  customer-harm path (§4.3, §5.3).
