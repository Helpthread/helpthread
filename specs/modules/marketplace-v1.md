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
| **Subscription** | `id`, `customer_id`, `module_id`, `stripe_subscription_id`, `stripe_latest_payment_intent_id` (nullable; updated on each successful `invoice.paid` for this subscription), `interval` (`year`, per TJ's annual decision), `stripe_status` (mirrors Stripe's own status string), `current_period_end`, `created_at` | One subscription per (customer, module, deployment) — see License key below for why "per deployment" lands here, not as a separate column. **`stripe_latest_payment_intent_id` is the join key refund/dispute webhooks resolve against**: those events arrive on Stripe charge/payment-intent/dispute objects, not Subscription objects, and `stripe_customer_id` alone can't disambiguate which subscription a given charge belongs to when one customer holds multiple module subscriptions — see §3's webhook table. |
| **License key** | `id`, `subscription_id` (1:1), `module_id`, `secret_hash` (SHA-256 digest of the token's secret half — the plaintext `ht_lic_<id>_<secret>` is never persisted), `state` (`active`\|`lapsed`\|`frozen`\|`refunded`\|`revoked`), `entitled_up_to_version` (semver, meaningful only while `lapsed`), `pre_freeze_state` and `stripe_dispute_id` (both nullable; set together on entering `frozen`, cleared together on leaving it), `created_at`, `rotated_at`, `revealed_at` (null until the customer has viewed the plaintext once, §3) | **Mint/verify mechanism inherited verbatim from Assistant tokens** (`src/auth/assistant-token.ts`, `src/api/assistants.ts`, `src/store/assistants.ts`) — the id is generated first, `ht_lic_<id>_<secret>` minted against it, and only `secret_hash` is ever stored; verification looks the row up by the id embedded in the presented token, then does a constant-time digest compare, exactly as `getForAuth`'s single-snapshot read does for Assistants. The plaintext is returned to the caller exactly once — at first reveal or at rotation (§3, §9) — never logged, never persisted, no reveal endpoint. **"Scoped to one helpdesk deployment" is a licensing TERM, not a technical control.** Per TJ's "annual subscription per helpdesk deployment" decision, an operator running two helpdesks is expected to buy two subscriptions and hold two keys — but nothing in this schema records which deployment a key is actually used against, and nothing can: the no-phone-home posture (§1) means the marketplace never learns a deployment's identity at all, so per-deployment scoping is enforced by the terms of sale (§8) an operator agrees to, never by a technical check. A subscription and its license key stay 1:1 — the subscription is the billing object, the key is what the operator's tooling holds. **Pre-freeze state is preserved, not assumed**: entering `frozen` snapshots the license's current `state` into `pre_freeze_state` and the triggering dispute's Stripe id into `stripe_dispute_id`; a `won` outcome restores exactly that saved state — a license that was `lapsed` before the dispute comes back `lapsed`, never promoted to `active` — see §2's states table and §3. |
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
| `refunded` | Entitlement ended with **no fraud finding**: a voluntary refund, or a dispute the merchant lost (the chargeback stands, funds are gone either way) — terminal for entitlement | Hard-refused | Hard-refused |
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

- **Refund** (`charge.refunded`/`refund.created`, or a *lost* dispute) → `refunded`.
  Terminal for entitlement, explicitly not a fraud label — the buy→download→refund
  path must not let the customer keep both the money and the bits, but it also must
  not brand an ordinary refund request as fraud. Running software already deployed is
  untouched either way, per §1's governing constraint.
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
| `charge.refunded` / `refund.created` | Resolve the Subscription via `stripe_latest_payment_intent_id` (§2 — a customer may hold multiple module subscriptions, so `customer_id` alone can't disambiguate); License → `refunded` (terminal, not a fraud finding) |
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
| `active` | Any published release, unrestricted; `version` omitted defaults to latest |
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

## 5. Install UX v1

Extends `docs/modules/README.md` and mirrors `module-draft-assistant`'s own README
exactly (the reference artifact already documents this flow one system early):

1. **Buy** — Stripe Checkout on the store site (annual). The marketplace emails a
   magic link into the account area (§3's Authentication); the operator authenticates
   there and reveals the license key exactly once (§3 — never anywhere before that).
2. **Download** — account area "Download" button hits the session-authenticated
   `GET /account/subscriptions/{subscriptionId}/download` route (§3) — a separate
   path from the Bearer-token API in §3b that shares its entitlement logic but never
   touches the plaintext license key, which the browser never holds. Fetches the
   tarball.
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
4. **Refund**: trigger a test-mode refund (`charge.refunded`) → verify license flips
   to `refunded`, downloads/update-check hard-refuse immediately, and — again — the
   already-deployed module keeps running untouched.
5. **Dispute lifecycle**, via Stripe test mode's dispute-simulation test cards —
   run this twice, from two different starting states, to actually prove
   `pre_freeze_state` fidelity (§2) rather than the one path that happens to look
   right by coincidence:
   - **From `active`**: `charge.dispute.created` → verify license flips to `frozen`
     automatically, `pre_freeze_state = 'active'`, downloads/update-check fully
     paused. Resolve `won` → verify the license restores to `active`.
   - **From `lapsed`**: force the subscription into `past_due` first, confirm the
     license is `lapsed`, *then* trigger `charge.dispute.created` → verify
     `pre_freeze_state = 'lapsed'`, not `'active'`. Resolve `won` → verify the
     license restores to `lapsed`, **not** `active` — this is the exact bug this
     revision fixed; the test must fail loudly if it regresses.
   - Repeat either starting state and resolve `lost` → verify the license flips to
     `refunded` regardless of `pre_freeze_state`, and never to `revoked` — confirming
     a filed-then-lost dispute is never treated as a fraud finding.
6. **Revoke**: simulate a `revoked` state via *manual* admin action only (standing in
   for a confirmed-fraud investigation, never triggered by the dispute flow above) →
   verify both download and update-check hard-fail immediately.
7. **Exit criteria**: all of the above — active, lapsed, frozen, refunded, and
   revoked, plus every transition between them exercised at least once — green in
   test mode, using Resonant IQ's own store account as customer #1, before Stripe is
   flipped to live mode for public launch (Phase 3).

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
| Terms of sale — including the refund policy (§2's `refunded` state) and the dispute-handling policy (§2's `frozen` state): this spec pins the entitlement *mechanics*, but the customer-facing policy language itself is counsel's call | Counsel-drafted | Same gate | Same — pre-revenue, not pre-dogfood |
| Privacy policy for the store | Counsel-drafted | Same gate (real customer PII starts flowing at first live charge) | Same |
| **Stripe Tax enabled** (automated EU VAT / US sales-tax calculation and remittance on Checkout Sessions) | Compliance/finance configuration, not counsel-drafted | Same gate — charging real customers across jurisdictions without correct tax handling is its own launch blocker | Not pre-dogfood — Stripe test mode carries no real tax obligation. Which jurisdictions to register in first is decision point §10.9 |

CHARTER.md §7's plugin exception counsel deadline (referenced above in this spec's
§3, unchanged by the HT-79 amendment) stays separate and earlier: before the first
external code contribution — unaffected by this spec, since every v1 marketplace
Module is out-of-process and needs no exception (charter amendment text, quoted in
full in CHARTER.md).

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
- **Bundle / multi-module pricing.** Every Subscription and License key is scoped to
  exactly one module (§2); there is no "all-modules suite" Price v1. See decision
  point §10.8 for the schema consequence if this is added later — it isn't a free
  addition, since today's 1:1 subscription↔license-key design would need to become
  one-subscription-to-many-license-keys or similar.
- **Automated in-place update / a build-time module API.** `admin-ia.md`'s Manage →
  Modules description includes "in-place update with visible ops log" as an aspirational
  future surface; v1 delivers none of that (see the conflict called out below) — updates
  are the manual redeploy flow in §5, full stop.
- **A `module_installs` table**, a version-diff "update available" badge, and any
  module self-reporting convention (§6) — all explicitly deferred, not solved by this
  spec.

**Conflict found and resolved here, named per house style**: `specs/ui/admin-ia.md`
§2 describes the target "Manage → Modules" surface as "Installed (activate/deactivate,
license-key entry, in-place update with a visible ops log) + Directory (browse/install)." That
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
     draft-assistant-led**, not the KB-plus-AI-modules lineup CHARTER.md's Phase 3
     text currently implies — a real narrowing of that text, not a wording nuance.
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
5. **§6's "update available" simplification** (feed's latest version + changelog
   link only, no version-diff badge) — confirm this is an acceptable v1 scope-down
   given the substrate has no module self-reporting convention, rather than treating
   it as a gap to close before HT-81 ships.
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
