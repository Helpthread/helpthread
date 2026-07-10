# Session log

Append-only. One entry per working session: date, side, sources touched, artifacts.

## 2026-07-09 — foundation — TJ Baker + Claude (Fable 5)

- **Side:** foundation (no source contact: no FreeScout source, no quarantined material read).
- **Sources touched:** none requiring the wall. License verification via public registries/repos (Chatwoot LICENSE, npm, GitHub API). Codex CLI used for an independent charter review.
- **Artifacts:** CHARTER.md (drafted by a Sonnet agent from a decision brief; proofed, revised, and approved by TJ through multiple rounds — human authorship throughout), LICENSE (AGPL-3.0 verbatim from gnu.org), README.md, CLAUDE.md, this provenance skeleton.
- **Decisions of record:** name Helpthread; AGPL-3.0 core + CLA + commercial first-party modules; Resonant IQ, Inc. holds copyright; clean-room reference hierarchy (permissive → black-box → source-last-resort); quarantine = resonant-help repo's ported mail modules, reference-only, spec side only.

## 2026-07-09 (evening) — foundation

- Actors: TJ Baker (human) + Claude (Fable 5, orchestrating; Sonnet agent drafted the protocol doc)
- Sources touched: CHARTER.md, CLAUDE.md, provenance/README.md (this repo only — no FreeScout source, no quarantined material)
- Artifacts produced: docs/clean-room-protocol.md (HT-3); CHARTER.md edits (mail-semantics principle generalized beyond FreeScout; §3 note on why FreeScout alone is named; Phase 0 history rule scoped to code); CLAUDE.md quarantine rule scoped to engine code
- Notes: proof pass caught and fixed a §8/CLAUDE.md/charter contradiction — the "nothing traceable to source-visible sessions" rule would have outlawed committing specs; now scoped to engine code with the spec-side carve-out.
