# Helpthread — Status

**Current state:** the mail engine's full loop is built and behind a native HTTP API that now implements the complete **v1.1 contract the Agent Inbox UI was designed against** ([HT-25](https://resonantiq.atlassian.net/browse/HT-25), `specs/api/agent-inbox-v1.md`): four-state conversation status with folder-semantics listing, human-facing conversation numbers and previews, internal notes, tags, a single-Agent assignee, soft delete, and config-gated (default-OFF) open tracking. An inbound reply is parsed, threaded, and stored; an Agent can work the whole inbox surface; replies go out through a real Gmail adapter with a signed token in the Message-ID, and the store runs on either PGlite (local) or Postgres (Supabase-ready, pooler-safe) behind the same seam. What's left to run it *live* is a deployment; what's left to *see* it is the UI integration ([HT-23](https://resonantiq.atlassian.net/browse/HT-23)). All work lands through a guarded pipeline: every PR runs typecheck, lint, tests-with-coverage, secret scanning, and CodeQL, plus AI review (CodeRabbit) and — for security-, auth-, and threading-critical code — an independent Codex pass.

## Now

**Phase 1 — Core engine, dogfooded.** The backend for the whole designed v1 is done: adapters (Gmail send, Postgres), send idempotency + the delivery worker ([HT-16](https://resonantiq.atlassian.net/browse/HT-16)), and the full v1.1 API surface (HT-26…HT-32, below). What's left: the **Agent Inbox UI integration** ([HT-23](https://resonantiq.atlassian.net/browse/HT-23) — the Claude Design hand-back becomes the real frontend against this API) and the live deployment — a thin Vercel/Node route wrapping `createInboxApi`, a real Gmail inbound webhook, and Supabase.

## Done

**Foundation**
- Founding charter ([CHARTER.md](CHARTER.md)) — mission, principles, licensing, architecture, roadmap; amended ([HT-21](https://resonantiq.atlassian.net/browse/HT-21)) to replace the CLA with DCO-only contributions — contributors keep their copyright, and the AGPL-3.0 §7 plugin exception is now the sole legal mechanism separating commercial modules.
- Behavioral specs: mail threading (`specs/mail/threading.md`), outbound sending (`specs/mail/sending.md`), conversation store (`specs/store/conversations.md`), and the native Agent Inbox API (`specs/api/agent-inbox-v1.md`).
- Platform provider interfaces (`src/providers/`) — queue, scheduler, blob storage, inbound email, and outbound email sender — Vercel-first, not Vercel-only.
- Black-box acceptance fixtures (`fixtures/mail/`).
- CI/quality foundation: TypeScript (strict, NodeNext) + Biome + Vitest (v8 coverage); CI (quality + secret scan), CodeQL, OpenSSF Scorecard; branch protection requires all checks green.

**Mail engine — the closed loop**
- **Inbound parser** (`src/mail/parse.ts`) — raw RFC 5322/MIME → a normalized `ParsedEmail` (built on postal-mime). Surfaces the threading-critical headers; captures HTML verbatim.
- **Signed reply tokens** (`src/mail/reply-token.ts`) — HMAC-SHA256 tokens minted into outbound Message-IDs and verified on reply, with key rotation. The cryptographic basis for trustworthy threading.
- **RFC 5322 message-id extractor** (`src/mail/message-id.ts`) — comment/quoted-string-aware tokenization, shared across the engine.
- **Threading decision** (`src/mail/thread.ts`) — the 5-rule algorithm: a verified token routes a reply to its conversation; no valid token starts a new one; subject is never used.
- **Conversation/thread store** (`src/store/`, `src/db/`) — persistence on a thin, portable raw-SQL layer over PGlite (in-process Postgres) locally, the same SQL destined for Supabase. Keyset-paginated listing; a valid token to a closed conversation reopens it, to a deleted one the caller starts fresh.
- **Outbound send** (`src/mail/send.ts`) — mints the reply token into the outbound Message-ID, persists the outbound thread as an outbox item (`pending`→`sent`/`failed`), and hands it to an `EmailSender`. Returns typed outcomes (a delivered message is never reported as failed). A round-trip test proves a sent reply threads back to the right conversation.
- **Send idempotency + delivery worker** (`src/mail/send.ts`, `src/mail/delivery-worker.ts`, [HT-16](https://resonantiq.atlassian.net/browse/HT-16)) — a required `Idempotency-Key` on the reply endpoint, an envelope snapshot, and a delivery lease guard `sendReply` against double-sends; a delivery-worker sweep retries failed/pending outbound on the same lease. Delivery is at-least-once, with provider Message-ID dedup as the recommended backstop.

**Agent Inbox API v1** (`src/api/`) — native, framework-agnostic `Request → Response` (a Vercel/Node adapter is a later thin wrapper; Node runtime, since the engine's HMAC uses `node:crypto`).
- Constant-time Bearer auth that runs *before* routing; native `{ error: { code, message } }` envelope; `Cache-Control: no-store` on every response; UUID-shape guards; a top-level catch so nothing leaks as an uncontrolled 500.
- `GET /api/v1/conversations` (inbox list, newest-activity-first, folder filter, keyset cursor) · `GET /api/v1/conversations/{id}` (conversation + threads) · `POST /api/v1/conversations/{id}/replies` (derives the headers, mints + sends) · `PATCH /api/v1/conversations/{id}` (set status).

**Agent Inbox API v1.1 — the designed contract, implemented** (spec amended in [HT-25](https://resonantiq.atlassian.net/browse/HT-25); the surface the UI prototype was built against, adopted as the v1 target)
- **Four-state status model** ([HT-26](https://resonantiq.atlassian.net/browse/HT-26)) — `active/pending/closed/spam`; the list filter is a FOLDER (`open` = active + pending); replies reopen closed and spam to active, pending is an Agent statement never set or cleared automatically.
- **`number` + `preview`** ([HT-27](https://resonantiq.atlassian.net/browse/HT-27)) — a sequential human-facing id (display-only; the uuid stays canonical) and a derived latest-text excerpt, one shared derivation for list and detail.
- **Internal notes** ([HT-28](https://resonantiq.atlassian.net/browse/HT-28)) — `direction: 'note'` + `POST …/notes`: Agent-only, never emailed (test-asserted from both sides of the mail boundary), bumps activity but never reopens.
- **Tags** ([HT-29](https://resonantiq.atlassian.net/browse/HT-29)) — replace-set `PUT …/tags` with trim→lowercase→dedupe normalization; metadata, not activity.
- **Soft delete** ([HT-30](https://resonantiq.atlassian.net/browse/HT-30)) — `DELETE …/{id}` → 204; indistinguishable-from-nonexistent everywhere after, including keyed reply replays; rows and mail stay in storage.
- **Single-Agent assignee** ([HT-31](https://resonantiq.atlassian.net/browse/HT-31)) — `'me' | null` via `PUT …/assignee`; deliberately not identity.
- **Open tracking, default OFF** ([HT-32](https://resonantiq.atlassian.net/browse/HT-32)) — a deliberate privacy stance: absent config means byte-identical mail (test-proven) and nothing recorded, ever. When enabled: a SIGNED view token (never the bare thread id) in an HTML-only pixel, injected before persist so retries carry it for free, and an unauthenticated gif endpoint that answers identically valid-or-not.

**Provider adapters — the first concrete implementations**
- **Gmail `EmailSender`** (`src/providers/adapters/gmail/`, [HT-19](https://resonantiq.atlassian.net/browse/HT-19)) — the first thing that puts actual mail on the wire: builds a raw RFC 5322 MIME message (mimetext, hardened against header injection, over-long lines, and `References` folding), base64url-encodes it, and sends via `users.messages.send` through the support Google Workspace account. A wire-level test proves our Message-ID is transmitted verbatim. Postmark/SES/Resend remain a later one-file swap if scale or deliverability demands it.
- **Postgres `Db`** (`src/db/postgres.ts`, [HT-20](https://resonantiq.atlassian.net/browse/HT-20)) — a pooler-safe implementation of the same `Db`/`Queryable` seam as PGlite, wrapping `pg`. Per-transaction `search_path` scoping (survives Supabase's transaction-mode pooler shuffling backends between statements), validated schema names, and serverless-sized pool defaults. The store and migrations run unchanged against it.

## Next

- **Agent Inbox UI integration** ([HT-23](https://resonantiq.atlassian.net/browse/HT-23)) — the Claude Design hand-back (design system + prototype) becomes the real frontend over the now-complete v1.1 API. The design system also lives as a Claude Design *design-system project* ("Helpthread"), so future screens are designed from the real components.
- **A deployment** — a thin Vercel/Node route wrapping `createInboxApi`, a real Gmail inbound webhook, and Supabase.
- **HT-5 counsel work** — plugin exception text, board consent memo, and trademark policy (charter §3/§7, per the DCO amendment) — gates opening the project to external contributions.

## Not yet / deferred

- A customer-side / self-service API (a separate future surface, designed native when there are customers to serve).
- Marketplace (paid modules, license keys, module registry).

---

_Last updated: 2026-07-12_
