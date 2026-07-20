# Module Design Pack v1 — components and tokens so modules match the desk

Status: **draft for TJ review** (HT-95). Governed by CHARTER.md §3/§4 (module boundary,
out-of-process preference, zero privileged first-party access), `specs/modules/catalog.md`
(HT-66) §1's born-proprietary discipline, and CLAUDE.md's UI-fidelity rule.

**Not blocked on HT-93/HT-94.** The pack sources from the Claude Design project directly,
as a sibling of `web/src/components/ds/` rather than downstream of it (§5). 16 of the 20
components are already promoted there; the four new primitives arrive in the pack whenever
HT-94 part B promotes them upstream.

## 1. Purpose

Modules are out-of-process and render their own UI (`specs/modules/substrate-v1.md` §1
non-goals: "UI injection points"). That is the right boundary and this spec does not
change it. But it leaves a gap: **nothing makes a module look like the desk it is
installed into**, and nothing can, because there is no shared package a module author
can consume.

The goal, stated as the operator experiences it: a module's screens should look like
Helpthread — and when an operator has white-labeled their desk, like *their* desk.

**Non-goals for v1**: UI injection into core screens (still deferred; see §7), a
module manifest, runtime theme negotiation beyond token values, any change to `ds/`
itself.

## 2. Why a separate package, and why permissive

`web/src/components/ds/` (20 components after HT-93) and `web/src/theme/tokens/`
(`colors.css`, `shape.css`, `typography.css`) are the right raw material. They are also
**AGPL-3.0**, because they live in this tree.

A paid module is born-proprietary (`catalog.md` §1). A proprietary module that imports
AGPL components links them **in-process** — which is exactly the combination the §7
Module API Exception was drafted to permit, and that exception is
`legal/module-api-exception.md` **Status: DRAFT… Not yet adopted**. So today there is no
clean way for a paid module to use these components.

Three ways out; this spec picks the third.

| Option | Verdict |
| --- | --- |
| Wait for §7 adoption, import from the AGPL tree | Couples the design pack to a legal gate that exists for a different purpose (build-time core linkage). Also drags third-party authors into exception-compliance analysis to use a button. |
| Ship tokens only, no components | Preserves licensing purity, delivers little. Colors without components is not a design system. |
| **Publish the pack under a permissive license (MIT or Apache-2.0)** | **Needs no §7 exception at all.** Any module — first-party paid, third-party free, or a competitor's — can consume it with zero copyleft entanglement. |

The strategic read: components are not the moat. The mail engine, the modules, and the
hosted engine are. AGPL on the design pack actively fights the goal in §1; a permissive
license serves it. And per `catalog.md` §1, **paid → free stays possible** — moving
these components to a permissive license is a move in the permitted direction.

**Decision: MIT — ratified by TJ, 2026-07-20** ("yes MIT"), after confirming the scope is
the design pack alone: the core stays AGPL-3.0, `LICENSE` is untouched, and
`web/src/components/ds/` remains part of the AGPL core. This is not a relicensing of core
code — Resonant IQ holds the copyright outright (`ds/` has a single author), so the same
components are simply published under a second licence in a separate package while the
copies inside the core stay AGPL. On the cost, TJ: *"i really don't care if someone does
anything with design components."* The brand-asset carve-out in §3 is the one boundary
that stands.

Apache-2.0 was considered for its express patent grant and rejected —
there is no patentable invention in a component library, so the grant covers a threat
that does not exist here, while its NOTICE-preservation requirements are real overhead.
MIT is the ecosystem norm for React component libraries (React, Radix, Tailwind, shadcn),
and a third-party module author can read it without legal review. Adoption friction is
the live constraint; patent exposure is not.

**Decision: its own repo** — `helpthread-design-pack`, published as
`@helpthread/design-pack`. A permissively-licensed directory inside an AGPL tree is a
recurring source of misreading by exactly the audience that needs to trust it, and the
pack has its own release cadence.

### 2.1 Provenance gate before first publish

Relicensing requires owning the rights. Generation from the design project establishes
where the files came from, not what may be granted. Before the first publish:

- **Fonts — cleared.** `fonts/fonts.css` `@import`s Source Serif 4 and Source Code Pro
  from Google Fonts, both OFL, and **no font binaries are bundled**; the UI sans is the
  native system stack. Nothing is redistributed, so no font license travels with the
  pack. (Verified 2026-07-20; re-check if the pack ever vendors a binary.)
- **Components — audit required.** The `ds/` components originate in the Claude Design
  project as AI-assisted work product. Confirm the rights chain against the repo's own
  provenance/AI policy (`legal/`, drafted for counsel under HT-5) — specifically that the
  human review CLAUDE.md requires was real enough to support authorship, and that nothing
  was adapted from a source whose license forbids relicensing (CHARTER provenance rules).

**The asymmetry that lowers the stakes:** MIT grants whatever rights exist. If some of
the pack turns out to be uncopyrightable, the license still functions — the exposure is
"cannot stop others from using it," not "infringing." For a pack whose entire purpose is
for others to use it, that failure mode is close to harmless. The audit is due diligence,
not a blocker to design around.

## 3. Scope of the pack

**Brand assets are excluded, permanently.** The wordmark, logo, and any
Helpthread-identifying mark stay out of the pack and out of its repo — including
`guidelines/type-wordmark.html` and any brand-specific value in `theme/helpthread.css`.

MIT grants copyright, **not trademark**, so a permissive licence would not let anyone
call their product Helpthread regardless. But shipping the wordmark inside an MIT package
invites exactly the confusion `legal/trademark-policy.md` exists to prevent, and a
licence file is a poor place to litigate it. The pack ships the *system* — components and
tokens — never the *identity*.

Sourced from the design project (§5), in three layers:

1. **Tokens** — `tokens/{colors,shape,typography}.css` plus `theme/helpthread.css`,
   published as CSS and as a typed export. This is the layer that makes §4 work.
   `fonts/fonts.css` is **excluded pending HT-99** — see §3.1.
2. **Core components** — `components/core/`. **12 at v1**: Button, Avatar, DropdownMenu,
   StatusPill, TagChip, Toast, TextInput, MenuItem, IconButton, EmptyState, Skeleton,
   Kbd. **16 after HT-94 part B** promotes SplitButton, CommandMenu, SnoozePicker, and
   CredentialRow/PasskeyList out of `templates/new-primitives/`.
3. **Inbox components** — `components/inbox/` (ConversationRow, MessageBand, ToolbarBand,
   FolderItem). Included because a module rendering conversation-shaped data should
   render it the same way the desk does.

**Totals, stated once to stop the drift:** v1 ships **16** (12 core + 4 inbox); after
HT-94 part B it is **20** (16 core + 4 inbox). Every count elsewhere in this spec refers
to the post-HT-94 figure unless it says "at v1".

### 3.1 Fonts are excluded from v1 — HT-99

`fonts/fonts.css` is a single `@import` of Source Serif 4 and Source Code Pro from
`fonts.googleapis.com`. The fonts are OFL and no binaries are vendored, so §2.1's
*licensing* question is settled — but shipping that line in the pack would make every
module page issue a runtime request to Google, carrying the visitor's IP with it.

That is a poor fit for a product that ships **open-tracking privacy default OFF** as a
free-core feature, and it raises CSP and offline-availability problems for self-hosters
besides. The same `@import` is already live in the desk (`web/src/theme/fonts/fonts.css`),
so this is not a pack-only question — filed as **HT-99** against core. The pack takes
whatever core decides (vendor the OFL files, or document the dependency and its fallback);
until then it ships tokens without the font layer, falling back to the native stack the
UI sans already uses.

## 4. Theming resolves against the installed desk

The pack must not hardcode Helpthread's palette. **White-labeling is a paid catalog
item** (`catalog.md` §3.3) — operators will re-skin, and a module that ships Helpthread
blue into a re-skinned desk looks broken, which is the failure this spec exists to
prevent.

Tokens are already CSS custom properties, so the mechanism is simple: the module
consumes token *values* from the desk it is installed into rather than bundling its
own. The transport for those values is the one genuinely new engine-side surface this
spec implies, and per **zero privileged first-party access** it ships public — available
to every module author, not just first-party ones.

**Decision: ship the custom properties with the pack and let the desk's values win. No
endpoint.** A module rendering in an embedded context inherits the desk's token scope for
free — no engine change, no new surface. A module on its own origin gets the pack's
Helpthread defaults, which is correct until an operator has both re-skinned their desk
*and* installed a cross-origin module.

At that point the fix is a small public read endpoint serving token values, and it ships
public like everything else. Building it before that pair of conditions is met is
speculative, and substrate-v1's rule applies: each surface waits for a real module to
need it.

**Consequence: cross-origin white-label parity is explicitly OUT of §6's MUST for v1.**
Deciding to ship no token transport means a cross-origin module *cannot* match a
re-skinned desk — so requiring it would be requiring the impossible. The v1 requirement
therefore binds as: match the desk's design, resolving tokens from the desk wherever the
render context allows it (embedded), and from the pack's Helpthread defaults where it
does not (cross-origin). When the token endpoint ships, this exemption is removed and the
MUST applies everywhere. Named here rather than left implicit, because a conformance rule
nobody can satisfy is worse than no rule.

## 5. Sourced from the design project, as a sibling of `ds/`

CLAUDE.md: `ds/` files are **verbatim copies** of the Claude Design project, and
improvements go upstream. HT-94 exists because Biome silently broke that byte-equality.

The pack inherits that discipline, but **not by chaining off `ds/`**. Both are
independent verbatim consumers of the same upstream:

```text
Claude Design project ("Helpthread", 40b953cc)
   ├── web/src/components/ds/     (the desk)
   └── @helpthread/design-pack    (modules)
```

A chain (`pack ← ds/ ← design project`) would propagate any `ds/` drift into every
module — reintroducing one layer down the exact failure §1 exists to prevent. As
siblings, the desk and its modules cannot drift *from each other* without both drifting
from a single source that byte-comparison catches.

The upstream already carries everything the pack needs at v1: `components/core/` (12),
`components/inbox/` (4), `tokens/{colors,shape,typography}.css`, and
`theme/helpthread.css`. (`fonts/fonts.css` is excluded — §3.1.) The four new primitives
are still staged at `templates/new-primitives/Primitives.jsx` and enter the pack when
HT-94 part B promotes them to `components/core/`, taking core to 16.

### Sync is never unattended past the PR boundary

DesignSync authenticates through the operator's claude.ai login and its write path
requires an interactive plan approval, so it cannot hold a service credential or run
unattended in CI. The *fetch* side can be scheduled; nothing past the PR can.

What is real:

- **The `/design-sync` skill** — an **Assistant** session that pulls changed components
  incrementally, the same mechanism `ds/` already uses. Repeatable, human-initiated.
- **Optionally, a scheduled Assistant** that runs the fetch on a cadence and **opens a
  PR** against the pack repo. It may prepare and open; it may never merge or release.
  Automation of the *cadence*, not of the decision.

Either way the merge is a reviewed PR, which is what keeps §6's conformance claim
honest.

(Vocabulary, per CLAUDE.md: **Agents** are human support staff, **Assistants** are AI
actors. The automation here is an Assistant.)

### The drift gate needs a content hash, not a revision pin

"Regenerate and byte-compare" is only meaningful against a recorded baseline — otherwise
a stale pack and a moved upstream are indistinguishable, and both look like "the files
differ."

The obvious answer, pinning an upstream revision, **is not available**: the design
project is not a git repo and DesignSync exposes no commit or version identifier
(`list_files`/`get_file` return paths and content, nothing more). So the baseline is a
**content-hash manifest** committed to the pack repo.

It must cover **two path sets, not one** — hashing only the sourced files cannot tell
expected generation from a hand edit, because the pack also contains derived output the
manifest never saw:

- **`sources`** — per-file SHA-256 of every file fetched from the design project, plus
  its exact path set. Detects upstream movement.
- **`generated`** — per-file SHA-256 of every artifact the build emits (typed token
  exports, entry points, type declarations), plus its exact path set. Detects hand edits
  *and* files that appear or vanish, which a hash-only check would miss.

Both sets are exhaustive and closed: a path present in the package but absent from the
manifest fails the gate, same as a mismatched hash.

CI then re-fetches, rebuilds, re-hashes, and compares, which distinguishes the two cases
the byte-compare alone conflates:

| `sources` vs. re-fetched | `generated` vs. rebuilt | Means |
| --- | --- | --- |
| differs | matches | **upstream moved** — regenerate, review, release |
| matches | differs | **pack was hand-edited** — reject, this is the fork §5 forbids |
| differs | differs | upstream moved *and* someone edited — reject, resolve separately |
| matches | matches | clean |

HT-93's Biome override is what makes the hashes stable; without it, formatting-on-arrival
would churn them on every sync.

## 6. Conformance is contractual, not technical

An out-of-process module renders its own UI on its own origin. **Nothing in the engine
can force it to use the pack** — no runtime check exists, and per the marketplace's
distribution-credential-only rule, none ever will.

So conformance is a **marketplace listing requirement**, checked at review:

- a listed module **MUST** match the desk's design on every operator-visible surface,
  **subject to §4's cross-origin exemption** — a module that cannot inherit the desk's
  token scope conforms by matching the pack's defaults, until the token endpoint ships.
  The pack is the supported way to satisfy this and the only one that stays correct as
  the design moves; an independent implementation is permitted but carries the whole
  burden of proving parity, including after upstream changes.
- a listed module **MUST NOT** ship a look that impersonates core Helpthread UI while
  behaving differently
- deviations need the same sign-off any UI deviation needs (CLAUDE.md: TJ's explicit
  sign-off), recorded on the listing

The requirement is on the *outcome* (matches the desk), not the *mechanism* (imports the
pack) — otherwise a module with no operator-visible UI at all, like a notifications
relay, would be non-conformant for having nothing to style. Such a module is trivially
conformant.

Marketplace is first-party-only today — "Every Module row is first-party; no seller
onboarding" (`marketplace-v1.md`) — so this costs nothing to adopt now. **The rule needs
to exist before the first third-party module, not after**, because retrofitting a
conformance requirement onto published modules is a breaking change to someone else's
product.

## 7. What this does not solve

The pack makes a module's own screens look native. It does **not** put module UI inside
core screens — no QA panel in the conversation view, no module column in the inbox list.
That still requires a public UI extension point, still deferred by
`substrate-v1.md` §1, and still subject to zero-privileged-first-party-access if it is
ever built.

That deferral is correct until a real module proves the need. The first candidate is the
QA module (HT-96): ship it notes-only, and let the dogfood answer whether notes are
sufficient or whether the extension point is worth building.
