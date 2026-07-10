# Helpthread — Status

**Current state:** the mail engine's threading core is built and merged — an inbound reply can be parsed, its signed reply token verified, and routed to the correct conversation end-to-end. Persistence (store) and outbound (send) are next. All work lands through a guarded pipeline: every PR runs typecheck, lint, tests-with-coverage, secret scanning, and CodeQL, plus AI review (CodeRabbit) and — for security- and threading-critical code — an independent Codex pass.

## Now

**Phase 1 — Core engine, dogfooded.** The threading decision is complete; building outward toward a runnable, dogfoodable slice.

## Done

**Foundation**
- Founding charter ([CHARTER.md](CHARTER.md)) — mission, principles, licensing, architecture, roadmap.
- Behavioral specs: conversation API contract (`specs/api/conversations-v1.md`), mail threading (`specs/mail/threading.md`).
- Platform provider interfaces (`src/providers/`) — queue, scheduler, blob storage, inbound email — Vercel-first, not Vercel-only.
- Black-box acceptance fixtures (`fixtures/mail/`).
- CI/quality foundation: TypeScript (strict, NodeNext) + Biome + Vitest (v8 coverage); CI (quality + secret scan), CodeQL, OpenSSF Scorecard; branch protection requires all checks green.

**Mail engine — threading core**
- **Inbound parser** (`src/mail/parse.ts`) — raw RFC 5322/MIME → a normalized `ParsedEmail` (built on postal-mime). Surfaces the threading-critical headers; captures HTML verbatim.
- **Signed reply tokens** (`src/mail/reply-token.ts`) — HMAC-SHA256 tokens minted into outbound Message-IDs and verified on reply, with key rotation. The cryptographic basis for trustworthy threading.
- **RFC 5322 message-id extractor** (`src/mail/message-id.ts`) — comment/quoted-string-aware tokenization, shared by the parser and the threading decision.
- **Threading decision** (`src/mail/thread.ts`) — the 5-rule algorithm: a verified token routes a reply to its conversation; no valid token starts a new one; subject is never used.

## Next

- **Store** — persist conversations and threads (local Postgres via a portable, thin SQL layer) so the decision's `{conversationId, threadId}` lands somewhere real; handle tokens pointing at closed/deleted conversations.
- **Send** — outbound replies that mint the reply tokens the whole system depends on.
- Then: the six-operation conversation API and an agent inbox UI (API-first, per the charter).

## Not yet / deferred

- Live Vercel + Supabase deployment — deferred to the first deployable milestone; provider adapters are interfaces, not yet built.
- Agent inbox UI.
- Marketplace (paid modules, license keys, module registry).

---

_Last updated: 2026-07-10_
