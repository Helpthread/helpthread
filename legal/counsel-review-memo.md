# Counsel review memo — Helpthread legal drafts

**Status:** prepared work product for outside counsel. **Not legal advice.** Prepared
2026-07-20 by the project's AI tooling under TJ's direction, in the role of paralegal
legwork: issue-spotting, internal-consistency auditing, and draft alternatives. Counsel
decides; nothing here is a legal conclusion.

**Covers:** `module-commercial-license.md`, `trademark-policy.md`,
`provenance-policy.md` (this PR), and `module-api-exception.md` (PR #99, reviewed
together as one package).

## Method — and its limits

Five independent review passes: two by OpenAI Codex, one each by GPT-5.2, Grok 4.5, and
Gemini 3.1 Pro, adjudicated by a Claude lead. Every reviewer of the AGPL exception was
given the **canonical AGPL-3.0 §7 text** (gnu.org, matching this repo's `LICENSE`)
rather than left to recall it — an early pass proved that recall-based §7 analysis gets
it wrong. Every finding below was **verified against the actual document text** before
being applied or listed; of ~45 raw findings, roughly a fifth were false positives
(stale reads, misquotes, or objections to deliberate charter decisions) and were
dropped.

Hard limits of this work: no access to Westlaw/Lexis or any case-law database; no
verification of current statutes or doctrine; no jurisdiction-specific analysis.
Anything below that rests on law rather than on the documents' own text is flagged.
**No case citations appear anywhere in this package by design** — reviewers were
instructed not to cite what they cannot verify.

## What was already applied (drafting fixes, in the diffs)

Commercial license: forward-entitlement vs. Surviving-Held-Copies split in §1 (was an
internal contradiction with §7); lapse/hosted-instance continuity stated affirmatively
(§6); license-keys-are-distribution-credentials-only clause added (§6, encoding the
project's central commercial invariant into the contract); notice-and-cure termination
of forward entitlement for material breach (§8 — was a right with no remedy); fraud
examples narrowed so ordinary breach is not swept into revocation (§8); survival list
now includes §3 as applied to held copies; change-of-control transfer given a notice
period and a one-time domain redesignation (§13, preserving the one-license-one-domain
unit); formal grant verbs in §4; taxes and no-support-obligation boilerplate; defined-
term punctuation.

Trademark policy: npm organization/namespace moved out of the "Marks" definition into a
separate distribution-channel-control paragraph (claiming a namespace *as a trademark*
overreached); §4 fork heading aligned with its non-binding body; marketplace-name
placeholder marked for counsel to finalize.

Provenance policy: attribution mechanics stated (where MIT notices live, and that they
travel in the same reviewed commit as the adaptation).

AGPL exception (PR #99): the narrowing proviso reframed from prohibition to §7 ¶2
self-removal, twice — the first fix still carried a labelling prohibition a second pass
caught; the Module API boundary reframed from "not licensed for combination" (reads as
a new denial of rights) to "not covered by this permission" (scope).

## Decisions deliberately NOT made here — counsel's queue

1. **Exception — which anti-mislabeling framing.** Three viable routes: §7 ¶2
   self-removal (currently drafted), §7(c) origin/marking terms, or full relocation to
   the trademark policy. Drafting notes in the document lay out all three.
2. **Exception — Corresponding Source / Installation Information carve-out.** Does the
   current carve-out overreach for a pure additional permission, or is it acceptable?
   Needs AGPL interpretation applied to this integration model.
3. **Exception — grant framing vs. network use.** The grant opens "If you modify this
   Program... by combining... or by linking, loading, or invoking." Whether that reaches
   pure deployment/AGPL §13 network-use scenarios — exactly where the exception is
   needed — is a scope question counsel should settle.
4. **Exception — strip-the-clause fork.** If a fork removes only the self-removal
   sentence while keeping the permission, does the base AGPL adequately protect the
   project? (Additional permissions are removable in whole or in part.)
5. **Exception — severability.** No severability clause for the permission itself;
   should one be added?
6. **Commercial license — Surviving Held-Copies vs. fraud.** One reviewer flagged that
   the survival of held-copy rights through *fraud revocation* grants a perpetual
   license to bad actors. This is **deliberate** — the charter (2026-07-19 amendment)
   accepts it as "a consciously accepted residual exposure," because no runtime
   enforcement exists by design. The open legal question: should the *legal right*
   nonetheless terminate on confirmed fraud (with enforcement simply impractical),
   or does the current honest-encoding approach serve better? Product posture says the
   latter; counsel should confirm the risk is acceptable as written.
7. **Commercial license — breach termination vs. running hosted instances.** The new
   material-breach remedy deliberately does *not* decommission an already-running
   hosted instance. Alternative: allow decommissioning after the cure window. The
   drafted choice is the more customer-protective and charter-consistent one.
8. **Commercial license — venue/forum selection.** Deliberately undrafted (outside
   decided scope). One reviewer flagged long-arm exposure without it. Needs law.
9. **Commercial license — liability-cap enforceability.** Delaware
   consumer-protection/unconscionability limits on §10's cap: needs verification, not
   assessable from the text.
10. **Commercial license — smaller items.** Modification-ownership vs. license-back
    (§7 says "you own your own original modification contributions" with no
    definition); affiliates vs. assignment interplay (§4/§13); the service-bureau
    clause vs. "outsourced support agents" in Authorized Users (§4/§5.4) — the terms
    coexist but the boundary ("support *for* you" vs. "helpdesk *as* you") could be
    crisper; "Source — a source-code tarball" may need adjusting if delivery later
    includes built artifacts.
11. **Trademark — naked-licensing risk.** §3.3 permits keeping the Marks on unmodified
    redistribution with no quality-control provision. Whether that risks abandonment
    arguments (and what minimal quality-control language cures it) needs trademark
    doctrine.
12. **Trademark — "materially modified" threshold.** Where the rename *request* could
    become an enforceable confusion claim is a Lanham Act question; the policy
    deliberately does not assert the answer.
13. **Provenance — absolutes vs. hedges.** The policy states absolutes ("no code is
    copied," "every substantive change receives real human review") that mirror the
    charter's own posture and serve as copyrightability/enforcement evidence. One
    reviewer (correctly) noted absolutes become impeachment material on a single
    exception. Softening them is a posture decision with real costs both ways;
    a middle path is a documented-exceptions register. Not changed here.
14. **Marketing-copy audit (action item, TJ).** Public statements like "a license
    never stops running software" must carry the refund/revocation qualifiers the
    license itself carries, or reliance/false-advertising risk accrues. Someone should
    sweep the site/README copy against §6/§8 before launch.

## Cross-document consistency note

The commercial license references the marketplace **terms of sale** and
**managed-hosting terms** for refund windows, dispute mechanics, and decommissioning
timelines. Neither document exists yet; both are on the same pre-revenue counsel gate.
Until they exist, §8's incorporations-by-reference are forward references.

**⚠️ Counsel: the specific figures below are NOT client instructions.** A 14-day refund
window, a 7-day config-export grace, and immediate-decommission-on-revocation-only appear
in `specs/modules/marketplace-v1.md` §10, and an earlier draft of this memo attributed
them to a client decision dated 2026-07-19. **That attribution was false.** An audit on
2026-07-20 searched every message the client sent across all working sessions and found
no instance of any of these terms. They were generated by an AI assistant drafting the
spec and then cited back as though the client had chosen them.

They are recorded here only as **placeholders awaiting the client's actual decision**.
Do not draft the terms of sale or managed-hosting terms around them, and do not treat
them as instructions, until the client has stated the figures himself.
