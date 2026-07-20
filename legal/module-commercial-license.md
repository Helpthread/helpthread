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
between **Resonant IQ, Inc.**, a Delaware corporation (**"Resonant IQ"**, **"we"**, or
**"us"**, the licensor), and the individual or entity that purchases a subscription to a
Helpthread commercial Module (**"you,"** the **"Licensee"**).

A **"Module"** is a first-party Helpthread extension that Resonant IQ distributes for a
fee through the official Helpthread marketplace, delivered to you as **Source** — a
source-code tarball, not a compiled binary. The **"Source"** is the complete tarball
contents of a Module release as published. This License governs your use of the Module
and its Source. It does **not** govern the Helpthread core, which is separately licensed
under the GNU Affero General Public License, version 3.0 (**"AGPL-3.0"**), together with
any additional permissions the core's LICENSE file carries (including, once adopted, the
Helpthread Module API Exception), nor any third-party dependency, which each carry their
own licenses. The Source may include third-party materials under their own permissive
licenses; their notices travel with the Source as delivered. Your rights in the Module are
exercised through the documented module interfaces and out-of-process integration; nothing
in this License restricts, modifies, or replaces any right you have in the AGPL-licensed
core under the AGPL-3.0.

Your rights under this License **to receive downloads and updates** begin when your
subscription is active. Your rights in copies you have already received are governed by
the Surviving Held-Copies License (section 7), which continues as stated there
**regardless of subscription status** — nothing in this section, or in any statement
that rights "begin" with an active subscription, cuts back what section 7 grants.

## 2. Subscription

The Module is licensed, not sold, on an **annual subscription** basis. A subscription
grants the rights in section 4 for the paid term and entitles you to Module updates as
described in section 6 for as long as the subscription remains in good standing.

Subscription fees are **exclusive of taxes**. You are responsible for any sales, use,
value-added, or similar taxes arising from your purchase, other than taxes on Resonant
IQ's income; where Resonant IQ is required to collect them, they are added at checkout
as stated in the terms of sale.

## 3. Licensing unit — one license, one domain

The unit of licensing is the **domain**. One license authorizes the use of one Module in
**one helpdesk deployment serving one domain** (the **"Licensed Domain"**). Operating
the Module for more than one domain requires a separate license — and therefore a
separate subscription — for each additional domain.

This is a **contractual term**, and it is enforced solely by this License. Consistent
with section 7, Resonant IQ does **not** and will not verify, meter, or technically
constrain the number of domains on which the Module runs; the Module contains nothing
that records, reports, or checks the Licensed Domain. Honoring the one-license-per-domain
term is your contractual obligation, not a gate the software imposes.

## 4. What you may do

Resonant IQ grants you a **non-exclusive, non-transferable** (except as section 13
allows), **non-sublicensable** license, for the term stated in sections 1, 2, and 7,
to do the following. Subject to sections 3 and 5, while your subscription is active
you may:

1. **Run** the Module in your helpdesk deployment for the Licensed Domain, whether you
   self-host it on your own infrastructure or run it through Resonant IQ managed hosting.
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

**A lapse does not stop a Resonant IQ-hosted instance.** If Resonant IQ hosts your
Module instance, that instance **keeps running throughout any lapse, at the version you
were entitled to at the moment of lapse**; it is **not** decommissioned for non-payment,
and it continues to serve your deployment until you cancel it or one of the section 8
events that ends hosting — a **full refund** or a **revocation for confirmed fraud** —
occurs. What a lapse stops is updates, nothing else.

**License keys are distribution credentials only.** Any license key, token, or other
credential Resonant IQ issues under this License authenticates marketplace downloads and
the update channel, and does nothing else. It is not required to run the Module, is never
checked at runtime by the Module or the helpdesk core, and has no effect on copies you
already hold. Disabling, rotating, or revoking a key affects marketplace download and
update access only.

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
  previously entitled to, and any instance Resonant IQ hosts on your behalf is
  decommissioned in accordance with the published managed-hosting policy. The
  configuration-export grace window applies to termination by **full refund**;
  revocation for confirmed fraud decommissions immediately, with no grace window
  (section 8). Termination never reaches any
  copy of the Module, original or modified, that you already hold and run on your own
  infrastructure: those copies continue under the Surviving Held-Copies License above,
  because there is nothing in them to switch off.

This guarantee is why the licensing unit in section 3 can rest on contract alone: we
would rather state the terms plainly and trust you to honor them than degrade the
product with enforcement machinery that would make it hostile to the people who own it.

## 8. Termination

Termination under this section ends the **forward entitlement** this License grants — your
right to new downloads and updates, all future marketplace download access (including to
versions you were previously entitled to), and any Resonant IQ-hosted service. It does
**not** disturb the **Surviving Held-Copies License** in section 7, which is a separate,
defined right that continues for the copies already in your hands and your internal
modifications of them. "Terminated" and "survives" therefore refer to two different things:
the forward entitlement terminates; the Surviving Held-Copies License survives.

**Full refund.** If your purchase is refunded in full within the refund window stated in
the marketplace **terms of sale** (fourteen (14) days from purchase; only a refund of the
full purchase price terminates — partial or goodwill refunds do not affect this License),
the forward entitlement under this License terminates: your entitlement to new downloads
and updates ends, and all future marketplace download access ends, including to versions
you were previously entitled to. A Resonant IQ-hosted instance is decommissioned after the
configuration-export grace period stated in those terms (seven (7) days), during which you
may export the instance's configuration. Section 7 governs what the termination does
**not** reach.

**Revocation for fraud.** Resonant IQ may revoke this License for confirmed fraud — for
example a stolen payment method or a fraudulent chargeback — following an actual
investigation. Revocation ends the forward entitlement and all future marketplace download access
(including to previously entitled versions) and, for a hosted instance, results in
immediate decommissioning. Revocation is never triggered automatically by a payment
dispute merely being filed. Section 7 again governs what revocation does **not** reach.

**Ordinary breach is not fraud.** A non-fraudulent breach of this License or the terms
of sale — running a second deployment on a single-domain License, say — is **not**
grounds for revocation under this section. Revocation is reserved for confirmed fraud,
because its consequences (immediate loss of download access and decommissioning of a
hosted instance) are the harshest this License provides. Ordinary breach is addressed by
the following paragraph, and commercially under the terms of sale.

**Termination of forward entitlement for material breach.** If you materially breach
section 3 or section 5 and the breach is not fraud, Resonant IQ may give you written
notice describing the breach. If the breach is not cured within **thirty (30) days** of
that notice (or, where the breach is incapable of cure — a completed public disclosure of
the Source, say — immediately upon notice), Resonant IQ may terminate your **forward
entitlement**: new downloads, updates, and managed hosting of new instances end. This
remedy does **not** reach the Surviving Held-Copies License (section 7), does not
decommission an already-running hosted instance, and is in addition to — not in place of
— any claim for damages or injunctive relief Resonant IQ may have for the breach itself,
subject to section 10.

The full mechanics and exact time windows of refunds, disputes, and hosted-instance
decommissioning are set out in the marketplace **terms of sale** and **managed-hosting
terms**, and are not restated in full here; this section states only their effect on
this License.

Sections 3 (as it applies to copies held under section 7), 5, 7, 9, 10, 11, 12, and 13
survive termination of this License.

## 9. Warranty disclaimer

The Module and its Source are provided **"as is"** and **"as available,"** without
warranty of any kind. To the maximum extent permitted by applicable law, Resonant IQ
disclaims all warranties, whether express, implied, or statutory, including any implied
warranties of merchantability, fitness for a particular purpose, title, and
non-infringement, and any warranty arising from course of dealing or usage of trade.
Resonant IQ does not warrant that the Module will be uninterrupted, error-free, or free
of harmful components, or that it will meet your requirements.

**No support obligation.** This License itself includes no technical support,
maintenance, or service-level commitment. Any support Resonant IQ offers is described
in the terms of sale or a separate agreement, not here.

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
without regard to its conflict-of-laws rules. *(Verified: Certificate of
Incorporation of Resonant IQ, Inc., a Delaware corporation, filed with the Delaware
Secretary of State May 19, 2026, file no. 10629316 — corporate records on file.)*

## 12. Entire agreement and order of precedence

This License, together with the marketplace terms of sale and — where you use managed
hosting — the managed-hosting terms and data-handling disclosure, constitutes the entire
agreement between you and Resonant IQ regarding the Module, and supersedes any prior or
contemporaneous understandings on that subject.

Each of these documents governs its own domain, and on any conflict each controls within
that domain:

- **This License** controls the **code-use mechanics** — what you may and may not do with
  the Module and its Source (sections 4, 5, and 7).
- The marketplace **terms of sale** control the **commerce** — pricing, refunds, lapse,
  disputes, and the domain-count economics of purchasing.
- The **managed-hosting terms** (and data-handling disclosure) control **hosted
  operations** — how a Resonant IQ-hosted instance is run, decommissioned, and its data
  handled.

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
  which the Licensed Domain belongs, for continued use by the acquired operations, on
  thirty (30) days' written notice to Resonant IQ. If those operations migrate to a
  different domain, the acquirer may redesignate the Licensed Domain once as part of the
  transfer — the License still covers exactly **one** domain (section 3); redesignation
  changes which one, not how many. Any other purported assignment is void. Resonant IQ may
  assign this License in connection with a merger, acquisition, or sale of its business.

---

### Notes to counsel (not part of the License)

- **Governing law / incorporation — VERIFIED 2026-07-19.** Delaware confirmed against the
  filed Certificate of Incorporation (Delaware SoS, filed May 19, 2026, file no. 10629316)
  in the company's corporate records. Venue/forum-selection remains undrafted (outside the
  decided scope) — add if desired.
- **Cross-references left as pointers.** The refund window (14 days), full-refund-only
  termination, and the config-export grace window (7 days) are referenced as
  **placeholders**, with their mechanics deferred to the terms of sale.
  **⚠️ These figures were NOT decided by TJ.** An earlier draft cited them as "CONFIRMED
  by TJ 2026-07-19"; an audit on 2026-07-20 searched every message he sent and found no
  instance of any of them. They were generated by an assistant and cited back as his.
  They stand as placeholders until he states the figures himself.
- **Scope held to the decided space.** Multi-domain / bulk licensing is deliberately not
  drafted (decision: "may exist later; do not draft it"). Severability, waiver, notices,
  and assignment/change-of-control were added per the adjudicated Codex-review fixes
  (2026-07-19, HT-5); no arbitration clause and no venue/forum-selection clause beyond the
  Delaware governing law in section 11 is included. Export-control remains undrafted.
