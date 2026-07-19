# Module Catalog & the Open-Core Line

Status: **accepted** (2026-07-18, TJ — HT-66). This is the canonical free-vs-paid line for
Helpthread functionality. CHARTER.md §3/§4 governs the legal/architectural mechanics;
`specs/ui/admin-ia.md` §2 carries the reference-instance observations this catalog resolves.
Where `admin-ia.md` deferred core-vs-module calls to "ticket grooming," this document is
that decision.

**Provenance.** The market inventory below derives from FreeScout's public module listing
(freescout.net/modules — 71 official modules, read 2026-07-18) and the black-box
observations already recorded in `admin-ia.md`. It is priced-demand data: a decade of what
self-hosted helpdesk operators actually pay for. No module source code was observed
(CHARTER provenance rules). FreeScout's third-party community marketplace has not yet been
inventoried; revisit at grooming if a gap appears.

## 1. The line, stated once

**Free core = parity and hygiene. Paid = intelligence, channels, and enterprise.**

- Everything a self-hosted helpdesk operator would call table stakes — including features
  FreeScout paywalls — ships AGPL-free in core. Security hygiene is always free:
  **passkey login (WebAuthn) is core**, deliberately, where the reference ecosystem sells
  2FA. The conventionally accepted auth paywall is enterprise SSO, and that is where ours
  sits (§3.3).
- The charter floor applies verbatim: nothing free today gets paywalled retroactively;
  monetization adds, never subtracts.
- The line is one-way asymmetric: free → paid never happens; paid → free stays possible.
  When a future call is genuinely uncertain, born-proprietary is the reversible choice.
- **Born-proprietary discipline**: a paid module lives in a closed repo from its first
  commit and touches core only through public extension points. Nothing intended for the
  paid catalog is ever prototyped inside the AGPL tree.
- **Zero privileged first-party access**: any hook a paid module needs ships in the public
  plugin API first (charter module boundary).
- **Preferred module shape is out-of-process** — typed events/webhooks plus the public
  API — which needs no §7 exception at all. The in-process build-time plugin API is built
  only when a module genuinely needs UI presence, and not before a real module hits that
  wall.
- Positioning corollary, used deliberately in marketing: tags, the public API + webhooks,
  the knowledge base, dark mode, keyboard shortcuts, and passkey-class security are paid
  modules in the FreeScout ecosystem and free in Helpthread core.

## 2. Free core

### 2.1 Already shipped

Tags (HT-29) · internal notes (HT-28) · single-Agent assignee, now roster-wide (HT-31,
HT-54) · soft delete (HT-30) · four-state status incl. spam and pending (HT-26) · folder
semantics (open/closed/spam listing) · public API (charter-core, with the MCP server to
follow it) · per-Agent identity, login, team management, mailbox-access grants (HT-54) ·
theme/appearance preference (HT-54) · keyboard-shortcuts surface (admin-ia deviation
list) · open-tracking privacy default OFF (HT-32).

### 2.2 Committed core, built incrementally (priority at grooming)

Saved replies · custom folders · send & close · satisfaction ratings · basic reports ·
basic workflows/automations · global search · basic custom fields (conversations and
customers) · custom mailbox signatures · office hours / auto-reply windows · out of
office · followers · @mentions in notes · snooze-until-a-date (extends `pending`) ·
sender time zone · noreply-address warnings and external-image blocking · CSV export ·
GDPR-grade hard delete and export (extends soft delete) · extended editor · dark mode
(full surface) · **passkey login** (WebAuthn on the HT-54 session infrastructure) ·
knowledge base (charter-core) · notifications matrix (email/browser, per admin-ia).

The chat channel is core engine work when it arrives (charter §4: a second channel over
the same engine), distinct from any paid trappings layered on it.

### 2.3 Not ported — obsolete by architecture

Move/Remove IMAP Message (no IMAP polling) · Faster Search via Meilisearch (search is
Postgres-native) · Auto Login from notification emails · Custom Homepage · Ticket Number
in subject (threading never depends on it; display numbers shipped in HT-27) · Mailbox
Icons · Twitter/X DM integration (API effectively dead).

## 3. Paid modules — three clusters

Each entry is born proprietary (closed repo), integrates out-of-process unless noted, and
ships through the marketplace when that phase opens (charter §5). Order within clusters is
rough priority.

### 3.1 Intelligence (the differentiator; charter-named leading candidates)

- **Draft-reply assistant** — the first module (§4). Subscribes to inbound events, calls
  the operator-configured model with the operator's keys, posts a draft as an assistant
  actor; an Agent approves in core UI. Pure out-of-process.
- **Auto-triage** — tagging, routing, priority; same event-driven shape.
- **KB-grounded auto-answers** — depends on the KB and widget; later.
- AI subsumes rather than ports several reference modules: ticket translation,
  learning spam filter, customer data enrichment, satisfaction/sentiment analysis become
  facets of assistant modules, not standalone products.

### 3.2 Channels & integrations (the reference ecosystem's biggest paid cluster)

WhatsApp · Telegram (integration + notifications) · SMS (Twilio-class) · Facebook
Messenger · Slack notifications · Jira · commerce order-context panes
(Shopify/WooCommerce-class) · mobile push (paired with any future mobile surface).
All are out-of-process by nature: a channel adapter feeds the same channel-agnostic
conversation engine; an integration consumes events and the public API.

### 3.3 Enterprise & ops

- **Enterprise Auth** — SAML/OIDC SSO, SCIM/directory sync, 2FA *policy enforcement*,
  login audit. (Passkeys themselves are core, per §1.)
- **PGP / S-MIME** signing and encryption.
- **Wallboards & advanced analytics** (basic reports stay core).
- **Kanban view** · **time tracking** · **CRM-grade customer management** (basic
  customer records and fields stay core).
- **White-labeling** — see §3.4.
- *Possible, deliberately undecided*: an advanced-workflows module above core's basic
  automations. Deciding it is deferred; the core/paid seam inside "workflows" gets drawn
  when basic automations are specced, not retroactively.

### 3.4 The white-label pattern

The embeddable support widget and end-user portal ship **free with Helpthread branding**;
**branding removal is paid**. Every free install is distribution; the pattern is additive
monetization and thus charter-clean (Help Scout's Beacon and the reference ecosystem both
validate it).

## 4. Build sequence

1. **HT-67 — plugin substrate v1 spec**: typed event vocabulary, webhook delivery
   (registration, signed payloads, retries), assistant-actor API (draft-post,
   list-pending, approve/send with audit). Doubles as counsel raw material for the
   §7-exception text (HT-5) — the exception gets drafted against a real API, before the
   first external contribution.
2. **Core: event emission + webhook delivery** (AGPL — the substrate is always free).
3. **Core: assistant-actor API + draft-review inbox UI** (design-project-first per the
   UI-fidelity rule; the schema has been AI-ready since day one).
4. **First module: draft-reply assistant** in a closed repo, dogfooded on the live
   Resonant IQ desk. Dogfood installs are a private npm package in the Vercel build —
   no marketplace plumbing required to use our own modules.
5. Marketplace plumbing (license keys, registry, update channel) stays deferred to its
   charter phase.

## 5. Marketplace phase — additive by contract

The standing rule (TJ, 2026-07-18): **everything built for dogfood must be sellable
without rebuild — the marketplace only ever adds.** What that means concretely, recorded
now so the marketplace design inherits it:

- **Runtime credentials ≠ licenses.** Modules authenticate with security credentials
  (assistant tokens, webhook signing secrets — substrate v1, free core, every module
  uses them). A license key is a *distribution* credential: it authenticates registry
  download and the update channel. No runtime license check exists in the substrate,
  ever — a runtime phone-home inside a self-hosted product is both hostile to the
  own-your-data posture and trivially strippable; enforcement in this market is
  distribution + updates + support. Revoking a license stops updates; it never breaks a
  running helpdesk.
- **Dogfooding needs no licensing** — we are the vendor; our installs are direct
  deployments of product-shaped module repos (credentials/env config only, no
  first-party special-casing). The dogfooded artifact IS the marketplace artifact.
- **Install bundles come later, attribution starts now**: assistants and webhook
  endpoints carry a `module` slug from substrate v1, so marketplace-phase
  install/uninstall/health tooling references existing rows rather than retrofitting
  identity.
- Modules **we host** as convenience services are ordinary SaaS billing — no special
  machinery in the product.

## 6. Changelog

- **2026-07-18**: initial version (HT-66). Free/paid line decided by TJ from the
  FreeScout official-catalog inventory + charter constraints; passkeys-core,
  Enterprise-Auth-paid, white-label pattern, and the three paid clusters locked.
