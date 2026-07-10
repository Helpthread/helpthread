# Helpthread — engine repo

Helpthread is an open-source serverless helpdesk (AGPL-3.0 core, owned by Resonant IQ, Inc.). **CHARTER.md is the constitution** — read it before substantive work.

## References & provenance

- Helpthread is an independent implementation. No code copied or derived from copyleft-licensed projects, ever.
- Dependencies and study references are permissively licensed (MIT/Apache), with the license verified at adoption.
- Behavior is specified from public standards (RFCs), public documentation, and black-box testing of running systems.
- Every substantive change gets real human review before merge — ordinary PR review, preserved in git history. This is also what keeps AI-assisted work copyrightable and thus dual-licensable; a rubber stamp doesn't meet that bar.

## Coding discipline

Adapted in our own words from Andrej Karpathy's observations on LLM coding pitfalls (see [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills); that repo carries no license, so nothing here is copied verbatim):

- **Think before coding.** State assumptions out loud. If a request is ambiguous, present the interpretations instead of silently picking one. Name confusion the moment it appears — don't code through it.
- **Simplicity first.** The minimum code that solves the problem; nothing speculative. No unrequested features, no configurability nobody asked for, no abstractions for single-use code. Self-check: would a senior engineer call this overcomplicated?
- **Surgical changes.** Every changed line traces directly to the request. Match the surrounding style. Clean up only the messes your own change created — pre-existing dead code stays unless removal was asked for.
- **Goal-driven execution.** Turn vague asks into verifiable success criteria (a failing test first, where possible), then loop until *verified* — not until plausible.

## Workflow

- Branches: `<type>/ht-<ticket>-<kebab-desc>` (Jira project **HT**). PRs to `main`; `main` stays releasable (charter invariant #4). No direct pushes to `main` after Phase 0.
- Commit author email stays the noreply address already set in `.git/config` (GitHub email-privacy blocks the real one).
- Delegate work to subagents on the cheapest capable model: Haiku for mechanical, Sonnet for standard implementation, top-tier only for correctness-critical reasoning.
- Mail semantics are sacred (charter §2, invariant #5): changes require fixture-proven equivalence or explicit written justification. Verify against reality before claiming done; put the evidence in the PR.

## Vocabulary

**Agents** are human support staff. **Assistants** are AI actors. Never conflate them — in schema, code, docs, or prose.

## Ecosystem

- **This repo**: engineering truth — charter, specs, ADRs, code.
- **Confluence (Helpthread space)**: business layer — decision log, counsel checklist, status for stakeholders (Tito reads here).
- A `CLAUDE.local.md` (gitignored) may carry machine-local working notes; it is never committed.
