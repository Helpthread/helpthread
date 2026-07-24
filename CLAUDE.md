# Helpthread — engine repo

Helpthread is open-source support infrastructure (AGPL-3.0 core; a Resonant IQ, Inc. product). **CHARTER.md is the constitution** — read it before substantive work.

## Delegation ladder

Shared rule (mirrored from the resonantiq canonical doc) — imported so it loads in every session that reads this repo.

@.claude/rules/delegation-ladder.md

## PR verdict protocol

Every PR opens with a verdict TJ can act on in under 30 seconds, and **no decision is ever attributed to him without a direct quote**. Mirrored from the canonical rule so it loads in every session that reads this repo. Enforced mechanically for the constitution, `legal/`, and licensing specs by `.github/workflows/pr-verdict.yml`.

@.claude/rules/pr-verdict.md

## References & provenance

- Helpthread is an independent implementation. No code copied or derived from copyleft-licensed projects, ever.
- **The core is our own code, or fully-free (permissively-licensed) code.** Study/adapt references, license verified at adoption:
  - **RFCs** (5322 etc.) for mail semantics — public standards, the primary source.
  - **postal-mime** (MIT-0) — modern serverless MIME parsing; the parsing dependency.
  - **Chatwoot** (MIT core; the `enterprise/` folder is NOT MIT — exclude it) — behavioral/feature reference, adaptable with attribution.
  - Modern TS/AI helpdesks (e.g. antiwork/helper) may be *looked at* for UX/AI patterns, but **their code is not adapted unless a permissive LICENSE is confirmed** — as of 2026-07-10 helper's and cossistant's licenses did not resolve on GitHub, so: look-only.
- Product and interface decisions are governed by Helpthread's charter and specifications,
  not by competitor parity. Existing black-box observations may provide evidence for a
  behavior, but they do not define the product. Copyleft-licensed projects are never code
  sources and their source is not read in a Helpthread development session.
- Behavior is specified from RFCs, public documentation, and — where already captured —
  black-box fixtures.
- Every substantive change gets real human review before merge — ordinary PR review, preserved in git history. This is also what keeps AI-assisted work copyrightable; a rubber stamp doesn't meet that bar.

## Coding discipline

Adapted in our own words from Andrej Karpathy's observations on LLM coding pitfalls (see [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills); that repo carries no license, so nothing here is copied verbatim):

- **Think before coding.** State assumptions out loud. If a request is ambiguous, present the interpretations instead of silently picking one. Name confusion the moment it appears — don't code through it.
- **Simplicity first.** The minimum code that solves the problem; nothing speculative. No unrequested features, no configurability nobody asked for, no abstractions for single-use code. Self-check: would a senior engineer call this overcomplicated?
- **Surgical changes.** Every changed line traces directly to the request. Match the surrounding style. Clean up only the messes your own change created — pre-existing dead code stays unless removal was asked for.
- **Goal-driven execution.** Turn vague asks into verifiable success criteria (a failing test first, where possible), then loop until *verified* — not until plausible.

## Workflow

- Branches: `<type>/<kebab-description>`. PRs to `main`; `main` stays releasable. No direct pushes to `main` after Phase 0.
- Commit author email stays the noreply address already set in `.git/config` (GitHub email-privacy blocks the real one).
- Delegate work to subagents on the cheapest capable model: Haiku for mechanical, Sonnet for standard implementation, top-tier only for correctness-critical reasoning.
- Mail semantics are sacred under the charter's "Conversation integrity" rule: changes require fixture-proven equivalence or explicit written justification. Verify against reality before claiming done; put the evidence in the PR.

## Vocabulary

**Agents** are human support staff. **Assistants** are AI actors. Never conflate them — in schema, code, docs, or prose.

**Modules** are the extension artifacts operators install (free or paid; TJ, 2026-07-18). Never "plugins" — that word survives only inside the legal phrase *plugin exception* (the AGPL §7 additional permission) and charter quotations.

## UI fidelity (TJ, 2026-07-12)

The Agent Inbox UI's pixel source of truth is the Claude Design prototype — `Helpthread App.dc.html` in the "Helpthread Agent Inbox Design" project (the "Helpthread" design-system project carries the same components). **The dogfood site must match it exactly — the whole designed surface, not a subset.** Any deviation — visual, copy, or interaction — requires TJ's explicit sign-off. The work is not complete until the maintained fidelity checklist is clear.

**Design and app reconcile in both directions (TJ, 2026-07-20).** The two are one system, and neither is allowed to silently drift from the other:

- **Design → app.** Files under `web/src/components/ds/` are verbatim copies of the design project's components. Byte-for-byte: its quotes, its semicolons, its import order, its line wrapping. Biome is disabled for that path (`biome.json` override) precisely so a formatter pass can't quietly break the correspondence — without that, byte comparison stops working as a drift detector. New or changed design work comes down via DesignSync; it is not hand-edited in the app.
- **App → design.** If TJ approved something into the dev app, it is approved, and it goes back up into the design project. App-first work is normal — it just isn't finished until the design system has it. `.tsx` screens with API wiring convert to presentational `.jsx` with fixture data on the way up; every style value survives the conversion unchanged.

**Where things live upstream (TJ, 2026-07-20).** The design project has three component folders: `components/core/` for primitives (reusable, context-free, no knowledge of a screen), `components/inbox/` for inbox-specific composition, and `components/app/` for app-level surface — whole screens plus the chrome that frames every screen. The test for `app/` is that the thing owns a route or wraps all of them; anything smaller and reusable is `core/`. Screens upstream are presentational: fixture data, callback props, no API. The app keeps the wiring, the design project keeps the pixels. `web/src/components/ds/` mirrors `core/` and `inbox/`; the `app/` screens live at `web/src/components/` as `.tsx` and are *converted* on the way up, not copied — so they are the one part of the surface where the two sides are deliberately not byte-identical.

The invariant underneath both directions is that **a difference between the two is always a bug in one of them** — so when a re-pull surfaces a semantic difference (a changed style value, prop, or logic, as opposed to formatting), that is a finding, not a merge conflict to resolve in passing. Stop and get TJ's call on which side wins.

## Ecosystem

- **This repo**: engineering truth — charter, specs, ADRs, code.
- **Confluence (Helpthread space)**: business layer — decision log, counsel checklist, status for stakeholders (Tito reads here).
- A `CLAUDE.local.md` (gitignored) may carry machine-local working notes; it is never committed.
