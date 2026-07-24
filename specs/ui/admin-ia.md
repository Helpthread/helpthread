# Admin Information Architecture

Status: **accepted** (2026-07-18, TJ fidelity review) — the information-architecture
contract every UI increment is checked against. It incorporates TJ's direction and
black-box observations captured during the original internal deployment. Those
observations are evidence, not a product definition; Helpthread's charter and design
system govern the interface.

## 1. The three-scope rule (load-bearing)

Every navigation affordance belongs to exactly one scope. Mixing scopes is a fidelity
defect (the first draft hung team management off the avatar menu — wrong).

| Scope | Entry point | Belongs here |
|---|---|---|
| **Global admin** | `Manage ▾` in the top nav (admins only) | Settings, Mailboxes, Tags, Team (Agents), Modules, Logs, System |
| **Mailbox-scoped** | Gear button in the mailbox sidebar | Edit Mailbox, Connection Settings, Permissions, Auto Reply, Custom Folders, Saved Replies, Satisfaction Ratings, Default Redirect, Mute Notifications |
| **Personal** | Avatar menu (top right) | **Your Profile and Log out. Nothing else, ever.** |

Top-bar utilities (scope-neutral): notifications bell (event feed), global search.

## 2. Surface index

Observed 2026-07-18 and subsequently made Helpthread-specific. The module catalog—not
another product's packaging—defines what belongs in core and what is paid. See
`specs/modules/catalog.md`.

- **Dashboard (home)** — multi-mailbox card grid: one card per mailbox with folder counts
  (Unassigned/Mine/Starred/Drafts/Assigned + last-activity dates) and quick actions
  (settings, compose, open). Helpthread is multi-inbox by design; the home page reflects it.
- **Manage → Team** — card grid (photo/initials, name, email) + New
  Agent; per-Agent left sidebar: Profile / Permissions / Notifications. Create = role,
  first/last, email, mailbox access, invite toggle ("An invite can be sent later").
  *Helpthread status: shipping in  (Profile + Permissions; Notifications deferred).*
- **Manage → Mailboxes** — card list + New Mailbox (address, name, ratings toggle, who
  else uses it). *Deferred: mailbox management UI.*
- **Manage → Settings** — company, user-permission toggles, language/timezone/format,
  emails-to-customers (**open tracking ships OFF by default**), notification email defaults, system mail
  transport (SMTP), alerts. *Partially shipped (our Settings surface); expansion deferred.*
- **Manage → Tags** — deferred.
- **Manage → Modules** — Installed (activate/deactivate, license key, in-place update with
  visible ops log) + Directory (browse/install). The directory ships with search and
  filtering from day one. *Marketplace
  phase (see the [legal guide](../../legal/README.md)); the §7-exception boundary gates external modules.*
- **Manage → Logs** — Outgoing Emails (delivery ledger incl. invite sends), Users
  (login/audit events with IP), Fetch Errors, App Logs. *Deferred; implies an audit-log
  increment ( spec §11 deferred it knowingly).*
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
3. **Vocabulary**: copy and routes say Agents/Team
   (CHARTER vocabulary — Agents are humans, Assistants are AI). Deliberate departure.
4. **Deliberate deviations are documented here or they're defects.** Current list:
   Agents/Team vocabulary; open tracking default OFF; lean v1 Agent profile (no
   photo/job-title/phone/language/time-format yet); keyboard shortcuts in core under
   Settings and the `?` key.
5. **Prefer continuity over novelty**: improvements sharpen the interface (module search,
   accessibility, calmer errors) without relocating or reinventing established surfaces
   without a clear reason.
6. **The module catalog governs classification**: observations from other products do
   not determine whether a Helpthread surface belongs in core or in a module.

## 4. Changelog

- **2026-07-18**: initial version from TJ's fidelity review (screenshot index +
  three-scope rule + module caveat). Roadmap tickets for deferred surfaces filed under HT.
- **2026-07-18**: §2's open core-vs-module calls resolved by
  `specs/modules/catalog.md`; this doc keeps the observations, that one keeps the line.
