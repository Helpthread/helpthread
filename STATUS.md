# Helpthread — Status

**Current state:** Helpthread is **live and dogfooded**. The mail engine runs at
**desk.resonantiq.app** and the Agent Inbox UI at **inbox.resonantiq.app**, both on Vercel
(Resonant IQ team), backed by Supabase Postgres and a real Gmail mailbox (`help@resonantiq.app`).
Real inbound mail is parsed, threaded, and stored; Agents log in with their own identity, work
the full inbox surface, and reply back out through Gmail with a signed token in the Message-ID —
threading proven end-to-end against the live mailbox. On top of that closed loop, the **module
substrate v1** is built and merged: typed events, signed webhook delivery, and assistant (AI)
actors that authenticate and post draft-before-send work for an Agent to approve — the extension
foundation the whole paid-module catalog will ride on. All work lands through a guarded pipeline:
every PR runs typecheck, lint, tests-with-coverage, secret scanning, and CodeQL, plus AI review
(CodeRabbit) and — for security-, auth-, threading-, and substrate-critical code — an independent
Codex pass.

## Now

**Phase 1 shipped; the substrate is the floor; the marketplace is now launch-day work.** The
designed v1.1 engine, the Agent Inbox UI, per-Agent auth, and inbound observability are all live.
The **module substrate** (`specs/modules/`) — the out-of-process extension surface (events +
webhooks + assistant actors) that lets AI and third-party modules extend Helpthread without
touching core — is merged across waves 1–3 and documented for operators (`docs/modules/`); the
**first module**, a draft-reply assistant, is scaffolded in its own closed repo.

The charter was amended 2026-07-19 ([HT-79](https://resonantiq.atlassian.net/browse/HT-79)) to
move the **marketplace from a deferred phase to a launch-day component of Phase 3** — built now,
proven first as Resonant IQ's own dogfood install path. That reframes what's next: commerce
plumbing (license keys, distribution, update feed) is current work, not speculation. In flight:
the marketplace v1 spec is **draft for TJ review** (`specs/modules/marketplace-v1.md`), the
passkey login spec is at **draft.3** (`specs/auth/passkeys.md`), and the draft-reply assistant
is being built out against the live substrate ([HT-73](https://resonantiq.atlassian.net/browse/HT-73)).

## Done

**Foundation**
- Founding charter ([CHARTER.md](CHARTER.md)) — mission, principles, licensing, architecture, roadmap; amended ([HT-21](https://resonantiq.atlassian.net/browse/HT-21)) to replace the CLA with DCO-only contributions — contributors keep their copyright, and the AGPL-3.0 §7 plugin exception is the sole legal mechanism separating commercial modules.
- Behavioral specs: mail threading (`specs/mail/threading.md`), outbound sending (`specs/mail/sending.md`), conversation store (`specs/store/conversations.md`), the native Agent Inbox API (`specs/api/agent-inbox-v1.md`), and the module substrate (`specs/modules/`).
- Platform provider interfaces (`src/providers/`) — queue, scheduler, blob storage, inbound email, and outbound email sender — Vercel-first, not Vercel-only.
- Black-box acceptance fixtures (`fixtures/mail/`).
- CI/quality foundation: TypeScript (strict, NodeNext) + Biome + Vitest (v8 coverage); CI (quality + secret scan), CodeQL, OpenSSF Scorecard; branch protection requires all checks green.

**Mail engine — the closed loop**
- **Inbound parser** (`src/mail/parse.ts`) — raw RFC 5322/MIME → a normalized `ParsedEmail` (built on postal-mime). Surfaces the threading-critical headers; captures HTML verbatim.
- **Signed reply tokens** (`src/mail/reply-token.ts`) — HMAC-SHA256 tokens minted into outbound Message-IDs and verified on reply, with key rotation. The cryptographic basis for trustworthy threading.
- **RFC 5322 message-id extractor** (`src/mail/message-id.ts`) — comment/quoted-string-aware tokenization, shared across the engine.
- **Threading decision** (`src/mail/thread.ts`) — the 5-rule algorithm: a verified token routes a reply to its conversation; no valid token starts a new one; subject is never used.
- **Conversation/thread store** (`src/store/`, `src/db/`) — persistence on a thin, portable raw-SQL layer over PGlite (in-process Postgres) locally, the same SQL running on Supabase in production. Keyset-paginated listing; a valid token to a closed conversation reopens it, to a deleted one the caller starts fresh.
- **Outbound send** (`src/mail/send.ts`) — mints the reply token into the outbound Message-ID, persists the outbound thread as an outbox item (`pending`→`sent`/`failed`), and hands it to an `EmailSender`. Returns typed outcomes (a delivered message is never reported as failed).
- **Send idempotency + delivery worker** (`src/mail/send.ts`, `src/mail/delivery-worker.ts`, [HT-16](https://resonantiq.atlassian.net/browse/HT-16)) — a required `Idempotency-Key`, an envelope snapshot, and a delivery lease guard `sendReply` against double-sends; a delivery-worker sweep retries failed/pending outbound on the same lease. Delivery is at-least-once, with provider Message-ID dedup as the recommended backstop.
- **Inbound reliability wave** ([HT-45](https://resonantiq.atlassian.net/browse/HT-45)–[HT-48](https://resonantiq.atlassian.net/browse/HT-48), PRs [#46](https://github.com/Helpthread/helpthread/pull/46)–[#49](https://github.com/Helpthread/helpthread/pull/49)) — lease-reclaim for stuck `received` inbound deliveries, inbound attachment bytes persisted to the `BlobStore`, a Gmail OAuth disconnect admin action, and retry-instead-of-ack on lease-held reconcile with token-scoped lease release.

**Agent Inbox API v1 + v1.1 — the designed contract, implemented** (`src/api/`; spec amended in [HT-25](https://resonantiq.atlassian.net/browse/HT-25), the surface the UI prototype was built against)
- Native, framework-agnostic `Request → Response`; constant-time Bearer auth that runs *before* routing; native `{ error: { code, message } }` envelope; `Cache-Control: no-store`; UUID-shape guards; a top-level catch so nothing leaks as an uncontrolled 500.
- Core routes: list (`GET /api/v1/conversations`, folder filter + keyset cursor) · detail (`GET …/{id}`) · reply (`POST …/{id}/replies`) · status (`PATCH …/{id}`).
- **Four-state status model** ([HT-26](https://resonantiq.atlassian.net/browse/HT-26)) — `active/pending/closed/spam`; the list filter is a FOLDER (`open` = active + pending); replies reopen closed and spam, pending is an Agent statement never set or cleared automatically.
- **`number` + `preview`** ([HT-27](https://resonantiq.atlassian.net/browse/HT-27)), **internal notes** ([HT-28](https://resonantiq.atlassian.net/browse/HT-28)), **tags** ([HT-29](https://resonantiq.atlassian.net/browse/HT-29)), **soft delete** ([HT-30](https://resonantiq.atlassian.net/browse/HT-30)), **single-Agent assignee** ([HT-31](https://resonantiq.atlassian.net/browse/HT-31)), and **open tracking, default OFF** ([HT-32](https://resonantiq.atlassian.net/browse/HT-32) — absent config means byte-identical mail and nothing recorded).

**Provider adapters**
- **Gmail `EmailSender`** (`src/providers/adapters/gmail/`, [HT-19](https://resonantiq.atlassian.net/browse/HT-19)) — builds a raw RFC 5322 MIME message (mimetext, hardened against header injection, over-long lines, and `References` folding), base64url-encodes it, and sends via `users.messages.send`. A wire-level test proves our Message-ID is transmitted verbatim.
- **Postgres `Db`** (`src/db/postgres.ts`, [HT-20](https://resonantiq.atlassian.net/browse/HT-20)) — a pooler-safe implementation of the same `Db`/`Queryable` seam as PGlite, wrapping `pg`, with per-transaction `search_path` scoping (survives Supabase's transaction-mode pooler). The store and migrations run unchanged against it.

**Agent Inbox UI — live** ([HT-23](https://resonantiq.atlassian.net/browse/HT-23), PRs [#64](https://github.com/Helpthread/helpthread/pull/64)–[#66](https://github.com/Helpthread/helpthread/pull/66))
- The Claude Design hand-back (design system + prototype) built out as the real Next.js frontend over the v1.1 API, deployed standalone (project rooted at `web/`) to **inbox.resonantiq.app**: conversation list + detail skeleton, optimistic status transitions, attachment rendering. Design-system files under `web/src/components/ds/` are verbatim copies of the Claude Design source; deviations require sign-off (fidelity checklist tracked on HT-23).

**Live deployment** ([HT-43](https://resonantiq.atlassian.net/browse/HT-43))
- Engine on Vercel (project `helpthread`) at **desk.resonantiq.app**; `/api/**` routed to `createInboxApi`; UI standalone at **inbox.resonantiq.app**; Supabase Postgres; GCP project `helpthread-desk` driving Gmail push for `help@resonantiq.app`. As-deployed values and console gotchas are recorded in `specs/deploy/gmail-inbound-runbook.md`.
- Live-only Gmail bugs found and fixed against the running instance: reply token now carried in `References` with self-echo suppression ([HT-49](https://resonantiq.atlassian.net/browse/HT-49)), and self-echoed Gmail reconcile sends/drafts skipped ([HT-50](https://resonantiq.atlassian.net/browse/HT-50)).

**Per-Agent identity, login & auth** ([HT-54](https://resonantiq.atlassian.net/browse/HT-54); operator login groundwork in [HT-51](https://resonantiq.atlassian.net/browse/HT-51))
- Engine layer (PRs [#70](https://github.com/Helpthread/helpthread/pull/70), [#72](https://github.com/Helpthread/helpthread/pull/72), migration 18) — per-Agent identity, login, user management, plus mailbox-access grants + an admin API and an admin-IA fidelity doc.
- Web layer (PR [#71](https://github.com/Helpthread/helpthread/pull/71)) — per-Agent login, session identity, and team management, retiring the single shared operator password.

**Inbound observability** ([HT-44](https://resonantiq.atlassian.net/browse/HT-44), PR [#73](https://github.com/Helpthread/helpthread/pull/73), migration 19)
- A `/internal/health` endpoint (the alertable surface), a forged-token signal on inbound deliveries, and closed logging gaps. Deployed and live-verified.

**Module substrate — the open-core extension foundation** (`specs/modules/`)
- **Module catalog & the open-core line** ([HT-66](https://resonantiq.atlassian.net/browse/HT-66), PR [#75](https://github.com/Helpthread/helpthread/pull/75), `specs/modules/catalog.md`) — the canonical free-vs-paid decision: free core = parity + hygiene (passkey login is core), paid = intelligence, channels, enterprise (SSO is the auth paywall). Born-proprietary discipline; one-way asymmetric line; **Modules**, never "plugins" (the word survives only in the legal *plugin exception*).
- **Substrate v1 spec** ([HT-67](https://resonantiq.atlassian.net/browse/HT-67), PR [#76](https://github.com/Helpthread/helpthread/pull/76), `specs/modules/substrate-v1.md`) — three surfaces, all core-AGPL and free forever: typed event emission, signed webhook delivery, and assistant (AI) actors that authenticate and post draft-before-send work. Additive-forward rule (marketplace attaches, never retrofits); licensing stays distribution-side, never runtime.
- **Wave 1** ([HT-68](https://resonantiq.atlassian.net/browse/HT-68), PR [#77](https://github.com/Helpthread/helpthread/pull/77)) — the actor model and its schema floor: migrations **020–023** land the `assistants` principal table, the `threads` actor model + draft lifecycle, `webhook_endpoints`, and the `event_outbox`.
- **Wave 2** ([HT-69](https://resonantiq.atlassian.net/browse/HT-69), PR [#79](https://github.com/Helpthread/helpthread/pull/79)) — typed events, the outbox drain, signed webhook delivery, and the module admin API.
- **Wave 3** ([HT-70](https://resonantiq.atlassian.net/browse/HT-70), PR [#80](https://github.com/Helpthread/helpthread/pull/80)) — assistant authentication, the drafts API, and the draft-approval orchestration an Agent drives in core.
- **First module scaffold** ([HT-73](https://resonantiq.atlassian.net/browse/HT-73)) — the draft-reply assistant, born proprietary in its own closed repo (`Helpthread/module-draft-assistant`), bootstrapped as a product-shaped scaffold that will ride the public substrate (events → webhook, API read, assistant draft) and touch core only through those extension points.
- **Operator guide** ([HT-71](https://resonantiq.atlassian.net/browse/HT-71), PRs [#81](https://github.com/Helpthread/helpthread/pull/81), [#84](https://github.com/Helpthread/helpthread/pull/84), `docs/modules/`) — README, assistants-and-drafts, and webhooks documentation for running the substrate, plus a precision follow-up pinning event-transaction scope and payload sensitivity.

**Catalog & licensing refinements**
- **KB and portal reclassified to paid** ([HT-75](https://resonantiq.atlassian.net/browse/HT-75), PR [#82](https://github.com/Helpthread/helpthread/pull/82)) — the full 71-module FreeScout listing re-audited item-by-item, closing the gap audit. The knowledge base ships entirely as a paid module (not core), as does the end-user portal; the open-core line is restated as **free = parity and hygiene; paid = intelligence, channels, enterprise, and self-service surfaces**. Passkey login (WebAuthn) stays core, deliberately.
- **Passkey classification reconciled** ([HT-76](https://resonantiq.atlassian.net/browse/HT-76), PR [#85](https://github.com/Helpthread/helpthread/pull/85)) — `specs/auth/agents-and-auth.md` squared with the catalog: passkeys core, enterprise SSO paid.
- **Marketplace becomes launch-day** ([HT-79](https://resonantiq.atlassian.net/browse/HT-79), PR [#86](https://github.com/Helpthread/helpthread/pull/86)) — CHARTER §3/§4/§5 amended: the marketplace moves from "a later phase, once demand justifies it" to a **Phase 3 launch-day component**, because the substrate and first modules shipped during dogfood, leaving commerce plumbing rather than speculation. New counsel items before it takes real money: commercial module license text and terms of sale. The §7 plugin-exception deadline is unchanged (every v1 marketplace module is out-of-process and needs no exception).

**Inbox basics** ([HT-76](https://resonantiq.atlassian.net/browse/HT-76)/[HT-77](https://resonantiq.atlassian.net/browse/HT-77)/[HT-78](https://resonantiq.atlassian.net/browse/HT-78), PR [#90](https://github.com/Helpthread/helpthread/pull/90), migrations 24–25)
- **Saved replies & macros** (`src/api/saved-replies.ts`, `src/store/saved-replies.ts`, migration 24 `saved_replies`) — the canned-response surface behind the native API.
- **Snooze** (`src/mail/snooze-wake.ts`, migration 25 `conversation_snooze`) — a conversation sleeps until its wake time, then returns to the working folder.
- **Send & close** (`src/mail/send.ts`) — reply and resolve in one action, the highest-frequency Agent gesture.

## Next

- **Marketplace v1** ([HT-79](https://resonantiq.atlassian.net/browse/HT-79), `specs/modules/marketplace-v1.md` — draft for TJ review) — the commerce plumbing around the substrate: license keys, subscriptions, module distribution, an update feed. Child tickets scoped by the spec: an in-product module directory ([HT-81](https://resonantiq.atlassian.net/browse/HT-81)) and dogfooding Resonant IQ's own install through the marketplace ([HT-82](https://resonantiq.atlassian.net/browse/HT-82)).
- **Passkey (WebAuthn) login** ([HT-75](https://resonantiq.atlassian.net/browse/HT-75), `specs/auth/passkeys.md` — draft.3, spec only) — the second auth provider on the HT-54 seam, and the first real exercise of that seam's marketplace-boundary claim. No migrations or implementation yet.
- **Build out the draft-reply assistant** ([HT-73](https://resonantiq.atlassian.net/browse/HT-73)) against the live substrate — the first real consumer, proving the module boundary end-to-end.
- **HT-5 counsel work** — plugin exception text (now drafted against the real, shipped substrate API), board consent memo, and trademark policy (charter §3/§7, per the DCO amendment) — gates opening the project to external contributions. Per the HT-79 amendment, the marketplace adds two more before it takes money: commercial module license text and terms of sale.

## Not yet / deferred

- The in-process/build-time module API, UI injection points, and a general scopes/permissions system (each waits for a real module to need it — substrate v1 non-goals).
- A customer-side / self-service API (a separate future surface, designed native when there are customers to serve).

---

_Last updated: 2026-07-19_
