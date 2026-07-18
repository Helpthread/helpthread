# Agents & Authentication

Status: **draft** (2026-07-18) — the contract for real per-Agent identity, login, and user
management, replacing the single shared operator password that HT-51 shipped as a
deliberate placeholder. Authored native (Helpthread's own domain model); the *experience*
is modelled on the Help Scout / FreeScout user-management UX (black-box observation only —
never their source), rendered entirely in Helpthread's own design system.

This supersedes the single-operator posture of `agent-inbox-v1.md` §1/§5/§6, whose own note
mandates the direction: *"when multi-Agent lands it is expected to **replace** this single
shared password with real per-Agent accounts, not extend it."* This is that replacement.

## 1. Purpose & the core / marketplace boundary

Two audiences pull authentication in different directions, and this spec serves both by
splitting them at a seam:

- **The self-hosted, open-source product (AGPL core):** must ship a complete, honest login
  with no dependency on any hosted identity service or third-party provider. That is
  **username/password** — a real, self-contained auth system.
- **Resonant IQ's own deployment, and paying customers:** want Google SSO, magic-link,
  passkeys, SAML. These are **licensed marketplace modules**, not part of the free core.

The mechanism that makes both true at once is an **auth-provider seam** (§4). The core ships
the seam and exactly one provider — `password`. A marketplace module is a package that
registers an additional provider against that seam. **This seam is a concrete instance of
the AGPL-3.0 §7 module-marketplace boundary** the charter is built around and that counsel
is defining ([HT-5](https://resonantiq.atlassian.net/browse/HT-5), critical path). Building
the seam and the free `password` provider in core is AGPL-clean and can proceed now; it also
gives counsel a *concrete* boundary to write the exception text against. Shipping any
premium provider module waits on that text being counsel-final (charter: the §7 exception
must be final before the first external module merges). **Entitlement/licensing enforcement**
(how a deployment proves it bought a module) is separate marketplace infrastructure and is
out of scope here — the seam simply loads whatever providers are registered.

The free core must stand entirely on its own: password login is a *real* login, not a
crippled demo. Premium providers are pure additions that attach with **zero core-schema
change** (§3.2 is why).

## 2. Vocabulary (charter §, fixed)

**Agent** = a human member of the support staff who operates the inbox. **Assistant** = an AI
actor. Never conflated. The identity records this spec introduces are **Agents**. We never
call them "users" loosely in schema, API, or UI copy; the API resource is `/agents`, the
records are Agents. (The FreeScout screens we model call them "Users"; our copy says
"Agents" or "Team" — a deliberate, charter-required departure, not a fidelity miss.)

## 3. Data model

Three new tables (`agents`, `agent_auth_identities`, `agent_mailbox_access` §3.4) plus one
`ALTER` (assignee, §3.3) in the
engine's Postgres (`src/db/migrate.ts`, next migration ids). Web has no DB access
(`agent-inbox-v1.md` API-first rule) — all of this is reachable only through the engine API
(§6).

### 3.1 `agents` — the identity

```sql
CREATE TABLE agents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,                       -- normalised lower-case; unique (below)
  name        text NOT NULL,                        -- display name, "First Last"
  role        text NOT NULL DEFAULT 'agent'
                CHECK (role IN ('admin', 'agent')), -- §5
  status      text NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited', 'active', 'disabled')),
  timezone    text NOT NULL DEFAULT 'UTC',          -- the one profile nicety in v1 (§7 decision)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agents_email_key ON agents (lower(email));
```

`status`: `invited` = created via the invite path, no usable password yet (awaiting invite
acceptance) — **only** the invite path ever produces this status; `active` = can sign in;
`disabled` = soft-off, cannot sign in, records and history retained (FreeScout's "Prevent
user from logging in"). **Both provisioning paths converge on `active`** — invite acceptance
flips `invited`→`active` (§6), and an admin-set-password Agent is created `active` outright
(§8) — so a working Agent is never left at `invited`. Login (`/auth/verify`) treats `invited`
and `disabled` identically to a wrong password: a generic `401`, no status leak (§6, §9).
Deletion is separate and hard (§6).

### 3.2 `agent_auth_identities` — *how* an Agent proves who they are

This is the table that makes the marketplace work. **One Agent, many login methods.**

```sql
CREATE TABLE agent_auth_identities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider     text NOT NULL,          -- 'password' (core); 'google','passkey',... (marketplace)
  subject      text NOT NULL,          -- provider's stable identifier for this Agent
  secret_hash  text,                   -- scrypt hash for 'password'; NULL for OAuth-style providers
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX agent_auth_identities_agent ON agent_auth_identities (agent_id);
-- "One password identity per Agent" is a schema invariant, not a convention:
-- UNIQUE(provider, subject) alone would still admit two 'password' rows for one
-- Agent under different subjects, making password lookup/reset ambiguous.
CREATE UNIQUE INDEX agent_auth_identities_one_password_per_agent
  ON agent_auth_identities (agent_id) WHERE provider = 'password';
```

- For `provider='password'`: `subject` = the Agent's normalised email; `secret_hash` = the
  scrypt hash (§9). One password identity per Agent — enforced by the partial unique index
  above *and* by the core identity service (§4), which refuses to link a second `password`
  identity rather than surfacing the constraint violation raw. **Email is immutable in v1** (§7.5): a
  password identity's `subject` is the login key and the `UNIQUE(provider, subject)` invariant,
  so changing an Agent's email would require rewriting the identity `subject` in lockstep and
  guarding a freed old email against later collision — deferred rather than half-built. An
  Agent record is re-created if the email must change.
- A marketplace `google` module inserts `provider='google', subject=<google sub>,
  secret_hash=NULL` — **no core migration**. A `passkey` module inserts its own rows. The
  seam (§4) is the only code that reads this table by provider.
- Deleting an Agent cascades their identities. An Agent may have several rows (password +
  google + passkey) — all resolving to the same `agents.id`. Linking additional methods to an
  existing Agent is a marketplace-module concern; core only ever writes `password`.

### 3.3 `assignee` graduates from a flag to an identity — **breaking**

Today `conversations.assignee` is `text CHECK (assignee IS NULL OR assignee = 'me')`
(migration 006), deliberately shaped to need no identity. Multi-Agent replaces it. Existing
`'me'` rows have no Agent to map to (Agents are created only after this migration, at
first-run), so they become `NULL` (unassigned) automatically — the new column defaults NULL
and the old is dropped; no `UPDATE` step. Per house style the rationale lives in the JS
doc-comment above the SQL constant, not inside the string:

```sql
ALTER TABLE conversations ADD COLUMN assignee_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE conversations DROP COLUMN assignee;
```

`ON DELETE SET NULL`: deleting an Agent un-assigns (does not delete) their conversations
(precedent: `inbound_deliveries.thread_id`). This is **one of two breaking changes** to the
existing surface (§10), coordinated backend+UI in a single deploy — exactly as
`agent-inbox-v1.md` §4f anticipated ("the multi-Agent increment replaces `'me'` with real
Agent ids") and how HT-26 was handled.

### 3.4 Per-Agent mailbox scoping — **schema now, behavior deferred** (§12.4, decided)

FreeScout scopes each user to specific mailboxes, and Helpthread already carries `mailbox_id`
throughout. **Decided (TJ, 2026-07-18): model the join table in this migration; build no
scoping behavior or UI.** v1 grants every Agent access to all mailboxes — nothing reads or
writes this table yet; it exists so the future scoping increment is data-model-compatible
from day one rather than a later migration against live rows.

```sql
CREATE TABLE agent_mailbox_access (
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mailbox_id  uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, mailbox_id)
);
```

An absent row set means "unrestricted" in v1 by definition (the table is empty and
unconsulted); the semantics of a populated table are pinned when scoping actually ships.

## 4. The auth-provider seam

The seam is an engine-side interface. It exists so the core and marketplace providers share
one contract, and so the web UI can render the right login controls for whatever is enabled.

```ts
interface AuthProvider {
  readonly key: string                       // 'password', 'google', ...
  // What the login UI needs to render this method (a password field; a "Sign in with X"
  // button + start URL). Serialised by GET /auth/providers (§6).
  descriptor(): AuthProviderDescriptor
  // Verify an attempt and resolve it to an existing Agent identity, or null.
  // 'password' reads agent_auth_identities; an OAuth module runs its own flow then maps
  // the verified external subject → an Agent. Never mints the session — that is the core's
  // job (§8); a provider only returns *who this is*.
  authenticate(attempt: AuthAttempt): Promise<VerifiedIdentity | null>
}
```

- **Registry:** the composition root (`src/composition/root.ts`, today an all-hardcoded
  `buildApp`) grows a small provider registry — an ordered list wired at composition time.
  **Core wires exactly `PasswordAuthProvider`.** A marketplace module is wired here too; the
  registry is the §1 boundary. **Honest scope note:** v1 builds the registry and the one core
  provider, *not* a dynamic module-discovery mechanism — so adding Google SSO later is still a
  core *code* edit to `root.ts` (wire one more provider), not a drop-in. That is fine and
  deliberate: the §7 boundary this spec makes concrete is the **`AuthProvider` interface + the
  provider-agnostic identity schema** (§3.2), which a module targets; the packaging/discovery
  mechanism is later marketplace infrastructure (§11), and HT-5's exception text points at the
  interface, not at a plugin loader that doesn't exist yet. Do not overclaim a plugin API is
  delivered.
- **`PasswordAuthProvider`** (core): `authenticate({email, password})` → look up the Agent by
  `lower(email)`, find its `password` identity, scrypt-verify `password` against `secret_hash`
  in constant time (§9). Returns the Agent's `VerifiedIdentity` or null. No account
  enumeration: a missing Agent and a wrong password are indistinguishable in timing and
  response (§9).
- **Identity provisioning is part of the contract, not a side door.** A provider that can
  *create/link* identities (an SSO module mapping a first-time external subject to a new or
  existing Agent) must do so through a core-owned identity service (e.g. an
  `AgentIdentityStore.link(agentId, provider, subject, secretHash?)`), **never** by writing
  `agent_auth_identities` directly — direct cross-module table writes are exactly the shared-DB
  coupling the charter's marketplace boundary exists to prevent. Core ships this service and
  uses it for `password`; a module calls it. (The link/provision API is sketched here so the
  boundary is real; its full shape lands with the first module, gated on HT-5.)
- Building the interface, the registry, the core provider, and the identity-service seam now
  is **not** speculative: it *is* the product architecture (the marketplace boundary) and the
  artifact HT-5's legal text points at. We build no marketplace scaffolding beyond that.

## 5. Roles & authorization

Two roles (your call: Admin + Agent):

- **`admin`** — manages Agents (create, edit, set role, disable, delete, resend invite),
  manages deployment settings, and can do everything an `agent` can.
- **`agent`** — works the inbox (every conversation operation in `agent-inbox-v1.md`), edits
  their **own** profile, changes their **own** password. Cannot manage other Agents or
  settings.

Authorization is enforced **in the engine**, per-endpoint, against the **acting Agent** (§8
trust model) — not in the UI (the UI hides controls, but the engine is the gate). Admin-gated
endpoints (`/agents` mutations, settings) reject a non-admin acting Agent with `403`.

**What these 403s do and don't protect (state plainly, don't over-trust).** This is the first
role authorization *for Agents coming through the web app*. It is **not** a boundary against a
holder of `HELPTHREAD_API_TOKEN`: that service token still grants the whole engine and can
assert any `X-Helpthread-Agent-Id` (§8) — including an admin's — so a bearer holder bypasses
every role check. The bearer remains a full-power *deployment* credential (as
`agent-inbox-v1.md` §5 already is); the role checks stratify the *humans behind the web app*,
not the service channel. The guardrail that keeps this honest: **the web derives the acting-Agent
header *only* from the verified session `sub`, never from any client-supplied value** (§8).

**Last-admin invariant.** A deployment must always have at least one *active* admin. Deleting,
disabling, or demoting the last active admin is refused. **A guard predicate alone is not
enough:** under Postgres's default READ COMMITTED isolation, two concurrent demotions each
running `UPDATE ... WHERE (SELECT count(*) FROM agents WHERE role='admin' AND status='active')
> 1` both see a count of 2 in their own snapshots (they touch different rows, so neither
blocks the other) — both pass, and the active-admin count drops to zero. So every mutation
that can reduce the active-admin set (demote, disable, delete an admin) runs inside a
transaction that first takes a **`pg_advisory_xact_lock`** on a single well-known key (the
same serialization tool `migrate.ts` already uses), then checks the count, then mutates —
the lock serializes the check-and-act, and the predicate stays as a belt-and-suspenders
guard inside it. The invariant is defined over **active** admins (a `disabled` admin does
not satisfy "a deployment has an admin").

## 6. Engine API (new)

All under the existing service-bearer channel (`Authorization: Bearer <HELPTHREAD_API_TOKEN>`
still authenticates the *web app → engine* call). **Agent identity rides inside** that
channel via an acting-Agent assertion (§8), it does not replace the service token.
`agent-inbox-v1.md`'s existing endpoints are unchanged except `assignee` (§3.3, §10).

Auth / bootstrap:
- **`GET /api/v1/auth/providers`** → `{ providers: AuthProviderDescriptor[], needsSetup: boolean }`.
  `needsSetup` = zero Agents exist. The web reads this to decide login vs. `/setup`, and to
  render the right controls.
- **`POST /api/v1/setup`** `{ name, email, password }` → creates the **first admin**
  (role=admin, status=active, a `password` identity). **Guarded atomically — and a predicate
  alone is not enough:** under READ COMMITTED, two concurrent
  `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM agents)` calls each see an empty table in their
  own snapshots and both insert (different emails, so no unique index saves it). The setup
  transaction therefore takes the same **`pg_advisory_xact_lock`** the last-admin guard (§5)
  uses before the zero-Agents check + insert; the `WHERE NOT EXISTS` predicate stays as a
  guard inside it. Exactly one concurrent call wins; the other gets `409`. Zero-Agents-gated
  (the RIQ superadmin pattern); the one endpoint that creates an Agent without an acting
  admin. Returns the Agent.
- **`POST /api/v1/auth/verify`** `{ providerKey, ... }` → dispatches to the named provider's
  `authenticate`; returns `{ agent }` or a **generic `401`**. For `password`:
  `{ providerKey:'password', email, password }`. **All failure modes return the same generic
  `401` with comparable timing** — unknown email, wrong password, an `invited` Agent with no
  password set, and a `disabled` Agent (even with a correct password) are indistinguishable, so
  this endpoint leaks neither existence nor status (§9). The web calls this, then mints the
  session (§8). (An Agent's `disabled`/`invited` state is surfaced only through the admin
  `/agents` endpoints, never through login.)
- **`GET /api/v1/auth/me`** → the acting Agent (`{ id, email, name, role, timezone }`) when a
  valid acting-Agent header is present and the Agent is active; **`401` when the header is
  absent or the Agent is missing/disabled**. The UI uses it to know who it is (resolves "assign
  to me", gates admin controls) and treats `401` as "log in again."

Agents (management):
Response envelopes (as built): a single Agent rides as `{ agent }` (`/setup`,
`/auth/verify`, `/auth/invite/accept`, `GET`/`PATCH /agents/{id}`), the roster as
`{ agents }`, and provider discovery as `{ providers, needsSetup }` — object envelopes
throughout, extensible without breaking clients, matching the wrapped shapes below.

- **`GET /api/v1/agents`** (any active Agent) → `{ agents: Agent[] }`. *(Amended at build time, HT-54:
  was admin-only in the draft, but the assignee UI — any Agent may assign any Agent, §5 —
  needs the roster to render names and offer choices; an admin-only list would make a
  non-admin's assignee menu impossible. The roster carries no secrets (no identities, no
  hashes). Every mutation below remains admin-gated.)*
- **`POST /api/v1/agents`** (admin) `{ name, email, role, sendInvite, password? }` → creates
  an Agent (§8 provisioning): with `sendInvite`, `status='invited'` and no password; with
  `password` (the admin-set fallback), a `password` identity and `status='active'` outright.
  Exactly one of the two paths per call. Returns the Agent.
- **`GET /api/v1/agents/{id}`** (admin, or self) → the Agent.
- **`PATCH /api/v1/agents/{id}`** (admin for anyone; self for own name/timezone) `{ name?,
  role?, status?, timezone? }` → updated Agent. **No `email`** — email is immutable in v1
  (§3.2); re-create the Agent to change it. `role`/`status` changes are admin-only and bound by
  §5's last-admin invariant. **`status` is a lifecycle, not a free field:** PATCH may only
  toggle `active` ↔ `disabled`. `invited` is neither a settable target nor a PATCH-able
  source — an `invited` Agent leaves that status only through invite acceptance (the atomic
  transition below), or by being deleted and re-created; any PATCH naming an `invited` Agent's
  `status` (either direction) is `409`. This is what keeps the §8 provisioning stories the
  only lifecycle paths: no admin edit can mint an `active` Agent with no credential, or
  strand an invite token against a status it can no longer transition.
- **`DELETE /api/v1/agents/{id}`** (admin) → **hard delete** (cascades identities;
  `ON DELETE SET NULL` un-assigns their conversations). Distinct from disable
  (`PATCH status='disabled'`, the reversible soft-off). Blocked for the last admin.
- **`POST /api/v1/agents/{id}/password`** (self, or admin reset) `{ password }` → sets/replaces
  the `password` identity's hash. **Refused (`409`) for an `invited` Agent** — a password on a
  record whose status still gates login off would be a credential that cannot be used and an
  invite token still armed against it; the invite path sets the first password atomically with
  activation, and the admin-set path creates `active` outright (§8). Allowed for `disabled`
  (an admin may rotate a disabled Agent's password; login stays off until re-enabled).
- **`POST /api/v1/agents/{id}/invite`** (admin) → (re)send the invite email (§8), when a mail
  sender is configured.
- **`POST /api/v1/auth/invite/accept`** `{ token, password }` → validate the signed invite
  token, set the Agent's password, flip `invited`→`active`. **One-time, enforced atomically:**
  the acceptance is an `UPDATE agents SET status='active' ... WHERE id=$1 AND status='invited'`
  in the same transaction as the password write — two concurrent accepts (or a replay after the
  Agent is `active`) affect zero rows and are rejected, so the token cannot set a password
  twice. Returns the Agent; the web then mints the session.

## 7. Web UI (screens, in our design system)

Modelled on the observed FreeScout UX, composed from Helpthread's existing DS primitives.
Each is a **new designed surface** requiring your fidelity sign-off (same gate as the HT-51
login screen). The Claude Design project has the login template but **not** these — they are
new. Copy uses Agent/Team vocabulary (§2), never "user".

1. **`/setup` — first run.** Shown when `needsSetup`. Create the first admin: name, email,
   password (+ confirm). One-shot; once an Agent exists, `/setup` redirects to `/login`.
   *(New surface.)*
2. **`/login` — per-Agent.** Extends HT-51's screen: **email + password** (was password
   only), verified against the engine. Renders whatever `/auth/providers` reports (a password
   form in core; premium builds add a "Sign in with …" button here — the seam surfaces).
3. **Team / Agents list** (route e.g. `/settings/team`, admin-only). FreeScout-modelled:
   cards (avatar-or-initial, name, email, a role chip), a "New Agent" action, search.
4. **New Agent** (admin-only). FreeScout-modelled wizard: **Role** (Agent/Admin), First/Last
   name, Email, and provisioning — **"Send an invite email"** (default on, when a sender is
   configured) with the *"an invite can be sent later"* fallback, **or** an **admin-set
   password** when invite is off. No password field when inviting.
5. **Agent profile / edit** (`/settings/team/{id}`; admin for anyone, self for own).
   FreeScout-modelled: Role, **Disabled** ("prevent sign-in") toggle, name, **Change password**
   (self, or admin reset), timezone; **Save** and, for admins on others, **Delete**
   (destructive, two-step per our pattern — never `confirm()`). **Email is displayed
   read-only** (immutable in v1, §3.2) — the field shows the address but cannot be edited.
6. **`/invite/{token}` — accept invite.** Validate token → set password → signed in.
   *(New surface.)*
7. **Own profile & logout** — wire the avatar menu's existing "Your profile" and "Log out"
   stubs to #5 (self) and HT-51's `logoutAction`.

## 8. Session, acting-Agent trust model, and provisioning

**Session carries identity.** HT-51's cookie payload `{v:1, iat}` becomes `{v:2, iat, sub:
<agentId>}`. The `v` field exists for exactly this bump. Signing/verification (HMAC via Web
Crypto, Edge-safe middleware — which still only *verifies* the cookie, never touching the
Agent store, so the `node:crypto`-free Edge constraint holds), the route gate, and
open-redirect hardening carry over. **One thing does NOT carry over unchanged:** the
sliding-expiry re-stamp in `middleware.ts` re-mints the cookie
(`response.cookies.set(..., await mintSessionCookie(), ...)`), so `mintSessionCookie` gains a
required `sub` parameter and the refresh path must thread it from the just-verified session
(`mintSessionCookie(session.payload.sub)`). Make `sub` **required** on `mintSessionCookie` so
the compiler rejects any call that would silently re-mint an identity-less cookie mid-session.
Existing v1 cookies fail the `v`-check closed and the (single) operator re-logs in once —
acceptable.

**Acting-Agent trust model — and the `api.ts` change it requires.** The web verifies the
session cookie (getting `sub`) and asserts it to the engine as
`X-Helpthread-Agent-Id: <agentId>`. Today `web/src/lib/api.ts`'s `request()` reads only server
env and has no access to the request's session, so this is a **real refactor, specified here,
not a free carry-over**: `request()` (server-only already) reads and verifies the session
cookie via `next/headers` and attaches the header on calls that need it. Per-endpoint rule
(pinned precisely, so neither side guesses):
  - **Header required** on every `/agents/*` op, `/auth/me`, and `PUT
    /conversations/{id}/assignee` — the one existing inbox op that now records an Agent.
  - **Other existing inbox endpoints stay service-bearer-only in this increment** — requiring
    the header there would be a third breaking change §10 doesn't make, and they neither
    record nor authorize by Agent yet. Each future increment that adds Agent authorship to an
    inbox op moves that op into the header-required set. (Consequence, stated honestly: until
    then, a `disabled` Agent holding a still-valid cookie can read/act on *conversations* for
    up to the cookie lifetime; the bound on them is `/auth/me` — which the UI consults and
    which 401s a disabled Agent — plus session expiry. The admin surface and assignee are
    bounded immediately.)
  - **Header forbidden/ignored** on the three pre-session bootstrap endpoints — `/setup`,
    `/auth/verify`, `/auth/invite/accept` — which run before a session exists, and on
    `GET /auth/providers` (same pre-session reality).
  - **Absent where required → engine returns `401`** (the web should have supplied it; treat as
    unauthenticated).
The engine, on every header-required call, **loads the asserted Agent and rejects with `401`
if the row is missing or `status='disabled'`** — this is what bounds a `disabled` or
hard-deleted Agent whose signed cookie is still valid (up to 7 days), since Edge middleware
cannot check the DB. Only after that check does it enforce role (§5) and record the actor
(assignee; future authorship).

The engine **trusts the header because the caller holds the service bearer token** — the web is
the trusted first-party that minted and verified the cookie, and (guardrail, §5) derives the
header *only* from the verified `sub`, never from client input. Identity rides *inside* the
service channel, it does not replace the service token (`agent-inbox-v1.md` §5). A future
public API issuing *per-Agent* tokens would authenticate Agents directly; out of scope — the
trust boundary is stated so it is a decision, not an accident.

**Provisioning (both paths, invite-primary).**
- **Invite (default, needs a configured sender):** `POST /agents` with `sendInvite` creates an
  Agent (`status='invited'`), the engine mints a **signed, expiring, one-time invite token**
  on the same `Keyring`/HMAC pattern reply and Gmail-`state` tokens use (stateless,
  serverless-safe, `issuedAtMs`+nonce, carrying the `agentId`) — with a **distinct
  domain-separator prefix** (`hti.` — never reusing the reply-token `ht.` or Gmail-state `gmc.`
  prefixes) so an invite signature can never verify as another token type. The invite email
  goes out through the deployment's own **`EmailSender` transport** — the core outbound sender
  (`src/providers/email-sender.ts`, Gmail adapter), reached by building a fresh `OutboundEmail`
  and calling the sender directly. It does **not** go through `sendReply`/`src/mail/send.ts`
  (which is reply-specific: it mints a reply token, persists an outbound *thread*, snapshots
  `send_envelope`, and holds a delivery lease — an invite has no conversation, so routing it
  there would create bogus thread rows). No new dependency: the sender is already core. The
  link → `/invite/{token}` → set password → `active` (the atomic transition, §6).
- **Admin-set password (fallback + first-run reality):** when invite is off (or no sender is
  connected yet — a fresh deploy can't email before it can), the admin sets the Agent's
  initial password inline; the Agent signs in with it and may change it. Always available; the
  only path that works before a mailbox is connected. (FreeScout's "an invite can be sent
  later" is the same admission.) **This path creates the Agent directly as `active`** — it has
  a usable password from the moment it exists, `invited` would be a lie the login path (§6)
  would then have to special-case, and no invite token is ever minted for it. This is honestly
  an *admin-set* password, not a temporary one: v1 has no forced-change-on-first-login
  machinery or credential expiry (deferred, §11), so nothing forces the Agent to rotate it —
  the admin handing over the password out-of-band is the trust step, same as FreeScout.

**Retiring HT-51's shared password.** `HELPTHREAD_UI_PASSWORD` is *replaced*, not extended
(per HT-51's own note). On deploy: if zero Agents exist, the web routes to `/setup`; the old
single password stops being consulted. `HELPTHREAD_UI_SESSION_SECRET` stays (it signs the
now-identity-carrying cookie). Document the retirement in the runbook and README.

## 9. Security

- **Password hashing at rest — now real.** Unlike HT-51 (which compared against a plaintext
  env value and used scrypt only as a length-blind), there is now a **hash at rest**
  (`agent_auth_identities.secret_hash`), so a slow KDF genuinely matters. Use **scrypt**
  (`node:crypto`, no new dep) with a **per-identity random salt** stored alongside the hash
  (encode salt+params+hash in one string). Verify in constant time. CodeQL's
  `js/insufficient-password-hash` is satisfied by scrypt (learned on HT-51).
- **No account enumeration.** `POST /auth/verify` returns the same `401` and comparable timing
  whether the email is unknown or the password wrong (do the scrypt work against a dummy hash
  on a missing Agent).
- **Invite tokens:** signed (Keyring HMAC, distinct `hti.` prefix), short-lived, one-time —
  consumed by the atomic `invited`→`active` transition (§6), so a replay after `active` affects
  zero rows and is rejected. Never a bare random in a URL without a signature; never logged.
  (No email-based *reset* token in v1 — admin reset is direct via `POST /agents/{id}/password`,
  §11. Self-service reset, if added later, acts on an already-`active` Agent, so it cannot lean
  on the status transition for one-time-ness — it will need its own mechanism, e.g. a
  per-identity token nonce/version; called out so it is not assumed free.)
- **Session crypto** unchanged from HT-51 (HMAC, Web Crypto on Edge). Middleware still only
  *verifies* the cookie — it never touches the Agent store, so the Edge/`node:crypto`
  constraint holds.
- **Rate-limiting** remains the HT-51 per-instance gap
  ([HT-53](https://resonantiq.atlassian.net/browse/HT-53)) — now more pressing with multiple
  accounts and a public login. Not solved here; called out.
- **Charter "own your data":** identity is entirely self-contained in the operator's own
  Postgres. No Helpthread-hosted identity service, ever. A premium Google-SSO module uses the
  *operator's own* Google Workspace (OIDC), not ours.
- **No secret in the client bundle** (the HT-51 gate): password verification and hashing are
  server-only (engine); the web never sees a hash. `web/` gains no DB access.

## 10. Rollout

Two breaking changes, both coordinated single-deploy (dogfood = one deploy, per HT-16/HT-26):

1. **`assignee` shape** (§3.3): `PUT /conversations/{id}/assignee` body becomes
   `{ assigneeAgentId: uuid | null }` (was `{ assignee: 'me' | null }`); the summary field
   likewise. The UI's "Assign to me" resolves `me` → the current Agent id client-side (from
   `/auth/me`). Existing `'me'` rows migrate to `NULL`.
2. **Session payload `v1`→`v2`** (§8): the operator re-logs in once.

Everything else is additive (new tables, new endpoints, new screens). `HELPTHREAD_UI_PASSWORD`
is retired (§8).

## 11. What this is NOT (scope)

- **No marketplace providers** (Google SSO, magic-link, passkey, SAML) — only the seam + the
  free `password` provider. Premium modules wait on the HT-5 §7 exception text.
- **No entitlement/licensing machinery** — separate marketplace infrastructure.
- **No per-Agent mailbox scoping** (§3.4) — deferred; the model accommodates it.
- **No teams/groups, granular permissions, or per-mailbox roles** (FreeScout has these;
  out of scope for a two-role v1).
- **No per-Agent API tokens / public multi-Agent API** — the acting-Agent assertion (§8) is
  the first-party trust model; direct Agent-authenticated API is later.
- **No forced password change / credential expiry** — the admin-set-password fallback (§8)
  hands over a real password, not a temporary one; must-change-on-first-login state is a
  later addition if wanted.
- **No SCIM provisioning, audit log, or password-reset-by-email** for the forgotten case
  (admin reset covers v1; self-service email reset can follow, but needs its own one-time
  mechanism — it acts on an already-`active` Agent, so it cannot reuse the invite token's
  status-transition consumption, §9).

## 12. Decision points for TJ (called out, not silently taken)

1. **Roles:** Admin + Agent. *(Confirmed.)*
2. **First admin:** `/setup` first-run screen, zero-Agents-guarded. *(Confirmed.)*
3. **Provisioning:** both — invite-primary (via the core `EmailSender`) + admin-set-password
   fallback. *(Recommended; FreeScout confirms.)*
4. **Per-Agent mailbox scoping (§3.4):** model the `agent_mailbox_access` table in this
   migration; no scoping behavior or UI. *(Confirmed — TJ, 2026-07-18.)*
5. **Profile fields (§3.1):** lean v1 — name, email, password, role, disable, **timezone**;
   avatar, job title, phone, alternate-emails, language, time-format **deferred**. *(Open.)*
6. **Acting-Agent trust model (§8):** the web asserts the Agent id under the service token,
   vs. issuing per-Agent tokens now. *(Recommend the assertion model; per-Agent tokens later.)*

## Changelog

- **draft.4 (2026-07-18, HT-54 build):** `GET /agents` opened to any active Agent (was
  admin-only) — the assignee UI needs the roster; mutations stay admin-gated (§6).
- **draft.3 (2026-07-18):** status is a closed lifecycle (CodeRabbit round 2): PATCH may
  only toggle `active`↔`disabled`; `invited` exits solely via invite acceptance (or
  delete/re-create); password writes on an `invited` Agent are refused (§6) — closing the
  incoherent states (credential-less `active`, permanently-stranded invite, unusable
  password) an unconstrained `status` field permitted.
- **draft.2 (2026-07-18):** decisions resolved for the build (TJ's HT-54 go-ahead):
  `agent_mailbox_access` is modelled now, schema-only, no behavior (§3.4, §12.4 confirmed);
  the acting-Agent header rule pinned per-endpoint — required on `/agents/*`, `/auth/me`,
  and `PUT .../assignee`; other inbox endpoints stay bearer-only this increment, with the
  disabled-Agent consequence stated (§8).
- **draft.1 (2026-07-18):** review fixes from PR #69 (CodeRabbit): the admin-set-password
  path creates Agents directly `active` (resolving the `invited`-status contradiction — an
  Agent whose login is uniformly 401'd at `invited` could never "activate on first login"),
  and is named honestly (admin-set, not temporary; forced-change deferred, §11);
  one-password-identity-per-Agent becomes a partial unique index plus an identity-service
  check (§3.2); `/setup` and the last-admin guard are serialized with `pg_advisory_xact_lock`
  (guard predicates alone race under READ COMMITTED — both concurrent callers see the same
  snapshot); vocabulary nit in §2.
- **draft (2026-07-18):** initial contract — data model (§3), auth-provider seam (§4), roles
  (§5), engine API (§6), UI screens (§7), session/trust/provisioning (§8), security (§9),
  rollout (§10). Replaces the HT-51 single-operator password per that ticket's own mandate.
  Hardened after an independent adversarial review against the codebase/charter: the session
  refresh path threads `sub` (was silently dropping identity mid-session); the acting-Agent
  header is specified as a real `api.ts` change with a per-endpoint rule and an engine-side
  status/existence re-check (bounding disabled/deleted Agents whose cookie is still valid);
  `/setup`, last-admin, and invite-accept are atomic (no check-then-act races); login returns a
  uniform `401` for unknown/wrong/invited/disabled (no status leak); the temp-password path
  transitions to `active`; the §7 boundary claim is scoped to the interface + provider-agnostic
  schema (not a plugin loader) and adds an identity-service seam so modules never write core
  tables directly; invites use the `EmailSender` *transport* (not `sendReply`) with a distinct
  `hti.` token prefix; email is immutable in v1; the bearer-token-bypasses-role-checks boundary
  is stated plainly.
