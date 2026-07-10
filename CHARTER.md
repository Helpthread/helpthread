# Helpthread — Founding Charter

> Helpthread is an open-source, serverless helpdesk — shared inbox, threaded email conversations, knowledge base — built for teams who live on Vercel and Supabase rather than a LAMP server. It is inspired by FreeScout — the established self-hosted PHP helpdesk that proved the ownership model — and aimed at the bar Help Scout set for ease of use, rebuilt in modern TypeScript with no daemons, no polling loops, and an extension system designed for how serverless software actually deploys. Core is AGPL-3.0; the project is dogfooded first, built by the team behind Resonant IQ as their own production support system before anyone else touches it.

## 1. Mission & positioning

FreeScout proved something real: a self-hosted helpdesk, owned outright by the operator, is worth building and worth running. Thousands of teams run it instead of paying rent to Zendesk or Help Scout forever. But it's a decade-old Laravel 5.5 app held together by IMAP polling daemons, its extensibility means dropping PHP into a runtime `/Modules` folder, and even basic customization — the knowledge base's design, its URLs — is out of reach without forking. It's a walled garden built on aging tech.

Helpthread is the answer for people who already live on serverless infrastructure. Same promise — own your helpdesk, own your data, self-host on your own accounts — rebuilt for a world of edge functions, managed Postgres, and push-based delivery instead of cron loops watching a mailbox. Two audiences have to come out of this feeling the same way: customers should find getting support dead easy, and operators should find running the thing dead easy. Neither of those is negotiable in favor of the other. That bar was set by Help Scout — still the gold standard for a helpdesk that feels effortless on both sides of the conversation. FreeScout proved the ownership model works; Help Scout shows what the experience should feel like. Helpthread exists to deliver both at once.

## 2. Product principles

- **Innovate on the platform. Be boringly faithful on mail semantics.** Everything about *how* Helpthread runs — compute model, storage, deployment — is fair game for rethinking from scratch. How it parses, threads, and sends email is not. FreeScout earned ten years of edge-case scars in production; we respect them, reproduce them behaviorally, and verify against fixtures rather than re-deriving them from first principles. Any change to mail behavior needs proof of equivalence or an explicit, written justification — not a hunch that the old way looked wrong. During this project's own early development we watched well-intentioned "improvements" to mail handling silently destroy message content in testing; that lesson is why this rule exists and why it's not up for debate per-PR.
- **Threading reliability comes from the outbound side.** The engine controls its own Message-IDs via HMAC-signed reply tokens rather than trying to cleverly reverse-engineer inbound headers written by every mail client on earth. This is the mechanism the whole system leans on — treat it as the crown jewel it is.
- **API-first — and the UI isn't the only client.** Anything the UI can do, a typed public API can do. The UI is a client of that API, not a special case; so are AI agents. An MCP server exposing the same operations ships as a first-class client of the same API, so any operator can point their own AI tooling at their own helpdesk.
- **Serverless-native, Vercel-first, not Vercel-only.** No daemons, no polling loops. Inbound mail arrives via push webhooks (Gmail push through Pub/Sub, and equivalents as we add providers); anything that needs to happen later is a scheduled action or a cron trigger, not a process sitting in a loop. The engine's core reaches every platform service through interfaces the project owns — see the platform posture note in the architecture section.
- **Own your data.** Self-hosted on the operator's own Vercel and Supabase accounts. We don't sit in the data path — and AI features preserve that: assistants call model providers the operator configures, with the operator's own keys. Conversation data never proxies through Helpthread's infrastructure.

## 3. Licensing & intellectual property

Helpthread's core is licensed **AGPL-3.0**. All contributions require a **CLA**, so the project maintainer holds consolidated copyright over the codebase — this is what makes it lawful to also sell first-party commercial modules alongside the AGPL core — the well-established open-core structure that FreeScout's own AGPL-core-plus-paid-modules model demonstrates is viable. Paid first-party modules will ship under a separate proprietary/commercial license, distributed through an official marketplace — a later phase, not a launch-day feature.

**What's free and what's paid, stated early:** the core helpdesk — mail engine, conversations, agent inbox, knowledge base, the public API and MCP server, self-hosting — is AGPL-licensed free software, forever, and nothing free today gets paywalled retroactively. Paid, eventually: advanced first-party modules (AI assistants are the leading candidates) and possibly hosted convenience services. Monetization adds; it never subtracts.

### Module boundary

The line between the AGPL core and commercial modules must be an engineered artifact, not an accident. Modules — first- or third-party — integrate through a narrowly-defined, documented public plugin API, and the core's license will carry an explicit linking permission for it (a plugin exception in the Classpath-exception tradition), so module authors are never left guessing whether their work becomes a derivative of the core. Where a module can live out-of-process — webhooks, the event API — that is the preferred shape. Drawing this boundary precisely is counsel-review work before the marketplace opens; the discipline it demands — narrow, stable, documented extension points — is the same discipline a good module API needs anyway.

### Clean-room provenance policy

Helpthread contains no FreeScout code. FreeScout is AGPL and is used strictly as a *behavioral* reference, never as a source of copied implementation.

**Reference hierarchy**, in order of preference — the strongest legal posture is the code you never had to defend:

1. **Permissively-licensed sources first.** Mail plumbing comes from MIT/Apache-licensed libraries used as ordinary dependencies (each license verified at adoption), and permissively-licensed helpdesk implementations — notably Chatwoot's MIT-licensed core — may be studied freely and adapted with attribution. No wall required.
2. **Black-box observation second.** FreeScout-specific behavior is established wherever possible by observing a running instance: crafted inputs in, recorded behavior out. Observing a running program's behavior involves no copying of expression, which makes fixtures produced this way the safest raw material available.
3. **FreeScout source study as a last resort.** Only when a behavior cannot be determined by observation or public documentation — and then exclusively on the spec side of the wall described below.

The process:

- A **spec side** studies FreeScout's source and produces written behavioral specifications and black-box test fixtures. Specs carry behavior, interfaces, data formats, and constraints only — no implementation code, no copied comments, no naming or structure beyond what interoperability genuinely dictates.
- **Test fixtures are authored from observed behavior** (inputs, outputs, edge cases). They are never copied from FreeScout's own test suite.
- An **implementation side** writes Helpthread's actual code against those specs and fixtures only. For AI-assisted implementation this is defined precisely: the working context contains no FreeScout source and no quarantined material — a condition that, unlike with human teams, can be enforced and logged per session.
- Code previously drafted with FreeScout source visible is **quarantined**: stored outside the shipping repository, accessible to the spec side only, and never shown to the implementation side. It does not ship, ever, under any circumstance.
- **The wall is documented, not just described.** Dated records of which actors and sessions accessed which sources, spec review sign-offs, and a per-module provenance manifest are maintained from the first spec onward. A clean-room defense is evidentiary; process without records is a story.
- **Every shipped module has documented human authorship** — substantive human design, review, and revision, recorded. This is both defensive hygiene and existential for the business model: under current U.S. Copyright Office guidance, AI-generated material without sufficient human authorship may not be copyrightable, and code the project cannot copyright, it cannot dual-license.

This matters for two reasons, both load-bearing: legal hygiene (AGPL is a strong copyleft license and we do not want Helpthread's core treated as a derivative work of it), and copyright consolidation (the CLA-based dual-license model only works if we can show the code is genuinely ours). We'd hold this policy even if only one of the two reasons applied.

An honest limitation, stated rather than hidden: this is a small project, and the same humans oversee both sides of the wall. The separation Helpthread can prove is contextual and documentary — which sessions and actors had which material in view — not the two-isolated-teams personnel wall of classic clean-room efforts. That is exactly why the reference hierarchy above pushes source contact toward zero in the first place, and why the records are mandatory rather than aspirational.

Known open legal terrain, flagged for counsel rather than papered over: whether an AI model's training-data exposure to a codebase bears on clean-room separation is unresolved law. Our position is that a documented context-level wall plus behavioral-only specs is the strongest available posture, and we maintain the records to prove it.

**Ownership, decided:** Resonant IQ, Inc. holds the copyright and will run the marketplace — Helpthread is a Resonant IQ product. Remaining paperwork for counsel before the repository goes public: memorialize founder alignment in a short board consent, and draft the CLA in the company's name with successors-and-assigns language so a future spin-out of Helpthread into its own entity stays clean. **Open question:** the specific CLA instrument (individual and corporate CLA, likely administered via something like cla-assistant) is not yet finalized; it must be before any outside contribution is accepted.

This charter is not legal advice. Counsel will review the licensing structure, the CLA, and the clean-room policy before public launch.

## 4. Architecture direction

Serverless kills FreeScout's runtime `/Modules` folder — there's no long-lived filesystem to drop a module into. Helpthread's extension model is designed in from day one along two tracks: **build-time npm plugins**, where an operator adds a package and redeploys — the install *is* the Vercel build — and **typed event hooks / webhooks** for integrations that live out-of-process entirely. The plumbing paid modules will need (license keys, a private registry, an update channel) is marketplace-phase work, not something we're speculatively building now.

**Platform posture: Vercel-first, not Vercel-only.** The first-class deployment target is Vercel + Supabase, and the deploy story is optimized for it without apology. But the engine's core never calls a platform directly: queueing, scheduled and durable work, blob storage, and inbound email all sit behind thin provider interfaces the project owns, with today's implementations (Vercel Queues, Vercel Cron and Workflows, Supabase Storage, Gmail push) as adapters rather than assumptions. Inbound email forces this discipline anyway — Gmail can't be the only supported mailbox forever — and applying it to the other seams keeps a future plain-Node-plus-Postgres deployment mode reachable without an engine rewrite. Supabase itself is open source and self-hostable, so that half of the stack is a soft dependency by construction. No additional deployment targets are promised at launch: every supported target is a permanent test matrix, and that cost gets taken on only when demand justifies it.

The conversation model is **channel-agnostic from day one**. Email is the founding channel — but a conversation and its threads don't care how a message arrived, and the schema never assumes SMTP. Chat/messaging arrives later as a second channel over the same engine (Supabase Realtime is the push transport; a "chat" is a conversation whose threads travel a faster wire), and an embeddable support widget — knowledge-base search, start a conversation, follow the replies, in the tradition of Help Scout's Beacon — is a planned first-party module built on the same public API. Live-chat trappings like presence and typing indicators layer onto that channel per-operator; they are staffing promises more than plumbing.

The actor model is **AI-ready from day one**. Every thread records what kind of actor authored it — customer, human staff, or AI. AI-authored work supports draft-before-send states, human-approval handoffs, and a full audit trail. Like channels and modules, these are day-one schema shapes, not features: they cost a column now and a migration crisis later. Vocabulary, fixed here to prevent permanent confusion: **agents** are human support staff; **assistants** are AI actors.

The knowledge base is core product capability; **content-as-code** is its initial form: docs live in git, build to static output, get a search index generated at build time. A runtime KB editor is plausible later, but it ships as a module, not as core.

The founding public API surface is six conversation operations: list conversations by customer email, get a conversation with its threads, get a conversation's owner, create a conversation (with attachments), add a customer reply, and look up a customer — the customer-side contract, matching what a production integration already consumes. The agent-side API grows in lockstep with the inbox UI under the API-first rule: no UI capability ships without its public API underneath. Everything else — mailbox management, roles, workflows, reporting — gets built on top of and around this surface, not ahead of it.

## 5. Roadmap

No dates; phases are ordered by dependency, not calendar.

- **Phase 0 — Foundations.** Name, domains, GitHub org, and npm org secured (done). This charter. A written clean-room protocol doc. A public-ready engine repo with clean history — nothing checked in that traces back to a FreeScout-source-visible session.
- **Phase 1 — Core engine, dogfooded.** Clean-room mail engine: event-driven ingestion (bounded reconciliation fetches, never a long-running poller), parsing, threading, sending, signed reply tokens, auto-responder handling, bounce handling, HTML sanitization. The six-operation conversation API. An agent inbox UI. Gmail push for inbound. This runs as Resonant IQ's actual production support desk before it runs as anyone else's.
- **Phase 2 — Production cutover.** Resonant IQ retires its FreeScout instance and switches to Helpthread at the config level — a clean cutover with no legacy data requiring migration.
- **Phase 3 — Public launch.** Deploy-to-Vercel button, public docs site, the operator-facing knowledge base, and the start of a community. The marketplace — license keys, module registry, first paid modules — follows once there's demand to justify it; AI-powered modules (draft-reply suggestions, auto-triage, knowledge-base-grounded auto-answers in the widget) are the leading candidates for those first commercial offerings.

The full helpdesk surface — mailbox management, roles and permissions, workflows, SLAs, saved replies, reporting, admin, search, and the chat channel plus embeddable support widget described in the architecture section — gets built incrementally, prioritized by what real usage demands. FreeScout's feature surface is a map of that territory, not a contract; the measure Helpthread holds itself to is Help Scout's ease of use, for customers and operators alike. The mail engine, for all the care it gets, is only something like 10–15% of that eventual surface. This is a multi-month-plus endeavor, not a weekend rewrite, and nobody involved should pretend otherwise.

## 6. Sacred invariants

Five things we do not trade away for speed, convenience, or a good demo:

1. Never lose or corrupt customer mail.
2. Provenance purity — no AGPL-derived code enters the shipping tree.
3. Threading correctness outranks feature velocity.
4. Main stays releasable.
5. No silent scope creep in mail semantics — see the clean-room and equivalence rules above.

## 7. Governance

Solo-maintainer, BDFL model for now — there is one project, one person accountable for it, and that's honestly where it is. A CLA is required for every contribution, per the licensing section above. Conventional-commit conventions and PR review norms will get written down once there are contributors to write them down for; inventing process ahead of contributors is its own kind of scope creep, so this section stays short on purpose.

---

**Status:** Written 2026-07-09, prior to the first code commit. This charter is the founding document of the Helpthread project and precedes any implementation.
