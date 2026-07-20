# Helpthread Module API Exception — AGPL-3.0 §7 Additional Permission

**Status: DRAFT for counsel review (TJ, acting as counsel). Not yet adopted.**
Adoption gate (CHARTER.md §3): this text must be final and applied to the core's
license **before the first external contribution is merged** — under DCO, broadening
it afterward requires the consent of every copyright holder. Adoption mechanics: on
sign-off, the exception text below is appended to the repository's `LICENSE` file
beneath the AGPL-3.0 text, referenced from every source-file header block that names
the license, and noted in CHARTER.md's §7 appendix with the adoption date.

Drafting tradition: the GPL Classpath Exception and the FSF's §7 additional-permission
mechanism, adapted for (a) AGPL §13 network use, which the Classpath exception predates,
and (b) Helpthread's build-time npm module model, where a module compiles into the same
running program as the core (CHARTER.md §3: "Repository separation alone does no legal
work"). Symmetric by design: the same permission for first-party, third-party, and
fork-based modules alike.

---

## The exception text

> ### Additional permission under GNU AGPL version 3 section 7 — the Helpthread Module API Exception
>
> If you modify this Program, or any covered work, by combining it with one or more
> Helpthread Modules (as defined below), or by linking, loading, or invoking such
> Modules through the Module API, the licensors of this Program grant you additional
> permission to convey the resulting combined work, and to make it available for use
> over a computer network as described in section 13 of the GNU Affero General Public
> License version 3, **without** being required to license the Helpthread Modules
> themselves under the GNU Affero General Public License version 3, and **without**
> the requirement that the Corresponding Source conveyed or offered under sections 6
> or 13 include the source code of those Helpthread Modules.
>
> **"Module API"** means the extension interfaces that this Program's copyright
> holders publish and document as the Module API in the version of the Program you
> received — including its typed event hooks, webhook and event-delivery contracts,
> module manifest and entry-point conventions, and the public HTTP API surfaces the
> module documentation designates for module use — and no other interface. Interfaces
> of the Program that its documentation does not designate as part of the Module API
> are not licensed for combination under this permission.
>
> **"Helpthread Module"** means a work, in any form, that satisfies all of the
> following: (a) it interacts with this Program exclusively through the Module API;
> (b) it is combined with the Program only by the loading, linking, build-time
> composition, or network-delivery mechanisms the Module API documentation defines;
> (c) it does not modify, replace, patch, or extend any part of the Program other
> than through the Module API; and (d) it is not itself a modified version of this
> Program. A work that modifies the Program other than through the Module API is not
> a Helpthread Module, and this additional permission does not apply to it.
>
> This additional permission applies equally to every licensee and every Helpthread
> Module, regardless of the Module's author, license, or commercial terms, and it
> travels with every conveyed copy of the Program, including modified versions —
> provided that if you convey a modified version of the Program whose Module API
> differs from the one you received, this permission applies, for recipients of your
> modified version, to the Module API as you publish and document it for that
> modified version.
>
> You may remove this additional permission from your copy or your modified version,
> as section 7 of the GNU Affero General Public License permits; you may not narrow
> it for works you convey while retaining it in name.
>
> If you do not understand whether a planned integration falls within the Module API,
> the safe harbors are: out-of-process integration through webhooks and the public
> HTTP API, which needs no additional permission at all; or asking the Program's
> maintainers to designate the interface you need, which is how the Module API is
> intended to grow.

---

## Drafting notes for counsel (not part of the exception)

1. **Why the API-boundary definition rather than a named-directory definition.**
   The Classpath exception defines by linking mechanics; Helpthread's risk case is a
   build-time npm module compiled into one bundle, where "linking" is fuzzy. Defining
   the boundary as *the documented Module API in the version received* makes the
   published documentation the legal boundary object — the same artifact engineering
   already maintains (charter: "the exception text is the mechanism").
2. **§13 coverage** is explicit in the grant ("make it available for use over a
   computer network"), which the Classpath tradition lacks and AGPL requires.
3. **Fork symmetry** (charter requirement) is the "travels with every conveyed copy"
   paragraph. The modified-Module-API proviso prevents the known abuse where a fork
   silently *narrows* its published Module API to strand third-party modules while
   claiming the exception still applies — their recipients get the exception against
   the API the fork actually publishes.
4. **The (d) clause** (a module may not be a modified Program) closes the loophole of
   relicensing a fork of the core as a "module" of itself.
5. **What this deliberately does not do:** grant trademark rights (separate policy),
   grant patent rights beyond AGPL §11, or promise Module API stability (engineering
   concern, not license concern).
6. **One-way-door reminder:** narrowing after adoption is impossible for conveyed
   copies and broadening requires every contributor's consent once external DCO
   contributions merge. Review accordingly.
