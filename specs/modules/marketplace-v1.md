# Helpthread Marketplace v1

Status: **draft for TJ review** (HT-79; HT-81 in-product directory and HT-82
dogfood-through-marketplace are child tickets scoped by this spec). Governed by
CHARTER.md §3/§4/§5 (**2026-07-19 HT-79 amendment**: the marketplace is a launch-day
component of Phase 3, built now and proven first as the project's own dogfood install
path — not deferred to "once demand justifies it") and `specs/modules/catalog.md` §5,
the additive contract this spec is built to satisfy exactly.

**Sequencing note.** The HT-79 charter amendment (`docs/ht-79-marketplace-timing`,
commit `d8bd2d4`) is pushed but not yet merged to `main` as of this draft. This spec
cites the amended §3/§4/§5 text throughout; if that PR's wording changes before merge,
re-check the citations below against the merged text before this spec is accepted.

## 1. Purpose & scope

This spec pins the Helpthread Marketplace: the commerce plumbing — license keys,
subscriptions, module distribution, an update feed — around the module substrate
(`specs/modules/substrate-v1.md`), which stays AGPL-free and unchanged. It covers
entities, service architecture, the artifact pipeline, install UX v1, the in-product
directory contract (HT-81), the dogfood-through-marketplace plan (HT-82), counsel
dependencies, non-goals, and decision points for TJ. It does not re-spec the
substrate's events/webhooks/assistant surfaces (already shipped, HT-67/69/70) or the
module catalog's free/paid line (`catalog.md`, already decided).

**The governing constraint, stated once because every design choice below derives
from it** (`catalog.md` §5, restated verbatim in spirit):

> A license key is a *distribution* credential. It authenticates registry download
> and the update feed — nothing else. No runtime license check exists in the
> substrate, ever, and none is added by this spec. Revoking a license stops updates;
> it never reaches into a running helpdesk, and it never breaks a running module.
> The dogfooded artifact IS the marketplace artifact.

Concretely, this means: no code this spec describes runs *inside* a deployed
Helpthread engine or a deployed module. Every entity, table, and endpoint below lives
in one place only — the separate marketplace service (§3) — and a deployed module's
own runtime configuration never contains a license key. This is independently
verifiable today: `module-draft-assistant`'s full environment-variable table
(`HELPDESK_API_URL`, `HELPDESK_ASSISTANT_TOKEN`, `WEBHOOK_SIGNING_SECRET`,
`ANTHROPIC_API_KEY`, `DRAFT_MODEL`, `DRAFT_SYSTEM_PROMPT_APPEND`) contains nothing
resembling a license key or a marketplace URL — the reference module artifact already
satisfies the constraint this spec is designed not to violate.

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
| **Release** | `id`, `module_id`, `semver`, `tarball_storage_path`, `checksum_sha256`, `changelog_md`, `published_at` | One row per published version. Immutable once published — a bad release ships a new version, never edits an old one. |
| **Customer** | `id`, `stripe_customer_id`, `email`, `created_at` | The marketplace's own account, 1:1 with a Stripe Customer. Unrelated to the engine's `agents`/`assistants` tables — a store customer and a Helpthread Agent are different systems' users, even when the same human. |
| **Subscription** | `id`, `customer_id`, `module_id`, `stripe_subscription_id`, `interval` (`year`, per TJ's annual decision), `stripe_status` (mirrors Stripe's own status string), `current_period_end`, `created_at` | One subscription per (customer, module, deployment) — see License key below for why "per deployment" lands here, not as a separate column. |
| **License key** | `id`, `subscription_id` (1:1), `module_id`, `key` (`ht_lic_<id>_<secret>`, house token format — see `substrate-v1.md` §3's `ht_asst_<id>_<secret>` and the engine's own `HELPTHREAD_API_TOKEN`/webhook-secret precedent), `state` (`active`\|`lapsed`\|`revoked`), `entitled_up_to_version` (semver, meaningful only while lapsed), `created_at`, `rotated_at` | **Scoped to one helpdesk deployment**, per TJ's "annual subscription per helpdesk deployment" decision: an operator running two helpdeses buys two subscriptions and holds two keys, one per deployment, even for the same module. A subscription and its license key are 1:1 — the subscription is the billing object, the key is what the operator's tooling actually holds. |
| **Download grant** | `id`, `license_key_id`, `release_id`, `issued_at`, `expires_at`, `redeemed_at`, `requester_ip` | Minted per download/update-check call (§3's download endpoint) as a short-lived, single-purpose authorization for one Supabase Storage object — never a standing credential. Exists so the download endpoint has an audit trail distinct from the long-lived license key itself, and so a leaked signed URL has a bounded blast radius (default expiry: 5 minutes). |

### License key states — pinned, with justification

| State | Meaning | Downloads | Update-check |
|---|---|---|---|
| `active` | Subscription in good standing | Any published release, unrestricted | Reports true latest, entitled |
| `lapsed` | Payment missed or subscription non-renewed — **not** a fraud finding | Releases published **up to `entitled_up_to_version`** remain downloadable indefinitely; a release newer than that requires resubscribing | Reports `entitledVersion` (frozen at lapse) **and** `latestAvailableVersion` (informational, so the operator sees what they're missing) |
| `revoked` | Fraud only — chargeback, stolen payment method, confirmed ToS violation | Hard-refused, including releases previously downloaded fine | Hard-refused |

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
- `revoked` stays the hard stop, reserved for fraud exactly as the task specifies,
  which keeps a real enforcement tool without making ordinary non-renewal punitive.

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
- **Account area** (customer-authenticated) — purchase history; per-subscription
  license key (shown once at issuance, mirroring the substrate's own `ht_asst_`/
  webhook-secret show-once pattern — a lost key is rotated, never re-revealed);
  download links; a link into the Stripe Customer Portal for self-serve
  cancel/payment-method updates.
- **Stripe integration** — Checkout Sessions (`mode: subscription`, one annual Price
  per module) for purchase; Customer Portal for self-serve subscription management;
  a webhook endpoint (Stripe-signature-verified) driving all state transitions below.

**Stripe webhook → state mapping:**

| Stripe event | Effect |
|---|---|
| `checkout.session.completed` | Create/find Customer; create Subscription; mint License key (`active`), shown once via a one-time reveal page keyed to the checkout session |
| `customer.subscription.updated` → `active` | License → `active` |
| `customer.subscription.updated` → `past_due`/`unpaid`, or `customer.subscription.deleted` (ordinary cancellation) | License → `lapsed`, snapshot `entitled_up_to_version` = that module's latest published release at the moment of lapse |
| `charge.dispute.created`, or manual admin action on confirmed fraud | License → `revoked` (terminal — a legitimate re-purchase creates a new Subscription and License key, never an un-revoke) |

**APIs** (all under the marketplace's own base URL, distinct from any Helpthread
deployment's `/api/v1`):

**a. Public metadata feed — unauthenticated.**

```
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
      "docsUrl": "https://helpthread.dev/docs/modules/draft-assistant"
    }
  ]
}
```

No auth, no PII, no per-deployment data of any kind — this is marketing/catalog data
the in-product directory consumes (§6). Cacheable aggressively (CDN + long
`Cache-Control`); safe to serve from a public CDN edge.

**b. Authenticated download endpoint.**

```
POST /api/v1/download
Authorization: Bearer ht_lic_<id>_<secret>
{ "module": "draft-assistant", "version": "1.2.0" }   // version optional
```

Behavior: `revoked` → `403`. `active` → any published release, `version` omitted
defaults to latest. `lapsed` → `version` omitted defaults to `entitled_up_to_version`;
an explicitly-requested `version` newer than that → `402 Payment Required` with a
message pointing at the resubscribe flow (an honest, explicit refusal rather than a
silent downgrade to an older tarball than requested). On success: mint a Download
grant, respond with a short-lived signed Supabase Storage URL plus the checksum:

```json
{ "version": "1.2.0", "downloadUrl": "https://...", "expiresAt": "...", "checksumSha256": "..." }
```

**c. Update-check endpoint** — deliberately not telemetry.

```
POST /api/v1/update-check
Authorization: Bearer ht_lic_<id>_<secret>
{ "module": "draft-assistant" }
```

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

## 4. Artifact pipeline

```
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

**Signing.** Checksum (sha256) published in both the public feed and every download
response, at minimum — a download can already be verified against an
independently-obtained, API-reported checksum without any additional machinery.
Sigstore/minisign detached signing is **optional-later**, not v1: v1's threat model
(tampering in transit, a compromised storage object) is covered by HTTPS + a checksum
sourced from an authenticated API call; a detached signature adds defense against a
compromised checksum-serving API itself, which matters more once third-party modules
or an untrusted CDN enter the picture — both explicitly out of scope v1 (§9). Revisit
when either changes.

## 5. Install UX v1

Extends `docs/modules/README.md` and mirrors `module-draft-assistant`'s own README
exactly (the reference artifact already documents this flow one system early):

1. **Buy** — Stripe Checkout on the store site (annual). Account area shows the
   license key once.
2. **Download** — account area "Download" button (browser-session-authenticated;
   under the hood, the same Download grant mechanism as the API path in §3b) fetches
   the tarball.
3. **Deploy to Vercel** — extract the tarball, push to the operator's own git
   provider (or import directly), `vercel` CLI or dashboard import — unchanged from
   `module-draft-assistant`'s existing README.
4. **Configure env vars** — module-specific config in Vercel project settings (e.g.
   `HELPDESK_API_URL`, `HELPDESK_ASSISTANT_TOKEN`, `WEBHOOK_SIGNING_SECRET`,
   `ANTHROPIC_API_KEY`). **No license key appears here** — licensing stayed at the
   download step, never entering the module's own runtime config (§1).
5. **Provision credentials via the Helpthread admin API** — create an Assistant,
   register the module's webhook endpoint (`docs/modules/assistants-and-drafts.md`,
   `docs/modules/webhooks.md`) — unchanged by the marketplace; the marketplace only
   got the operator the tarball, not the wiring.

**Friction, named honestly**: this is five manual steps, no one-click deploy, no
automated env-var injection, no automated Assistant/webhook provisioning. **Additive
path to one-click, later** (each layers onto these same v1 primitives, none requires
rebuilding them): a Vercel "Deploy" button with pre-filled repo + env-var prompts
collapses steps 3–4; a setup wizard driving the admin API collapses step 5; a
license-key-parametrized deploy-button flow could fetch the tarball at Vercel build
time instead of a manual extract-and-push, collapsing 2–3. None of this is built v1.

## 6. In-product directory contract (HT-81)

**What Manage → Modules reads.** The engine (or the web app serving it) fetches and
caches the public feed (§3a) server-side — proxied, so the operator's browser never
makes a cross-origin call to the marketplace and the feed is never fetched with any
credential. No license key ever reaches the running helpdesk through this path,
consistent with §1.

**How "installed" is known.** There is no `module_installs` table yet — one is
explicitly deferred (`substrate-v1.md` §1's non-goals, `catalog.md` §5's forward
note). v1 infers installed-ness purely from existing local attribution: an `active`
row in `assistants` or `webhook_endpoints` carrying a given `module` slug means that
module is (at least partially) installed. The directory lists each distinct `module`
slug seen locally, matches it against the public feed by slug for display name/
summary/changelog, and shows health from data the engine already has:
`assistants.status`, and `webhook_endpoints.status`/`consecutiveFailures` (surfaced
today at `/api/v1/internal/health`, HT-44). This is an honest inference, not a
tracked install record — a module that never registered a webhook or never got an
Assistant (unlikely for any real module, given §1's "typically uses all three")
simply wouldn't appear.

**"Update available" — scoped down for v1, flagged explicitly.** The task framing
assumes a version-diff badge (installed version vs. latest feed version); that is
**not buildable in v1** and the spec resolves it honestly rather than pretending
otherwise: **nothing in the shipped substrate gives the engine, or the browser, any
way to learn which version of a module is actually deployed.** A module's tarball
carries no version marker the engine ever sees — the module runs as an entirely
separate Vercel project, decoupled from the engine's own DB/schema, and reports
nothing about itself back to the helpdesk. v1's answer: **Manage → Modules surfaces
the feed's `latestVersion` and `changelogUrl` next to each inferred-installed module,
informational only** — the operator does the "am I behind" comparison themselves,
the same way they would reading any changelog. No update/current badge is computed.
The additive path to a real diff (v2+): a module-authoring convention where a module
self-reports its own version at a well-known path off the URL already on file in
`webhook_endpoints.url` — that convention does not exist today and is not proposed by
this spec; it is named here only so a future ticket has the honest starting point.
This is called out again as decision point §10.5.

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

**Test plan, Stripe test mode:**

1. Create a test-mode Stripe Product + annual Price for `draft-assistant`.
2. Full flow as a real customer would: store checkout (test card) → webhook creates
   Customer/Subscription/License key → account area one-time key reveal → download
   tarball → deploy to a fresh Vercel project (not the existing npm-package-based
   dogfood instance — a genuinely separate deployment, to prove the marketplace path
   independent of any leftover shortcut) → provision Assistant + webhook against the
   live Resonant IQ desk exactly per §5.
3. **Stripe test clock**, advance time to exercise:
   - Successful renewal → license stays `active`.
   - A failed charge → `past_due` → license flips `lapsed`; verify the update-check
     and download endpoints correctly cap at `entitled_up_to_version`; verify **the
     running helpdesk and the running module are completely unaffected** — no outage,
     no runtime check trips anywhere in the deployed module. This is the literal proof
     of catalog §5's central promise, exercised for real rather than argued abstractly.
   - Resubscribe after lapse → license flips back to `active`, full latest access
     restored, no back-charge (§2).
4. Simulate a `revoked` state via manual admin action (standing in for a confirmed
   fraud finding) → verify both download and update-check hard-fail immediately.
5. **Exit criteria**: all of the above green in test mode, using Resonant IQ's own
   store account as customer #1, before Stripe is flipped to live mode for public
   launch (Phase 3).

## 8. Counsel dependencies

Per the HT-79 charter amendment's own text: *"New counsel items before the
marketplace takes real money: the commercial module license text and terms of
sale."* This spec adds the store's privacy policy to that same gate (Stripe checkout
collects real customer PII the moment a real card is charged).

| Item | Gate | Not gating |
|---|---|---|
| Commercial module license text (replaces the current placeholder) | Before Stripe flips to live mode / before the marketplace takes real money | Does **not** gate HT-82's test-mode dogfood — Resonant IQ as its own test-mode customer needs no finished license text, only a placeholder |
| Terms of sale | Same gate | Same — pre-revenue, not pre-dogfood |
| Privacy policy for the store | Same gate (real customer PII starts flowing at first live charge) | Same |

The §7 plugin-exception counsel deadline (CHARTER.md §3, unchanged by the HT-79
amendment) stays separate and earlier: before the first external code contribution —
unaffected by this spec, since every v1 marketplace module is out-of-process and needs
no exception (charter amendment text, quoted in full in CHARTER.md).

## 9. Non-goals v1

- **Third-party sellers.** Every Module row (§2) is first-party; no seller onboarding,
  no revenue split, no third-party publish credentials.
- **Reviews / ratings.** Store pages show official copy only.
- **In-product purchase.** No buy button inside the helpdesk itself — purchasing
  always happens on the separate store site, never inside a running Helpthread
  deployment (keeps commercial surface fully decoupled from the AGPL core's UI).
- **npm distribution.** v1 ships tarball + Vercel deploy only, per TJ's decision;
  publishing modules as installable npm packages is additive, later.
- **Usage metering.** No conversation counts, no per-seat metering, no usage-based
  billing — flat annual per-deployment (§2), matching the update-check endpoint's
  explicit "not telemetry" posture (§3c).
- **Automated in-place update / a build-time module API.** `admin-ia.md`'s Manage →
  Modules description includes "in-place update with visible ops log" as an aspirational
  future surface; v1 delivers none of that (see the conflict called out below) — updates
  are the manual redeploy flow in §5, full stop.
- **A `module_installs` table**, a version-diff "update available" badge, and any
  module self-reporting convention (§6) — all explicitly deferred, not solved by this
  spec.

**Conflict found and resolved here, named per house style**: `specs/ui/admin-ia.md`
§2 describes the target "Manage → Modules" surface as "Installed (activate/deactivate,
license key, in-place update with visible ops log) + Directory (browse/install)." That
description predates both the module substrate (which has no in-process module API,
`substrate-v1.md` §1) and this spec's v1 install flow (§5: manual tarball download,
manual Vercel redeploy). **"In-place update with visible ops log" is not deliverable
in v1** — there is no build-time module API for the engine to hook into, and no
mechanism by which the engine could trigger or observe a *separate Vercel project's*
redeploy. v1's actual Manage → Modules is: an inferred Installed list (§6) with
health, and a Directory that links out to the store site rather than installing
in-place. `admin-ia.md` should be read as the longer-term aspiration this spec does
not yet fulfill, not as a same-phase requirement; flagging this discrepancy is this
spec's honest deliverable on that front, not a silent scope-down.

## 10. Decision points for TJ

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
4. **Launch module lineup.** `draft-assistant` is the only module that exists today.
   CHARTER.md's Phase 3 text names "the knowledge base and AI-powered modules" as the
   catalog that leads launch — but the knowledge base ships as **content-as-code**
   (`catalog.md` §3.4, CHARTER.md §4: docs in git, static build, build-time search
   index), which does not obviously fit this spec's tarball-plus-Vercel-deploy shape
   built for a running service like `draft-assistant`. **This spec does not resolve
   how (or whether) the knowledge base sells through this same marketplace pipeline —
   flagged here rather than silently assumed.** Needs a decision before the KB module
   itself is specced, not before this spec ships.
5. **§6's "update available" simplification** (feed's latest version + changelog
   link only, no version-diff badge) — confirm this is an acceptable v1 scope-down
   given the substrate has no module self-reporting convention, rather than treating
   it as a gap to close before HT-81 ships.
6. **Reactivation-after-lapse restores full latest access with no back-charge** (§2)
   — confirm acceptable; the alternative (pro-rated back-charge for skipped releases)
   was considered and rejected for v1 complexity reasons, not on principle.

## 11. Changelog

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
