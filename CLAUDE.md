# Helpthread — engine repo

Helpthread is an open-source serverless helpdesk (AGPL-3.0 core, owned by Resonant IQ, Inc.). **CHARTER.md is the constitution** — read it before substantive work. This file operationalizes it for every session in this repo.

## Clean-room rules (non-negotiable)

Declare each session's side before touching code:

- **Spec side** — may study FreeScout source and the quarantined ports; produces written behavioral specs and black-box fixtures (behavior, interfaces, formats only — no implementation code, no copied comments or naming).
- **Implementation side** — writes engine code. Context must NEVER contain FreeScout source or quarantined material. Concretely, never read: any FreeScout source tree; `~/Projects/resonant-help/lib/mail/**` or `lib/mailengine/**` (the quarantined tainted port); FreeScout's test suite.

Reference hierarchy (charter §3): permissive sources first (e.g. Chatwoot's MIT core — free to study/adapt with attribution, verify license at adoption) → black-box observation of a running FreeScout → FreeScout source study last resort, spec side only.

**Provenance is mandatory:** log every session in `provenance/sessions.md` (date, side, sources touched, artifacts produced). When module code lands, maintain `provenance/modules/<module>.md` (specs used, sessions involved, human design/review record — human authorship per module is existential for dual-licensing, not optional).

## Workflow

- Branches: `<type>/ht-<ticket>-<kebab-desc>` (Jira project **HT**). PRs to `main`; `main` stays releasable (charter invariant #4). No direct pushes to `main` after Phase 0.
- Commit author email stays the noreply address already set in `.git/config` (GitHub email-privacy blocks the real one).
- Delegate work to subagents on the cheapest capable model: Haiku for mechanical, Sonnet for standard implementation, top-tier only for correctness-critical reasoning. Implementation agents receive context assembled from specs and fixtures only — tiering and the clean room are the same dispatch discipline.
- Mail semantics are sacred (charter §2, invariant #5): changes require fixture-proven equivalence or explicit written justification. Verify against reality before claiming done; put the evidence in the PR.

## Vocabulary

**Agents** are human support staff. **Assistants** are AI actors. Never conflate them — in schema, code, docs, or prose.

## Ecosystem

- **This repo**: engineering truth — charter, specs, ADRs, provenance, code.
- **Confluence (Helpthread space)**: business layer — decision log, counsel checklist, status for stakeholders (Tito reads here).
- **Quarantine**: lives in the `resonant-help` repo, never here. Nothing in this repo's history may trace to a source-visible session.
