# Provenance Policy

> **This document states the properties Helpthread's codebase is built to hold.** It is
> not a warranty, not a factual guarantee, and it creates no rights in any third party.
> It is not legal advice.
>
> **It commits to outcomes, not to methods.** The tools, workflows, and review mechanisms
> the project uses to reach these outcomes change as the technology changes, and nothing
> here is a commitment to any particular one of them. Where this policy and the
> [Founding Charter](../CHARTER.md) appear to differ, the charter governs.

---

## 1. Why this policy exists

Helpthread's value rests on clean provenance. Clean provenance is what supports the
project's ability to enforce the AGPL on its core — you can only enforce a copyright you
can prove you hold — and supports Resonant IQ's title to its own work.

## 2. Independent implementation

Helpthread is an **independent implementation**. **No copyleft-derived code enters the
shipping tree.** The core is the project's own code, built on permissively-licensed
foundations, and its behavior is specified against public sources rather than reproduced
from another project's implementation.

This is one of the project's charter commitments ("Provenance must be defensible"):
*provenance purity — no copyleft-derived code enters the shipping tree.*

## 3. Observed behavior is not a code source

The distinction between **observed behavior** — evidence about how a system can behave —
and a **code source**, from which implementation is taken, is load-bearing, and the
project holds it strictly. Observations are evidence. They do not define Helpthread's
interface, feature set, or product decisions, and they are not a route by which another
project's code enters this one.

Where Helpthread's behavior comes from:

- **Public standards** — RFCs (RFC 5322 and related) for mail semantics, the primary
  source for how email is expected to behave.
- **Public documentation** and published product behavior.
- **Black-box observation** of running systems, verified against the project's own
  fixtures.
- **Permissively-licensed references**, whose licenses are confirmed before anything is
  adopted from them. Currently: **postal-mime** (MIT-0), the MIME-parsing dependency;
  and **Chatwoot**, whose core is MIT and adaptable with attribution — its `enterprise/`
  folder is not MIT and is excluded.

Where a reference project's license does not clearly resolve as permissive, nothing is
adapted from it. Patterns and ideas, never code.

## 4. Dependency licensing

**Every third-party dependency in the tree carries a license compatible with the
project's licensing structure** — permissive, or otherwise cleanly compatible with
shipping the core under AGPL-3.0. A dependency whose license does not resolve does not
ship.

**Attribution travels with what requires it.** Where a permissive license requires
attribution, the notice is carried in the repository: adapted files identify their
source and license at the point of adaptation, and each distributed artifact carries the
third-party license texts it is required to include.

## 5. Changes are reviewed before they merge

**No change reaches `main` without review and the maintainer's approval, and the record
of that review is preserved in the repository's history.** Review is how the project's
sacred invariants are actually protected — threading correctness, mail-semantics
equivalence, and the rest — and it is the principal safeguard against unrecognized
copied fragments entering the tree.

How that review is performed is an engineering decision, not a commitment made here.

## 6. Developer Certificate of Origin on every commit

Contributions are accepted under the **Developer Certificate of Origin (DCO)** — a
sign-off on **every commit**, with the inbound license identical to the outbound license
and no contributor license agreement. The DCO sign-off is each contributor's attestation
that they have the right to submit the work under the project's license. Contributors
keep the copyright on their own work; Resonant IQ holds the copyright on its own.

**External contributions are held to this policy.** Outside contributors are asked for
the same properties it states: no copyleft-derived code, license-compatible
dependencies, DCO sign-off on every commit, and review before merge. The DCO attests a
contributor's **right to submit**; this policy governs what the resulting tree contains.

## 7. AI-assisted development

Helpthread is built with substantial AI assistance. Everything in this policy applies to
AI-assisted work without exception — the same prohibition on copyleft-derived code, the
same dependency-licensing requirement, the same review and approval before merge, and
the same DCO sign-off. The provenance properties this policy states do not vary with who
or what produced a change.
