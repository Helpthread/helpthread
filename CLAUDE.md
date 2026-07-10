# Helpthread — engine repo

Helpthread is an open-source serverless helpdesk (AGPL-3.0 core, owned by Resonant IQ, Inc.). **CHARTER.md is the constitution** — read it before substantive work.

## References & provenance

- Helpthread is an independent implementation. No code copied or derived from copyleft-licensed projects, ever.
- Dependencies and study references are permissively licensed (MIT/Apache), with the license verified at adoption.
- Behavior is specified from public standards (RFCs), public documentation, and black-box testing of running systems.
- Every substantive change gets real human review before merge — ordinary PR review, preserved in git history. This is also what keeps AI-assisted work copyrightable and thus dual-licensable; a rubber stamp doesn't meet that bar.

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
