# Helpthread Module API Exception — AGPL-3.0 §7 Additional Permission

> **This permission is not yet in force.** It takes effect when the exception text
> below is appended to this repository's `LICENSE` file beneath the AGPL-3.0 text; it
> has not been appended. Until then the core is licensed under the unmodified AGPL-3.0,
> and no additional permission is granted by this document. On adoption the text is
> also referenced from every source-file header block that names the license, and the
> adoption date is recorded in this directory.
>
> Adoption must happen **before the first external contribution is merged**: under the
> DCO, broadening the permission afterward requires the consent of every copyright
> holder.

Drafting tradition: the GPL Classpath Exception and the FSF's §7 additional-permission
mechanism, adapted for (a) AGPL §13 network use, which the Classpath exception predates,
and (b) Helpthread's build-time npm module model, where a module compiles into the same
running program as the core ([legal guide](README.md): "Repository separation alone does no legal
work"). Symmetric by design: the same permission for first-party, third-party, and
fork-based modules alike.

---

## The exception text — not adopted, grants nothing

> ### Additional permission under GNU AGPL version 3 section 7 — the Helpthread Module API Exception
>
> **NOT ADOPTED — THIS PERMISSION GRANTS NOTHING.** This text has not been appended to
> the Program's `LICENSE` and is not part of the Program's licensing. No one may rely on
> it. The Program is licensed under the unmodified GNU AGPL-3.0. This notice is not part
> of the permission and is deleted when the permission is adopted.
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
