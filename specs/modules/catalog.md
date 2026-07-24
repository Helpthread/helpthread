# Module Catalog & the Open-Core Line

Status: **accepted** (2026-07-18, TJ). This is the canonical free-vs-paid line for
Helpthread functionality. docs/history/CHARTER-v1.md §3/§4 governs the legal/architectural mechanics;
`specs/ui/admin-ia.md` §2 carries the reference-instance observations this catalog resolves.
Where `admin-ia.md` deferred core-vs-module calls, this document records the decision.

**Provenance.** The market inventory below draws on public module listings and the
black-box observations already recorded in `admin-ia.md`. Those sources were used as
market research, not as product definitions. No module source code was observed
(CHARTER provenance rules).

## 1. The line, stated once

**Free core = a capable, secure support operation. Paid = AI and automation, channels, enterprise, and
self-service surfaces (§3.4).**

- Everything needed to run a capable, secure support operation ships in the AGPL core.
  Security hygiene is always free: **passkey login (WebAuthn) is core**. Enterprise
  identity administration belongs in the paid Enterprise Auth module (§3.3).
- The charter floor applies verbatim: nothing free today gets paywalled retroactively;
  monetization adds, never subtracts.
- The line is one-way asymmetric: free → paid never happens; paid → free stays possible.
  When a future call is genuinely uncertain, born-proprietary is the reversible choice.
- **Born-proprietary discipline**: a paid module lives in a closed repo from its first
  commit and touches core only through public extension points. Nothing intended for the
  paid catalog is ever prototyped inside the AGPL tree.
- **Zero privileged first-party access**: any hook a paid module needs ships in the public
  module API first (charter module boundary).
- **Preferred module shape is out-of-process** — typed events/webhooks plus the public
  API — which needs no §7 exception at all. The in-process build-time module API is built
  only when a module genuinely needs UI presence, and not before a real module hits that
  wall.
- Positioning corollary: tags, the public API and webhooks, dark mode, keyboard
  shortcuts, and passkey-class security belong in Helpthread core because they make the
  foundation useful, accessible, and secure.

## 2. Free core

### 2.1 Already shipped

Tags · internal notes · roster-wide Agent assignment · soft delete · four-state status
including spam and pending · folder
semantics (open/closed/spam listing) · public API (charter-core, with the MCP server to
follow it) · per-Agent identity, login, team management, mailbox-access grants  ·
theme/appearance preference  · keyboard-shortcuts surface (admin-ia deviation
list) · open-tracking privacy default OFF.

### 2.2 Committed core, built incrementally (priority at grooming)

Saved replies · custom folders · send & close · satisfaction ratings · basic reports ·
basic workflows/automations · global search · basic custom fields (conversations and
customers) · custom mailbox signatures · office hours / auto-reply windows · out of
office · followers · @mentions in notes · sticky notes on conversations ·
snooze-until-a-date (extends `pending`) · sender time zone · noreply-address warnings
and external-image blocking · extra security (reCAPTCHA, IP allowlisting) · CSV export ·
GDPR-grade hard delete and export (extends soft delete) · extended editor · inline
embedded images · extended attachments (richer file management/search) · dark mode
(full surface) · **passkey login** and baseline **OAuth/social login** (WebAuthn plus
alt-provider login on the core session infrastructure, using the same hygiene logic) · custom
agent profile fields · global cross-mailbox inbox view · sent-folder tracking ·
notifications matrix (email/browser, per admin-ia).

The chat channel is core engine work when it arrives (architecture guide: a second channel
over the same engine), distinct from optional paid capabilities layered on it. It ships
free by the same logic as passkeys and tags.

### 2.3 Not ported — obsolete by architecture

Move/Remove IMAP Message (no server-side folder manipulation; note the "no IMAP
polling" rationale this once carried is void now that scheduled fetch is
permitted, so if IMAP intake ships this entry needs re-deciding on its own merits) ·
Faster Search via Meilisearch (search is
Postgres-native) · Auto Login from notification emails · Custom Homepage · Ticket Number
in subject (threading never depends on it; display numbers shipped in) · Mailbox
Icons · Twitter/X DM integration (API effectively dead).

## 3. Paid modules — four clusters

Each entry is born proprietary (closed repo), integrates out-of-process unless noted, and
ships through the marketplace when that phase opens (STATUS.md). Order within clusters is
rough priority.

### 3.1 AI & automation

- **Draft-reply assistant** — the first module (§4). Subscribes to inbound events, calls
  the operator-configured model with the operator's keys, posts a draft as an assistant
  actor; an Agent approves in core UI. Pure out-of-process.
- **Auto-triage** — tagging, routing, priority; same event-driven shape.
- **KB-grounded auto-answers** — depends on the KB and widget; later.
- **Conversation QA & coaching**  — rubric scoring of the team's own replies:
  qualitative criteria judged by a model, deterministic threshold/SLA criteria scored
  without one, and customer-feedback criteria normalized alongside them; plus a human
  review-and-correct queue and evidence-grounded coaching. Out-of-process: subscribes to
  `conversation.reply_sent`, reads the thread through the assistant API, posts results
  back as internal notes, and hosts its own review UI on the design pack.
  **The line against §2.2's free `satisfaction ratings`: those are the customer's
  verdict, collected freely; QA is the operator's rubric applied to their own team's
  work.** Related but not the same as §3.3's wallboards — QA scores individual
  conversations, analytics aggregates whatever has been scored.
- AI subsumes rather than ports several reference modules: ticket translation,
  learning spam filter, customer data enrichment, satisfaction/sentiment analysis become
  facets of assistant modules, not standalone products. (Sentiment ≠ QA: sentiment reads
  the customer's mood, QA evaluates the Agent's reply against a rubric a human maintains.
  The former is a facet; the latter carries its own review workflow and is its own
  module.)

### 3.2 Channels & integrations

WhatsApp · Telegram (integration + notifications) · SMS (Twilio-class) · Facebook
Messenger · Slack notifications · Rocket.Chat notifications · Jira · commerce
order-context panes (Shopify/WooCommerce-class, incl. Easy-Digital-Downloads-class
digital-goods stores) · mobile push (paired with any future mobile surface).
All are out-of-process by nature: a channel adapter feeds the same channel-agnostic
conversation engine; an integration consumes events and the public API.

### 3.3 Enterprise & ops

- **Enterprise Auth** — SAML/OIDC SSO, SCIM/directory sync, LDAP directory
  integration, 2FA *policy enforcement*, login audit. (Passkeys and baseline
  OAuth/social login themselves are core, per §1 and §2.2.)
- **PGP / S-MIME** signing and encryption.
- **Wallboards & advanced analytics** (basic reports stay core).
- **Kanban view** · **time tracking** · **checklists** (task lists within
  conversations) · **CRM-grade customer management** (basic customer records and
  fields stay core).
- **White-labeling** — see §3.4 (the embeddable widget's branding removal only; the
  end-user portal itself is paid in full, also §3.4).
- *Possible, deliberately undecided*: an advanced-workflows module above core's basic
  automations. Deciding it is deferred; the core/paid seam inside "workflows" gets drawn
  when basic automations are specced, not retroactively.

### 3.4 Self-service surfaces

- **Knowledge base** — the entire KB ships as a paid module, not core: content-as-code
  (docs in git, static build, build-time search index) as its initial form, a runtime
  editor later. Reclassified 2026-07-19 (charter-amended) because knowledge
  authoring and publishing are an optional application built on Helpthread's support
  infrastructure, not a prerequisite for operating the core.
- **End-user portal** — customer ticket submission and history ships as a paid module
  in full. No free tier; distinct from the embeddable widget below.
- **Embeddable support widget** — ships **free with Helpthread branding**; **branding
  removal is paid**. The free widget remains fully useful; paid branding removal is an
  additive commercial capability.

## 4. Build sequence

1. **Module substrate v1 spec**: typed event vocabulary, webhook delivery
   (registration, signed payloads, retries), assistant-actor API (draft-post,
   list-pending, approve/send with audit). Doubles as counsel raw material for the
   §7-exception text  — the exception gets drafted against a real API, before the
   first external contribution.
2. **Core: event emission + webhook delivery** (AGPL — the substrate is always free).
3. **Core: assistant-actor API + draft-review inbox UI** (design-project-first per the
   UI-fidelity rule; the schema has been AI-ready since day one).
4. **First module: draft-reply assistant** in a closed repo, dogfooded on the live
   Resonant IQ desk. Dogfood installs are a private npm package in the Vercel build —
   no marketplace plumbing required to use our own modules. *(Superseded 2026-07-19 —
   see `specs/modules/marketplace-v1.md` §7: once the marketplace ships,
   Resonant IQ's own install moves onto the real marketplace flow, not this
   shortcut.)*
5. **Marketplace plumbing** (license keys, registry, update channel — pinned in
   `specs/modules/marketplace-v1.md`) is built now, during the dogfood phase,
   not deferred to "once demand justifies it": the marketplace launch decision
   made the marketplace itself the project's proven install path, so this
   step lands inside the dogfood phase rather than after launch. Step 4's point still
   stands on its own terms — Resonant IQ's early installs didn't strictly *need* this
   plumbing to use our own modules — but the plumbing is no longer future work.

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

## 6. Changelog

- **2026-07-18**: initial version. Free/paid line decided by TJ from market
  inventory and charter constraints; passkeys-core,
  Enterprise-Auth-paid, white-label pattern, and the three paid clusters locked.
- **2026-07-19**: public module inventory re-audited item-by-item
  against this catalog's coverage; ~14 gaps found and classified using the existing
  free/paid logic. New free-core items (§2.2): extended attachments, sent-folder
  tracking, inline image embeds, global cross-mailbox inbox view, sticky notes,
  custom agent profile fields, baseline OAuth/social login, extra security
  (reCAPTCHA/IP allowlisting). New paid items: checklists (§3.3, folded LDAP directory
  sync into Enterprise Auth rather than a separate line), Rocket.Chat notifications
  and Easy-Digital-Downloads-class commerce (§3.2). **Knowledge base reclassified
  free-core → paid module in full** (charter-amended; see CHARTER.md's 2026-07-19
  amendment) — not a retroactive paywall, since it was never shipped. **End-user
  portal reclassified free-with-branding → paid module in full** (§3.4); the
  embeddable widget keeps the unchanged free/branding-paid pattern. Live chat's
  free-core status (§2.2, architecture guide) reaffirmed from Helpthread's own
  core/product boundary. Paid catalog now 22 line items across four
  clusters (AI & automation 3, Channels & integrations 9, Enterprise & ops 8,
  Self-service surfaces 2 paid + 1 free-with-branding).
- **2026-07-19**: §4 step 4's npm-package dogfood-install sentence marked
  superseded by `specs/modules/marketplace-v1.md` §7 — the charter
  amendment now requires the marketplace itself to be Resonant IQ's proven install
  path, so the shortcut this step describes stops being current once that spec
  ships. Sentence left in place for history; the supersession note is the current
  instruction.
- **2026-07-19** (CodeRabbit PR review): §4 step 5 corrected — it still said
  marketplace plumbing "stays deferred to its charter phase," which no longer
  matches step 4's own supersession note or `marketplace-v1.md` §1's "launch-day,
  built now" framing. Reworded so both steps agree.
- **2026-07-20**: **Conversation QA & coaching** added to §3.1 — the catalog had
  no QA/quality-scoring line, and §1's one-way rule (free → paid never happens) means an
  unclaimed slot is one accidental free shipment away from being permanently
  unmonetizable. Claiming it now is the reversible direction; paid → free stays open.
  Two boundaries stated with it, because QA sits next to three existing entries: it is
  **not** §2.2's free `satisfaction ratings` (the customer's verdict, freely collected —
  QA is the operator's rubric on their own team's work), **not** the sentiment-analysis
  facet named in this same section (sentiment reads the customer's mood; QA evaluates a
  reply against a human-maintained rubric and carries its own review workflow), and
  **not** §3.3's wallboards (QA scores individual conversations; analytics aggregates
  what QA produced). Paid catalog now 23 line items across four clusters (AI & automation 4,
  Channels & integrations 9, Enterprise & ops 8, Self-service surfaces 2 paid + 1
  free-with-branding). Build sequence unchanged — the module is out-of-process on the
  shipped substrate and needs no new core hook.
