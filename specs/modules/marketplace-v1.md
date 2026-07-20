# Helpthread Marketplace v1.1

Status: **draft for TJ review** (HT-79; HT-81 in-product directory and HT-82
dogfood-through-marketplace are child tickets scoped by this spec). Governed by
CHARTER.md §3/§4/§5 (**2026-07-19 HT-79 amendment**: the marketplace is a launch-day
component of Phase 3, built now and proven first as the project's own dogfood install
path — not deferred to "once demand justifies it"; **2026-07-19 HT-79 managed-hosting
amendment**: the default install path is managed hosting — clicking Install provisions
a Resonant IQ-hosted instance of the module — with the self-host tarball path kept as
the open-core escape hatch) and `specs/modules/catalog.md` §5, the additive contract
this spec is built to satisfy exactly.

**v1.1 — managed hosting (the mainline install path).** TJ walked the v1 manual
self-host install as customer #1 (HT-82 dogfood, 2026-07-19) and rejected its
friction: the intended experience is *visit the module store in-app, buy, install,
enable* — one designed loop, not five hand-assembled seams. This revision makes
**managed hosting** the default: Resonant IQ hosts the module runtime; clicking Install
in Manage → Modules provisions a hosted instance for that deployment; enable/disable is
a toggle; there is no operator DevOps. The manual tarball flow of v1 is not deleted —
it is demoted to a documented self-host escape hatch (§5.4), still fully supported and
already proven end-to-end today (purchase → license → key-authed download with verified
checksum). The revision is contained: the entities (§2), the commerce/download/
update-check service (§3a–§3c), and the artifact pipeline (§4) are **unchanged**; what
is new is a third trust domain — a **hosting control plane** (§3d) — and the operator
UX that rides it (§5). Every invariant this spec was built to protect survives verbatim
(§1).

**Citation basis.** The HT-79 charter amendment merged to `main` as PR #86, commit
`b528971`; the HT-79 managed-hosting amendment is drafted on this branch against §4 and
the §7 appendix by the same direct-edit mechanism PR #86 used (this spec does not
invent a separate amendment file — the charter's amendments live in its own Governance
appendix). Every CHARTER.md citation below was re-verified against the merged text on
2026-07-19.

## 1. Purpose & scope

This spec pins the Helpthread Marketplace: the commerce plumbing — license keys,
subscriptions, module distribution, an update feed — plus the **hosting control plane**
that runs modules on the operator's behalf, both built around the module substrate
(`specs/modules/substrate-v1.md`), which stays AGPL-free and unchanged. It covers
entities, service architecture (including the hosting control plane, §3d), the
buy → install → enable managed handoff (§3e), the artifact pipeline, the managed-hosting
install UX and its self-host escape hatch (§5), the in-product directory contract
(HT-81), the dogfood-through-marketplace plan (HT-82), counsel dependencies, non-goals,
and decision points for TJ. It does not re-spec the substrate's events/webhooks/
assistant surfaces (already shipped, HT-67/69/70) or the module catalog's free/paid
line (`catalog.md`, already decided).

**The governing constraint, stated once because every design choice below derives
from it** (`catalog.md` §5, restated verbatim in spirit):

> A license key is a *distribution* credential. It authenticates registry download
> and the update feed — nothing else. No runtime license check exists in the
> substrate, ever, and none is added by this spec. Revoking a license stops updates;
> it never reaches into a running helpdesk, and it never breaks a running module.
> The dogfooded artifact IS the marketplace artifact.

Concretely, this means: **no code this spec describes runs inside the AGPL core, and
no license-check code runs inside a deployed module — hosted or self-hosted.** The
license key and every entitlement decision live in Resonant IQ-operated services
outside the core: the marketplace service (§3a–§3c) and, new in v1.1, the hosting
control plane (§3d). A deployed module's own runtime configuration never contains a
license key, whether the operator deployed it or Resonant IQ hosts it — the two
artifacts are byte-identical (§4), so "the dogfooded artifact IS the marketplace
artifact" now also means *the hosted artifact IS the self-host artifact*. This is
independently verifiable today: `module-draft-assistant`'s full environment-variable
table (`HELPDESK_API_URL`, `HELPDESK_ASSISTANT_TOKEN`, `WEBHOOK_SIGNING_SECRET`,
`ANTHROPIC_API_KEY`, `DRAFT_MODEL`, `DRAFT_SYSTEM_PROMPT_APPEND`) contains nothing
resembling a license key or a marketplace URL — the reference module artifact already
satisfies the constraint this spec is designed not to violate, and managed hosting adds
nothing to that table.

**Managed hosting does not move a single check into the core or the module.** When
Resonant IQ hosts a module, the license key sits in the hosting control plane's vault
(§3d), never in the hosted module's environment; entitlement is enforced only by the
control plane's *provisioning* decisions (whether to roll an update, whether to keep an
instance running), exactly as it is enforced only by the marketplace's *download*
decisions for a self-hoster. The running module contains no phone-home and no license
logic in either case. The one genuinely new fact v1.1 introduces — that Resonant IQ,
as host, is now *able* to stop a running instance it operates — is confined to the
`refunded`/`revoked` lifecycle (§3d, §5.3) and is deliberately held to the same
"a lapse never stops running software" floor the self-host path already guarantees.

**Ownership.** Unlike the AGPL engine, the marketplace service itself is not
self-hosted or distributed to operators — it is a Resonant IQ-run, closed-source,
single-tenant SaaS. CHARTER.md §3's module boundary names the Helpthread marks and
"the official marketplace" as the assets that stay with the company; this is that
asset's implementation.

## 2. Entities

All entities live in the marketplace's own Postgres (Supabase project, §3) — entirely
separate from any operator's Helpthread engine database. No foreign keys cross that
boundary; the only thing that travels between the two systems is a license key
(opaque bearer credential) and a `module` slug (a plain string, matching the
substrate's own `assistants.module` / `webhook_endpoints.module` attribution,
`substrate-v1.md` §3/§5).

| Entity | Key fields | Notes |
|---|---|---|
| **Module** | `id`, `slug` (matches substrate `module` attribution, e.g. `draft-assistant`), `name`, `summary`, `cluster` (catalog.md §3's cluster name, informational), `status` (`active`/`deprecated`) | One row per sellable module. Third-party modules are a non-goal v1 (§9) — every row here is first-party. |
| **Release** | `id`, `module_id`, `semver`, `tarball_storage_path`, `checksum_sha256`, `changelog_md`, `published_at` | One row per published version. Immutable once published — a bad release ships a new version, never edits an old one. **"Latest" is defined normatively here, once:** the module's release with the highest `published_at` — equivalently, publish order — **not** the highest semver (per §10's resolution; back-porting is not current practice). Every other use of "latest" / "latest version" in this spec (§3a `latestVersion`, §3b/§3c defaults, §5, §6) refers to this definition. |
| **Customer** | `id`, `stripe_customer_id`, `email`, `created_at` | The marketplace's own account, 1:1 with a Stripe Customer. Unrelated to the engine's `agents`/`assistants` tables — a store customer and a Helpthread Agent are different systems' users, even when the same human. |
| **Subscription** | `id`, `customer_id`, `module_id`, `stripe_subscription_id`, `stripe_latest_payment_intent_id` (nullable; updated on each successful `invoice.paid` for this subscription), `interval` (`year`, per TJ's annual decision), `stripe_status` (mirrors Stripe's own status string), `current_period_end`, `created_at` | One subscription per (customer, module, deployment) — see License key below for why "per deployment" lands here, not as a separate column. **`stripe_latest_payment_intent_id` is the join key refund/dispute webhooks resolve against**: those events arrive on Stripe charge/payment-intent/dispute objects, not Subscription objects, and `stripe_customer_id` alone can't disambiguate which subscription a given charge belongs to when one customer holds multiple module subscriptions — see §3's webhook table. |
| **License key** | `id`, `subscription_id` (1:1), `module_id`, `secret_hash` (SHA-256 digest of the token's secret half — the plaintext `ht_lic_<id>_<secret>` is never persisted), `state` (`active`\|`lapsed`\|`frozen`\|`refunded`\|`revoked`), `entitled_up_to_version` (semver, meaningful only while `lapsed`), `pre_freeze_state` and `stripe_dispute_id` (both nullable; set together on entering `frozen`, cleared together on leaving it), `created_at`, `rotated_at`, `revealed_at` (null until the customer has viewed the plaintext once, §3) | **Mint/verify mechanism inherited verbatim from Assistant tokens** (`src/auth/assistant-token.ts`, `src/api/assistants.ts`, `src/store/assistants.ts`) — the id is generated first, `ht_lic_<id>_<secret>` minted against it, and only `secret_hash` is ever stored; verification looks the row up by the id embedded in the presented token, then does a constant-time digest compare, exactly as `getForAuth`'s single-snapshot read does for Assistants. The plaintext is returned to the caller exactly once — at first reveal or at rotation (§3, §9) — never logged, never persisted, no reveal endpoint. **"Scoped to one helpdesk deployment serving one domain" is a licensing TERM, not a technical control.** Per TJ's "annual subscription per helpdesk deployment" decision, refined 2026-07-19 to **one license = one domain** (§10 resolutions): an operator running two helpdesks — or one helpdesk serving two domains — is expected to buy two subscriptions and hold two keys. A **licensed domain is recorded** against the subscription at purchase — collected at checkout or first download (exact collection point per HT-89) — as a **contractual designation** used for the terms of sale (§8) and for provenance stamping (§10 resolutions, HT-89/HT-90). That record is for attribution, **never for verification**: nothing in this schema checks which deployment a key is actually used against, and nothing ever does at runtime. The no-phone-home posture (§1) is unchanged — the marketplace never learns a *running* deployment's identity, no deployed module reports one, and per-deployment scoping is enforced by the terms of sale (§8) an operator agrees to, never by a technical check. Record-for-attribution and never-verify coexist deliberately: the recorded domain is a designation on the contract and a signature in a provenance file (§10), not a value any running software phones home to confirm. A subscription and its license key stay 1:1 — the subscription is the billing object, the key is what the operator's tooling holds. **Pre-freeze state is preserved, not assumed**: entering `frozen` snapshots the license's current `state` into `pre_freeze_state` and the triggering dispute's Stripe id into `stripe_dispute_id`; a `won` outcome restores exactly that saved state — a license that was `lapsed` before the dispute comes back `lapsed`, never promoted to `active` — see §2's states table and §3. |
| **Download grant** | `id`, `license_key_id`, `release_id`, `issued_at`, `expires_at`, `redeemed_at`, `requester_ip` | Minted per download/update-check call (§3's download endpoint) as a short-lived, single-purpose authorization for one Supabase Storage object — never a standing credential. Exists so the download endpoint has an audit trail distinct from the long-lived license key itself, and so a leaked signed URL has a bounded blast radius (default expiry: 5 minutes). |
| **Webhook event log** | `id` (Stripe `event.id`), `type`, `received_at`, `processed_at` | The idempotency/replay-protection ledger every incoming Stripe webhook is checked against before applying a state transition — keyed by Stripe's own event id, **never** by `stripe_subscription_id` (see the Implementation note below for why that would be wrong). |

**Implementation note — webhook idempotency is keyed on `event.id`, not
`stripe_subscription_id`.** A single subscription legitimately emits many events over
its life — created, renewed, past_due, canceled, disputed, and so on — so
`stripe_subscription_id` is not a dedup key; using it as one would silently collapse
distinct, valid events into "already seen." Replay protection instead uses the
Webhook event log above, keyed on Stripe's own `event.id`: on receipt, the handler
inserts-or-checks the incoming event's id in that log before doing anything else; if
it's already present, the event was already processed and the handler returns success
without reapplying the transition — safe against Stripe's at-least-once redelivery and
out-of-order arrival. The event-log insert and the entitlement state transition it
triggers happen inside the **same database transaction**, so a crash between them can
never leave a half-applied state change that then double-applies on retry, duplicates
a purchase, or reopens a terminal license.

Separately: should implementation add any **uniqueness constraint** on Subscription or
License key rows (e.g. a future bundle-pricing constraint — this is a distinct
concern from event-replay dedup above), it must be scoped to exclude
`revoked`/`refunded` rows — e.g. a partial index
`WHERE state NOT IN ('revoked', 'refunded')` rather than a bare `UNIQUE`. Otherwise a
legitimate re-purchase after a refund or a lost dispute would collide with its own
terminal predecessor row and fail at the database level, which would be a
self-inflicted way to lock out exactly the customer §2 and §7 are careful to say never
gets locked out of buying again.

### License key states — pinned, with justification

All five states below are enforced only inside the marketplace's own download and
update-check endpoints (§3) — never inside a deployed engine or a deployed module,
per §1's governing constraint. That is true of `frozen` and `refunded` exactly as
much as it was already true of `lapsed` and `revoked`; nothing below is an exception.

| State | Meaning | Downloads | Update-check |
|---|---|---|---|
| `active` | Subscription in good standing | Any published release, unrestricted | Reports true latest, entitled |
| `lapsed` | Payment missed or subscription non-renewed — **not** a fraud finding | Releases published **up to `entitled_up_to_version`** remain downloadable indefinitely; a release newer than that requires resubscribing | Reports `entitledVersion` (frozen at lapse) **and** `latestAvailableVersion` (informational, so the operator sees what they're missing) |
| `frozen` | A dispute has been **filed** (Stripe `charge.dispute.created`) and is under investigation — automatic, protective, and explicitly **not** a fraud finding: a filed dispute proves nothing about who's right yet. The prior `state` is snapshotted (`pre_freeze_state`) so resolution can restore it exactly, not assume `active` | Fully paused — zero access, including versions already downloaded fine before the freeze — until the dispute resolves (§3) | Fully paused |
| `refunded` | Entitlement ended with **no fraud finding**: a **full** refund of the purchase (cumulative refunded amount equal to the amount captured), or a dispute the merchant lost (the chargeback stands, funds are gone either way) — terminal for entitlement. A **partial or goodwill refund causes no state change** (HT-86) | Hard-refused | Hard-refused |
| `revoked` | **Confirmed** fraud only — a manual admin action following an actual investigation (a stolen payment method, a confirmed ToS violation). **Never** set automatically by a dispute merely being filed — "filed" and "confirmed" are different claims, and only `frozen` reacts to "filed" | Hard-refused | Hard-refused |

**Decision, justified** (task item 1's explicit "pick and justify" — also decision
point §10.3): **lapsed keeps downloading already-entitled versions.** Reasoning:

- It is the literal reading of catalog §5's promise that revocation "never breaks a
  running module" extended one step further — a lapsed (non-fraud) customer must also
  be able to *redeploy* the exact software they already paid for (disaster recovery,
  a new Vercel project, a lost tarball), not just keep the one instance already
  running. Cutting off already-entitled downloads on ordinary non-renewal would make
  that redeploy impossible and would functionally break the module the moment
  anything else about the deployment needed to change — a stealth version of exactly
  the runtime hostility catalog §5 rules out.
- It matches the standard self-hosted-software licensing shape (WooCommerce
  extensions, JetBrains fallback licenses): a lapsed subscription freezes you at what
  you already own; only *new* releases require staying current. That is the actual
  commercial lever — pay to keep getting updates — without holding paid-for bits
  hostage.
- `revoked` stays the hard stop, reserved for **confirmed** fraud, which keeps a real
  enforcement tool without making ordinary non-renewal — or a merely-filed dispute —
  punitive.

**Refunds and disputes, reconciled** (this draft's original table mapped
`charge.dispute.created` straight to `revoked`, which conflated a dispute being
*filed* with fraud being *confirmed* — wrong, fixed here):

- **Refund** (a **full** `charge.refunded`/`refund.created` — cumulative refunded
  amount equal to the amount captured — or a *lost* dispute) → `refunded`.
  Terminal for entitlement, explicitly not a fraud label — the buy→download→refund
  path must not let the customer keep both the money and the bits, but it also must
  not brand an ordinary refund request as fraud. A **partial or goodwill refund leaves
  entitlement untouched** (HT-86) — no state change. Running software already deployed
  is untouched either way, per §1's governing constraint.
- **Dispute filed** (`charge.dispute.created`) → `frozen`, automatically, the moment
  Stripe reports it, **snapshotting the license's current `state` into
  `pre_freeze_state`** (and the dispute's Stripe id into `stripe_dispute_id`) before
  overwriting `state` — a precaution, not a verdict, because at filing time nobody yet
  knows whether the dispute is legitimate.
- **Dispute resolved** (`charge.dispute.closed`): outcome `won` (the charge was
  legitimate) → restore `state` to the saved `pre_freeze_state` **exactly**, then
  clear both `pre_freeze_state` and `stripe_dispute_id`. A license that was `lapsed`
  before the dispute was filed comes back `lapsed`, not promoted to `active` — only a
  license that was genuinely `active` before the freeze comes back `active`. Outcome
  `lost` (the chargeback stands) → `refunded` regardless of `pre_freeze_state`, by the
  same reasoning as a voluntary refund above — a lost dispute is not proof of fraud on
  the cardholder's part, it only means the funds are gone.
- `revoked` is reachable **only** by deliberate admin action after an actual
  investigation — never by any automatic webhook mapping, disputes included.

**Reactivation.** A lapsed subscription that resumes paying (Stripe
`customer.subscription.updated` back to `active`) restores the license to `active`
immediately — full latest-version access, no back-charge for versions released
during the gap. *Alternative considered*: pro-rate a reactivation charge for skipped
releases. Rejected for v1 — added Stripe/billing complexity with no clear customer
benefit; revisit only if lapse-and-resubscribe abuse is observed in practice.

## 3. Service architecture

**Repo & stack**: private repo `Helpthread/marketplace`, Vercel + Supabase — the
project's own stack, chosen deliberately as a dogfooding argument for the platform
itself, not only for the helpdesk product built on it.

**Surfaces:**

- **Store site** (public, unauthenticated) — per-module catalog pages: description,
  pricing, changelog, "Subscribe" → Stripe Checkout.
- **Account area** (customer-authenticated — see Authentication below) — purchase
  history; per-subscription license key reveal and rotation; download links; a link
  into the Stripe Customer Portal for self-serve cancel/payment-method updates.
- **Stripe integration** — Checkout Sessions (`mode: subscription`, one annual Price
  per module) for purchase; Customer Portal for self-serve subscription management;
  a webhook endpoint (Stripe-signature-verified) driving all state transitions below.

**Authentication — magic link, no passwords** (decision point §10.7). The account
area is not the engine's own Agent auth (HT-54's passkeys/OAuth/passwords) — it is a
different system serving a different population (occasional purchasers, not daily
Agent users), so a lighter mechanism is the deliberate, not accidental, choice:

- The customer enters their email at `/account/login`, or follows the "Manage your
  subscription" link the marketplace emails automatically right after
  `checkout.session.completed`.
- The marketplace emails a single-use magic link, **15-minute TTL**. No password is
  ever set, stored, or asked for anywhere in this system.
- Clicking the link establishes an authenticated session (httpOnly, `Secure` cookie;
  30-day idle session TTL, after which a fresh magic link is required).
- **The account area is the only reveal surface, full stop** — there is no
  checkout-session-keyed reveal page and no plaintext key in any webhook payload,
  email, or redirect URL. A License key row is created at `checkout.session.completed`
  time with `secret_hash` left `NULL` — the secret is not minted yet. The first time
  the authenticated customer requests that subscription's key, the marketplace mints
  and stores it inside a single **compare-and-set** transaction:
  `UPDATE license_keys SET secret_hash = $hash, revealed_at = now() WHERE id = $id AND
  secret_hash IS NULL RETURNING *`. If two concurrent requests race for the same
  never-revealed license, exactly one `UPDATE` matches and commits; the other affects
  zero rows and gets `409 { "error": { "code": "already_revealed" } }` — it never
  returns a plaintext, because it never won the write, so a response can never
  describe a secret other than the one actually persisted. This is the same
  id-then-secret ordering as Assistant tokens, just deferred to first authenticated
  view instead of row-creation time, made race-safe by construction rather than by
  assuming two requests never overlap. Nothing about this flow ever routes a
  plaintext key through a webhook handler, an email, or an unauthenticated redirect.

**Key rotation** (task item 9). An account-area action, mirroring
`POST /api/v1/assistants/{id}/rotate-token` exactly: the authenticated customer
session (never the license key itself) triggers
`POST /api/v1/licenses/{id}/rotate`, which — inside a transaction that takes
`SELECT ... FOR UPDATE` on the license_key row first — mints a fresh secret for the
*same* license id, overwrites `secret_hash` in place (no new row, no overlap window —
the old secret stops verifying the instant the new one is stored), and returns the
new plaintext once, in the account area, same as first reveal. The row lock
serializes concurrent rotate requests for the same license: a second request blocks
until the first commits, then mints and returns its own fresh secret against the
now-current row — whichever transaction actually wrote is the only one whose response
is shown, so a response body can never describe a secret the database doesn't hold.
**The operator must update their own tooling's stored key** (wherever their
update-check/download workflow holds it, §5) — rotation is not detectable by that
tooling on its own; a rotated key simply starts rejecting the old secret on its next
call.

**Authorization on reveal, rotation, and the account-area download route below.**
Session-cookie authentication alone is not sufficient for any of these three
state-changing (or entitlement-exposing) actions:

- **Object-level ownership.** Every query is scoped by the authenticated customer's
  own id in the `WHERE` clause —
  `WHERE id = $licenseId AND subscription_id IN (SELECT id FROM subscriptions WHERE
  customer_id = $sessionCustomerId)` — never a bare `WHERE id = $licenseId`. A license
  id belonging to a different customer behaves exactly like a nonexistent one
  (`404`), the same indistinguishable-from-nonexistent convention the engine already
  uses for soft-deleted conversations — it neither confirms nor denies that the id
  exists at all.
- **CSRF.** `httpOnly`/`Secure` on the session cookie stop script-readable theft and
  plain-HTTP interception, but do **not** stop a cross-site form or fetch from riding
  an authenticated browser's cookies into a state change. Every state-changing
  account-area endpoint requires `SameSite=Strict` on the session cookie **and** a
  synchronizer CSRF token (issued to the account-area page, submitted with the
  request, checked server-side) — belt and suspenders, since `SameSite=Strict` alone
  has known browser/extension edge cases and a CSRF token alone doesn't stop
  cookie-riding from a same-site XSS.

**Account-area download route (session-authenticated)** (task item 7). The
account-area "Download" button (§5 step 2) cannot literally present a `ht_lic_`
Bearer token: after first reveal the marketplace holds only `secret_hash`, never the
plaintext again, so the server itself cannot reconstruct a token to call its own
Bearer-token endpoint (§3b) on the customer's behalf. It doesn't need to — the
browser is never the right holder of the license key at all. The key exists for the
operator's own out-of-band update/download tooling (§3c, §5), not for browser-driven
downloads, and never needs to reach the browser to make one happen. Instead:

`GET /account/subscriptions/{subscriptionId}/download?version=...` — session-cookie
authenticated (Authentication above), with the same object-level ownership check and
CSRF requirements as reveal/rotation just above
(`subscription.customer_id == session.customer_id`, else `404`). Internally it runs
the **same entitlement-resolution logic** §3b's state table defines (module-binding
is moot here, since the route is already scoped to one subscription's one
`module_id`), mints a Download grant, and responds with the same short-lived signed
Supabase Storage URL (or redirects straight to it) plus checksum. **The plaintext
license key never enters this path at any point** — the browser never sees it and
never needs it.

**Stripe webhook → state mapping:**

| Stripe event | Effect |
|---|---|
| `checkout.session.completed` | Create/find Customer; create Subscription (storing `stripe_latest_payment_intent_id`); create License key row (`active`, `secret_hash NULL` — not yet minted, see Authentication above) |
| `customer.subscription.updated` → `active` | License → `active` — **only** when transitioning from `lapsed` on resumed payment; this is the sole automatic path to `active` and never fires the dispute-restore logic below |
| `customer.subscription.updated` → `past_due`/`unpaid`, or `customer.subscription.deleted` (ordinary cancellation) | License → `lapsed`, snapshot `entitled_up_to_version` = that module's latest published release at the moment of lapse |
| `charge.refunded` / `refund.created` | Resolve the Subscription via `stripe_latest_payment_intent_id` (§2 — a customer may hold multiple module subscriptions, so `customer_id` alone can't disambiguate); License → `refunded` **only when the charge is fully refunded** (cumulative refunded amount equals the amount captured); a partial/goodwill refund is a no-op for entitlement (HT-86) — terminal, not a fraud finding |
| `charge.dispute.created` | Resolve the Subscription via `stripe_latest_payment_intent_id`; License → `frozen`, snapshotting `pre_freeze_state`/`stripe_dispute_id` (§2) — automatic, protective, not a fraud finding |
| `charge.dispute.closed`, outcome `won` | License restores to the saved `pre_freeze_state` exactly (§2) — **not** unconditionally `active` |
| `charge.dispute.closed`, outcome `lost` | License → `refunded` regardless of `pre_freeze_state` (the chargeback stands; not a fraud finding on the cardholder) |
| Manual admin action, following a confirmed-fraud investigation | License → `revoked` (terminal — never automatic, never triggered by a dispute merely being filed; a legitimate re-purchase creates a new Subscription and License key, never an un-revoke) |

Every row above processes inside the idempotent, transactional webhook handler
described in §2's Implementation note (dedup on Stripe `event.id`, never
`stripe_subscription_id`).

**APIs** (all under the marketplace's own base URL, distinct from any Helpthread
deployment's `/api/v1`):

**a. Public metadata feed — unauthenticated.**

```http
GET /api/v1/modules
```

```json
{
  "generatedAt": "2026-07-19T00:00:00.000Z",
  "modules": [
    {
      "slug": "draft-assistant",
      "name": "Draft-Reply Assistant",
      "summary": "AI-drafted replies for Agent approval, via the module substrate.",
      "cluster": "intelligence",
      "latestVersion": "1.2.0",
      "changelogUrl": "https://store.example/modules/draft-assistant/changelog",
      "priceUsd": 199,
      "billingInterval": "year",
      "docsUrl": "https://helpthread.dev/docs/modules/draft-assistant",
      "versions": [
        { "version": "1.2.0", "checksumSha256": "9f2c...", "publishedAt": "2026-07-01T00:00:00.000Z" },
        { "version": "1.1.0", "checksumSha256": "3ab1...", "publishedAt": "2026-05-14T00:00:00.000Z" }
      ]
    }
  ]
}
```

No auth, no PII, no per-deployment data of any kind — this is marketing/catalog data
the in-product directory consumes (§6). Cacheable aggressively (CDN + long
`Cache-Control`); safe to serve from a public CDN edge.

**`versions` carries every published Release's checksum, unconditionally** — not
gated by any customer's entitlement, because it's the same public catalog metadata
as `latestVersion`/`changelogUrl` and reveals nothing sensitive (the tarball itself
stays behind the download endpoint's license-key gate; a checksum alone downloads
nothing). This is what makes §4's "verify against an independently-obtained
checksum" claim literal rather than circular: without this, the only checksum an
operator ever sees is the one handed back in the *same* download response that
handed them the file — a compromised or lying download endpoint could misreport
both consistently and the operator would have no way to notice. With `versions`
published separately, on a different (unauthenticated, publicly cacheable,
third-party-mirrorable) endpoint, an operator — or anyone auditing the marketplace —
can compare the two independently. *Shape considered*: a separate per-module
versions endpoint (`GET /api/v1/modules/{slug}/versions`) instead of embedding the
array. Rejected for v1 — one extra round-trip for no benefit at this catalog's size;
revisit if per-module version history grows large enough to bloat the main feed.

**b. Authenticated download endpoint.**

```http
POST /api/v1/download
Authorization: Bearer ht_lic_<id>_<secret>
{ "module": "draft-assistant", "version": "1.2.0" }   // version optional
```

**Every request is checked against the presented license's own scope before
anything else**: if `module` doesn't match the license's `module_id`, the request is
refused `403 { "error": { "code": "module_mismatch" } }` regardless of license
state — an active license for one Module never authorizes another, full stop. The
selected Release (the requested `version`, or the default) is always resolved by
`(module_id, version)`, never by `version` alone, since semver strings are not
unique across different modules' release histories.

With the module confirmed, license state governs what happens next:

| State | Download behavior |
|---|---|
| `active` | Any published release, unrestricted; `version` omitted defaults to latest (highest `published_at`, per §2's normative definition) |
| `lapsed` | `version` omitted defaults to `entitled_up_to_version`; an explicitly-requested `version` newer than that → `402 Payment Required` pointing at the resubscribe flow (an honest, explicit refusal rather than a silent downgrade to an older tarball than requested) |
| `frozen` | `403 { "error": { "code": "license_frozen" } }` — a dispute is under review; fully paused per §2, including versions already downloaded fine before the freeze |
| `refunded` | `403 { "error": { "code": "license_refunded" } }` — terminal, not a fraud label |
| `revoked` | `403 { "error": { "code": "license_revoked" } }` — terminal, confirmed fraud only |

On success (`active`, or `lapsed` within its cap): mint a Download grant, respond
with a short-lived signed Supabase Storage URL plus the checksum:

```json
{ "version": "1.2.0", "downloadUrl": "https://...", "expiresAt": "...", "checksumSha256": "..." }
```

**c. Update-check endpoint** — deliberately not telemetry.

```http
POST /api/v1/update-check
Authorization: Bearer ht_lic_<id>_<secret>
{ "module": "draft-assistant" }
```

Same module-binding check as the download endpoint: `module` must match the
presented license's own `module_id`, or
`403 { "error": { "code": "module_mismatch" } }`, regardless of state. With the
module confirmed:

| State | Update-check behavior |
|---|---|
| `active` | Full response — `entitledVersion` is the true latest |
| `lapsed` | Full response — `entitledVersion` frozen at lapse, `latestAvailableVersion` shown as an upgrade nudge |
| `frozen` | `403 { "error": { "code": "license_frozen" } }` — matches §2's "fully paused," no informational exception |
| `refunded` | `403 { "error": { "code": "license_refunded" } }` |
| `revoked` | `403 { "error": { "code": "license_revoked" } }` |

`active`/`lapsed` response shape:

```json
{
  "module": "draft-assistant",
  "licenseState": "lapsed",
  "entitledVersion": "1.2.0",
  "latestAvailableVersion": "1.4.0",
  "changelogUrl": "https://store.example/modules/draft-assistant/changelog"
}
```

**What it can log**: license-key id, module, timestamp, response status, requester
IP — bounded-retention (30 days), operational abuse/rate-limit logging only, no
different in kind from any API's access log.

**What it cannot log, ever**: anything about the calling deployment beyond what the
license key's own known Customer record already carries — no deployment URL or
hostname (the request doesn't even carry one), no usage/volume/conversation data, no
correlation to helpdesk activity, no persistent per-call history surfaced back to the
operator or anyone else as "usage."

**Who calls this, and who never does — the no-phone-home line, precisely:**

- **The operator's own update workflow calls it** — a script, a CLI, a manual `curl`,
  run deliberately by a human, holding the license key in *their own* tooling's
  config (not the helpdesk's).
- **The running Helpthread engine never calls it, and never holds a license key in
  its own runtime configuration.** No engine code path, no module's deployed runtime
  code path, references this endpoint or any license key. This is the same posture
  independently confirmed in §1 by `module-draft-assistant`'s actual env-var table.
  **In managed hosting this caller is the hosting control plane (§3d), never the desk**
  — the control plane holds the license key and runs the operator's update workflow on
  their behalf. Nothing about that changes who *cannot* call it: the AGPL core still
  never does.

## 3d. The hosting control plane (new in v1.1)

Managed hosting introduces exactly one new component, and it is the load-bearing piece
of the whole revision: a Resonant IQ-operated **hosting control plane**. It exists
because the managed experience requires *someone* to hold a license key and a
provisioning credential at the same time and act on both — and the one place that must
**never** be is the AGPL core. The control plane is that someone.

**Three trust domains, stated once.** After v1.1 there are three, and the credential
each may hold is the whole point of separating them:

| Domain | Owned/run by | May hold | Must never hold |
|---|---|---|---|
| **Desk core** (the AGPL engine) | The operator (own Vercel + Supabase) | Its own substrate rows — `assistants`/`webhook_endpoints` carrying a `module` slug (the existing installed-ness signal, §6) | Any license key; any marketplace or control-plane credential in its runtime config |
| **Marketplace service** (§3a–§3c) | Resonant IQ (closed SaaS) | Stripe data; `secret_hash` of license keys; Release tarballs | Per-desk provisioning credentials (desk admin tokens, deploy tokens) |
| **Hosting control plane** (this section) | Resonant IQ (closed SaaS) | **Both** — the plaintext license key it redeemed for the operator (§3e), *and* the per-desk provisioning grant the operator delegated at enrollment | — (it is the deliberate single bridge; its blast radius is contained by keeping it off the public store surface) |

The control plane is the *only* domain that holds both a license key and a desk
credential, and it sits entirely outside the AGPL core. That is the precise, engineered
form of the charter invariant "the helpdesk never calls the marketplace with
credentials": the helpdesk (core) holds no such credential to call with, and the
component that does is not the helpdesk.

**Where it lives.** *Chosen default:* the control plane ships in the same private
repo and Supabase project as the marketplace service (`Helpthread/marketplace`) but as
a **distinct deployment and a distinct credential store** — a separate trust domain,
co-located for v1 velocity, with a clean seam to split into its own service later.
*Alternative considered:* a fully separate repo/infra from day one — rejected for v1 as
premature operational overhead; the separation that matters for the invariant is
credential isolation from the public store surface, which co-location with a separate
vault already achieves. (Decision point §10.10.)

**Responsibilities** — the full lifecycle of a hosted module instance, one row per
`(customer desk, module)`, all driven from the desk's Manage → Modules surface (§5):

- **Provision** — on a completed managed purchase (§3e), stand up a Resonant IQ-hosted
  instance of the module at its entitled version: fetch the tarball via the
  marketplace's own Bearer download endpoint (§3b) using the held license key, deploy
  it onto Resonant IQ hosting, inject the module's *runtime* config (the ordinary
  substrate env vars — `HELPDESK_API_URL`, `HELPDESK_ASSISTANT_TOKEN`,
  `WEBHOOK_SIGNING_SECRET`, model keys, §4/§5; **never** a license key), and register
  the module against the operator's desk (create its Assistant, register its webhook
  endpoint) via the substrate admin API, using the per-desk provisioning grant.
- **Enable / disable** — a toggle. Disable pauses the instance (and/or sets its
  registered Assistant `disabled` and its webhook endpoint inactive via the substrate
  admin API); enable resumes. No teardown, no data loss — a disabled instance is
  dormant, not decommissioned.
- **Update** — one-click, operator-initiated (§5.2): roll the hosted instance to a
  newer entitled release. Because the control plane both knows the deployed version and
  gates the roll on license state, this is where §6's "update available" question —
  *unbuildable* for self-host in v1 — becomes buildable for hosted instances (§6).
- **Decommission** — tear the instance down and deregister it. Reached by the
  `refunded`/`revoked` lifecycle below and by an operator's own explicit uninstall,
  always after a config-export grace window (§5.3).

**Hosted-instance lifecycle vs. license state.** The five license states (§2) drive
the marketplace's download/update-check endpoints unchanged. For a *hosted* instance,
the control plane adds one rule the self-host path could never enforce because it could
never reach a running deployment — and holds it to the "lapse never stops running
software" floor deliberately:

| License state | Hosted instance | Updates | Rationale |
|---|---|---|---|
| `active` | Runs latest entitled version | Available (one-click) | — |
| `lapsed` | **Keeps running, pinned at `entitled_up_to_version`** | Stop (nudge shown) | The central promise, now literally enforced by the control plane *not acting*: a lapse is non-payment, not a verdict, and hosting continues **indefinitely**. Refund is a different thing (below). |
| `frozen` (dispute filed) | **Keeps running** | Paused | A filed dispute is protective, not a verdict; stopping a customer's running support automation mid-dispute would punish them for exercising a chargeback right. Downloads/update-check pause per §2; the running instance does not. |
| `refunded` (voluntary refund, or dispute lost) | **Decommissioned after a config-export grace window** (7 days, confirmed §10.11) | Hard-refused immediately (unchanged, §3b/§3c) | Refund unwinds the transaction and returns the money; unlike a lapse, entitlement has *ended*, and — because Resonant IQ is the host and bears the ongoing cost — continuing to run a fully-refunded instance forever is not owed. This is **not** a contradiction of "lapse never stops running software": refund is not lapse. A dispute resolved `lost` (§2) routes here. |
| `revoked` (confirmed fraud, manual) | **Decommissioned immediately** | Hard-refused (unchanged) | The one case where an immediate stop is warranted — a manual admin action following an actual confirmed-fraud investigation (stolen card, ToS violation), never automatic. *Chosen default; §10.11.* |

**Self-host residual exposure is accepted, consciously and permanently.** A refunded or
revoked customer who took the self-host tarball path keeps a working old copy of the
module — the marketplace refuses them new downloads and updates, but there is **no DRM,
no kill switch, and no runtime license check, ever**, so the bits they already hold keep
running. This is stated here so no future change "fixes" it: it is the direct, intended
consequence of the charter's no-runtime-check posture (`catalog.md` §5), the same
property that makes the product trustworthy to self-hosters, and it is a deliberately
accepted cost, not an oversight. Managed hosting can decommission an instance *Resonant
IQ operates*; it never reaches into anything the operator holds.

**What the control plane logs** is bounded exactly as §3c's update-check is: license-key
id, module, desk identity it is provisioning for, action, timestamp, status — the
operational record a hosting operator needs to run the fleet. It is not usage telemetry
and never surfaces helpdesk conversation content or volume back as "usage."

## 3e. The buy → install → enable managed handoff (new in v1.1)

The operator's experience is *in-app*: browse in Manage → Modules, click Buy, and the
module ends up installed and enabled without ever copying a key. The architecture keeps
purchase and licensing **on the separate store service** (confirmed 2026-07-19) and
keeps every credential out of the AGPL core. The seam that makes both true is a
one-time **claim token**, redeemed by the control plane — never by the desk.

1. **Buy (browser, store-side).** The desk's Manage → Modules "Buy" button opens the
   store's **hosted Stripe Checkout** in the operator's browser (the charter-preserving
   rule that purchases happen in the operator's browser on the store site, §9, is
   intact). The desk passes only non-secret context — the module slug and an opaque
   desk-identifier for the return leg — as checkout metadata; **no credential, no
   credentialed marketplace call originates in the core.**
2. **License minted (marketplace webhook).** `checkout.session.completed` creates the
   Customer / Subscription / License-key row exactly as §2/§3 already specify. In
   addition, the marketplace mints a single-use, short-TTL **claim token** bound to that
   license and the desk-identifier from step 1 — this token is *not* the license key and
   *not* the plaintext secret; it is an OAuth-authorization-code-shaped one-time
   credential whose only power is "redeem me, once, for this one license, into a control
   plane."
3. **Return leg (browser redirect).** Checkout's success URL redirects the browser to
   the **hosting control plane's** claim endpoint carrying the claim token (the
   OAuth-code pattern — a one-time, single-use, minutes-TTL token in a redirect URL,
   never the license key and never PII). The redirect target is the control plane, not
   the desk core, precisely so the key never transits the core.
4. **Redeem + provision (control-plane-to-marketplace).** The control plane redeems the
   claim token against the marketplace (both parties outside the core), receives the
   plaintext license key **once**, and stores it in its own vault. It then runs the
   Provision responsibility (§3d) for that desk. The raw one-time key reveal of v1 (§3's
   account-area flow) still exists for self-hosters, but for a managed install it is now
   *plumbing the operator never sees* — exactly the "invisible handoff" this revision
   was asked to design.
5. **Reflected as installed (desk, credential-free).** Provisioning registers the
   module's Assistant + webhook endpoint on the desk via the substrate admin API, so the
   desk's Manage → Modules infers the module as installed by the **same local
   attribution signal it already uses** (§6) — no new "installed" table, no license key
   in the desk, no cross-origin credentialed call from the core. The control plane
   finally bounces the browser back to Manage → Modules, which now shows the module
   enabled. "The license key handed back to the desk automatically" is, precisely, this:
   the *operator experience* of an installed module appearing on its own, realized by
   the control plane, with the actual key resident only in the control plane's vault.

**Enrollment (one-time, prerequisite to step 4's provisioning).** Before the control
plane can provision on a desk, the operator grants it a **scoped, revocable per-desk
provisioning credential** — an OAuth-style consent the operator performs once from
Manage → Modules ("Enable managed hosting"). *Chosen default:* the grant is a scoped
substrate credential whose capability is limited to registering/rotating module
Assistants and webhook endpoints — **not** the desk's full `HELPTHREAD_API_TOKEN`.
**Dependency flagged:** the substrate today ships a single all-powerful service token
(`docs/modules/README.md`), not per-grantee scoped, revocable credentials; managed
hosting needs that scoped-credential class to exist, or it would have to hand the
control plane the full service token, which is too broad. This is a real new substrate
requirement, called out as decision/dependency §10.12, not silently assumed. The desk
issues this grant *to* the control plane (outbound, operator-initiated delegation); the
desk still holds no marketplace or license credential of its own — being called by the
control plane is not the core calling the marketplace.

**Module runtime configuration (install-time, browser → control plane).** Some modules
genuinely need operator-supplied settings — most prominently the operator's **own model
API key**, which charter §2 requires assistants to use ("with the operator's own
keys"). §3d's Provision step injects these as instance env; they have to come from
somewhere, and that somewhere is an **install-time configuration form in Manage →
Modules that the browser submits directly to the control plane's endpoint** — the same
never-transits-the-core rule as the claim token (step 3). The desk's backend never
receives, stores, or proxies these values; they live in the control-plane vault
alongside the license key and are re-injected on every update roll (§5.2). Two honest
consequences, stated rather than glossed: (a) the "no hand-entered env vars" promise
(§5.1) means *no hosting-dashboard plumbing* — a module that needs an operator secret
still asks for it once, in-app, at install; (b) operator-supplied secrets residing in
the control-plane vault are part of the same data-residency disclosure §8 requires and
the same §10.13 call TJ owns — a model key in Resonant IQ's vault is the credential
face of the question whose data face is a hosted module reading conversation content.

## 4. Artifact pipeline

```text
module repo CI (e.g. Helpthread/module-draft-assistant, on tag/release)
  → build a versioned tarball (source + package.json + lockfile; no node_modules —
    matches module-draft-assistant's existing "plain Vercel Functions project, no
    build step" shape)
  → compute sha256 checksum
  → publish via an authenticated CI→marketplace publish credential
    (a first-party publish token, a distinct credential class from customer
    license keys — CI is not a customer)
  → marketplace stores the tarball in Supabase Storage (private bucket, behind
    the §3 download endpoint's auth) and writes a new Release row
  → public feed's latestVersion for that module updates
```

**Signing.** Checksum (sha256) published in both the public feed's `versions` array
(§3a) and every download response, at minimum — a download can be verified against a
checksum obtained from a genuinely separate call, not merely echoed back by the same
authenticated response that handed over the file (§3a spells out why that separation
is what makes "independent" true rather than circular). Sigstore/minisign detached
signing is **optional-later**, not v1: v1's threat model
(tampering in transit, a compromised storage object) is covered by HTTPS + a checksum
sourced from an authenticated API call; a detached signature adds defense against a
compromised checksum-serving API itself, which matters more once third-party modules
or an untrusted CDN enter the picture — both explicitly out of scope v1 (§9). Revisit
when either changes.

## 5. Install & hosting UX

There are two install paths. **Managed hosting is the mainline** (§5.1–§5.3): the
designed loop TJ specified — *browse, buy, install, enable*, no operator DevOps. The
**self-host tarball path** (§5.4) is preserved unchanged as the open-core escape hatch
and open-core-credibility story — the same flow proven end-to-end today.

### 5.1 Install a module — managed hosting (mainline)

From the desk's Manage → Modules Directory (§6), the whole loop is in-app and
credential-free from the core's side:

1. **Buy** — the module's "Buy" button opens the store's hosted Stripe Checkout in the
   operator's browser (§3e step 1). Purchase and licensing stay on the separate store
   service; the core originates no credentialed call.
2. **Install** — on checkout success the buy → install handoff (§3e) runs end to end
   automatically: the marketplace mints a one-time claim token, the browser carries it
   to the hosting control plane, the control plane redeems it for the license key,
   provisions a Resonant IQ-hosted instance of the module at the entitled version, and
   registers its Assistant + webhook against the desk (§3d). The operator copies no key
   and touches no Vercel dashboard.
3. **Enable** — the module lands enabled; enable/disable is thereafter a toggle in
   Manage → Modules, backed by the control plane (§3d). Disable is dormant, not
   destructive.

**Prerequisite, one-time:** managed-hosting enrollment (§3e "Enrollment") — the
operator grants the control plane its scoped per-desk provisioning credential once.
After that, every module install is the three steps above.

**What the operator never does** (the friction v1 was rejected for): download a
tarball, push to a git provider, import a Vercel project, hand-copy env vars into a
hosting dashboard, or hand-run the admin API to wire up an Assistant and webhook. The
control plane does all of it. Settings a module genuinely needs from the operator —
e.g. their own model API key (charter §2) — are collected once by an in-app install
form submitted browser-direct to the control plane (§3e "Module runtime
configuration"), never typed into a hosting dashboard and never stored in the desk.
**No license key ever reaches the desk or the module's runtime config** (§1, §3d) —
managed hosting adds convenience, not a credential in the core.

### 5.2 Update a module — one-click (managed hosting)

When a newer entitled release exists, Manage → Modules shows an **Update** control next
to the hosted module (for hosted instances the version diff is computable — the control
plane knows the deployed version, §6). One click rolls the hosted instance forward: the
control plane gates the roll on license state (`active` → latest; `lapsed` → refused
past `entitled_up_to_version`, §3d), fetches the new release via §3b, redeploys the
instance, and reports the outcome as a visible ops record. This is the concrete
delivery of `admin-ia.md` §2's long-standing "in-place update with a visible ops log"
aspiration — *unbuildable* under the self-host model (§9) and now buildable precisely
because Resonant IQ operates the runtime.

### 5.3 Uninstall & decommission — the config-export grace window

Tearing down a hosted instance — whether by the operator's own explicit uninstall or by
the `refunded`/`revoked` lifecycle (§3d) — always runs through **decommission** (§3d),
and always after a short **config-export grace window** during which the operator can
export the instance's configuration before it is destroyed:

- **Operator-initiated uninstall** — immediate stop of new work, instance torn down
  after the grace window; the operator keeps their exported config.
- **Refund** (voluntary, or dispute `lost`) — the hosted instance is decommissioned
  after the grace window (**7 days**, confirmed §10.11);
  downloads/update-check hard-refuse immediately (`refunded`, unchanged §3b/§3c). Refund
  ends hosting; a **lapse does not** (§3d) — the two are deliberately different, and
  "lapse never stops running software" stays literally true. A short B2B refund window
  (**14 days**, confirmed §10.11) gates eligibility for this at all.
- **Revoke** (confirmed fraud, manual) — immediate decommission, no grace window owed
  (§3d).
- **Dispute open** (`frozen`) — **no decommission**; the instance keeps running while
  the dispute is investigated (§3d). Only a `lost` outcome (→ `refunded`) reaches the
  decommission flow.

### 5.4 Self-host the module — the tarball escape hatch (preserved)

The manual path from v1 remains fully supported for operators who want to run the module
on their **own** infrastructure — the open-core credibility story, and the guarantee
that nothing about the product depends on Resonant IQ hosting anything. It mirrors
`module-draft-assistant`'s own README and was proven end-to-end today
(2026-07-19, HT-82):

1. **Buy** — Stripe Checkout on the store site (annual). The marketplace emails a magic
   link into the account area (§3's Authentication); the operator authenticates there
   and reveals the license key exactly once (§3).
2. **Download** — account-area "Download" button hits the session-authenticated
   `GET /account/subscriptions/{subscriptionId}/download` route (§3), or the operator's
   own tooling calls the Bearer download endpoint (§3b) with the revealed key. Either
   fetches the tarball with a verifiable checksum.
3. **Deploy to Vercel** — extract, push to the operator's own git provider (or import
   directly), `vercel` CLI or dashboard import.
4. **Configure env vars** — module-specific config in Vercel project settings (e.g.
   `HELPDESK_API_URL`, `HELPDESK_ASSISTANT_TOKEN`, `WEBHOOK_SIGNING_SECRET`,
   `ANTHROPIC_API_KEY`). **No license key appears here** — licensing stayed at the
   download step (§1).
5. **Provision credentials via the Helpthread admin API** — create an Assistant,
   register the module's webhook endpoint (`docs/modules/assistants-and-drafts.md`,
   `docs/modules/webhooks.md`).

This is five manual steps, named honestly — which is exactly why managed hosting exists
as the mainline. The self-host path is not deprecated: it is the escape hatch that keeps
the whole model honest, and it is the path a refunded/revoked customer's already-held
copy keeps running on with no DRM and no runtime check, ever (§3d).

## 6. In-product directory contract (HT-81)

**What Manage → Modules reads.** The engine (or the web app serving it) fetches and
caches the public feed (§3a) server-side — proxied, so the operator's browser never
makes a cross-origin call to the marketplace and the feed is never fetched with any
credential. No license key ever reaches the running helpdesk through this path,
consistent with §1. The Directory's per-module **Buy** button opens the store's hosted
checkout in the browser and the managed handoff (§3e) takes it from there; **Install**,
**Enable/disable**, and **Update** controls target the hosting control plane (§3d/§5),
not the marketplace and not a credentialed core call — the core renders the controls and
reflects state, the control plane does the credentialed work.

**How "installed" is known.** There is no `module_installs` table yet — one is
explicitly deferred (`substrate-v1.md` §1's non-goals, `catalog.md` §5's forward
note). v1 infers installed-ness purely from existing local attribution: **the
presence of any row — any status, including `disabled`/`auto_disabled`, not only
`active`** — in `assistants` or `webhook_endpoints` carrying a given `module` slug
means that module is (at least partially) installed; status drives the health badge
shown next to it, never whether it appears in the list at all. This matters
concretely: a webhook endpoint that has tripped `auto_disabled` (HT-44) is exactly
the case an operator most needs to see in Manage → Modules — inferring
installed-ness only from `active` rows would make a module silently vanish from the
Installed list at precisely the moment its failure needs surfacing, which would
defeat the whole point of showing health here. The directory lists each distinct
`module` slug seen locally, matches it against the public feed by slug for display
name/summary/changelog, and shows health from data the engine already has:
`assistants.status`, and `webhook_endpoints.status`/`consecutiveFailures` (surfaced
today at `/api/v1/internal/health`, HT-44). This is an honest inference, not a
tracked install record — a module that never registered a webhook or never got an
Assistant (unlikely for any real module, given §1's "typically uses all three")
simply wouldn't appear. **For managed-hosting installs the very same rows are created
by the control plane during provisioning (§3e step 5)**, so this inference is what makes
a managed install show up as installed — no new `module_installs` table is needed even
for hosted modules; the existing local-attribution signal already carries it.

**"Update available" — now split by install path.** The version-diff badge that was
**unbuildable** for the self-host model *is* buildable for a **hosted** instance,
because the hosting control plane knows both the deployed version and the latest
entitled version. So:

- **Hosted instances** — Manage → Modules shows a real "update available" state and a
  one-click **Update** control (§5.2); the diff and the roll are the control plane's
  (§3d), surfaced through the desk UI. The desk core still computes nothing about a
  license and holds no key — it reflects control-plane state.
- **Self-hosted instances** — unchanged from v1, and still honestly limited: **nothing
  in the shipped substrate lets the engine or the browser learn which version a
  self-hosted module is running.** Its tarball carries no version marker the engine ever
  sees; it runs as a separate Vercel project the desk cannot inspect. Manage → Modules
  surfaces the feed's `latestVersion` and `changelogUrl` next to it, informational only
  — the operator does the "am I behind" comparison themselves. No current/diff badge is
  computed for self-host. The additive path to a real self-host diff (a module-authoring
  self-report convention off `webhook_endpoints.url`) still does not exist and is not
  proposed here; it is named only so a future ticket has an honest starting point.

Called out again as decision point §10.5.

**Client-side, no keys**: every computation in this section — the feed fetch (server
proxy, no credential needed because the feed itself needs none) and any comparison
math — happens without a license key touching the helpdesk at any point, matching §1.

## 7. Dogfood-through-marketplace plan (HT-82)

**Purpose**: prove the charter's literal HT-79 mandate — "the marketplace is LIVE at
public launch, proven first as the project's own install path" — by having Resonant
IQ buy its own draft-assistant module through the real marketplace, in Stripe test
mode, before it ever takes a stranger's money.

**Note — this supersedes catalog.md §4 step 4's stated shortcut.** That step reads:
"Dogfood installs are a private npm package in the Vercel build — no marketplace
plumbing required to use our own modules." That was accurate as of HT-66/HT-70, written
before the HT-79 charter amendment moved the marketplace onto the critical dogfood
path. HT-82 is the ticket that reconciles the two: once this spec ships, Resonant IQ's
own draft-assistant install moves off the npm-package shortcut and onto the actual
marketplace flow (test mode, then live mode at cutover) — not because the shortcut was
wrong when written, but because the charter's requirement changed underneath it. Flag
this explicitly in the HT-82 ticket description so nobody reads catalog.md §4 as still
current on this point without also reading this section.

**The Stripe seam matrix (test clock, refund, dispute) is unchanged by v1.1** — those
transitions are marketplace-side (§2/§3) and managed hosting adds no state to them. What
v1.1 changes is the **install and update legs**: they now run the managed-hosting flow,
and the hosted instance's behavior under each seam is an additional thing to assert.

**Test plan, Stripe test mode:**

1. Create a test-mode Stripe Product + annual Price for `draft-assistant`.
2. **Managed install leg (mainline).** Full flow as a real customer would, in-app:
   enroll the desk in managed hosting (§3e) → Manage → Modules "Buy" → store checkout
   (test card) → `checkout.session.completed` mints Customer/Subscription/License key +
   claim token → browser return leg redeems the claim token at the control plane → the
   control plane provisions a Resonant IQ-hosted `draft-assistant` instance and
   registers its Assistant + webhook against the live Resonant IQ desk → Manage →
   Modules shows it installed and enabled. **Assert the license key never appears in the
   desk or the hosted instance's env** (§1/§3d) and that the operator copied no key.
   *Also, once,* re-verify the **self-host leg** (§5.4) end to end onto a genuinely
   separate Vercel project — the escape hatch proven today (2026-07-19) must stay green.
3. **Stripe test clock**, advance time to exercise:
   - Successful renewal → license stays `active`; hosted instance unaffected.
   - A failed charge → `past_due` → license flips `lapsed`; verify the update-check and
     download endpoints correctly cap at `entitled_up_to_version`; verify **the running
     helpdesk and the hosted module instance are completely unaffected** — no outage, no
     decommission, no runtime check trips anywhere in the module, and the control plane
     does **not** stop the instance (`lapsed` → hosting continues indefinitely, §3d).
     This is the literal proof of catalog §5's central promise — now proven for the
     *hosted* case too, where Resonant IQ *could* stop it and deliberately does not.
   - Resubscribe after lapse → license flips back to `active`, full latest access
     restored, no back-charge (§2); hosted instance eligible for updates again.
4. **Managed update leg.** With the license `active`, publish a newer `draft-assistant`
   release → Manage → Modules shows "update available" for the hosted instance (§5.2/§6)
   → click Update → verify the control plane rolls the hosted instance to the new
   version and records a visible ops result. Then, with the license `lapsed`, confirm
   the Update control is refused past `entitled_up_to_version` (§3d).
5. **Refund**: trigger a test-mode refund (`charge.refunded`) → verify license flips to
   `refunded`, downloads/update-check hard-refuse **immediately**, and the hosted
   instance enters the **decommission flow after the config-export grace window** (§3d/
   §5.3) — assert it is *not* torn down instantly, the config export is available during
   the window, and it is decommissioned at the end of it. Separately assert a self-host
   copy (from step 2's self-host leg), if used, keeps running with no runtime check —
   the consciously-accepted residual exposure (§3d).
6. **Dispute lifecycle**, via Stripe test mode's dispute-simulation test cards —
   run this twice, from two different starting states, to actually prove
   `pre_freeze_state` fidelity (§2) rather than the one path that happens to look
   right by coincidence:
   - **From `active`**: `charge.dispute.created` → verify license flips to `frozen`
     automatically, `pre_freeze_state = 'active'`, downloads/update-check fully
     paused — **and verify the hosted instance keeps running** (a filed dispute does
     not stop hosting, §3d). Resolve `won` → verify the license restores to `active`.
   - **From `lapsed`**: force the subscription into `past_due` first, confirm the
     license is `lapsed`, *then* trigger `charge.dispute.created` → verify
     `pre_freeze_state = 'lapsed'`, not `'active'`. Resolve `won` → verify the
     license restores to `lapsed`, **not** `active` — this is the exact bug this
     revision fixed; the test must fail loudly if it regresses.
   - Repeat either starting state and resolve `lost` → verify the license flips to
     `refunded` regardless of `pre_freeze_state`, never to `revoked`, and the hosted
     instance now enters the decommission-after-grace flow (§5.3) — confirming a
     filed-then-lost dispute is treated as a refund, never as a fraud finding.
7. **Revoke**: simulate a `revoked` state via *manual* admin action only (standing in
   for a confirmed-fraud investigation, never triggered by the dispute flow above) →
   verify both download and update-check hard-fail immediately **and** the hosted
   instance is decommissioned immediately, no grace window owed (§3d).
8. **Exit criteria**: all of the above — active, lapsed, frozen, refunded, and revoked,
   the managed install/update/decommission legs, the one self-host escape-hatch leg,
   plus every transition between them exercised at least once — green in test mode,
   using Resonant IQ's own store account as customer #1, before Stripe is flipped to
   live mode for public launch (Phase 3).

## 8. Counsel & compliance dependencies

Per the HT-79 charter amendment's own text: *"New counsel items before the
marketplace takes real money: the commercial module license text and terms of
sale."* This spec adds the store's privacy policy, the refund/dispute policy, and
Stripe Tax enablement to that same gate — the last of which is a **compliance
configuration**, not a counsel-drafted document; it's grouped with the others here
only because it shares their gate (pre-revenue, not pre-dogfood), not because it's
legal work. Worth keeping that distinction precise rather than letting "counsel
dependencies" quietly become a catch-all label for anything pre-launch.

| Item | Nature | Gate | Not gating |
|---|---|---|---|
| Commercial module license text (replaces the current placeholder) | Counsel-drafted | Before Stripe flips to live mode / before the marketplace takes real money | Does **not** gate HT-82's test-mode dogfood — Resonant IQ as its own test-mode customer needs no finished license text, only a placeholder |
| Terms of sale — including the refund policy (§2's `refunded` state, §5.3's decommission-after-refund), the refund window (**14 days**) and config-export grace period (**7 days**) (§5.3; the day figures are confirmed, §10.11 — only the customer-facing policy *wording* remains on this gate), and the dispute-handling policy (§2's `frozen` state): this spec pins the entitlement and hosting-lifecycle *mechanics* and the exact windows; the customer-facing policy language is counsel's/TJ's call | Counsel-drafted (the window figures are decided; policy wording remains) | Before Stripe flips to live mode / before the marketplace takes real money | Same — pre-revenue, not pre-dogfood (test-mode dogfood uses the confirmed figures) |
| Privacy policy for the store | Counsel-drafted | Same gate (real customer PII starts flowing at first live charge) | Same |
| **Managed-hosting terms & data-handling disclosure** (new in v1.1) — because a Resonant IQ-hosted module reads the operator's conversation data on Resonant IQ infrastructure to do its job, managed hosting is the charter's "hosted convenience services" (§3) made real, and it needs its own disclosure/DPA-style terms the operator consents to at enrollment (§3e). This is distinct from the store privacy policy, which covers *purchaser* PII; this covers the *operator's end-customers'* conversation data flowing through a hosted module | Counsel-drafted | Same gate — real operator data starts flowing through a hosted module at first live managed install | Not pre-dogfood — Resonant IQ hosting its own module for its own desk raises no third-party data question. **The charter §2 own-your-data reconciliation flagged at §10.13 is now RESOLVED — charter §2 was amended the same day (HT-5/HT-82); the managed-hosting data-handling terms/disclosure themselves remain on this gate** |
| **Stripe Tax enabled** (automated EU VAT / US sales-tax calculation and remittance on Checkout Sessions) | Compliance/finance configuration, not counsel-drafted | Same gate — charging real customers across jurisdictions without correct tax handling is its own launch blocker | Not pre-dogfood — Stripe test mode carries no real tax obligation. Which jurisdictions to register in first is decision point §10.9 |

The plugin exception's counsel deadline — set in CHARTER.md §3's module boundary,
where "§7" names the *AGPL-3.0* §7 additional permission, not a CHARTER.md section —
stays separate and earlier: before the first external contribution is accepted. The
HT-79 amendment left it unchanged, and this spec does not touch it, since every v1
marketplace Module is out-of-process and needs no exception. The merged amendment
says so directly: *"The §7 plugin exception's counsel deadline is unchanged (before
first external contribution): every v1 marketplace module is out-of-process and needs
no exception."*

## 9. Non-goals v1

- **Third-party sellers.** Every Module row (§2) is first-party; no seller onboarding,
  no revenue split, no third-party publish credentials.
- **Reviews / ratings.** Store pages show official copy only.
- **In-product *checkout*.** Manage → Modules now carries a **Buy button** (§3e/§6) —
  the in-app feel TJ asked for — but it only *opens the separate store's hosted Stripe
  Checkout in the operator's browser*; the purchase, the card entry, and the licensing
  all still happen on the store service, never inside the AGPL core. The commercial
  *checkout surface* stays decoupled from the core exactly as before; what changed in
  v1.1 is that the core may now *link to* it in-app, not that it hosts it. (This
  supersedes v1's flat "no buy button inside the helpdesk" phrasing, which conflated the
  button with the checkout.)
- **npm distribution.** v1 ships tarball distribution only (Resonant IQ-hosted deploy
  for managed installs, operator Vercel deploy for self-host), per TJ's decision;
  publishing modules as installable npm packages is additive, later.
- **Usage metering.** No conversation counts, no per-seat metering, no usage-based
  billing — flat annual per-deployment (§2), matching the update-check endpoint's
  explicit "not telemetry" posture (§3c).
- **Bundle / multi-module pricing.** Every Subscription and License key is scoped to
  exactly one module (§2); there is no "all-modules suite" Price v1. See decision
  point §10.8 for the schema consequence if this is added later — it isn't a free
  addition, since today's 1:1 subscription↔license-key design would need to become
  one-subscription-to-many-license-keys or similar.
- **A build-time / in-process module API.** Modules remain out-of-process only
  (`substrate-v1.md` §1); managed hosting runs the *same* out-of-process artifact on
  Resonant IQ infrastructure — it does **not** introduce an in-process module API, UI
  injection points, or any §7-exception-requiring surface. In-place update is now
  delivered for hosted instances (below), but via the control plane operating a separate
  runtime, never via an in-process hook.
- **A version-diff "update available" badge and self-reporting convention *for
  self-hosted instances*.** Still deferred for self-host (§6) — the substrate gives the
  engine no way to learn a self-hosted module's deployed version. (For *hosted*
  instances the control plane knows the version, so the badge and one-click update **are**
  delivered — §5.2/§6. The non-goal is now scoped to self-host only.)
- **A `module_installs` table.** Still none; installed-ness is inferred from local
  attribution for both install paths (§6), managed provisioning simply creates those
  same rows.

**Conflict from v1, now resolved by managed hosting, named per house style**:
`specs/ui/admin-ia.md` §2 describes the target "Manage → Modules" surface as "Installed
(activate/deactivate, license-key entry, in-place update with a visible ops log) +
Directory (browse/install)." Under v1's manual self-host model this spec had to flag
"in-place update with visible ops log" as **not deliverable** — there was no way for the
engine to trigger or observe a *separate Vercel project's* redeploy. **Managed hosting
delivers exactly that surface** (§5.2): because Resonant IQ operates the runtime, the
control plane can roll a hosted instance and report the result, so Manage → Modules gets
one-click in-place update with a visible ops record for hosted modules. Two nuances the
`admin-ia.md` line predates, reconciled rather than silently absorbed: (1) "license-key
entry" never happens *in the desk* — the operator never enters a key anywhere in the
core (§1/§3e), so read that phrase as "the licensing step of install," which managed
hosting makes invisible; (2) in-place update is delivered for **hosted** instances, not
self-hosted ones (§6), which remain the informational-only case. `admin-ia.md`'s
aspiration is now met for the mainline path; the self-host residue is the only part that
stays informational.

## 10. Decision points for TJ

> **Resolved 2026-07-19 (TJ, acting as counsel — HT-5/HT-82 licensing session).**
> The following items on this list, plus the three service-review policy calls from
> HT-79's comment thread, are now DECIDED; each item below retains its original text
> for the reasoning, with its disposition noted here:
>
> - **Licensing unit refined: one license = one domain.** The "per helpdesk
>   deployment" term is formalized as *a license authorizes one helpdesk deployment
>   serving one domain* (§2's License-key row updated). Bulk/multi-domain purchases
>   are a possible later product; today, more domains = more licenses. Still a
>   contractual term, never a technical control (no phone-home).
> - **Partial refunds do NOT terminate** (HT-79 service-review call #1): only a
>   refund of the full purchase price flips a license to `refunded` (webhook compares
>   the charge's cumulative refunded amount to the amount captured). Goodwill/partial
>   refunds leave the entitlement untouched. Code change ticketed.
> - **Customer email uniqueness ENFORCED** (HT-79 call #2): `customers.email` gets a
>   unique constraint; migration ticketed.
> - **"Latest" stays publish-order** (HT-79 call #3): documented operator expectation
>   is "publish releases in semver order"; revisit only if back-porting ever becomes
>   real practice.
> - **§10.3 signed off** — lapsed keys keep downloading already-entitled versions.
> - **§10.6 signed off** — reactivation restores full latest access, no back-charge.
> - **§10.8 confirmed** — no bundles in v1; TJ's bulk-domain idea is the noted v1.1
>   candidate shape (multi-domain purchase, still 1 subscription : 1 license : 1
>   domain underneath).
> - **§10.9 decided** — Stripe Tax enabled at live-mode flip with US home-state nexus
>   registration only; Stripe's threshold monitoring drives later registrations; EU
>   VAT (OSS) revisited at first EU customer.
> - **§10.10 confirmed** — control plane co-located (same repo/Supabase, distinct
>   deployment + credential vault).
> - **§10.11 confirmed** — 14-day B2B refund window; 7-day config-export grace;
>   revoke decommissions immediately. Policy *wording* still counsel-drafted at the
>   §8 gate (drafting in flight, same session).
> - **§10.12 direction approved** — the scoped per-desk provisioning credential gets
>   built (substrate ticket to file); the full service token is never handed to the
>   control plane.
> - **§10.13 RESOLVED** — charter §2 amended (same-day charter PR): the own-your-data
>   promise is scoped to the core with the managed-hosting opt-in stated explicitly;
>   the managed-hosting data-handling terms remain on the §8 gate.
>
> - **Provenance stamping + attribution display (decided in the same session,
>   follow-up exchange):** the one-domain term stays contractually enforced —
>   a blocking install/startup domain check was considered and REJECTED
>   (defeatable in one line by anyone holding the source; false-positives on
>   rebrands/staging; contradicts the charter's zero-runtime-checks invariant
>   and commercial-license §7). Adopted instead, both non-blocking: every
>   license-authenticated download embeds a signed provenance file (license id,
>   licensed domain, issued-at, marketplace signature — leak attribution and
>   audit evidence, HT-89), and every paid module displays "Licensed to:
>   <domain>" in its diagnostics surface (display only, HT-90). Both are
>   compatible with every posture invariant by construction; managed hosting
>   already enforces 1:1 naturally at provisioning.
>
> **Addendum — Codex-review-round rulings (TJ, acting as counsel, 2026-07-19).** Five
> further judgment calls settled while adjudicating the independent Codex review of the
> HT-5 licensing texts:
>
> - **The 14-day refund window applies to the initial purchase only, not renewals.** A
>   renewal charge does not reopen a refund window; only the first purchase of a
>   subscription is refund-eligible under the B2B window.
> - **A lapsed or terminated customer may create new internal modifications of versions
>   they already hold.** The entitlement that ends is to *new releases and updates*,
>   never to what they already possess; modifying an already-held version for their own
>   internal use is theirs to do — consistent with the no-runtime-check, no-DRM posture
>   and the self-host residual exposure (§3d).
> - **The §7 exception's Corresponding Source exclusion covers module object code and
>   build artifacts at maximal scope**, not only module source. Applied in
>   `legal/module-api-exception.md`'s grant this same session.
> - **The provenance policy splits into a public policy and a private counsel memo:** the
>   customer-facing statement of what is recorded and displayed (HT-89/HT-90) is public;
>   the legal analysis behind it lives in a separate counsel memo, not this public spec.
> - **Managed-hosting model providers are the operator's own relationship.** When a
>   hosted module calls a model provider with the operator's own key, Resonant IQ is an
>   **instructed conduit** holding that key on the operator's behalf — it does **not**
>   engage the model provider as its own subprocessor. Should Resonant IQ later offer a
>   bundled model key (its own provider relationship), that provider would be added to
>   Resonant IQ's subprocessor list at that time, and not before.
>
> Still genuinely open after this session: §10.1 (price points), §10.2 (store
> domain), §10.4 (KB-vs-pipeline charter conflict — product/architecture, not
> licensing), §10.5 and §10.7 (product confirmations).

1. **Price points per module.** Not decided; blocks store page content, not the
   architecture above (Stripe Price objects are created per module regardless of the
   number).
2. **Store domain** (e.g. `store.helpthread.dev` vs. a `resonantiq.app` subdomain).
   Affects Stripe Checkout success/cancel URLs, the public feed's CORS/cache posture,
   and DNS/cert setup — needed before §3's implementation starts, not before this spec
   is accepted.
3. **Lapsed keys keep downloading already-entitled versions** — recommended and
   justified in §2; needs explicit sign-off since it is the one place this spec
   resolves an open "pick and justify" call rather than merely recording a TJ decision
   already made.
4. **Launch module lineup — elevated: this is a charter-affecting conflict, not an
   ordinary open question, and this spec deliberately does not resolve it.**
   CHARTER.md's Phase 3 text names "the knowledge base and AI-powered modules" as the
   catalog that leads launch. The knowledge base ships as **content-as-code**
   (`catalog.md` §3.4, CHARTER.md §4: docs live in git, build to static output,
   search index generated at build time) — categorically different from
   `draft-assistant`'s shape (a long-running Vercel Functions service). This spec's
   entire pipeline (§4: tarball → Vercel deploy → env vars → running process) is
   built for the second shape. It is not obvious the first shape sells through it at
   all. Two resolutions, presented crisply, TJ decides:
   - **(a) KB gets its own, separate distribution mechanism** — e.g. a licensed git
     template or content package the operator merges/builds into their own docs
     site, using this spec's Customer/Subscription/License-key entities for
     *payment and entitlement* but not its Release/tarball/Vercel-deploy mechanics
     for *delivery*. Consequence: this spec's pipeline is scoped to
     running-service-shaped modules only, and the **actual launch catalog becomes
     draft-assistant-led**, not the KB-plus-AI-modules lineup CHARTER.md's amended
     Phase 3 text now names outright — a real narrowing of that text, not a wording
     nuance.
   - **(b) Generalize this pipeline to carry content-as-code artifacts too** — e.g. a
     Release's `tarball_storage_path` can point at a static-build output or a docs
     source bundle instead of a deployable service, consumed by a different (not yet
     specced) operator-side build step rather than a Vercel Functions deploy.
     Consequence: one pipeline, two artifact shapes, more spec surface before KB can
     ship, but the charter's stated launch lineup stays intact as written.
   **This spec takes no position between (a) and (b)** — flagging the conflict
   precisely is the deliverable here; resolving it is a decision that affects what
   CHARTER.md's Phase 3 text is understood to promise, and belongs to TJ, not to this
   draft. Needs resolution before the KB module itself is specced, not before this
   spec ships.
5. **§6's "update available" simplification — now scoped to self-host only.** For
   *hosted* instances the control plane delivers a real version diff and one-click
   update (§5.2/§6); the informational-only limitation remains only for *self-hosted*
   instances (the substrate has no self-report convention). Confirm this split is the
   right v1 line rather than a gap to close before HT-81 ships.
6. **Reactivation-after-lapse restores full latest access with no back-charge** (§2)
   — confirm acceptable; the alternative (pro-rated back-charge for skipped releases)
   was considered and rejected for v1 complexity reasons, not on principle.
7. **Magic-link account-area authentication** (§3) — no passwords, 15-minute link
   TTL, 30-day session — confirm this lighter mechanism is acceptable for the store's
   different (lower-frequency, non-Agent) user population rather than reusing HT-54's
   heavier Agent auth machinery.
8. **Bundle / multi-module pricing v1: none** (§9) — confirm; recommendation is no
   bundles at launch, with a possible later "all-modules suite" Price noted as a
   real schema consequence (today's 1:1 subscription↔license-key design does not
   accommodate it for free) rather than a trivial pricing-page addition.
9. **Which tax jurisdictions to register Stripe Tax for** before flipping to live
   mode (§8) — not an engineering decision, but needed before that gate closes;
   flagged here so it isn't discovered late.
10. **Hosting control plane — co-located vs. fully separate (§3d).** Recommended
    default: same private repo + Supabase project as the marketplace service, but a
    distinct deployment with its own credential vault (a separate trust domain,
    co-located for v1 velocity, with a clean seam to split later). Confirm, or elect a
    fully-separate repo/infra now. Either way the invariant that matters — the control
    plane is outside the AGPL core and its credential store is isolated from the public
    store surface — holds.
11. **Refund window and config-export grace period — exact figures (§3d/§5.3/§8).**
    Working figures: a **14-day** B2B refund window and a **7-day** config-export grace
    window before a refunded/uninstalled hosted instance is decommissioned; **revoked**
    (confirmed fraud) decommissions immediately with no grace. The *mechanics* are
    decided (refund → decommission-after-grace; lapse → hosting continues indefinitely;
    frozen → keeps running; the self-host residual copy is consciously accepted, no DRM
    ever). The day-counts are now CONFIRMED (see the resolved block above); only the customer-facing policy wording remains open —
    TJ/counsel, at the pre-revenue gate (§8). Test-mode dogfood (§7) uses the working
    figures.
12. **Scoped per-desk provisioning credential — a new substrate requirement (§3e).**
    Managed-hosting enrollment needs the desk to grant the control plane a *scoped,
    revocable* credential limited to registering/rotating module Assistants + webhook
    endpoints. The substrate today ships a single all-powerful service token
    (`docs/modules/README.md`), not per-grantee scoped credentials. Recommended: add
    that scoped-credential class (its own ticket) rather than hand the control plane the
    full service token (too broad). Confirm the direction; the detailed design is a
    separate spec, and this is a real dependency for managed hosting to ship, flagged so
    it isn't discovered late.
13. **Charter §2 "own your data" reconciliation — RESOLVED 2026-07-19 by the same-day
    charter amendment (§8).** A Resonant IQ-hosted module reads the operator's conversation data on
    Resonant IQ infrastructure, which is in tension with charter §2's absolute wording
    "Conversation data never proxies through Helpthread's infrastructure." The anchor
    that makes managed hosting legitimate is already in the charter: §3 contemplates
    "hosted convenience services," and `catalog.md` §5 says "modules we host as
    convenience services are ordinary SaaS billing." Recommended framing: managed
    hosting is opt-in per operator, the *core* mail/data path is unchanged (still the
    operator's own Supabase), and the hosted module is the already-contemplated
    convenience service the operator knowingly enrolls in with disclosed data handling
    (§8's managed-hosting terms). **Resolved (TJ, acting as counsel, 2026-07-19):** §2
    was amended the same day — its own-your-data promise now reads "conversation data
    never touches Resonant IQ-operated infrastructure," with the managed-hosting opt-in
    named explicitly (see CHARTER.md §2 and its §7 appendix, the HT-5/HT-82 own-your-data
    scoping amendment; that amendment also corrected the earlier mis-scoped "the core" phrasing). The managed-hosting data-handling terms themselves
    remain on the §8 pre-revenue counsel gate. The same call covers the credential face of the question:
    operator-supplied module secrets — most prominently the operator's own model API
    key (§3e "Module runtime configuration") — reside in the control-plane vault, i.e.
    on Resonant IQ infrastructure, when hosting is managed. One decision, two faces:
    conversation data read by a hosted module, and operator secrets held to run it.

## 11. Changelog

- **2026-07-19** (HT-79, v1.1 — managed hosting): after TJ walked the v1 manual
  self-host install as customer #1 (HT-82 dogfood) and rejected its friction, the
  **default install path becomes managed hosting**. New: a third trust domain, the
  **hosting control plane** (§3d), the only component holding both a license key and a
  per-desk provisioning grant, entirely outside the AGPL core; the **buy → install →
  enable managed handoff** via a one-time claim token redeemed by the control plane, not
  the desk (§3e); a rewritten **§5** with managed install/update/uninstall as the
  mainline and the v1 five-step tarball flow demoted to a preserved **self-host escape
  hatch** (§5.4); **one-click in-place update** for hosted instances, which resolves the
  long-flagged `admin-ia.md` "in-place update with visible ops log" conflict (§5.2/§6/§9);
  **hosted-instance lifecycle** tied to license state — `lapsed`/`frozen` keep running,
  `refunded` decommissions after a config-export grace window, `revoked` decommissions
  immediately (§3d/§5.3), with the "lapse never stops running software" floor preserved
  literally even though Resonant IQ is now the host. Decided per TJ/coordinator
  (2026-07-19): purchase/licensing stay on the separate store service, the desk supplies
  only the in-app *feel* (Buy button opens hosted checkout, license lands via the
  managed handoff, never in the core); refund ⇒ decommission-after-grace (14-day refund
  window / 7-day grace — the working figures at v1.1 authoring, since confirmed §10.11);
  the self-host residual copy of a refunded module is a **consciously accepted** exposure — no DRM, no
  runtime check, ever. Invariants held verbatim: license = distribution credential only,
  zero runtime license checks in any module, AGPL core holds no marketplace credential
  and never calls the marketplace. Entities (§2), commerce/download/update-check APIs
  (§3a–§3c), and the artifact pipeline (§4) are unchanged. New decision points §10.10–13
  (control-plane co-location; exact refund/grace figures; the scoped provisioning-
  credential substrate dependency; the charter §2 "own your data" data-residency
  reconciliation, explicitly left to TJ). Charter amended by direct edit (§4 + §7
  appendix) per the PR #86 mechanism; `catalog.md` §5 given a reconciling note.
- **2026-07-19** (HT-79): initial draft. Entities, service architecture (Vercel +
  Supabase, Stripe Checkout/Portal/webhooks), artifact pipeline, install UX v1,
  in-product directory contract (HT-81), dogfood-through-marketplace plan (HT-82),
  counsel dependencies, non-goals, and decision points, all built against
  `catalog.md` §5's additive contract and the HT-79 charter amendment. Two conflicts
  named and resolved rather than silently absorbed: `admin-ia.md`'s "in-place
  update" aspiration is not v1-deliverable (§9); `catalog.md` §4 step 4's
  npm-package dogfood shortcut is superseded by HT-82 now that the charter requires
  the marketplace itself to be the proven dogfood path (§7). One scope question left
  open rather than assumed: whether the content-as-code knowledge base module fits
  this same distribution pipeline (§10.4).
- **2026-07-19** (HT-79, Opus review round — 1 blocker, 6 major, 6 minor, all
  applied): **blocker** — License key entity was storing the plaintext key,
  contradicting show-once; fixed to `secret_hash` (SHA-256 of the secret half),
  mint/verify mechanism inherited verbatim from Assistant tokens (§2). **Major** —
  added a fourth-then-fifth license state: `refunded` (terminal, non-fraud) and
  `frozen` (automatic protective pause on a filed-not-yet-confirmed dispute); the
  original `charge.dispute.created → revoked` mapping conflated "filed" with
  "confirmed" and is replaced by a full dispute lifecycle (`frozen` →
  `won`-restores / `lost`-refunds), with `revoked` now reachable only by deliberate
  admin action after a confirmed investigation (§2, §3). **Major** — account-area
  authentication specified: magic link to the Customer's email, no passwords,
  15-minute link TTL, 30-day session; the plaintext key's only reveal surface is now
  that authenticated area, minted lazily on first view rather than shown via a
  checkout-session-keyed page (§3, §5, §10.7). **Major** — per-deployment license
  scoping stated plainly as a licensing *term*, not a technical control — no
  deployment identifier exists by design, so it cannot be enforced mechanically (§2).
  **Major** — public feed gained a per-module `versions` array carrying every
  release's checksum unconditionally, making §4's "independently verifiable
  checksum" claim real instead of circular (§3a, §4). **Major** — §10.4's
  knowledge-base-vs-pipeline question elevated from an ordinary open item to a named
  charter-affecting conflict, with two resolutions stated crisply and explicitly
  left to TJ rather than resolved here. **Minor** — `catalog.md` §4 step 4 patched
  with a one-line supersession note pointing at this spec's §7 (see that file's own
  changelog). **Minor** — key rotation specified as an account-area action mirroring
  `POST /api/v1/assistants/{id}/rotate-token` (§3). **Minor** — §6's
  installed-module inference broadened from "`active` rows only" to "any non-deleted
  row of any status," so an `auto_disabled` module no longer vanishes from Manage →
  Modules at exactly the moment its health needs surfacing. **Minor** — added an
  explicit uniqueness-invariant note (§2) so a future constraint on
  Subscription/License-key rows can't accidentally block re-purchase after a refund
  or revocation. Also folded in: refund/dispute policy and Stripe Tax added as
  explicit pre-revenue gates in §8 (Stripe Tax flagged as a compliance-configuration
  gate, distinct in kind from the counsel-drafted items it's grouped with); "no
  bundles v1" made an explicit non-goal and decision point (§9, §10.8); the
  dogfood-through-marketplace test plan (§7) extended to exercise `refunded` and the
  full `frozen` dispute lifecycle, not just `lapsed`/`revoked`, so HT-82 actually
  proves the state machine this revision introduces.
- **2026-07-19** (HT-79, CodeRabbit PR #87 review — 9 actionables, all applied):
  **Persist a stable payment-object mapping** — Subscription gained
  `stripe_latest_payment_intent_id`; refund/dispute webhooks (which arrive on Stripe
  charge/payment-intent/dispute objects, not Subscription objects) resolve through
  it, since `stripe_customer_id` alone can't disambiguate a customer with multiple
  module subscriptions (§2, §3). **Persist the pre-dispute license state** — License
  key gained `pre_freeze_state`/`stripe_dispute_id`; a `won` dispute now restores the
  *exact* prior state instead of unconditionally `active` (this also caught and fixed
  a leftover inconsistency in the `customer.subscription.updated → active` webhook
  row from the same bug class, missed in the first pass; §2, §3, §7's test plan now
  exercises dispute-from-`lapsed` specifically to prove it). **Webhook idempotency
  corrected** — replay protection is keyed on Stripe `event.id` in a new Webhook
  event log entity, not `stripe_subscription_id` (which the prior draft wrongly
  suggested as an example dedup key — one subscription emits many valid events over
  its life); processing is transactional (§2). **Serialized first-reveal and
  rotation** — both now specified as compare-and-set/row-lock transactions so
  concurrent requests can never return a plaintext that doesn't match what's
  persisted (§3). **CSRF and object-level authorization on rotation** (and reveal,
  and the new download route) — explicit ownership scoping
  (`subscription.customer_id == session.customer_id`, 404 otherwise, matching the
  engine's own indistinguishable-from-nonexistent convention) plus `SameSite=Strict`
  + synchronizer CSRF token, stated once and applied to all three account-area
  actions (§3). **License↔module binding enforced on both download and
  update-check** — a `module_mismatch` 403 gate before any state check, plus
  explicit `frozen`/`refunded`/`revoked` refusal codes on both endpoints where the
  prior draft only pinned codes for download (§3b, §3c). **Account-area download
  route specified** — a separate session-authenticated
  `GET /account/subscriptions/{subscriptionId}/download`, since the server holds
  only `secret_hash` after first reveal and literally cannot reconstruct a Bearer
  token to call its own API on the customer's behalf (§3, §5). **`catalog.md` §4
  step 5 aligned** — it still said marketplace plumbing "stays deferred to its
  charter phase," contradicting both step 4's own supersession note and this spec's
  §1; reworded. **Modules vocabulary fixed** — "§7 plugin-exception counsel
  deadline" corrected to the exact legal phrase "plugin exception," with the
  CHARTER.md-vs-this-doc's own §7 numbering disambiguated in the same pass (§8).
  Also, incidentally: four fenced code blocks (§3a, §3b, §3c, §4) given language
  tags to clear a markdownlint MD040 finding surfaced alongside the flagged one —
  verified by running `markdownlint-cli2` locally with only MD040 enabled (the
  vanilla default ruleset's other findings, e.g. MD013 line-length, do not reflect
  what this repo's CI/CodeRabbit actually enforces and were left alone).
- **2026-07-19** (HT-79, post-merge citation reconciliation — docs-only, no
  substantive change): the HT-79 charter amendment merged as PR #86 (`b528971`), so
  the draft's sequencing note — which flagged the amendment as pushed-but-unmerged
  and asked for a re-check before acceptance — was discharged and replaced with a
  citation basis recording the merged commit. All CHARTER.md citations re-verified
  against the merged §3/§4/§5 text: the launch-day Phase 3 claim (§1), the
  marks-and-marketplace asset list (§1), the amendment's verbatim counsel-items
  sentence (§8), the Phase 3 launch lineup and content-as-code KB description
  (§10.4) all check out as written. **One mis-citation corrected** (§8): the plugin
  exception's counsel deadline was attributed to "CHARTER.md §7," but CHARTER.md §7
  is Governance — the deadline is set in CHARTER.md §3's module boundary, and "§7"
  there names the AGPL-3.0 §7 additional permission. The parenthetical pointing at
  "this spec's §3" was dangling for the same reason (this spec's §3 is Service
  architecture and never mentions the exception); both replaced with a direct quote
  of the merged amendment. **One wording tightening** (§10.4): the KB-plus-AI-modules
  lineup was described as what Phase 3 "currently implies" — the amended text names
  those modules outright, which strengthens rather than weakens the conflict that
  decision point raises. Status deliberately left at **draft for TJ review**;
  accepting the spec remains TJ's call.
