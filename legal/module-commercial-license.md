# Helpthread Commercial Module License v1.0 (DRAFT for counsel review)

> **Status: DRAFT for counsel review (TJ).** Drafted 2026-07-19. This is a faithful
> first draft encoding already-made product decisions; it is not legal advice and has
> not been reviewed by outside counsel — TJ is the reviewing counsel.
>
> **Gate:** must clear review **before public launch** — specifically before Stripe is
> switched to live mode and the marketplace takes real money. It does **not** gate the
> HT-82 test-mode dogfood, where a placeholder license suffices (`specs/modules/
> marketplace-v1.md` §8). On adoption, this text **replaces the `All rights reserved`
> placeholder `LICENSE`** in each paid-module repository.

---

## 1. Parties and subject

This Helpthread Commercial Module License (the **"License"**) is a legal agreement
between **Resonant IQ, Inc.**, a Delaware corporation (**"Resonant IQ,"** **"we,"** or
**"us,"** the licensor), and the individual or entity that purchases a subscription to a
Helpthread commercial module (**"you,"** the **"Licensee"**).

A **"Module"** is a first-party Helpthread extension that Resonant IQ distributes for a
fee through the official Helpthread marketplace, delivered to you as **Source** — a
source-code tarball, not a compiled binary. The **"Source"** is the complete tarball
contents of a Module release as published. This License governs your use of the Module
and its Source. It does **not** govern the Helpthread core, which is separately licensed
under the GNU Affero General Public License, version 3.0 (**"AGPL-3.0"**), nor any
third-party dependency, which each carry their own licenses.

Your rights under this License begin when your subscription is active and are subject to
the survival and termination terms in sections 7 and 8.

## 2. Subscription

The Module is licensed, not sold, on an **annual subscription** basis. A subscription
grants the rights in section 4 for the paid term and entitles you to Module updates as
described in section 6 for as long as the subscription remains in good standing.

## 3. Licensing unit — one license, one domain

The unit of licensing is the **domain**. One license authorizes the use of one Module in
**one helpdesk deployment serving one domain** (the **"Licensed Domain"**). Operating
the Module for more than one domain requires a separate license — and therefore a
separate subscription — for each additional domain.

This is a **contractual term**, and it is enforced solely by this License. Consistent
with section 5, Resonant IQ does **not** and will not verify, meter, or technically
constrain the number of domains on which the Module runs; the Module contains nothing
that records, reports, or checks the Licensed Domain. Honoring the one-license-per-domain
term is your contractual obligation, not a gate the software imposes.

## 4. What you may do

Subject to sections 3 and 5, while your subscription is active you may:

1. **Run** the Module in your helpdesk deployment for the Licensed Domain, whether you
   self-host it on your own infrastructure or run it through Resonant IQ managed hosting.
2. **Read** the Source in full.
3. **Modify** the Source **for your own internal use** — to adapt, configure, fix, or
   extend the Module for your own Licensed Domain deployment.

Modifications you make for internal use are yours to run under the same terms as the
unmodified Module, on the Licensed Domain, subject to the same prohibitions in section 5.

## 5. What you may not do

You may **not**, whether with the original Source or any modification of it:

1. **Redistribute** the Source or any Module artifact to any third party.
2. **Sublicense**, **resell**, rent, lease, or otherwise transfer your rights in the
   Module to any third party.
3. **Publish** or publicly disclose the Source, or any modified version of it, in any
   form or by any means.
4. **Offer the Module to third parties as a service** — that is, operate the Module, in
   original or modified form, so as to make its functionality available to anyone other
   than users of your own Licensed Domain helpdesk deployment.

The rights in section 4 exist for **your own** helpdesk. They do not extend to
distributing, publishing, or commercializing the Module or your modifications of it.

## 6. Updates and their relationship to the subscription

An **active** subscription entitles you to Module updates — new versions as they are
published — through the Helpthread marketplace's distribution and update channel.

If your subscription **lapses** (payment missed, or the subscription is not renewed),
you lose access to versions published **after** the lapse only. Every version you were
entitled to at the moment of lapse remains available to you to download, redeploy, and
run indefinitely, per section 7. Resuming payment restores access to current versions.
A lapse is an ordinary non-payment event; it is not a finding of wrongdoing and carries
no penalty beyond pausing access to **new** releases.

## 7. Your copies are yours to keep — no clawback, no DRM

This is a deliberate and permanent commitment, stated affirmatively because it is part
of what you are buying:

**Any version of the Module you have downloaded — and any modification of it you have
made for internal use — is yours to keep and to run, on the Licensed Domain, forever,
regardless of the state of your subscription.** The Module ships with **no digital
rights management, no license key check at runtime, no activation, no expiry, and no
"phone home"** of any kind. Nothing in the Module reaches back to Resonant IQ, and
nothing in it will stop working because a subscription has lapsed, been refunded, or
been revoked.

What a change in subscription state affects is **access to new downloads and updates**,
never software already in your hands:

- A **lapse** ends access to versions published after the lapse (section 6). It never
  reaches versions you already hold.
- A **termination** — whether by full refund or by revocation for fraud (section 8) —
  ends your **entitlement** going forward: your right to new downloads and updates
  stops, and any instance Resonant IQ hosts on your behalf is decommissioned in
  accordance with the published managed-hosting policy (a configuration-export grace
  window applies; section 8). Termination likewise never reaches any copy of the Module,
  original or modified, that you already hold and run on your own infrastructure. Those
  bits keep working, because there is nothing in them to switch off.

This guarantee is why the licensing unit in section 3 can rest on contract alone: we
would rather state the terms plainly and trust you to honor them than degrade the
product with enforcement machinery that would make it hostile to the people who own it.

## 8. Termination

**Full refund.** If your purchase is refunded in full within the refund window stated in
the marketplace **terms of sale** (fourteen (14) days from purchase; only a refund of the
full purchase price terminates — partial or goodwill refunds do not affect this License),
this License terminates and your entitlement to new downloads and updates ends. A
Resonant IQ-hosted instance is decommissioned after the configuration-export grace period
stated in those terms (seven (7) days), during which you may export the instance's
configuration. Section 7 governs what a termination does **not** reach.

**Revocation for fraud.** Resonant IQ may revoke this License for confirmed fraud — for
example a stolen payment method or a confirmed violation of the terms of sale —
following an actual investigation. Revocation ends your entitlement and, for a hosted
instance, results in immediate decommissioning. Revocation is never triggered
automatically by a payment dispute merely being filed. Section 7 again governs what
revocation does **not** reach.

The full mechanics and exact time windows of refunds, disputes, and hosted-instance
decommissioning are set out in the marketplace **terms of sale** and **managed-hosting
terms**, and are not restated in full here; this section states only their effect on
this License.

Sections 5, 7, 9, 10, and 11 survive termination of this License.

## 9. Warranty disclaimer

The Module and its Source are provided **"as is"** and **"as available,"** without
warranty of any kind. To the maximum extent permitted by applicable law, Resonant IQ
disclaims all warranties, whether express, implied, or statutory, including any implied
warranties of merchantability, fitness for a particular purpose, title, and
non-infringement, and any warranty arising from course of dealing or usage of trade.
Resonant IQ does not warrant that the Module will be uninterrupted, error-free, or free
of harmful components, or that it will meet your requirements.

## 10. Limitation of liability

To the maximum extent permitted by applicable law, Resonant IQ will not be liable for any
indirect, incidental, special, consequential, exemplary, or punitive damages, or for any
loss of profits, revenue, data, or goodwill, arising out of or relating to the Module or
this License, whether in contract, tort, or otherwise, even if advised of the possibility
of such damages.

Resonant IQ's **total aggregate liability** arising out of or relating to the Module or
this License will not exceed the **fees you actually paid to Resonant IQ for the Module
in the twelve (12) months** immediately preceding the event giving rise to the claim.

**No indemnity based on upstream contributor representations.** Resonant IQ offers no
indemnification obligation predicated on representations, warranties, or covenants of
third-party or community contributors to the Helpthread project. Consistent with the
Helpthread charter's licensing structure (CHARTER.md §3), the project accepts
contributions under the Developer Certificate of Origin without a contributor license
agreement, and therefore without the warranties or indemnities a CLA would collect; any
indemnity Resonant IQ may separately agree to is priced and scoped without reliance on
upstream contributor representations.

## 11. Governing law

This License is governed by the laws of the **State of Delaware**, United States,
without regard to its conflict-of-laws rules. *(Basis: Resonant IQ, Inc. is a Delaware
corporation. See the note to counsel below — the repository does not independently
corroborate the state of incorporation, so TJ should confirm before this text is
finalized.)*

## 12. Entire agreement

This License, together with the marketplace terms of sale and — where you use managed
hosting — the managed-hosting terms and data-handling disclosure, constitutes the entire
agreement between you and Resonant IQ regarding the Module, and supersedes any prior or
contemporaneous understandings on that subject.

---

### Notes to counsel (not part of the License)

- **Governing law / incorporation.** Delaware is encoded per the stated decision that
  Resonant IQ, Inc. is a Delaware corporation. No document in this repository independently
  states the state of incorporation; this rests solely on that instruction. Confirm before
  finalizing, and add a venue/forum-selection clause if desired (not specified in the
  decided scope, so not drafted).
- **Cross-references left as pointers, by instruction.** The refund window (14 days),
  full-refund-only termination, and the config-export grace window (7 days) — all
  CONFIRMED by TJ 2026-07-19 (spec §10 resolution block) — are referenced with their
  decided values but their full mechanics live in the terms of sale / managed-hosting
  terms rather than being restated here.
- **Scope held to the decided space.** Multi-domain / bulk licensing is deliberately not
  drafted (decision: "may exist later; do not draft it"). No venue, arbitration,
  assignment, or export-control clause is included beyond what the decided scope named.
