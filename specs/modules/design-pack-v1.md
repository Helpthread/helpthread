# Module Design Pack v1 — components and tokens so modules match the desk

Status: **draft for TJ review** (HT-95). Governed by CHARTER.md §3/§4 (module boundary,
out-of-process preference, zero privileged first-party access), `specs/modules/catalog.md`
(HT-66) §1's born-proprietary discipline, and CLAUDE.md's UI-fidelity rule. Depends on
HT-93 (PR #103) and HT-94 landing first — this spec describes a package *generated from*
`web/src/components/ds/`, so `ds/` must be reconciled before it can be a source.

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

**Decision: MIT.** Apache-2.0 was considered for its express patent grant and rejected —
there is no patentable invention in a component library, so the grant covers a threat
that does not exist here, while its NOTICE-preservation requirements are real overhead.
MIT is the ecosystem norm for React component libraries (React, Radix, Tailwind, shadcn),
and a third-party module author can read it without legal review. Adoption friction is
the live constraint; patent exposure is not.

**Decision: its own repo** — `helpthread-design-pack`, published as
`@helpthread/design-pack`. A permissively-licensed directory inside an AGPL tree is a
recurring source of misreading by exactly the audience that needs to trust it, and the
pack has its own release cadence.

## 3. Scope of the pack

Generated from the reconciled `ds/`, in three layers:

1. **Tokens** — the `theme/tokens/` custom properties, published as CSS and as a typed
   export. This is the layer that makes §4 work.
2. **Core components** — the 16 primitives in `ds/core/` (Button, Avatar, DropdownMenu,
   StatusPill, TagChip, Toast, TextInput, MenuItem, IconButton, EmptyState, Skeleton,
   Kbd, plus HT-93's SplitButton, CommandMenu, SnoozePicker, CredentialRow/PasskeyList).
3. **Inbox components** — `ds/inbox/` (ConversationRow, MessageBand, ToolbarBand,
   FolderItem). Included because a module rendering conversation-shaped data should
   render it the same way the desk does.

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

## 5. Generated, never forked

CLAUDE.md: `ds/` files are **verbatim copies** of the Claude Design project, and
improvements go upstream. HT-94 exists because Biome silently broke that byte-equality.

The pack inherits the same discipline, one hop further out: **the pack is generated from
`ds/`, and `ds/` is generated from the design project.** A hand-maintained second copy
would drift the desk and its modules apart — the precise failure §1 is trying to
prevent, reintroduced one layer down.

Practical consequence: the pack needs a generation step and a drift check in CI, not a
one-time copy. Byte-comparison is the check; HT-93's biome override is what makes byte
comparison meaningful again.

## 6. Conformance is contractual, not technical

An out-of-process module renders its own UI on its own origin. **Nothing in the engine
can force it to use the pack** — no runtime check exists, and per the marketplace's
distribution-credential-only rule, none ever will.

So conformance is a **marketplace listing requirement**, checked at review:

- a listed module SHOULD consume the pack for any surface an operator sees
- a listed module MUST NOT ship a look that impersonates core Helpthread UI while
  behaving differently
- deviations need the same sign-off any UI deviation needs (CLAUDE.md: TJ's explicit
  sign-off)

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
