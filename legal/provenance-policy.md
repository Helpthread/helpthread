# Provenance & AI-Assisted Development Policy (DRAFT)

> **Status: DRAFT for counsel review (TJ).** Drafted 2026-07-19. This is a faithful
> first draft codifying practices already stated in CHARTER.md §3; it is not legal advice
> and has not been reviewed by outside counsel — TJ is the reviewing counsel.
>
> **Gate:** **internal** policy — may be adopted at any time. It documents existing
> practice rather than gating a launch. (Section 8 is internal rationale for counsel, not
> a public warranty — see the banner on that section.)

---

## 1. Why this policy exists

Helpthread's value rests on clean provenance. Clean provenance is what lets the project
enforce the AGPL on its core (you can only enforce a copyright you can prove you hold),
what gives Resonant IQ clean title to its commercial modules, and what keeps
AI-assisted work firmly copyrightable. This policy states, as standing practice, how the
Helpthread codebase is built so that its provenance stays clean and demonstrable. It
codifies what CHARTER.md §3 (Provenance) already commits the project to; where this
policy and the charter appear to differ, the charter governs.

## 2. Independent implementation

Helpthread is an **independent implementation**. The repository contains **no code
copied or derived from any copyleft-licensed project**. The core is the project's own
code, built on permissively-licensed foundations, and its behavior is specified from
first principles against public sources — not reproduced from another project's
implementation.

This is one of the project's **sacred invariants** (CHARTER.md §6): *provenance
purity — no copyleft-derived code enters the shipping tree.*

## 3. What we read, and what we do not

The distinction between a **behavioral reference** (which informs *what* the software
should do) and a **code source** (from which implementation is taken) is load-bearing,
and the project holds it strictly.

**Copyleft codebases are never opened during development.** Copyleft-licensed source —
FreeScout's AGPL source foremost among the references the project is otherwise aware of —
is not read while building Helpthread. FreeScout serves only as a *window into the
user experience* of a self-hosted helpdesk; it is a UX and feature-surface reference,
never a source of code, and its source is not consulted.

**Where behavior comes from instead:**

- **Public standards** — RFCs (RFC 5322 and related) for mail semantics, the primary
  source for how email is expected to behave.
- **Public documentation** and published product behavior.
- **Black-box observation** of running systems — behavior verified against reality, and,
  where already captured, against the project's own fixtures.
- **Permissively-licensed references**, whose licenses are verified before adoption:
  - **postal-mime** (MIT-0) — the MIME-parsing dependency.
  - **Chatwoot** — MIT core, adaptable with attribution; **the `enterprise/` folder is
    not MIT and is excluded.**

Modern TypeScript/AI helpdesks may be *looked at* for UX and interaction patterns, but
their **code is not adapted unless a permissive license is confirmed**. Where a reference
project's license does not clearly resolve as permissive, the project's posture is
**look-only** — patterns and ideas, never code.

## 4. Dependency license verification

Every third-party dependency is **license-verified at adoption**. A dependency is added
only after its license is confirmed compatible with the project's licensing structure
(permissive, or otherwise cleanly compatible with shipping under AGPL-3.0 for the core
and under the commercial license for paid modules). License verification is a condition
of adoption, not an afterthought.

## 5. Human design and review on every change

**Every substantive change receives real human design and review before it is merged** —
ordinary pull-request review, preserved in git history. This is a first-class practice,
not a formality:

- it is how threading correctness, mail-semantics equivalence, and the other sacred
  invariants are actually protected (CHARTER.md §6);
- it is the human authorship and creative control that, under current U.S. Copyright
  Office guidance on AI-assisted works, keeps the resulting code **copyrightable** — a
  rubber stamp would not meet that bar;
- the preserved review history is the evidentiary record of that human involvement.

## 6. Developer Certificate of Origin on every commit

Contributions are accepted under the **Developer Certificate of Origin (DCO)** — a
sign-off on **every commit**, with the inbound license identical to the outbound license
and no contributor license agreement (CHARTER.md §3, §7). The DCO sign-off is each
contributor's attestation that they have the right to submit the work under the project's
license. Contributors keep the copyright on their own work; Resonant IQ holds the
copyright on its own.

## 7. What this provenance chain secures

Taken together — independent implementation, no copyleft-derived code, provenance-clean
references, license-verified dependencies, human-reviewed changes, and DCO sign-off — the
practices above are what let the project:

1. **Enforce the AGPL** on the core, because it can prove it holds the copyright it seeks
   to enforce (copyright claims belong to whoever owns the lines at issue).
2. Hold **clean title** to the first-party commercial modules.
3. Keep AI-assisted work **copyrightable**, via demonstrable human authorship.

## 8. AI-assisted development and training-data risk — internal policy rationale

> **This section is internal analysis for counsel. It is a candid risk assessment and a
> statement of mitigations — not a public warranty, representation, or guarantee to any
> user, contributor, or customer. Nothing in this section should be quoted as a promise
> that the codebase is free of any particular defect.**

Helpthread is built with substantial AI assistance. That raises a specific, honestly
acknowledged risk: an AI coding assistant, trained on large corpora that include
non-permissively-licensed code, could in principle **reproduce fragments of training-set
code** — including copyleft-licensed code — in its output, in a way that a human author
using the same tool might not immediately recognize as copied. This is the provenance
risk unique to AI-assisted development, distinct from the human-authorship /
copyrightability question addressed in section 5.

The project manages this risk with **layered mitigations**, no single one of which is
relied on alone:

1. **Independent, spec-first implementation.** Work proceeds from specifications derived
   from public standards, public documentation, and black-box observation (section 3),
   not from another project's source. Directing implementation from an independent spec
   structurally reduces the chance that output tracks any specific training-set
   implementation, because the target is the specified behavior, not an existing body of
   code.
2. **Human design and review of every change** (section 5). A human reviews each
   substantive change before merge — the same review that secures copyrightability also
   functions as a check against unrecognized copied fragments.
3. **Provenance-clean references** (section 3). Because copyleft source is never opened
   during development and permissive references are license-verified, the human context
   around each change is itself provenance-clean, which makes an anomalous copied fragment
   more likely to stand out in review.
4. **License scanning.** Automated license/secret scanning in the toolchain provides a
   further mechanical check on what enters the tree.

**Residual risk is managed, not eliminated.** These mitigations meaningfully reduce the
probability and blast radius of an AI-introduced provenance defect; they do not reduce it
to zero, and this policy does not claim they do. The honest posture is that the risk is
**actively managed** through the layers above, monitored, and correctable if a defect is
ever found — not that it is impossible. Counsel should treat this section as the basis for
any external representation on the subject, and should calibrate any such representation
to "managed risk," never to a guarantee.

---

### Notes to counsel (not part of the policy)

- **Faithful to CHARTER.md §3.** Sections 2–7 restate practices the charter already
  commits to (independent implementation; no copyleft-derived code; copyleft source never
  opened; behavior from RFCs / public docs / black-box; permissive references —
  postal-mime MIT-0, Chatwoot MIT core with `enterprise/` excluded; license verification
  at adoption; human review as the copyrightability basis; DCO on every commit). No new
  policy is invented.
- **Section 8 is flagged as internal rationale**, per instruction — the AI-training-data
  question is addressed candidly, with the "managed, not zero" statement explicit, and
  marked not-a-warranty at the top of the section.
- **Reference-list scope.** FreeScout is named only as the UX/experience window it is
  (never a code source); the "look-only" posture for reference projects whose license
  doesn't resolve is carried from the charter and CLAUDE.md. Specific such projects are
  not named here to avoid dating the policy; counsel can add or omit names as desired.
