# Helpthread — Status

**Current state:** pre-code foundation is laid — charter, specs, provider interfaces, fixtures, and a full CI/quality skeleton are in place; the mail engine itself has not been started.

## Now

**Phase 1 — Core engine, dogfooded.** Laying the guarded foundation the engine lands into: every PR runs typecheck, lint, tests-with-coverage, a secret scan, CodeQL, and OpenSSF Scorecard before anything merges. No engine code has shipped yet.

## Done

- Founding charter ([CHARTER.md](CHARTER.md)) — mission, principles, licensing, architecture, roadmap.
- Behavioral specs: the conversation API contract (`specs/api/conversations-v1.md`), mail threading (`specs/mail/threading.md`).
- Platform provider interfaces (`src/providers/`) — queue, scheduler, blob storage, inbound email — the seam that keeps the engine Vercel-first, not Vercel-only.
- Black-box acceptance fixtures (`fixtures/mail/`).
- This CI/quality foundation: TypeScript (strict, NodeNext) + Biome (lint/format) + Vitest (tests + v8 coverage), CI workflow (quality + secret scan), CodeQL, and OpenSSF Scorecard.

## Next

Engine increments, in dependency order: parse inbound mail → thread conversations → store → send (with signed reply tokens in outbound Message-IDs). The six-operation conversation API and an agent inbox UI follow per the charter's API-first rule.

## Not yet / deferred

- Live Vercel + Supabase deployment — deferred until the first deployable milestone; provider adapters are stubbed behind interfaces, not built yet.
- Agent inbox UI.
- Marketplace (paid modules, license keys, module registry).

---

_Last updated: 2026-07-10_
