# Knowledge Provider Interface v1 — connecting a knowledge base

Vocabulary (fixed, like Agents/Assistants/modules): a **knowledge provider** is any HTTP
endpoint implementing this contract. A **document** is one retrievable unit of knowledge in
one language. A **chunk** is an addressable passage of a document. Helpthread is always the
**consumer**; the provider is always the **source**. An **adapter** is a provider
implementation that fronts an existing product (Notion, Confluence, a static site) — §1.3
explains why adapters are the normal case, not the exception.

Status: **draft for maintainer review.** Governed by the Founding Charter (v2, adopted
2026-07-23) — principally *Extensibility without privilege*, *Public APIs and events*,
*Infrastructure before applications*, and *Operator ownership*. **Amends `substrate-v1.md`
§3** (§5.2 of this document); that amendment is explicit, not inherited.

## 1. Purpose & scope

Helpthread can consult knowledge, and is not tied to any particular knowledge base to do
it. This spec defines the public contract that makes that true.

**The originating decision (maintainer, 2026-08-02):**

> "we are not going to limit Helpthread to using our KB module only - Helpthread should be
> able to connect to any knowledgebase as a source of knowledge."

That quotation decides **provider neutrality** and nothing else. Every other choice in this
document is this spec's own, is marked as a recommendation where it is genuinely open, and
is listed in §10 where it needs a maintainer answer.

Three surfaces, all core-AGPL and free forever:

1. **Provider registration** — an operator registers one or more knowledge providers, each
   with a fixed **exposure profile** (§2).
2. **Retrieval** — Helpthread asks a registered provider for relevant knowledge at request
   time and receives passages with citations.
3. **A consumer-facing search API** — so the agent inbox, the embeddable widget, and AI
   modules all speak to knowledge the same way regardless of who provides it.

**This interface is free core and carries no commercial gate.** A first-party paid
knowledge-base module is one implementation of this contract and receives no privileged
path: no in-process API, no extra metadata channel, no privileged registration flag, and no
relaxed customer-safety path. §8 makes that testable rather than asserted.

### 1.1 Pull, not push

Helpthread **queries providers at request time**. It does not ingest, index, or mirror
provider content.

**This is a recommendation, not a charter requirement.** An earlier draft claimed the
charter's *Founding deployment posture* "rules out" a core-side indexing process; that was
an overstatement — the charter explicitly permits "queueing, scheduled and durable work"
behind provider interfaces. The argument for pull stands on its own merits:

- A core-side index is a second copy of operator knowledge, and copies desynchronize
  exactly when it matters most — when a document is edited, unpublished, or reclassified.
  Stale authorization state is the failure mode §2 exists to prevent.
- It keeps relevance a provider concern. A core index would rank best for whichever provider
  most resembled the core's indexing assumptions.
- It keeps the core's obligation narrow: ask well, route safely, cite honestly.

The costs are real and accepted: retrieval latency sits in the request path, a provider that
is down contributes nothing (§6), and the core cannot search knowledge offline. If those
costs prove wrong in practice, an optional provider-declared index is an additive change,
not a rewrite. Recorded as open decision **§10.1**.

### 1.2 Non-goals for v1

- **No core-side indexing, ingestion, or content storage.**
- **No write path.** Authoring, publishing, and management are provider capabilities
  (charter, *Application and module model*).
- **No answer generation.** This interface returns passages and citations. Composing an
  answer belongs to the consumer.
- **No customer-specific entitlement.** §2.4 — customer retrieval reaches globally public
  content only.
- **No cross-provider deduplication.** §5.5's merge is deliberately simple.
- **No knowledge events**, no pagination (§4.5), no provider-to-provider federation.
- **No first-party connectors for third-party products.** §1.3.

### 1.3 What "connect any knowledge base" honestly means

**Most existing products cannot implement this contract directly.** Notion, Confluence, and
Guru do not expose a Helpthread-shaped endpoint; a static documentation site has no
request-time compute at all. Each needs a small **adapter** — a service that receives this
contract's request, queries the product, and maps the result back.

The accurate claim is therefore: **any knowledge base with a usable search or content API
can participate, through an adapter implementing this contract.** The unqualified "connects
to anything" claim is not true and should not be made in documentation or marketing.

**The project does not ship adapters for third-party products in v1** (maintainer decision,
2026-08-02). The charter requires the same public mechanism, not a finished integration, and
states directly that "Replacement does not need to be effortless. It must remain
architecturally possible." A first-party module being designed around this interface is
commercial advantage, not platform privilege.

**What the project does ship, because the alternative is a contract that drifts** (maintainer
decision, 2026-08-02): a machine-readable schema for the request and response (§4), and a
**conformance suite written against this contract rather than against any implementation**,
which the first-party module passes unchanged (§8). Without these, ambiguities get resolved
silently in whatever way the only existing implementation happens to behave, and the public
path becomes nominal without anyone deciding that it should.

## 2. Exposure profiles — the safety model

**This section addresses results returned through the knowledge-provider interface. It does
not claim that Helpthread as a whole prevents all internal information from reaching a
customer.** It states the conformance requirements, the trust assumptions they rest on, and
the known residual disclosures.

The scoping matters: an earlier draft opened with the unqualified sentence "internal
knowledge must not reach a customer," which reads as a whole-product confidentiality
guarantee — and §2.7 says outright that Helpthread does not deliver one.

### 2.1 What an earlier draft got wrong

An earlier draft claimed "two independent gates": the provider filters by a requested
audience, and the core filters again on a per-result audience label. **Those gates are not
independent.** Both rest on the same provider-supplied fact. A provider that mislabels an
internal document as public defeats both simultaneously, and the core cannot tell that
response from a legitimate one. The claim is withdrawn.

### 2.2 The model: route by destination, isolate by credential

**A provider registration carries a fixed exposure profile**, set at registration and not
changeable by any request parameter:

| Profile | Meaning |
|---|---|
| `customer_safe` | Its credential can reach **only** content the operator has published to the general public. |
| `agent_only` | May reach internal content. Never queried from any customer-facing path. |

**A customer-egress retrieval path is one whose results can be supplied directly to a
customer, or to an Assistant capable of customer-directed output.** Routing follows that
definition:

- **The embeddable widget** — customer-egress. `customer_safe` only.
- **Any Assistant that can produce customer-directed output** (a draft reply, an automated
  response) — customer-egress. `customer_safe` only, *regardless of its read access
  elsewhere*.
- **Agent inbox search** — **not** a customer-egress path. Agents may query both profiles,
  and remain responsible for what they put in a reply.

Two clarifications, both corrections to earlier drafts:

The Assistant rule replaces reasoning that "the reader is trusted." An auto-answers module
reads with Assistant credentials and writes toward customers; it is an egress path, and human
approval of a draft is an operational control, **not a confidentiality boundary** — a
reviewer can approve a draft without recognising that a sentence in it was internal.

The Agent rule is where "route by where the answer can end up" was too loose as a slogan: an
Agent can read an internal article and paste it into a customer reply, and no interface can
stop that. The real distinction is **automated or direct customer egress versus a trusted
human workflow**, and this contract governs only the former.

**The boundary is the credential's reach, not the URL.** Two endpoints on one system sharing
one unrestricted credential are not isolation. What a `customer_safe` registration must mean
is that the credential it holds *cannot retrieve internal content at all* — an anonymous
public API, a published site, or a separately deployed public projection. A provider may
register twice with genuinely permission-separated credentials; it may also legitimately
share a URL if and only if the two credentials differ in what they can reach.

**`customer_safe` is the minimum useful provider.** Internal search is the optional second
profile. A provider that only ever serves public content implements one profile and is
complete — which keeps the cheap path the safe one, and means an adapter author is not
forced to build internal-content handling they do not want.

### 2.3 Security property required for conformance

Because the implementation and the conformance suite are planned rather than built (§8.2),
the following is a **normative requirement on a conforming v1 implementation, not a claim
about code that ships today**:

> Given a `customer_safe` registration whose credential the provider in fact enforces as
> restricted to a globally public corpus, a customer-egress retrieval request can query only
> `customer_safe` registrations, returns only results labelled `public` through the customer
> projection, and neither reads nor writes an agent-path cache. It cannot query, or return a
> result obtained from, an `agent_only` registration.

**This property is limited to retrieval through this interface.** It does not cover provider
or operator misconfiguration, text an Agent chooses to put in a reply, or information
obtained through any other Helpthread API.

Subject to its stated assumption, it prevents a request parameter widening the retrieval
profile, prevents an agent-path cache entry crossing into a customer-egress response, and
limits a stolen customer-egress credential to `customer_safe` registrations. **It does not
make a mixed-corpus or over-privileged `customer_safe` registration safe.**

It also does not establish that returned text is semantically public. A provider can
associate its public credential with the wrong collection, return internal text labelled
`public`, or an operator can publish an internal article into a genuinely public corpus.
**This contract cannot detect or prevent those conditions from the returned text alone** —
other architectures could add independent classification, public-origin verification, or
approval workflows, and this one deliberately does not.

The per-result `audience` field (§4.4) is retained as **schema validation and a tripwire**,
not as an authorization decision: a `customer_safe` provider returning anything labelled
`internal` is misconfigured, and the core drops the result and records a health warning.

### 2.4 Customer retrieval reaches globally public content only

There is no customer identity, tenant, plan, or entitlement in this contract. A document
meant for one customer but not another cannot be expressed: marking it public leaks it,
marking it internal makes it unreachable.

**v1 therefore states the limit rather than implying a capability it lacks**: customer-facing
retrieval reaches globally public content. Authenticated per-customer knowledge requires a
customer identity that does not exist anywhere in Helpthread today, and belongs to whichever
future module owns end-user identity.

### 2.5 Fail closed

- A missing, malformed, or unrecognised `audience` on a result is treated as `internal`.
- **If no `customer_safe` provider is configured, customer-facing search returns no
  knowledge.** It never falls back to an `agent_only` provider, and it never degrades to
  "search everything and filter." Absence of knowledge is an acceptable outcome; disclosure
  is not.
- A provider whose profile is unset cannot be queried at all.

### 2.6 Conformance invariants to be test-asserted

- No customer-egress retrieval request can query an `agent_only` registration, or return a
  result obtained from one, for any allowed request parameter, **customer-egress**
  credential, cache state, or provider response. (Agent credentials may query `agent_only`
  by design — §2.2.)
- An Assistant capable of customer-directed output cannot be granted
  `knowledge:read_internal`, and its retrieval can query only `customer_safe` registrations.
  (Scoped to this interface: §2.7 records what this does not cover.)
- Customer-egress responses use exactly the customer projection in §5.4, containing no
  dedicated provider-identity or status, total-count, score or rank, document/revision/chunk,
  audience or freshness, or translation-group field. Array length and order, returned URLs,
  and response timing remain observable, as §5.4 describes.
- Customer-egress retrieval never reads or writes a retrieval cache.
- A `customer_safe` provider returning an `internal`-labelled result has that result dropped
  and a health warning recorded.
- With no `customer_safe` provider configured, **every** customer-egress path returns no
  results.

### 2.7 A gap this spec does not close, stated plainly

Assistants today read conversations through the same read API Agents use, which includes
internal notes. **A perfectly safe knowledge path therefore does not deliver a general
"internal information never reaches a customer" property** — a drafting Assistant can
disclose an internal note instead of an internal article.

That is a substrate-level issue, larger than this spec and not created by it. Closing it
requires an **enforced customer-visible conversation projection that excludes internal notes
before the model call**. Human review alone will not do: §2.2 already establishes that draft
approval is an operational control, not a confidentiality boundary, and that reasoning does
not become weaker when applied to notes instead of articles.

Until that projection exists, a conversation-reading Assistant cannot conform to §4.6 for
customer-directed output. Recorded as open decision **§10.2**. **This gap limits the scope of
§2.3; it does not negate the knowledge-interface property.**

## 3. Provider registration

`knowledge_providers` table: `id`, `name`, `base_url` (https; see §3.2), `exposure_profile`
(`customer_safe` | `agent_only`, required, immutable after creation — changing exposure
means a new registration), `secret` (server-generated, returned once, encrypted at rest via
the existing token-crypto AES-256-GCM envelope — signing needs the plaintext back),
`previous_secret` + `secret_rotated_at` (nullable; §3.1), `module text NULL` (attribution
slug, mirroring `assistants.module` / `webhook_endpoints.module` per substrate-v1 §1's
additive-forward rule), `capabilities jsonb`, `contract_version`, `priority int` (operator
ordering, §5.5), `status`, failure counters (§6.2), timestamps.

**Admin API**: `POST /api/v1/knowledge/providers`, `GET …`, `PATCH …/{id}`, `DELETE …/{id}`,
`POST …/{id}/rotate-secret`, `POST …/{id}/test`.

**Authorization, stated exactly rather than by analogy.** These routes require the
deployment's service Bearer token **plus** an `X-Helpthread-Agent-Id` naming an Agent whose
`role === 'admin'` — the same three-part requirement the shipped webhook admin routes
enforce (`src/api/webhooks.ts`). An earlier draft said only "Agent-authenticated," which
would have let any Agent register an SSRF target and read back a signing secret.

`POST …/{id}/test` performs a synthetic retrieval and returns what came back. It is
**admin-only, never customer-shaped**: it does not accept an audience parameter, it queries
only the registration under test, it writes nothing to any cache shared with live traffic,
and it does not increment the failure counters that drive auto-disable.

### 3.1 Outbound authentication

Requests from Helpthread to a provider carry:

- `X-Helpthread-Signature: t=<unix-ts>, n=<nonce>, v1=<hex HMAC-SHA256(secret, t + "." + n + "." + rawBody)>`
  — the same HMAC construction shipped `signWebhookPayload` uses, extended with a nonce
  inside the signed material. Signature is computed over the **raw body bytes**, not a
  re-serialization.
- `X-Helpthread-Request`: the same nonce, for log correlation.

**Providers must reject** — not "should" — a request whose timestamp falls outside a
5-minute window, and must reject a repeated nonce within that window. An earlier draft's
"should" left a compliant provider able to serve captured requests indefinitely, and left
the request id outside the signature where it could be altered freely.

**Rotation**: the core is the *signer* and the provider the *verifier*, so an overlap window
only works if the core sends both signatures. `rotate-secret` mints a new secret and retains
the previous one for a window (default 24h); during it, the core emits **both** in one
header — `v1=<hmac-new>,v1=<hmac-previous>` — and a provider accepts the request if **any**
`v1` value matches the secret it holds. This is the multi-signature scheme Stripe uses for
the same reason. An adapter can then be redeployed with the new secret at any point in the
window with no failed requests in either direction.

(An earlier draft said the core "retains the previous secret… during which either verifies,"
which does nothing: the core signs with exactly one secret, so a provider still holding the
old one would have rejected every request.)

Signatures, secrets, and nonces are never logged.

### 3.2 Network posture, and the operator's own wiki

https only, redirects not followed, resolve-then-connect DNS pinning — matching webhook
delivery.

**Private and link-local address ranges are refused by default.** An earlier draft named "an
operator's own wiki" as a supported case while forbidding exactly the addresses such a wiki
usually lives on. Both cannot be true. The resolution: a registration may set
`allow_private_network: true`, which is **admin-only, off by default, logged, and displayed
prominently in the admin surface as an SSRF-risk acknowledgement**. An operator running an
internal wiki can then use it deliberately; nobody gets there by accident.

### 3.3 Capability declaration

A provider declares capabilities at registration, and the core re-reads them from
`GET {base_url}/capabilities` when the operator asks. The core adapts rather than requiring
parity — requiring parity would make the contract satisfiable only by providers built like
the first-party one.

| Capability | Absent means |
|---|---|
| `semanticSearch` | the provider matches however it can; the core does not care |
| `locale` | the core sends no locale and expects none back |
| `localeFallback` | the core never requests cross-language fallback |
| `freshness` | no staleness signal; the core must not infer one |
| `translationGroups` | no grouping data; the core synthesizes none |
| `chunking` | results are whole documents; `chunkId` absent |
| `scoring` | no `score`; ordering falls to operator `priority` (§5.5) |
| `citationUrl` | results carry no `url`; consumers show text without a link |

**Only `retrieve` is mandatory.** §8 states what "minimum viable provider" actually costs,
because an earlier draft's claim that it was "one endpoint" was not honest accounting.

## 4. Retrieval

`POST {base_url}/retrieve`, `Content-Type: application/json; charset=utf-8`.

### 4.1 Contract versioning

The provider contract carries its **own** version, independent of the core's `/api/v1`:
`X-Helpthread-Knowledge-Version: 1` on every request, and `contractVersion` in every
response. Additive optional fields do not bump it; any change to a required field, a
default, or a filtering rule does. Unknown fields are ignored by both sides. A provider
responding with an unsupported version is treated as failed, not as empty.

### 4.2 Limits, timeouts, and failure classes

- **Timeout**: 10 seconds, wall clock, **including DNS resolution** — the shipped webhook
  client's abort excludes it, and that gap is closed here rather than inherited.
- **Response size**: 1 MiB. Larger is truncated-and-failed, never partially parsed.
- **No retry within a request.** A retry doubles latency an agent is watching.
- **Failure classes are distinguished**, because treating them alike disadvantages
  externally-hosted providers that a co-located first-party module would rarely hit:

| Class | Core behaviour |
|---|---|
| `429` / `503` with `Retry-After` | honoured; counts toward a transient budget, not the disable counter |
| Timeout / connection failure | transient budget |
| `401` / `403` | configuration failure — surfaced to the operator immediately, disabled after a low threshold |
| Malformed or unsupported-version response | contract failure — surfaced, low threshold |
| `5xx` without `Retry-After` | transient budget |

Providers are queried **concurrently**; the call returns when all have answered or the
timeout expires.

### 4.3 Request

```json
{
  "query": "customer can't reset their password",
  "limit": 10,
  "locale": "de-DE",
  "localeFallback": true,
  "context": { "conversationId": "uuid" }
}
```

- **`query`** — required, non-empty, ≤ 1024 characters.
- **`limit`** — optional; default 10, maximum 50. Providers may return fewer, never more.
- **`locale`** — BCP 47. Sent only to providers declaring `locale`.
- **`localeFallback`** — sent only to providers declaring `localeFallback`.
- **`context.conversationId`** — **sent only to `agent_only` providers, and only when the
  operator has enabled it on that registration.** It is never sent to a `customer_safe`
  provider: telling a public-facing source that a specific conversation exists is a
  disclosure with no compensating benefit, and it would let a provider tailor results per
  conversation on a path where the core cannot reason about who is asking.

**No audience parameter exists.** Exposure is a property of the registration (§2.2), not of
the request, so there is nothing for a caller to tamper with and nothing for core code to
widen by mistake.

**What the core sends, stated accurately.** The core never *itself* adds conversation
content, message bodies, customer identity, or attachments to a retrieval request — the
fields above are the entire request. But `query` is caller-supplied text, and a caller can
put anything in it: an agent may paste a customer's words, and an automated consumer may
build a query from a conversation. **So the guarantee is on the core's own construction, not
on the bytes that ultimately leave.**

Consumers therefore carry an obligation the core cannot enforce: a consumer that derives a
query from conversation content must send only what retrieval needs, and must treat a
provider as a third-party recipient of whatever it puts in `query`. This is stated because
an earlier draft's absolute claim was false and would have been relied on.

### 4.4 Response

```json
{
  "contractVersion": 1,
  "results": [
    {
      "documentId": "provider-defined-stable-id",
      "title": "Resetting your password",
      "snippet": "…the passage that matched, as plain text…",
      "audience": "public",
      "revision": "opaque-version-token",
      "chunkId": "optional-passage-id",
      "url": "https://help.example.com/de/passwort-zuruecksetzen",
      "locale": "de-DE",
      "score": 0.87,
      "freshness": "current",
      "reviewDueAt": "2026-11-01T00:00:00Z",
      "translationGroupId": "optional-provider-defined-key"
    }
  ],
  "returnedLocale": "de-DE"
}
```

**Required on every result: `documentId`, `title`, `snippet`, `audience`.**

`snippet` is required because an earlier draft made it optional while claiming a
title-and-link-only provider was "fully supported." It is not: a provider returning no text
supplies nothing an AI consumer can ground an answer in and nothing an agent can read
without leaving the page. A contract whose stated minimum cannot serve its stated purpose is
a broken contract. `snippet` is **plain text** — providers send no markup, and the core
renders none (§4.6).

Optional fields, and what their absence means:

- **`audience`** — `public` | `internal`. Tripwire only (§2.3), not authorization. Missing
  or unrecognised is treated as `internal` and dropped.
- **`revision`** — opaque, compared only for equality. A **recommended** provenance
  mechanism so a citation can name the version actually read. An earlier draft attributed
  this requirement to the charter's *Actor model*; the charter requires AI work to stay
  attributable and reviewable, which is weaker and does not mandate revision tokens.
- **`freshness`** — `current` | `stale` | `unknown`, a **string**, with `reviewDueAt` as a
  separate optional field. (An earlier draft defined this as an object in the example and an
  enum in the prose.) Absent means `unknown`, never `current`.
- **`translationGroupId`** — opaque, provider-defined, **never required and never inferred**.
  A third-party knowledge base may model translations however it likes; requiring the
  first-party module's model would be the privileged path this spec exists to prevent.
  **Stripped entirely on customer paths** (§5.4).
- **`url`** — see §4.6.
- **`returnedLocale`** — computed by the core **after filtering**, from results that survived
  it. A provider-supplied envelope value is ignored, since it could otherwise describe a
  document the consumer never receives.

### 4.5 No pagination in v1

Search is **top-K only, permanently in v1** — there is no cursor, no continuation token, and
no snapshot semantics. Stable cross-provider pagination would require either a core-side
merged result set held across requests or per-provider cursors the core cannot reconcile.
Stated explicitly so it is a decision rather than an omission.

### 4.6 Retrieved content is untrusted, and "data not instructions" is not a control

A result's `title`, `snippet`, and `url` are authored in a system the project does not
control, and they flow into agent-facing UI and into AI prompts.

**Core obligations:**

- `title` and `snippet` are rendered as escaped plain text. No provider-supplied markup is
  rendered as markup, anywhere.
- `url`, when present, must be `https`, must resolve to a **public** destination, must carry
  no userinfo component, and is never fetched automatically by the core or offered to a model
  as something to retrieve. A URL failing these checks is dropped and the result is shown
  without a link.

**Consumer obligations, stated normatively because an earlier draft's "treat them as data,
never instructions" is an aspiration and not a boundary.** Models do not reliably separate
instructions from data, and a `public` passage can contain text instructing a model to
disclose whatever else is in its context. Therefore, any model call that can produce
customer-directed output:

1. contains **only** customer-visible conversation content and already-filtered
   `customer_safe` results — no internal notes, no agent-context retrieval, no secrets;
2. exposes **no tools** capable of network fetch, sending, or file access;
3. treats retrieved passages as quoted source material in a structurally separate part of
   the prompt, never as system or developer instruction;
4. re-checks provenance at the outbound sink: every citation in generated output must
   correspond to a result that actually survived filtering for that request;
5. is exercised by prompt-injection tests in the consuming module's own suite.

These are requirements on consumers, including the first-party auto-answers module. This
spec cannot enforce them from the core, and says so rather than implying the core has.

## 5. The consumer-facing search API

`POST /api/v1/knowledge/search` — POST rather than GET so query text and parameters stay out
of URLs, logs, and referrers. Responses carry `Cache-Control: private, no-store`, and
intermediary caching is prohibited on this route.

### 5.1 Callers and their ceilings

Three things are fixed per credential — what it may reach, which projection it receives, and
whether its results may be cached. They are decided together, by **egress class**: whether
the caller can put text in front of a customer.

| Caller | May reach | Projection | Cacheable |
|---|---|---|---|
| Agent (service token + acting-Agent id, per `docs/modules/README.md`) | `customer_safe` + `agent_only` | agent | yes (§6.3) |
| Assistant holding `knowledge:read_internal` — **future; unreachable in v1, see §5.2** | `customer_safe` + `agent_only` | agent | yes (§6.3) |
| Assistant holding `knowledge:read_public` | `customer_safe` only | **customer** | **no** |
| Widget route (§5.3) | `customer_safe` only | customer | no |

**The ceiling is a property of the credential, immutable per request.** No parameter selects
a wider scope.

The third column is not cosmetic. An earlier draft left Assistant callers unassigned, which
left a real disclosure path: a `customer_safe` result is cached while public, its source
article is then unpublished or reclassified, and a drafting Assistant serves the stale entry
into customer output. Any credential that can reach a customer therefore gets the customer
projection and no caching, so the freshness rule in §6.3 covers every egress path rather
than only the widget.

### 5.2 Substrate amendment (explicit)

This spec **amends `substrate-v1.md` §3**, which today defines a fixed capability set with no
named scopes. An earlier draft claimed to leave the substrate unchanged while adding a
capability to it — a contradiction, corrected here.

Two capabilities are added, **default-deny**: `knowledge:read_public` and
`knowledge:read_internal`. Existing Assistants receive neither on migration; an admin grants
them explicitly. **An Assistant that can post drafts or otherwise produce customer-directed
output must not hold `knowledge:read_internal`**, and the grant path refuses that
combination rather than trusting configuration discipline.

This is the substrate's first named capability. It is deliberately two flags rather than a
general scopes system — substrate-v1 §1's "capability enforcement lives at one point" means
a real scopes model can replace it additively later.

**`knowledge:read_internal` is unreachable in v1, and this spec says so rather than shipping
a dead grant.** Every Assistant under the shipped model can post drafts and notes — that is
the fixed capability set, not a configurable one — so *every* Assistant is a customer-output
principal, and the rule above forbids all of them the internal grant. Making it reachable
requires draft-posting to become separately revocable, which is substrate work this spec does
not do.

The consequence, stated plainly: **in v1, Assistants get `knowledge:read_public` and nothing
else.** `knowledge:read_internal` is defined here so the model is coherent and so a
non-drafting Assistant class has somewhere to land when it exists. An implementation must
refuse to grant it until then rather than granting it and relying on operator discipline.

### 5.3 The widget route

The widget does **not** call §5's endpoint. It calls a distinct route with a distinct
credential class, on which:

- exposure is hard-wired to `customer_safe` — the concept of an agent-only provider does not
  exist on this code path;
- there is no audience, provider-selection, or profile parameter in the request schema;
- the response uses the customer projection (§5.4);
- with no `customer_safe` provider configured, it returns empty (§2.5).

An earlier draft asserted the widget "derives audience server-side" without specifying a
route, which would have left an implementation free to expose the general endpoint and
overwrite a parameter — a correct-by-review rather than correct-by-construction design.

**The widget path is free core and works with any registered `customer_safe` provider.**
Whether the widget's own commercial terms change is a product question for the module
catalog, not this spec; an earlier draft asserted those terms here and should not have.

### 5.4 Two response projections

**Agent projection** — the full §4.4 fields, plus originating provider id and name, plus a
per-provider status list (§6.1).

**Customer projection** — `title`, `snippet`, `url`, `locale`, and a `localeFallback` flag.
**Nothing else.** Specifically absent: provider identity, per-provider status or error
detail, result counts beyond what is returned, scores, `documentId`, `revision`, `chunkId`,
`translationGroupId`, `audience`, and `freshness`.

Each omission closes a side channel. Provider identity and status reveal an operator's
internal tooling. Scores and counts reveal that *something* matched and was withheld —
`translationGroupId` most sharply, since a group key present on a public German article can
reveal that an internal sibling exists. Filtering results while leaving their metadata is
not filtering.

**Filtering happens before any cache write and again on read** (§6.3). A raw provider
envelope is never stored where a customer path can reach it.

**Residual signals this cannot remove, named rather than glossed.** Stripping explicit
metadata is not non-interference. If a misconfigured `customer_safe` provider returns mixed
results and the tripwire drops the internal ones, then **the number of surviving results and
their order still vary with what was withheld** — a JSON array discloses its own length.
Returned `url` values can also identify a provider despite no provider field being present.
And **timing** differs measurably between a query that matched withheld content and one that
matched nothing.

These signals do not directly return withheld passage text, but chosen-query observation can
reveal facts about whether particular content exists or matches. v1 does not mitigate them:
backfilling to a constant result count would require querying past the limit on every
request, and constant-time fan-out across external providers is not achievable.

**What follows from this** is the point of §2.3: the tripwire is a misconfiguration alarm,
not a containment boundary. A `customer_safe` registration pointed at a mixed corpus is a
misconfiguration to be detected and fixed, not a state the core makes safe. Recorded at
§10.3.

### 5.5 Locale honesty

When `returnedLocale` differs from the requested locale, results carry `localeFallback:
true` and consumers must surface it. Agent UI labels it. A customer-directed answer must not
be generated in the requested language from a fallback-language source without that fact
reaching the human reviewing the draft — otherwise an outdated English policy becomes
confident current German guidance.

### 5.6 Merging across providers

**Operator `priority` is the primary ordering**, then provider-reported `score` within a
priority band, then round-robin for providers declaring no `scoring` capability.

Operator ordering leads rather than score because scores from different providers are not
comparable, and ordering by raw score privileges whichever providers produce
confidently-scaled numbers. Cross-provider relevance normalization is not solvable without
scoring content the core does not hold.

## 6. Failure and caching

### 6.1 A provider being down is not an error

The agent projection returns results plus a per-provider status list, so a consumer showing
nothing can say why rather than implying the knowledge base is empty. The customer
projection carries no status (§5.4). The agent inbox never blocks on retrieval.

### 6.2 Auto-disable is a circuit breaker, not a counter

Transient failures (§4.2) open a circuit with exponential backoff and periodic probing;
recovery closes it without operator action. Configuration and contract failures escalate to
the operator quickly and disable at a low threshold. Failures driven by widget traffic do
not disable a provider for agent traffic — otherwise anonymous request volume becomes a way
to degrade staff tooling.

### 6.3 Caching

**Customer-path responses are not cached in v1.**

A short TTL cannot deliver §2's property. If an article is unpublished or reclassified, a
customer cache entry written legitimately moments earlier remains servable — audience keying
does not help, because the entry was correct when written. An earlier draft acknowledged
"invalidated by nothing in v1" while claiming an absolute guarantee; those cannot both hold,
and the cache is what gives way.

**Agent-path caching is optional**, keyed on the full tuple `(providerId, providerConfigGeneration,
normalizedQuery, locale, localeFallback, normalizedLimit, contractVersion, callerScope)`,
where `callerScope` is the canonical identifier of the authenticated principal and its
granted capabilities. **Caching is disabled entirely whenever `context.conversationId` is
present**, since the provider may have tailored results to it. Default TTL is short
(single-digit minutes). Entries are written post-filter and re-validated on read.

## 7. What this does not require of the core

The core gains provider registration, an outbound retrieval client, routing and filtering,
two endpoints, and two Assistant capabilities. It gains **no** content model, authoring,
publishing, editor, taxonomy, versioning, or article schema. Those are provider concerns,
exactly as the charter's *Application and module model* assigns them.

**Module API designation.** The routes in §3 and §5, and the provider contract in §4, are
added to the published `docs/modules/` surface. That designation matters for the future
AGPL-3.0 §7 additional permission, which per `legal/module-api-exception.md` is **not
adopted and grants nothing today**; the designation is documentation, not a licensing act.

## 8. Conformance, and honest minimum-provider accounting

### 8.1 What a minimum provider actually costs

An earlier draft claimed "one endpoint." The honest checklist:

1. A continuously-available public HTTPS endpoint with a valid certificate.
2. Accepting and validating this contract's request schema.
3. Verifying the HMAC signature over raw bytes, with timestamp and nonce rejection.
4. Searching the underlying corpus and responding within 10 seconds.
5. Producing a stable `documentId` per document.
6. Producing `title` and a plain-text `snippet`.
7. Emitting the response envelope with `contractVersion`.
8. Holding a credential whose reach matches its registered exposure profile.

That is a small service, but it is a service — with hosting, a certificate, and a credential
store. **For a static documentation site it additionally requires a search index**, since a
static site has no request-time compute. Stating this is what keeps §1.3's claim honest.

### 8.2 The conformance suite

**Planned deliverable, not an existing one.** A black-box conformance suite, written against
this contract and runnable against any URL, published rather than repository-internal. It
ships alongside the implementation of this spec; the first-party module is required to pass
it unchanged in CI, and the suite — not the first-party module's behaviour — is the
definition of conformance.

Stated as a requirement on future work because it is one. Nothing here has been built.

Beyond §2.6's invariants, it exercises: a minimum provider (mandatory fields only, no
declared capabilities); malformed, oversized, wrong-content-type, and unsupported-version
responses; results missing `audience`; each failure class in §4.2; timestamp and nonce
rejection; secret rotation across the overlap window; and fallback-locale flagging surviving
to the consumer.

**Privilege check, asserted rather than promised**: the first-party module registers through
the public admin API, holds no capability unavailable to a third party, receives no
in-process call path, and reaches no field or route absent from this document.

## 9. Deliberately accepted costs

Recorded so they are decisions rather than discoveries: retrieval latency in the request
path; no offline knowledge search; no pagination; no per-customer entitlement; timing side
channels unmitigated; no customer-path caching, so every widget search is a live fan-out;
and adapters required for existing products, written by whoever wants the integration.

## 9.1 What this document does not yet specify

This is a contract and a safety model, not an implementation specification. The following
must be settled before or alongside implementation, and are listed so their absence is
visible rather than discovered:

- Full JSON schemas for the provider request and response and for every route in §3 and §5,
  published as a named, versioned artifact — §1.3's anti-drift commitment is not satisfied by
  prose examples.
- A fixed error-code vocabulary and error envelope for provider responses.
- **Global merge limit.** `limit` is currently per provider, so N providers can produce
  N×limit results. The merged cap and how it interacts with §5.6's ordering are undefined.
- Capability grant and revoke API, persistence, and migration for §5.2's two flags.
- Nonce format and entropy, replay-store atomicity across multiple core instances, and
  clock-skew tolerance.
- Circuit-breaker constants: thresholds, backoff curve, probe interval, and the exact state
  machine. §6.2 is a policy, not yet a specification.
- Cache-key normalization rules and what increments `providerConfigGeneration`.
- Maximum lengths and uniqueness rules for `documentId`, `chunkId`, `title`, `snippet`,
  `url`, and `translationGroupId`.
- Abuse controls on the public widget route, with failure behaviour uniform enough not to
  become its own side channel.
- `allow_private_network` (§3.2) needs its exact permitted-range semantics, re-resolution
  behaviour, and audit-record shape — an escape hatch this sharp should not be left to
  implementer judgement.

## 10. Open questions for the maintainer

1. **Pull versus an optional provider-declared index** (§1.1) — recommendation: pull only in
   v1; an index is additive later if latency proves unacceptable.
2. **The conversation-notes gap** (§2.7) — a drafting Assistant can disclose an internal note
   even with a conforming knowledge path. It needs an enforced customer-visible conversation
   projection applied before the model call; human review alone is not a confidentiality
   boundary. **Recommendation: require that projection before the auto-answers module ships.
   It does not block this interface.**
3. **Timing side channel** (§5.4) — recommendation: accept and document for v1.
4. **`context.conversationId` on agent-only providers** (§4.3) — off by default, operator
   opt-in per registration. Confirm that is the right default.
5. **`allow_private_network`** (§3.2) — confirm that an admin-only, off-by-default,
   prominently-warned escape hatch is the right resolution for operator-hosted wikis.
6. **MCP as an optional transport later** — the Model Context Protocol standardizes server
   interaction and authorization but not this contract's semantics; a provider would still
   need an MCP server. Plausible as an additional transport once the contract is stable, not
   as a replacement for it in v1.

## 11. Changelog

- **2026-08-02**: initial draft, then substantially revised before review after two
  adversarial passes (Codex, read-only). The first draft claimed "two independent gates"
  protecting internal content; **they were not independent** — both rested on the same
  provider-supplied label — and the claim is withdrawn and replaced by registration-level
  exposure profiles routed by destination (§2). Other corrections: the minimum provider
  could not return any article text, making it unable to serve its stated purpose (§4.4);
  the widget's safe path was asserted but unspecified (§5.3); an Assistant's audience ceiling
  was undefined, so an auto-answers module could have read internal knowledge and drafted
  customer mail (§5.2); customer-path caching could serve reclassified content and is removed
  (§6.3); side channels in metadata, counts, and translation-group keys were open (§5.4); the
  substrate was said to be unchanged while being changed (§5.2); admin authorization was
  understated (§3); replay protection was advisory (§3.1); the charter was overstated to
  justify the pull design (§1.1); and "connects to any knowledge base" was not true without
  the adapter qualification (§1.3). Maintainer decisions recorded 2026-08-02: the corrected
  safety split; and module-first with no third-party connectors, but with machine-readable
  schemas and a conformance suite the first-party module must pass.
- **2026-08-02** (third pass): a verification review confirmed §2.3's narrowed guarantee
  holds and that the factual claims about shipped code and the charter are accurate. It found
  two further errors of reasoning, now fixed. **Secret rotation did not work as written** —
  the core signs and the provider verifies, so retaining a previous secret in the core
  achieved nothing; the core now emits both signatures during the overlap window (§3.1). **The
  claim that the core "never sends conversation content" was false** — `query` is
  caller-supplied and a consumer may build it from a conversation; the guarantee is narrowed
  to the core's own request construction and the consumer obligation is stated (§4.3). Also:
  Assistant callers had no assigned projection or caching class, leaving a stale-cache path
  into customer output (§5.1); `knowledge:read_internal` is unreachable under the shipped
  Assistant model and is now documented as such rather than shipped as a dead grant (§5.2);
  the no-leak invariant is narrowed to explicit metadata, with cardinality, ordering, URLs,
  and timing named as residual signals (§5.4, §2.6); the conformance suite is marked as a
  planned deliverable rather than an existing one (§8.2); and §9.1 now lists what remains
  unspecified rather than leaving it to be discovered.
- **2026-08-02** (fourth pass — §2 assessed specifically as a public commitment): the design
  was judged defensible and the disclosure posture appropriate, but the wording still read as
  a stronger promise than delivered. §2 is now **scoped to this interface** rather than
  opening with a whole-product confidentiality sentence its own §2.7 contradicts. §2.3 is
  restated as **a security property required for conformance**, not a guarantee about shipped
  code — nothing has been built, and categorical "never" language in a document headed "what
  this guarantees" is written assurance a reader could try to rely on. **"Customer-egress
  path" is now defined** (§2.2): agent inbox search is explicitly *not* one, since an Agent
  can put an internal article into a reply and no interface prevents that — the real line is
  automated or direct customer egress versus a trusted human workflow, which the earlier
  "where the answer can end up" slogan blurred. §2.6's invariants are scoped to
  customer-egress credentials, gain the missing no-cache invariant, and cover every
  customer-egress path rather than only the widget. §2.7 no longer offers "human review is the
  confidentiality control" as an option, which contradicted §2.2's own reasoning. §5.4 no
  longer claims residual signals disclose only existence — chosen-query observation can reveal
  more. And "no contract can prevent that" is narrowed: this contract cannot detect semantic
  misclassification from returned text, but other architectures could.
