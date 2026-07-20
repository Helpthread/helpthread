# SPEC-CHANGES — HT-79 managed hosting (for lead adjudication)

Branch: `docs/ht-79-managed-hosting`. Docs only. This file lists every decision I made
that was **not** explicitly handed to me in the task or the coordinator's mid-task
message, each as *chosen default + one-line alternative*, plus a separate **OPEN — needs
TJ** list I did not invent answers for.

## Files changed

- `specs/modules/marketplace-v1.md` — revised in place to **v1.1**. New §3d (hosting
  control plane), §3e (buy→install→enable managed handoff), rewritten §5 (managed
  install/update/uninstall mainline + preserved self-host escape hatch §5.4); §1, §6,
  §7, §8, §9, §10, §11 updated. Entities (§2), commerce/download/update-check APIs
  (§3a–§3c), artifact pipeline (§4) unchanged.
- `CHARTER.md` — amended by **direct edit** (the PR #86 mechanism): §4 architecture
  paragraph gains a dated "Amended … (managed hosting)" note; a matching entry appended
  to the §7 Governance amendment appendix.
- `specs/modules/catalog.md` — §5 "modules we host … no special machinery in the
  product" bullet annotated + changelog entry (house-style reconciling note).
- `SPEC-CHANGES.md` — this file.

Not changed, deliberately: `specs/ui/admin-ia.md` — its "in-place update with visible
ops log" aspiration is now *satisfied* by managed hosting, so there is no contradiction
to fix; the reconciliation is recorded in marketplace-v1 §9 instead (see default 9).

## Chosen defaults (not explicitly specified — lead to adjudicate)

1. **Charter amendment = direct edit, not a separate file.** The task suggested "a
   separate short file (docs/adr or wherever amendments live)"; the hard boundary said
   follow whatever mechanism the PR #86 precedent shows. PR #86 amended CHARTER.md by
   direct edit + a dated appendix entry, and the charter's amendments all live in its own
   §7 appendix. So I amended in place. *Alt:* a standalone ADR file — rejected, it would
   scatter the amendment record and break the established pattern.

2. **Where the credential-holding orchestration lives = a new hosting control plane
   (§3d), co-located with the marketplace service but a distinct trust domain.** Same
   `Helpthread/marketplace` repo + Supabase project, separate deployment and separate
   credential vault, isolated from the public store surface, with a clean seam to split
   later. Chosen over (a) folding it into the marketplace service — rejected, mixes
   desk-provisioning credentials into the public commerce surface; (b) a paid module —
   rejected, circular (a module that provisions modules) and wrong trust level.
   *Alt:* fully separate repo/infra from day one — rejected as premature (surfaced as
   decision point §10.10 for confirmation).

3. **Buy→install handoff = one-time claim token, redeemed by the control plane, not the
   desk (§3e).** OAuth-authorization-code-shaped: marketplace mints it at
   `checkout.session.completed`; the browser success-redirect targets the **control
   plane's** claim endpoint; the control plane redeems it for the license key and stores
   it in its own vault. The desk never sees the key. *Alt:* redirect back to the desk
   which redeems — rejected, routes the key through the AGPL core (invariant violation).

4. **"License key handed back to the desk automatically" = operator experience, not literal
   core possession.** The module simply appears installed/enabled in Manage → Modules;
   the actual key lives only in the control-plane vault, reflected into the desk via the
   existing installed-ness inference (§6). *Alt:* none viable under "core holds no
   marketplace credential."

5. **Enrollment grants the control plane a scoped, revocable per-desk provisioning
   credential (§3e), not the desk's full service token.** This surfaces a **new substrate
   requirement** (today the substrate ships one all-powerful service token). *Alt:* hand
   over the full `HELPTHREAD_API_TOKEN` — rejected, far too broad. Raised as decision/
   dependency §10.12.

6. **`revoked` (confirmed fraud) → immediate hosted-instance decommission, no grace
   window.** The coordinator specified the refund grace flow but not revoke; I extended
   the state machine so confirmed fraud stops immediately while refund gets the config-
   export grace. *Alt:* give revoke the same grace as refund — rejected, confirmed fraud
   warrants an immediate stop. (Minor; TJ may confirm at §10.11.)

7. **Revision done in place as v1.1 with stable section numbers** — added §3d/§3e as new
   subsections rather than renumbering §4–§11 (the doc cross-references §3b/§6/§10.x
   heavily). *Alt:* full renumber — rejected, high cross-reference-churn risk for no
   reader benefit.

8. **`catalog.md` §5 given a one-line reconciling note + changelog entry.** Its "no
   special machinery in the product" clause could read as contradicted; I annotated that
   it still holds (the machinery is outside the core), matching the established pattern of
   cross-doc supersession notes. *Alt:* leave catalog untouched — rejected, leaves a
   latent contradiction a future reader trips on.

9. **`admin-ia.md` left unedited** — its "in-place update with visible ops log" line is
   now *delivered* by managed hosting, so it needs no fix; reconciled inside
   marketplace-v1 §9. *Alt:* add a pointer note to admin-ia — deferred as unnecessary
   edit (fewer lines).

10. **v1's "In-product purchase" non-goal reworded to "in-product *checkout*" (§9).** A
    Buy button now exists in-app but only opens the store's hosted Stripe Checkout in the
    browser; purchase/licensing stay on the store service. *Alt:* leave the flat "no buy
    button inside the helpdesk" wording — rejected, it would contradict §3e/§6.

## Decided by the coordinator's mid-task message (encoded, not open)

Recorded here so the lead sees they were folded in, not left hanging: store separation
(purchase/licensing stay on the store; desk gives in-app feel only; no credentialed
marketplace call in core); refund ⇒ decommission-after-grace with `refunded` still
hard-refusing downloads/update-check immediately; lapse ≠ refund (lapse → hosting
continues indefinitely); self-host residual copy consciously accepted, no DRM ever;
disputes → `frozen` keeps the hosted instance running, dispute-lost ⇒ refunded/
decommission. Working figures 14-day refund window / 7-day grace are in as working
figures with exact numbers flagged OPEN.

## OPEN — needs TJ (I did not invent answers)

1. **Exact refund window and config-export grace figures** — working 14 days / 7 days;
   the day-counts and customer-facing policy wording are TJ/counsel at the pre-revenue
   gate (§10.11, §8). Mechanics are decided; only the numbers/wording are open.
2. **Charter §2 "own your data" reconciliation** — a Resonant IQ-hosted module reads
   operator conversation data on RIQ infrastructure, in tension with §2's absolute
   "Conversation data never proxies through Helpthread's infrastructure." Anchor: §3
   already contemplates "hosted convenience services." Whether §2's sentence needs its own
   wording tweak, plus the data-handling disclosure/DPA, is a charter-invariant + counsel
   call. I flagged it (§10.13, §8) and deliberately did **not** edit §2 or resolve it in
   the amendment. **This is the one I'd most want TJ's eyes on.**
3. **Hosting control plane: co-located vs. fully separate infra** — recommended
   co-located (default 2 above); TJ to confirm (§10.10).
4. **Scoped per-desk provisioning credential** — confirm the substrate should add a
   scoped, revocable credential class (its own ticket) vs. reuse the full service token
   (§10.12). Real dependency for managed hosting to ship.

### Pre-existing OPEN items, carried forward unchanged (not re-litigated here)

Price points (§10.1), store domain (§10.2), lapsed-downloads sign-off (§10.3), launch
module lineup KB-vs-pipeline charter conflict (§10.4), reactivation policy (§10.6),
magic-link auth (§10.7), no-bundles-v1 (§10.8), tax jurisdictions (§10.9). §10.5 was
narrowed (the "update available" limitation now applies to self-host only).

## Invariants explicitly preserved (verified against the edited text)

- License = distribution credential only; **zero runtime license checks in any module**,
  hosted or self-hosted (hosted artifact byte-identical to the tarball).
- **Lapse never stops running software** — held literally, including when RIQ is the
  host (§3d table; the control plane does not act on lapse).
- **AGPL core holds no marketplace/license/control-plane credential and never calls the
  marketplace** — the control plane is the sole credential bridge, outside the core.
- Self-host escape hatch preserved and not weakened (§5.4), including the consciously
  accepted residual-exposure of a refunded customer's already-held copy.
- Vocabulary: "modules" (not "plugins", except the legal "plugin exception"); Agents =
  human staff, Assistants = AI actors — checked in the added text.
