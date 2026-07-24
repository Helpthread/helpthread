# Provenance & AI-Assisted Development Policy (DRAFT)

> **Status: DRAFT for counsel review (TJ).** Drafted 2026-07-19. This is a faithful
> first draft codifying practices already stated in the [legal guide](README.md); it is not legal advice
> and has not been reviewed by outside counsel — TJ is the reviewing counsel.
>
> **This document states policy and process — the commitments and practices the project
> works to — not warranties or factual guarantees, and it creates no rights in any third
> party.** It describes how Helpthread is built and how contributions are handled; it is
> not a representation to any user, contributor, or customer that any particular outcome is
> assured.
>
> **Gate:** **internal-facing** policy that may also be published as a statement of
> practice — it documents existing process rather than gating a launch.

---

## 1. Why this policy exists

Helpthread's value rests on clean provenance. Clean provenance is what supports the
project's ability to enforce the AGPL on its core (you can only enforce a copyright you can
prove you hold), supports Resonant IQ's title to its commercial modules, and is intended to
support the copyrightability of AI-assisted work under current U.S. Copyright Office
guidance. This policy states, as our standing practice, how the Helpthread codebase is
built so that its provenance stays clean and demonstrable. It codifies what the [legal guide](README.md)
(Provenance) already commits the project to; where this policy and the charter appear to
differ, the charter governs.

## 2. Independent implementation

Helpthread is an **independent implementation**. It is our standing policy and practice
that **no code is copied or derived from any copyleft-licensed project**; contributions
are accepted only under the DCO (section 6) and these provenance rules. The core is the
project's own code, built on permissively-licensed foundations, and our practice is to
specify its behavior from first principles against public sources rather than reproduce
another project's implementation.

This is one of the project's **project commitments** (CHARTER.md, "Provenance must be defensible"): *provenance
purity — no copyleft-derived code enters the shipping tree.*

## 3. What we read, and what we do not

The distinction between **observed behavior** (evidence about how a system can behave)
and a **code source** (from which implementation is taken) is load-bearing, and the
project holds it strictly. Observations do not define Helpthread's product decisions.

**Our policy is that copyleft codebases are not opened during development.**
Copyleft-licensed source is not consulted while building Helpthread. Historical
black-box observations of running systems may remain as evidence, but they do not
govern Helpthread's interface, feature set, or commercial boundaries.

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

Our practice is to **license-verify every third-party dependency at adoption**. A
dependency is added only after its license is confirmed compatible with the project's
licensing structure (permissive, or otherwise cleanly compatible with shipping under
AGPL-3.0 for the core and under the commercial license for paid modules). License
verification is a condition of adoption, not an afterthought. Automated license scanning in
the toolchain supports this **dependency and license hygiene**; it is not a detector of
copied code fragments — human review (section 5) is the primary safeguard against
unrecognized reproduction.

**Where attribution lives.** Where a permissive license requires attribution (MIT's
copyright-notice condition, for adapted Chatwoot material, for example), the required
notice is carried **in the repository**: adapted files identify their source and license
at the point of adaptation, and each distributed artifact (the core repository, and each
module tarball) carries the third-party license texts it is required to include. Adding
the notice is part of the adaptation change itself — the same commit, reviewed together —
not a separate cleanup pass.

## 5. Human design and review on every change

**Our policy is that every substantive change receives real human design and review before
it is merged** — ordinary pull-request review, preserved in git history. This is a
first-class practice, not a formality:

- it is how threading correctness, mail-semantics equivalence, and the other sacred
  invariants are actually protected (CHARTER.md, "Conversation integrity" and "Provenance must be defensible");
- it is the human authorship and creative control that, under current U.S. Copyright
  Office guidance on AI-assisted works, is **intended to support the copyrightability** of
  the resulting code — a rubber stamp would not meet that bar;
- it is the **primary safeguard against unrecognized copied fragments** entering the tree,
  including any that an AI coding assistant might reproduce;
- the preserved review history is the evidentiary record of that human involvement.

## 6. Developer Certificate of Origin on every commit

Contributions are accepted under the **Developer Certificate of Origin (DCO)** — a
sign-off on **every commit**, with the inbound license identical to the outbound license
and no contributor license agreement (see the [legal guide](README.md)). The DCO sign-off is each
contributor's attestation that they have the right to submit the work under the project's
license. Contributors keep the copyright on their own work; Resonant IQ holds the
copyright on its own.

**External contributions follow the same provenance rules.** Outside contributors are
asked to follow the same practice this policy describes: no copyleft-derived code, DCO
sign-off on every commit, and the same human design-and-review before merge. The DCO
attests a contributor's **right to submit** the work; these provenance rules govern the
**process** by which it is written and reviewed. The two are complementary — the DCO
covers legal right-to-submit, these rules cover clean-room practice — and both apply to
first-party and outside contributions alike.

## 7. What this provenance chain is intended to secure

Taken together — independent implementation, no copyleft-derived code, provenance-clean
references, license-verified dependencies, human-reviewed changes, and DCO sign-off — the
practices above are intended to support the project's ability to:

1. **Enforce the AGPL** on the core, by being able to prove it holds the copyright it
   seeks to enforce (copyright claims belong to whoever owns the lines at issue).
2. Maintain **clean title** to the first-party commercial modules.
3. Support the **copyrightability** of AI-assisted work, via demonstrable human authorship.

## 8. AI-assisted development

Helpthread is built with substantial AI assistance. The provenance risk specific to
AI-assisted development is assessed and managed under internal counsel review.

---

### Notes to counsel (not part of the policy)

- **Faithful to the [legal guide](README.md).** Sections 2–7 restate practices the charter already
  commits to (independent implementation; no copyleft-derived code; copyleft source never
  opened; behavior from RFCs / public docs / black-box; permissive references —
  postal-mime MIT-0, Chatwoot MIT core with `enterprise/` excluded; license verification
  at adoption; human review as the copyrightability basis; DCO on every commit). No new
  policy is invented.
- **AI-training-data risk moved to a private counsel memo.** Per the adjudicated
  Codex-review fixes (2026-07-19), the candid residual-risk analysis that was §8 is
  no longer in this public file; §8 now states only that the risk is assessed and managed
  under internal counsel review. The full analysis and mitigations live in a privileged
  counsel memo held outside the repository.
- **Reference-list scope.** The "look-only" posture for projects whose license does not
  resolve is carried from the charter and CLAUDE.md. Specific such projects are not named
  here to avoid dating the policy; counsel can add or omit names as desired.
