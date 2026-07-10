# Helpthread — Status

**Current state:** the mail engine's core loop is closed end-to-end — an inbound reply is parsed and threaded, conversations and threads are persisted, and an outbound reply is sent with a signed reply token in its Message-ID that a future customer reply threads back on. Everything below the wire (parse → thread → store → send) exists and is tested against real in-process Postgres; what's left is a real email provider adapter, the HTTP/API surface, and a UI. All work lands through a guarded pipeline: every PR runs typecheck, lint, tests-with-coverage, secret scanning, and CodeQL, plus AI review (CodeRabbit) and — for security- and threading-critical code — an independent Codex pass.

## Now

**Phase 1 — Core engine, dogfooded.** The full inbound→outbound threading loop is built; turning it toward a runnable, dogfoodable slice (a real send adapter + the conversation API).

## Done

**Foundation**
- Founding charter ([CHARTER.md](CHARTER.md)) — mission, principles, licensing, architecture, roadmap.
- Behavioral specs: conversation API contract (`specs/api/conversations-v1.md`), mail threading (`specs/mail/threading.md`), outbound sending (`specs/mail/sending.md`), conversation store (`specs/store/conversations.md`).
- Platform provider interfaces (`src/providers/`) — queue, scheduler, blob storage, inbound email, and outbound email sender — Vercel-first, not Vercel-only.
- Black-box acceptance fixtures (`fixtures/mail/`).
- CI/quality foundation: TypeScript (strict, NodeNext) + Biome + Vitest (v8 coverage); CI (quality + secret scan), CodeQL, OpenSSF Scorecard; branch protection requires all checks green.

**Mail engine — the closed loop**
- **Inbound parser** (`src/mail/parse.ts`) — raw RFC 5322/MIME → a normalized `ParsedEmail` (built on postal-mime). Surfaces the threading-critical headers; captures HTML verbatim.
- **Signed reply tokens** (`src/mail/reply-token.ts`) — HMAC-SHA256 tokens minted into outbound Message-IDs and verified on reply, with key rotation. The cryptographic basis for trustworthy threading.
- **RFC 5322 message-id extractor** (`src/mail/message-id.ts`) — comment/quoted-string-aware tokenization, shared across the engine.
- **Threading decision** (`src/mail/thread.ts`) — the 5-rule algorithm: a verified token routes a reply to its conversation; no valid token starts a new one; subject is never used.
- **Conversation/thread store** (`src/store/`, `src/db/`) — persistence on a thin, portable raw-SQL layer over PGlite (in-process Postgres) locally, the same SQL destined for Supabase. A valid token to a closed conversation reopens it; to a deleted one, the caller starts fresh.
- **Outbound send** (`src/mail/send.ts`) — mints the reply token into the outbound Message-ID, persists the outbound thread as an outbox item (`pending`→`sent`/`failed`), and hands it to an `EmailSender`. A round-trip test proves a sent reply threads back to the right conversation.

## Next

- **A real `EmailSender` adapter** (Gmail send / Postmark / SES) — the first one that puts actual mail on the wire, with a wire-level test proving the Message-ID is transmitted verbatim.
- **Send idempotency + delivery worker** ([HT-16](https://resonantiq.atlassian.net/browse/HT-16)) — a dedup key and a worker that retries `pending`/`failed` outbound threads reusing the same Message-ID; required before `sendReply` goes behind a live retrying caller.
- **The six-operation conversation API** and an agent inbox UI (API-first, per the charter).

## Not yet / deferred

- Live Vercel + Supabase deployment — deferred to the first deployable milestone; provider adapters are interfaces (inbound + outbound), concrete ones not yet built.
- Agent inbox UI.
- Marketplace (paid modules, license keys, module registry).

---

_Last updated: 2026-07-10_
