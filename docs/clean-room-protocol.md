# Clean-Room Protocol

Operational expansion of CHARTER.md §3 (Licensing & intellectual property). Where this document and the charter conflict, **the charter wins** — file an issue to fix this doc, don't act on the conflict.

## 1. Purpose & authority

This document turns charter §3's clean-room policy into a procedure a person or an AI agent can actually follow session to session: how to declare a side, what each side may touch and produce, what gets logged, and what happens when a rule breaks. It has no authority of its own — it exists to make the charter's policy executable. Counsel reviews this protocol, alongside the CLA and module-boundary work, before public launch (charter §3); nothing here is legal advice in the meantime.

## 2. The two sides

**SPEC side.** May study FreeScout source and quarantined material (see §8) — as a last resort, per the hierarchy in §3. Produces: written behavioral specs, and black-box test fixtures. Output constraints:

- Behavior, interfaces, data formats, and constraints only.
- No implementation code — not draft code, not "reference" snippets.
- No copied comments.
- No FreeScout naming or file/class/module structure, beyond what interoperability with an existing FreeScout deployment genuinely requires (e.g. a wire-format field name).
- Fixtures are authored from *observed* behavior (inputs crafted, outputs recorded). Never copy fixtures or test cases from FreeScout's own test suite.

**IMPLEMENTATION side.** Writes Helpthread engine code from specs and fixtures ONLY. For AI agents this is a literal, enforceable constraint: the working context assembled for the session must contain no FreeScout source and no quarantined material (§8). The orchestrator (human or automated) is responsible for assembling that context and for logging what was assembled (§4d).

**Honest limitation.** The same humans oversee both sides of this wall — Helpthread is a small project, not two isolated teams. The separation that can be proven is contextual and documentary (which sessions and actors had which material in view, on which dates), not a personnel wall. Mitigation is the reference hierarchy below (push source contact toward zero) plus mandatory records (§4, §5) — process without records is a story, not a defense.

## 3. Reference hierarchy

In order of preference, strongest posture first:

1. **Permissively-licensed sources first.** MIT/Apache-licensed libraries as ordinary dependencies — verify and record the license at adoption. Permissively-licensed helpdesk implementations (notably Chatwoot's MIT core) may be studied and adapted freely, with attribution. No wall required for this tier.
2. **Black-box observation second.** Observe a running FreeScout instance: craft inputs, record outputs and behavior. This involves no copying of expression and is the preferred source for fixtures.
3. **FreeScout source study — last resort.** Only when a behavior can't be determined by observation or public documentation. Spec side only. Every instance of this is logged (§5) with what was read and why observation wasn't sufficient.

## 4. Session procedure

**a. Before starting.** Declare the session's side out loud, in the dispatch or the session's opening message: `spec`, `implementation`, or `foundation` (foundation = no source contact at all — docs, infra, CI, non-engine tooling).

**b. During.** Side rules from §2 apply for the whole session. Implementation sessions never open: the quarantine (`resonant-help` repo's `lib/mail/**` and `lib/mailengine/**`), any FreeScout source tree, or FreeScout's test suite — not to "just check something," not for one line, not ever.

**c. After.** Append one entry to `provenance/sessions.md` (format in §5) in the same PR as the work it covers. A PR with engine-code changes and no matching session entry is incomplete, full stop.

**d. Spec → implementation handoff.** When an implementation session is dispatched, its context is assembled from files in `specs/` and `fixtures/` only — never from spec-side working notes, chat history, or anything that touched FreeScout source. The orchestrator states this assembly rule explicitly in the dispatch, and the resulting session log entry records exactly which spec files and fixture files were provided.

## 5. Record formats

### `provenance/sessions.md` entry

Append-only. One block per session, in this format:

```
## 2026-07-09 — implementation

- Actors: TJ Baker (human) + Claude Sonnet 5 (agent)
- Sources touched: specs/mail/threading.md (v3), fixtures/mail/threading/*.json
- Artifacts produced: src/mail/threading.ts, tests/mail/threading.test.ts
- Notes: implemented reply-token matching per spec §2; no FreeScout source or
  quarantine material in context at any point this session.
```

Required fields: date, side (`spec` / `implementation` / `foundation`), actors (name every human and every model involved), sources touched (paths, and versions/commits where the source is a spec or fixture file — or "FreeScout source: <file/behavior>, reason: <why observation was insufficient>" for last-resort spec sessions), artifacts produced (paths), notes (anything relevant to provenance — handoff details, deviations, contamination flags).

### `provenance/modules/<module>.md` manifest

One per shipped module, created or updated whenever a session lands module code:

```
# Module: mail-threading

- Spec files used: specs/mail/threading.md (v3, commit a1b2c3d)
- Sessions that produced this module: 2026-07-09, 2026-07-11, 2026-07-14
  (see provenance/sessions.md for details)
- Human authorship record:
  - 2026-07-09 — TJ designed the reply-token verification flow (rejected the
    first draft's implicit-trust fallback; required explicit signature
    failure -> new-conversation behavior)
  - 2026-07-11 — TJ reviewed generated code, rewrote the header-parsing
    edge case for malformed In-Reply-To values after fixture failures
  - 2026-07-14 — TJ approved final diff after re-running fixture suite
- Dependency licenses verified: mailparser (MIT, verified 2026-07-08)
- Last updated: 2026-07-14
```

"Reviewed" alone never satisfies the human-authorship record — record the actual substantive decision (a design choice made, a generated draft rejected and why, an edge case a human identified and fixed). This record is what makes the module copyrightable; a rubber stamp does not meet the bar (§9).

## 6. Spec hygiene rules

A spec describes behavior; it must never carry FreeScout's expression.

- **GOOD:** "When an inbound message's `In-Reply-To` header contains a valid signed reply token, append the message to that token's conversation. On an invalid or missing signature, treat the message as the start of a new conversation."
- **BAD:** Pseudo-code that mirrors FreeScout's function structure (parameter order, control flow shape) rather than describing the behavior in prose or a black-box input/output table.
- **BAD:** Copying FreeScout's comment text into a spec, even "just for context."
- **GOOD:** "Given a bounce message matching DSN format with status code 5.x.x, mark the original conversation's delivery as failed and do not create a new conversation." (Behavior stated abstractly, verifiable by black-box fixture.)
- **BAD:** Reproducing FreeScout's class names, variable names, or file layout in a spec "so it's easier to find later" — if interoperability doesn't require the name, don't use it.

## 7. Contamination handling

If a session's side is ambiguous, or a rule in §2/§4 was broken (implementation context touched quarantine or FreeScout source, a spec leaked implementation code, etc.): treat the session as **contaminated**.

- Its code output does not ship, under any circumstance.
- Log the incident in `provenance/sessions.md` as its own entry: what was exposed, to which context, and how it was discovered.
- If contaminated output already merged, re-implement the affected artifact from spec in a fresh, clean session, and note the re-implementation in the module's manifest.

**If in doubt, it was contaminated.** Don't adjudicate borderline cases in favor of keeping the code — log it, discard it, redo it clean.

## 8. Quarantine registry

Known quarantined material as of this writing:

- `resonant-help` repo, `lib/mail/**` — FreeScout-derived mail-handling port.
- `resonant-help` repo, `lib/mailengine/**` — FreeScout-derived mail-engine port.
- Any local FreeScout source checkout used for spec-side study.

Rule: quarantined material lives outside this repo forever — it is never copied, symlinked, or vendored into `helpthread`. No **engine code** in this repo may trace to a session that had quarantine or FreeScout source in context; spec-side sessions are source-visible by definition and commit only specs and fixtures (§2), which is the sanctioned path. Additions to the quarantine are recorded here, in this section, when they occur.

## 9. Human authorship requirement

Every shipped module carries a `provenance/modules/<module>.md` manifest recording substantive human design, review, and revision (§5) — this is the project's copyrightability record. Under current U.S. Copyright Office guidance, AI-generated material without sufficient human authorship may not be copyrightable, and uncopyrightable code breaks the CLA/dual-license model the charter depends on (charter §3). AI-only output with a rubber-stamp "looks fine, approved" does not meet this bar — the manifest must name an actual decision a human made, rejected, or changed.
