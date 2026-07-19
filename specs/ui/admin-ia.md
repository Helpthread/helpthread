# Admin IA & Fidelity Reference

Status: **accepted** (2026-07-18, TJ fidelity review, HT-54) — the information-architecture
contract every UI increment is checked against. Source: black-box observation of the
FreeScout instance at help.resonantiq.app (screenshots reviewed with TJ; never its source —
CHARTER.md provenance) plus TJ's direction. Help Scout remains the ease-of-use North Star;
FreeScout is the open pane of glass we model the interface through. **We are not trying to
BE FreeScout or Help Scout — we present the same interface to a close degree, but better.**

## 1. The three-scope rule (load-bearing)

Every navigation affordance belongs to exactly one scope. Mixing scopes is a fidelity
defect (the HT-54 first draft hung team management off the avatar menu — wrong).

| Scope | Entry point | Belongs here |
|---|---|---|
| **Global admin** | `Manage ▾` in the top nav (admins only) | Settings, Mailboxes, Tags, Team (Agents), Modules, Logs, System |
| **Mailbox-scoped** | Gear button in the mailbox sidebar | Edit Mailbox, Connection Settings, Permissions, Auto Reply, Custom Folders, Saved Replies, Satisfaction Ratings, Default Redirect, Mute Notifications |
| **Personal** | Avatar menu (top right) | **Your Profile and Log out. Nothing else, ever.** |

Top-bar utilities (scope-neutral): notifications bell (event feed), global search.

## 2. Surface index (observed reference, target shape)

Observed 2026-07-18. **Caveat (TJ):** the reference instance runs PAID MODULES — nothing
observed is assumed FreeScout-core, and nothing absent is assumed nonexistent.

**Purchased-module list (TJ, 2026-07-18)** — these observed surfaces are PAID modules in
the reference, not FreeScout core: **API & Webhooks, Custom Folders, Knowledge Base
(installed, inactive), Satisfaction Ratings, Saved Replies, Send & Close, Tags.**
(Keyboard shortcuts is a further paid module NOT purchased — absent from the reference,
exists in the ecosystem.) Everything else observed — Users, Mailboxes, Modules manager,
Settings, Translate, Logs, System, notifications, search, dashboard — is core there.

What this classification means for Helpthread (charter §3 governs):
- **Already core-committed here, paid there** — the public API (+ MCP server) is
  charter-core AGPL, free forever; **Tags shipped core in v1.1**. These are honest
  positioning differentiators: FreeScout charges for them, we don't.
- **Knowledge Base — reclassified 2026-07-19 (HT-75).** Originally counted alongside
  the public API above as an "already core-committed, paid there" differentiator; TJ
  reversed that call on review. Unlike Custom Folders/Saved Replies/Send & Close/
  Satisfaction Ratings below (where the market signal was noted but overridden in
  favor of free), for the Knowledge Base the market signal was followed: it is now a
  paid module (`specs/modules/catalog.md` §3.4), amending CHARTER.md's original
  day-one free-forever commitment.
- **Their paid list is market signal for OUR marketplace candidates** — Custom Folders,
  Saved Replies, Send & Close, Satisfaction Ratings are proven willingness-to-pay
  features. Core-vs-module is now decided: `specs/modules/catalog.md` (HT-66) is the
  canonical line — all four land core-free there; the charter's floor ("nothing free
  today gets paywalled retroactively; monetization adds, never subtracts") applies, and
  AI-powered modules lead the paid catalog.

- **Dashboard (home)** — multi-mailbox card grid: one card per mailbox with folder counts
  (Unassigned/Mine/Starred/Drafts/Assigned + last-activity dates) and quick actions
  (settings, compose, open). Helpthread is multi-inbox by design; the home page reflects it.
- **Manage → Team** (FreeScout: "Users") — card grid (photo/initials, name, email) + New
  Agent; per-Agent left sidebar: Profile / Permissions / Notifications. Create = role,
  first/last, email, mailbox access, invite toggle ("An invite can be sent later").
  *Helpthread status: shipping in HT-54 (Profile + Permissions; Notifications deferred).*
- **Manage → Mailboxes** — card list + New Mailbox (address, name, ratings toggle, who
  else uses it). *Deferred: mailbox management UI.*
- **Manage → Settings** — company, user-permission toggles, language/timezone/format,
  emails-to-customers (open tracking: FreeScout defaults ON; **Helpthread ships OFF — a
  deliberate charter privacy stance, kept**), notification email defaults, system mail
  transport (SMTP), alerts. *Partially shipped (our Settings surface); expansion deferred.*
- **Manage → Tags** — deferred.
- **Manage → Modules** — Installed (activate/deactivate, license key, in-place update with
  visible ops log) + Directory (browse/install). **Better-than delta: the reference
  directory has NO search — ours ships with search/filter from day one.** *Marketplace
  phase (charter §3); the §7-exception boundary gates external modules.*
- **Manage → Logs** — Outgoing Emails (delivery ledger incl. invite sends), Users
  (login/audit events with IP), Fetch Errors, App Logs. *Deferred; implies an audit-log
  increment (HT-54 spec §11 deferred it knowingly).*
- **Manage → System** — Status (versions, DB, extensions, update-available) + Tools
  (cache, migrate, logout-all, manual fetch). *Deferred; serverless changes its shape.*
- **Per-Agent Notifications** — Email/Browser/Mobile matrix per event class, with
  deployment-level defaults under Settings → Alerts. *Deferred; needs engine support.*
- **Notifications bell** — dropdown feed of conversation events. *Deferred.*
- **Global search** — top-bar. *Deferred.*

## 3. Standing rules for future increments

1. **Check the scope table first.** New affordances land in their scope's entry point.
2. **Module extensibility is structural**: Manage entries, mailbox-settings entries, and
   Settings sections are all injection points a module can extend (charter module
   boundary). Core surfaces must not assume a closed menu.
3. **Vocabulary**: FreeScout says "Users"; our copy and routes say Agents/Team
   (CHARTER vocabulary — Agents are humans, Assistants are AI). Deliberate departure.
4. **Deliberate deviations are documented here or they're defects.** Current list:
   Agents/Team vocabulary; open tracking default OFF; lean v1 Agent profile (no
   photo/job-title/phone/language/time-format yet); keyboard-shortcuts surface in core
   (a paid module in the reference; ours lives under Settings + the `?` key).
5. **"Better, not different"**: improvements sharpen the same interface (module search,
   a11y, calmer errors) — they do not relocate or reinvent surfaces.
6. **Reference-instance inference ban**: observed ≠ core, absent ≠ nonexistent. Check the
   module list before classifying any surface.

## 4. Changelog

- **2026-07-18**: initial version from TJ's HT-54 fidelity review (screenshot index +
  three-scope rule + module caveat). Roadmap tickets for deferred surfaces filed under HT.
- **2026-07-18** (HT-66): §2's open core-vs-module calls resolved by
  `specs/modules/catalog.md`; this doc keeps the observations, that one keeps the line.
