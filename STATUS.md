# Helpthread — Status

**Current state:** the mail engine's full loop is built and behind a native HTTP API — an inbound reply is parsed, threaded, and stored; an Agent can list the inbox, read a conversation, and reply; the reply is sent through a real Gmail adapter with a signed token in its Message-ID that a future customer reply threads back on, and the store now runs on either PGlite (local) or Postgres (Supabase-ready, pooler-safe) behind the same seam. Everything from the wire up (parse → thread → store → read → reply → send) exists and is tested against real in-process Postgres, the real `pg` wire protocol, and real `Request`/`Response` objects. What's left to run it *live* is a deployment. All work lands through a guarded pipeline: every PR runs typecheck, lint, tests-with-coverage, secret scanning, and CodeQL, plus AI review (CodeRabbit) and — for security-, auth-, and threading-critical code — an independent Codex pass.

## Now

**Phase 1 — Core engine, dogfooded.** Both provider adapters (Gmail send, Postgres) are done, and send idempotency + the delivery worker ([HT-16](https://resonantiq.atlassian.net/browse/HT-16)) now guard `sendReply` against double-sends. What's left is the live deployment — a thin Vercel/Node route wrapping `createInboxApi`, a real Gmail inbound webhook, and Supabase.

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
- `GET /api/v1/conversations` (inbox list, newest-activity-first, status filter, keyset cursor) · `GET /api/v1/conversations/{id}` (conversation + threads) · `POST /api/v1/conversations/{id}/replies` (derives the headers, mints + sends) · `PATCH /api/v1/conversations/{id}` (close/reopen).

**Provider adapters — the first concrete implementations**
- **Gmail `EmailSender`** (`src/providers/adapters/gmail/`, [HT-19](https://resonantiq.atlassian.net/browse/HT-19)) — the first thing that puts actual mail on the wire: builds a raw RFC 5322 MIME message (mimetext, hardened against header injection, over-long lines, and `References` folding), base64url-encodes it, and sends via `users.messages.send` through the support Google Workspace account. A wire-level test proves our Message-ID is transmitted verbatim. Postmark/SES/Resend remain a later one-file swap if scale or deliverability demands it.
- **Postgres `Db`** (`src/db/postgres.ts`, [HT-20](https://resonantiq.atlassian.net/browse/HT-20)) — a pooler-safe implementation of the same `Db`/`Queryable` seam as PGlite, wrapping `pg`. Per-transaction `search_path` scoping (survives Supabase's transaction-mode pooler shuffling backends between statements), validated schema names, and serverless-sized pool defaults. The store and migrations run unchanged against it.

## Next

- **An Agent inbox UI** over the API (API-first, per the charter).
- **HT-5 counsel work** — plugin exception text, board consent memo, and trademark policy (charter §3/§7, per the DCO amendment) — gates opening the project to external contributions.

## Not yet / deferred

- Live Vercel + Supabase deployment — deferred to the first deployable milestone; the inbound and outbound provider seams exist and concrete adapters (Gmail send, Postgres) are now built, so what's left is deployment wiring, not a missing adapter.
- A customer-side / self-service API (a separate future surface, designed native when there are customers to serve).
- Marketplace (paid modules, license keys, module registry).

---

_Last updated: 2026-07-11_
