# Helpthread Commercial Module License v1.0 (DRAFT for counsel review)

> **Status: DRAFT for counsel review (TJ).** Drafted 2026-07-19. This is a faithful
> first draft encoding already-made product decisions; it is not legal advice and has
> not been reviewed by outside counsel — TJ is the reviewing counsel.
>
> **Gate:** must clear review **before public launch** — specifically before Stripe is
> switched to live mode and the marketplace takes real money. It does **not** gate
> test-mode dogfood, where a placeholder license suffices (`specs/modules/
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
third-party dependency, which each carry their own licenses. Your rights in the Module are
exercised through the documented module interfaces and out-of-process integration; nothing
in this License restricts, modifies, or replaces any right you have in the AGPL-licensed
core under the AGPL-3.0.

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

1. **Run** the Module in your operator-controlled Helpthread deployment for the Licensed Domain.
2. **Read** the Source in full.
3. **Modify** the Source **for your own internal use** — to adapt, configure, fix, or
   extend the Module for your own Licensed Domain deployment.

Modifications you make for internal use are yours to run under the same terms as the
unmodified Module, on the Licensed Domain, subject to the same prohibitions in section 5.

**Authorized Users.** The rights in this section are for your **Authorized Users**: your
employees, contractors, and outsourced support agents acting for you in operating the
Licensed Domain helpdesk; and your own end-customers, to the extent they interact with
that helpdesk. Your **affiliates** may exercise these rights as well, but only for the one
deployment serving the Licensed Domain — not to stand up separate deployments of their
own, each of which would require its own license under section 3.

## 5. What you may not do

You may **not**, whether with the original Source or any modification of it:

1. **Redistribute** the Source or any Module artifact to any third party.
2. **Sublicense**, **resell**, rent, lease, or otherwise transfer your rights in the
   Module to any third party.
3. **Publish** or publicly disclose the Source, or any modified version of it, in any
   form or by any means.
4. **Offer the Module to third parties as a service.** Operate the Module, in original or
   modified form, to provide hosted, managed, outsourced, white-label, or service-bureau
   helpdesk services to third-party businesses — that is, make its functionality available
   to anyone other than your Authorized Users (section 4). Ordinary support of your own
   customers through your own Licensed Domain helpdesk is expressly permitted and is not a
   service-bureau use; operating a helpdesk on behalf of other businesses is what this
   prohibits.

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

## 7. Your held copies keep working — the Surviving Held-Copies License

This is a deliberate and permanent commitment, stated affirmatively because it is part
of what you are buying. What continues is a **license that survives** — the **"Surviving
Held-Copies License"** — **not** a transfer of ownership: the Module itself and all of
Resonant IQ's underlying intellectual property remain Resonant IQ's, and what survives is
your right to keep and run, under this License, the copies already in your hands.

**Every version of the Module you have already downloaded — and every modification of it
you have made for internal use — is yours to keep and to run, on the Licensed Domain,
forever, under this Surviving Held-Copies License, regardless of the state of your
subscription.** This surviving right includes the right to **create new internal
modifications of versions you already hold** — to keep adapting, configuring, fixing, and
extending those copies for your own Licensed Domain deployment — and that right survives
lapse, full refund, and revocation alike. You own your own original modification
contributions; the Module itself and Resonant IQ's underlying IP remain Resonant IQ's, and
every prohibition in section 5 continues to apply to the held copies and to any
modification of them.

The Module ships with **no digital rights management, no license key check at runtime, no
activation, no expiry, and no "phone home"** of any kind. Nothing in the Module reaches
back to Resonant IQ, and nothing in it will stop working because a subscription has lapsed,
been refunded, or been revoked — because there is nothing in the held bits to switch off.

What a change in subscription state affects is **access to the marketplace's download and
update channel**, never software already in your hands:

- A **lapse** ends access to versions published after the lapse (section 6). It never
  reaches versions you already hold, and you keep marketplace access to re-download the
  versions you were entitled to at the moment of lapse.
- A **termination** — whether by full refund or by revocation for fraud (section 8) —
  ends **all** future marketplace download access, including to versions you were
  previously entitled to. Termination never reaches any copy of the Module, original or
  modified, that you already hold and run on your own infrastructure: those copies
  continue under the Surviving Held-Copies License above, because there is nothing in
  them to switch off.

This guarantee is why the licensing unit in section 3 can rest on contract alone: we
would rather state the terms plainly and trust you to honor them than degrade the
product with enforcement machinery that would make it hostile to the people who own it.

## 8. Termination

Termination under this section ends the **forward entitlement** this License grants — your
right to new downloads and updates, all future marketplace download access (including to
versions you were previously entitled to). It does
**not** disturb the **Surviving Held-Copies License** in section 7, which is a separate,
defined right that continues for the copies already in your hands and your internal
modifications of them. "Terminated" and "survives" therefore refer to two different things:
the forward entitlement terminates; the Surviving Held-Copies License survives.

**Full refund.** If your purchase is refunded in full within the refund window stated in
the marketplace **terms of sale** (fourteen (14) days from purchase; only a refund of the
full purchase price terminates — partial or goodwill refunds do not affect this License),
the forward entitlement under this License terminates: your entitlement to new downloads
and updates ends, and all future marketplace download access ends, including to versions
you were previously entitled to. Section 7 governs what the termination does **not**
reach.

**Revocation for fraud.** Resonant IQ may revoke this License for confirmed fraud — for
example a stolen payment method, a fraudulent chargeback, or redistribution or resale of
the Source in knowing breach of section 5 — following an actual investigation.
Revocation ends the forward entitlement and all future marketplace download access
(including to previously entitled versions). Revocation is never triggered automatically by a payment
dispute merely being filed. Section 7 again governs what revocation does **not** reach.

**Ordinary breach is not fraud.** A non-fraudulent breach of the terms of sale — running
a second deployment on a single-domain License, say — is **not** grounds for revocation
under this section. Revocation is reserved for confirmed fraud because loss of download
access is the harshest consequence this License provides. Ordinary breach is a commercial
matter handled under the terms of sale.

Sections 5, 7, 9, 10, 11, 12, and 13 survive termination of this License.

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
Helpthread's licensing structure (see the [legal guide](README.md)), the project accepts
contributions under the Developer Certificate of Origin without a contributor license
agreement, and therefore without the warranties or indemnities a CLA would collect; any
indemnity Resonant IQ may separately agree to is priced and scoped without reliance on
upstream contributor representations.

## 11. Governing law

This License is governed by the laws of the **State of Delaware**, United States,
without regard to its conflict-of-laws rules. *(Verified: Certificate of
Incorporation of Resonant IQ, Inc., a Delaware corporation, filed with the Delaware
Secretary of State May 19, 2026, file no. 10629316 — corporate records on file.)*

## 12. Entire agreement and order of precedence

This License, together with the marketplace terms of sale, constitutes the entire
agreement between you and Resonant IQ regarding the Module and supersedes any prior or
contemporaneous understandings on that subject.

Each of these documents governs its own domain, and on any conflict each controls within
that domain:

- **This License** controls the **code-use mechanics** — what you may and may not do with
  the Module and its Source (sections 4, 5, and 7).
- The marketplace **terms of sale** control the **commerce** — pricing, refunds, lapse,
  disputes, and the domain-count economics of purchasing.

Where the documents appear to conflict, the one whose domain the matter falls into
controls for that matter; no document is read to override another outside its own domain.

## 13. General provisions

- **Severability.** If any provision of this License is held unenforceable, that provision
  is enforced to the maximum extent permissible and the remaining provisions stay in full
  effect.
- **Waiver.** No failure or delay by Resonant IQ in exercising any right under this License
  waives that right, and no single or partial exercise forecloses any further exercise. A
  waiver is effective only if in writing and signed by Resonant IQ.
- **Notices.** Notices under this License are given in writing through the contact channels
  stated in the marketplace terms of sale (to Resonant IQ) and to the account and billing
  contact on your marketplace account (to you).
- **Assignment; change of control.** You may not assign or transfer this License, in whole
  or in part, without Resonant IQ's prior written consent, except that this License
  transfers with a sale of all or substantially all of the licensee's business or assets to
  which the Licensed Domain belongs, for continued use on that same Licensed Domain, on
  written notice to Resonant IQ. Any other purported assignment is void. Resonant IQ may
  assign this License in connection with a merger, acquisition, or sale of its business.

---

### Notes to counsel (not part of the License)

- **Governing law / incorporation — VERIFIED 2026-07-19.** Delaware confirmed against the
  filed Certificate of Incorporation (Delaware SoS, filed May 19, 2026, file no. 10629316)
  in the company's corporate records. Venue/forum-selection remains undrafted (outside the
  decided scope) — add if desired.
- **Cross-references left as pointers, by instruction.** The refund window (14 days)
  and full-refund-only termination are referenced with their decided values, while
  their full mechanics remain in the terms of sale rather than being restated here.
- **Scope held to the decided space.** Multi-domain / bulk licensing is deliberately not
  drafted (decision: "may exist later; do not draft it"). Severability, waiver, notices,
  and assignment/change-of-control were added per the adjudicated Codex-review fixes
  (2026-07-19); no arbitration clause and no venue/forum-selection clause beyond the
  Delaware governing law in section 11 is included. Export-control remains undrafted.
