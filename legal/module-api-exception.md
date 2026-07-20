# Helpthread Module API Exception — AGPL-3.0 §7 Additional Permission

**Status: DRAFT for counsel review (TJ, acting as counsel). Not yet adopted.**
Adoption gate (CHARTER.md §3): this text must be final and applied to the core's
license **before the first external contribution is merged** — under DCO, broadening
it afterward requires the consent of every copyright holder. Adoption mechanics: on
sign-off, the exception text below is appended to the repository's `LICENSE` file
beneath the AGPL-3.0 text, referenced from every source-file header block that names
the license, and noted in CHARTER.md's §7 appendix with the adoption date.

> **Provenance note (added 2026-07-20, HT-100).** This draft was authored by an assistant,
> reviewed by an assistant, and merged in PR #99 with **zero human review comments** — 1h37m
> from open to merge, inside a window with no human input at the decision point. The
> "independent different-vendor review" comments on that PR were posted by the assistant
> under TJ's GitHub account and adjudicated by the assistant; TJ's agreement covered a
> five-item summary, not this text.
>
> The charter calls this exception "this project's real one-way door." **No human has read
> this document line by line.** It remains DRAFT and unadopted, so the door has not been
> walked through — but it must not be adopted until TJ, and counsel, have actually read it.

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
> Modules through the Module API, the copyright holders of this Program give you
> additional
> permission to convey the resulting combined work, and to make it available for use
> over a computer network as described in section 13 of the GNU Affero General Public
> License version 3, **without** being required to license the Helpthread Modules
> themselves under the GNU Affero General Public License version 3, and **without**
> the requirement that the Corresponding Source conveyed or offered under sections 6
> or 13 include the source code of those Helpthread Modules, or their object code,
> build artifacts, installation metadata, or bundled or minified forms.
>
> **"Module API"** means the extension interfaces published and documented as the
> Module API for the version of the Program you received, by whoever conveyed that
> version to you — including its typed event hooks, webhook and event-delivery
> contracts, module manifest and entry-point conventions, and the public HTTP API
> surfaces that the accompanying module documentation designates for module use — and
> no other interface. This additional permission applies only to combination, linking,
> loading, or invocation through the Module API as defined above; combination with the
> Program through any other interface is simply not covered by this additional
> permission, and remains governed solely by the GNU Affero General Public License
> version 3 without it. The published Module API documentation for the
> version you received is the boundary object, whether that version came from this
> Program's original licensors or from a later conveyor of a modified version.
>
> **"Helpthread Module"** means a work, in any form, that satisfies all of the
> following: (a) it interacts with this Program exclusively through the Module API;
> (b) it is combined with the Program only by the loading, linking, build-time
> composition, or network-delivery mechanisms the Module API documentation defines;
> (c) it does not modify, replace, patch, or extend any part of the Program other
> than through the Module API; and (d) it is not itself a modified version of this
> Program, and does not contain, incorporate, derive from, replace, or substitute for
> any part of the Program's implementation code. A work that modifies the Program
> other than through the Module API, or that carries within itself any part of the
> Program's implementation code — including a thin interface layer wrapped around
> copied or adapted Program code — is not a Helpthread Module, and this additional
> permission does not apply to it.
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
> as section 7 of the GNU Affero General Public License permits.
>
> If you convey a modified version of this Program whose published and documented
> Module API is narrower than the Module API of the version you received, this
> additional permission does not apply to that modified version and is removed from it
> by its own terms — the self-removal that section 7 of that License expressly
> contemplates for additional permissions. Recipients of that modified version do not
> receive this additional permission unless you separately place equivalent additional
> permissions on that modified version in accord with section 7. Nothing in this
> paragraph limits your right under section 7 to remove this additional permission for
> any reason.

---

## Practical guidance (not part of the exception)

This guidance is practical, not operative: it forms no part of the exception text
above, states no legal conclusion that binds the grant, and grants no permission of
its own.

If you do not understand whether a planned integration falls within the Module API,
two safe harbors help in practice: integrate out-of-process, through webhooks and the
public HTTP API — the shape the charter already names as preferred; or ask the
Program's maintainers to designate the interface you need, which is how the Module API
is intended to grow. Whether any particular out-of-process integration needs this
additional permission at all is a legal question the operative text above governs, not
this note.

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
   paragraph: the exception reaches every recipient of every conveyed copy, forks
   included, so a fork *receives* it and can grow its own module ecosystem against its
   own published Module API. What the proviso does **not** do is force a fork to keep
   it — AGPL §7 expressly permits a conveyor to remove an additional permission, and
   the removal paragraph above says so, so a fork may strip the exception entirely.
   That is the accepted §7 removal risk, named honestly here rather than papered over.
   The proviso's job is narrower, and — following the 2026-07-20 review — it is now
   framed as **self-removal rather than prohibition**. AGPL-3.0 §7 ¶2 states in terms
   that "[a]dditional permissions may be written to require their own removal in
   certain cases when you modify the work," so a permission that lapses on narrowing
   is a drafting shape the license itself contemplates. The earlier wording ("you may
   not narrow it … while retaining it in name") was an *obligation on the conveyor*,
   and §7's closing paragraph sweeps every non-permissive additional term outside
   (a)–(f) into "further restrictions" under §10 — the one category that would make
   this license non-free. Same practical effect, sanctioned mechanism.

   Counsel may prefer to relocate the anti-mislabeling intent to the trademark policy
   instead. Note that §7(c) independently permits terms "[p]rohibiting
   misrepresentation of the origin of that material, or requiring that modified
   versions of such material be marked in reasonable ways as different from the
   original version," so an in-license route plausibly exists on that basis too. Which
   A second review pass (2026-07-20, multi-model) caught that the first attempt at this
   fix still carried a sentence — "it is not available in name to a modified version
   that does not carry it in substance" — which reads as a prohibition on *labelling*
   rather than a self-removal trigger, i.e. the same §10 defect in smaller form. The
   operative text now states only the self-removal condition and expressly preserves the
   §7 right to remove the permission for any reason. The scope sentence in the "Module
   API" definition was reframed in the same pass, from "are not licensed for
   combination" (which reads as a new prohibition on combining) to a statement that
   combination through other interfaces is simply *not covered* and remains under the
   unmodified AGPL. Which of the three framings to adopt is counsel's call; the defect
   being fixed is that the
   prior wording fit none of them. The intent throughout is to stop a fork that
   *retains* the exception in name from silently *narrowing* its published Module API
   to strand third-party modules
   while still claiming the permission applies — a fork's recipients get the exception
   against the Module API the fork actually publishes, or, if the fork removed it, no
   exception at all.
4. **The (d) clause** (a module may not be a modified Program, nor carry the Program's
   implementation code within itself) closes two loopholes: relicensing a fork of the
   core as a "module" of itself, and the split-work trick where an actor copies core
   implementation into a nominal "module" behind a thin API-only wrapper and argues
   only the wrapper is the Module.
5. **Corresponding Source exclusion covers non-source module forms too.** The grant
   excludes from the §§6/13 Corresponding Source obligation not only the Modules'
   *source* code but also their object code, build artifacts, installation metadata,
   and bundled or minified forms. In a build-time npm bundle the module compiles
   alongside the core, so an exclusion limited to source would invite the argument that
   the module's *non-source* materials are still owed as Corresponding Source for the
   combined work. Scoped to the maximum intended extent by design (TJ, acting as
   counsel, 2026-07-19).
6. **What this deliberately does not do:** grant trademark rights (separate policy),
   grant patent rights beyond AGPL §11, or promise Module API stability (engineering
   concern, not license concern).
7. **One-way-door reminder:** narrowing after adoption is impossible for conveyed
   copies and broadening requires every contributor's consent once external DCO
   contributions merge. Review accordingly.
