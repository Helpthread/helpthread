# Agents & Authentication

Status: **draft** (2026-07-18, amended 2026-07-19 — see Changelog). The contract for real
per-Agent identity, login, and user management, replacing the single shared operator
password that shipped as a deliberate placeholder. Authored on Helpthread's own domain
model and rendered entirely in Helpthread's own design system.

This supersedes the single-operator posture of `agent-inbox-v1.md` §1/§5/§6, whose own note
mandates the direction: *"when multi-Agent lands it is expected to **replace** this single
shared password with real per-Agent accounts, not extend it."*

## 1. Purpose & the core / marketplace boundary

Two audiences pull authentication in different directions; this spec serves both by
splitting them at a seam:

- **The self-hosted, open-source product (AGPL core):** must ship a complete, honest login
  with no dependency on any hosted identity service or third-party provider. That is
  **username/password** — a real, self-contained auth system.
- **Resonant IQ's own deployment, and paying customers:** want Google SSO, magic-link,
  SAML/enterprise SSO. These are **licensed marketplace modules**, not part of the free
  core. **Passkey login (WebAuthn) is the one exception — it is core, not a marketplace
  module:** security hygiene is always free (decided 2026-07-18). When built it ships as a
  second **core** auth provider on this same seam (catalog §2.2), never through the
  marketplace path. Not built in this increment (§11).

The mechanism that makes both true at once is an **auth-provider seam** (§4). The core ships
the seam and exactly one provider — `password`. A marketplace module registers an additional
provider against it. **This seam is a concrete instance of the AGPL-3.0 §7
module-marketplace boundary** the charter is built around and that counsel is defining
(critical path). Building the seam and the free `password` provider in core is AGPL-clean
and can proceed now; it also gives counsel a *concrete* boundary to write the exception text
against. Shipping any premium provider module waits on that text being counsel-final (the
charter requires the §7 exception be final before the first external module merges).
**Entitlement/licensing enforcement** is separate marketplace infrastructure and out of
scope — the seam simply loads whatever providers are registered.

The free core stands entirely on its own: password login is a *real* login, not a crippled
demo. Premium providers attach with **zero core-schema change** (§3.2 is why).

## 2. Vocabulary (charter, fixed)

**Agent** = a human member of the support staff who operates the inbox. **Assistant** = an
AI actor. Never conflated. The identity records this spec introduces are **Agents** — never
"users" in schema, API, or UI copy. The API resource is `/agents`; copy says "Agents" or
"Team".

## 3. Data model

Three new tables (`agents`, `agent_auth_identities`, `agent_mailbox_access` §3.4) plus one
`ALTER` (assignee, §3.3) in the engine's Postgres (`src/db/migrate.ts`, next migration ids).
Web has no DB access (`agent-inbox-v1.md`'s API-first rule) — all of this is reachable only
through the engine API (§6).

### 3.1 `agents` — the identity

```sql
CREATE TABLE agents (   id          uuid PRIMARY KEY DEFAULT gen_random_uuid,
  email       text NOT NULL,                       -- normalised lower-case; unique (below)
  name        text NOT NULL,                        -- display name, "First Last"
  role        text NOT NULL DEFAULT 'agent'
                CHECK (role IN ('admin', 'agent')), -- §5
  status      text NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited', 'active', 'disabled')),
  timezone    text NOT NULL DEFAULT 'UTC',          -- the one profile nicety in v1 (§7 decision)
  created_at  timestamptz NOT NULL DEFAULT now,
  updated_at  timestamptz NOT NULL DEFAULT now
);
CREATE UNIQUE INDEX agents_email_key ON agents (lower(email));
```

`status`: `invited` = created via the invite path, no usable password yet — **only** the
invite path produces this status; `active` = can sign in; `disabled` = soft-off, cannot sign
in, records and history retained. **Both provisioning paths converge on `active`** — invite
acceptance flips `invited`→`active` (§6), and an admin-set-password Agent is created `active`
outright (§8) — so a working Agent is never left at `invited`. Login (`/auth/verify`) treats
`invited` and `disabled` identically to a wrong password: a generic `401`, no status leak
(§6, §9). Deletion is separate and hard (§6).

### 3.2 `agent_auth_identities` — *how* an Agent proves who they are

This is the table that makes the marketplace work. **One Agent, many login methods.**

```sql
CREATE TABLE agent_auth_identities (   id           uuid PRIMARY KEY DEFAULT gen_random_uuid,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider     text NOT NULL,          -- 'password' (core, v1); 'google','saml',... (marketplace);
                                       -- 'passkey' is core too (§1) but stores its credentials in
                                       -- webauthn_credentials (passkeys.md §2.1), never here
  subject      text NOT NULL,          -- provider's stable identifier for this Agent
  secret_hash  text,                   -- scrypt hash for 'password'; NULL for OAuth-style providers
  created_at   timestamptz NOT NULL DEFAULT now,
  updated_at   timestamptz NOT NULL DEFAULT now,
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
  *and* by the core identity service (§4), which refuses to link a second `password` identity
  rather than surfacing the constraint violation raw. **Email is immutable in v1** (§12.5): a
  password identity's `subject` is the login key and the `UNIQUE(provider, subject)`
  invariant, so changing an email would require rewriting the `subject` in lockstep and
  guarding the freed old address against later collision — deferred rather than half-built.
  Re-create the Agent if the email must change.
- A marketplace `google` module inserts `provider='google', subject=<google sub>,
  secret_hash=NULL` — **no core migration**. The seam (§4) is the only code that reads this
  table by provider.
- **A `passkey`/WebAuthn provider does not use this table.** WebAuthn's per-credential
  mutable state (signature counter, transports, backup flags) has no analog in this table's
  one-row-one-optional-secret shape, so it gets its own `webauthn_credentials`
  (`specs/auth/passkeys.md` §2.1) — the same move `mailbox_oauth_tokens` already made for
  Gmail's OAuth material. Cardinality is **not** the reason: nothing here restricts
  `provider='passkey'` to one row per Agent. This table remains the right shape for
  single-secret, single-subject providers like `google`.
- Deleting an Agent cascades their identities. An Agent may have several rows (`password`
  plus any OAuth-style provider) — all resolving to the same `agents.id`. Linking additional
  methods is a marketplace-module concern; core writes only `password` today, with passkey
  landing as a second core-written provider storing credentials elsewhere.

### 3.3 `assignee` graduates from a flag to an identity — **breaking**

Today `conversations.assignee` is `text CHECK (assignee IS NULL OR assignee = 'me')`
(migration 006), deliberately shaped to need no identity. Existing `'me'` rows have no Agent
to map to (Agents are created only after this migration, at first-run), so they become `NULL`
automatically — the new column defaults NULL and the old is dropped, with no `UPDATE` step.
Per house style the rationale lives in the JS doc-comment above the SQL constant, not inside
the string:

```sql
ALTER TABLE conversations ADD COLUMN assignee_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE conversations DROP COLUMN assignee;
```

`ON DELETE SET NULL`: deleting an Agent un-assigns (does not delete) their conversations —
precedent `inbound_deliveries.thread_id`. This is **one of two breaking changes** (§10),
coordinated backend+UI in a single deploy, exactly as `agent-inbox-v1.md` §4f anticipated.

### 3.4 Per-Agent mailbox scoping — **grants managed now, enforcement deferred** (§12.4)

Helpthread scopes each Agent to specific mailboxes and already carries `mailbox_id`
throughout. **Superseding the original schema-only scope (maintainer decision,
2026-07-18)**: the grants are real, managed data — auto-granted at Agent creation, read and
written through the §6 endpoints and the per-Agent Permissions screen (§7). What remains
deferred is *enforcement of conversation visibility*.

```sql
CREATE TABLE agent_mailbox_access (   agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mailbox_id  uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now,
  PRIMARY KEY (agent_id, mailbox_id)
);
```

**Semantics pinned (maintainer, 2026-07-18 — the Permissions UI ships now):**

- **Admins have implicit access to all mailboxes** — grant rows are never consulted for an
  admin.
- A non-admin Agent's mailbox access = their rows in this table.
- **Every newly created Agent (any role, both provisioning paths and `/setup`) is
  auto-granted all mailboxes existing at creation time**, in the same transaction — no Agent
  is born locked out of the deployment's only inbox, and rows on an admin are harmless
  bookkeeping that becomes meaningful if they are ever demoted.
- Grants are managed via the §6 endpoints and the per-Agent Permissions screen (§7).
- **Enforcement of conversation visibility is deferred to the multi-mailbox increment**:
  `conversations` carries no `mailbox_id` today, so there is nothing to filter by. When
  conversations gain one, reads filter by the acting Agent's grants (admins unfiltered).
  Until then the grants are real, managed data the enforcement increment consults on arrival.

## 4. The auth-provider seam

An engine-side interface, so core and marketplace providers share one contract and the web
UI can render the right login controls for whatever is enabled.

```ts
interface AuthProvider {
  readonly key: string                       // 'password', 'google', ...
  // What the login UI needs to render this method (a password field; a "Sign in with X"
  // button + start URL). Serialised by GET /auth/providers (§6).
  descriptor: AuthProviderDescriptor
  // Verify an attempt and resolve it to an existing Agent identity, or null.
  // 'password' reads agent_auth_identities; an OAuth module runs its own flow then maps
  // the verified external subject → an Agent. Never mints the session — that is the core's
  // job (§8); a provider only returns *who this is*.
  authenticate(attempt: AuthAttempt): Promise<VerifiedIdentity | null>
}
```

- **Registry:** the composition root (`src/composition/root.ts`) grows a small provider
  registry — an ordered list wired at composition time. **Core wires exactly
  `PasswordAuthProvider`.** A marketplace module is wired here too; the registry is the §1
  boundary. **Honest scope note:** v1 builds the registry and the one core provider, *not* a
  dynamic module-discovery mechanism — adding Google SSO later is still a core *code* edit to
  `root.ts`, not a drop-in. The §7 boundary this spec makes concrete is the **`AuthProvider`
  interface + the provider-agnostic identity schema** (§3.2), which a module targets; the
  packaging/discovery mechanism is later marketplace infrastructure (§11), and the module-API
  exception points at the interface, not at a loader that doesn't exist yet. Do not overclaim
  a module API is delivered.
- **`PasswordAuthProvider`** (core): `authenticate({email, password})` → look up the Agent by
  `lower(email)`, find its `password` identity, scrypt-verify against `secret_hash` in
  constant time (§9). Returns the Agent's `VerifiedIdentity` or null. A missing Agent and a
  wrong password are indistinguishable in timing and response (§9).
- **Identity provisioning is part of the contract, not a side door.** A provider that can
  *create or link* identities (an SSO module mapping a first-time external subject to an
  Agent) must do so through a core-owned identity service (e.g.
  `AgentIdentityStore.link(agentId, provider, subject, secretHash?)`), **never** by writing
  `agent_auth_identities` directly — direct cross-module table writes are exactly the
  shared-DB coupling the charter's marketplace boundary exists to prevent. Core ships this
  service and uses it for `password`; a module calls it. Its full shape lands with the first
  module, gated on final legal review.

## 5. Roles & authorization

Two roles:

- **`admin`** — manages Agents (create, edit, set role, disable, delete, resend invite),
  manages deployment settings, and can do everything an `agent` can.
- **`agent`** — works the inbox (every conversation operation in `agent-inbox-v1.md`), edits
  their **own** profile, changes their **own** password. Cannot manage other Agents or
  settings.

Authorization is enforced **in the engine**, per-endpoint, against the **acting Agent** (§8)
— not in the UI. The UI hides controls; the engine is the gate. Admin-gated endpoints
(`/agents` mutations, settings) reject a non-admin acting Agent with `403`.

**What these 403s do and don't protect.** This is role authorization *for Agents coming
through the web app*. It is **not** a boundary against a holder of `HELPTHREAD_API_TOKEN`:
that service token grants the whole engine and can assert any `X-Helpthread-Agent-Id` (§8),
including an admin's, so a bearer holder bypasses every role check. The bearer remains a
full-power *deployment* credential; the role checks stratify the *humans behind the web app*,
not the service channel. The guardrail that keeps this honest: **the web derives the
acting-Agent header *only* from the verified session `sub`, never from any client-supplied
value** (§8).

**Last-admin invariant.** A deployment must always have at least one *active* admin.
Deleting, disabling, or demoting the last one is refused. **A guard predicate alone is not
enough:** under Postgres's default READ COMMITTED isolation, two concurrent demotions each
running `UPDATE ... WHERE (SELECT count(*) FROM agents WHERE role='admin' AND
status='active') > 1` both see a count of 2 in their own snapshots (they touch different
rows, so neither blocks the other) — both pass, and the count drops to zero. So every
mutation that can reduce the active-admin set runs inside a transaction that first takes a
**`pg_advisory_xact_lock`** on a single well-known key (the same tool `migrate.ts` already
uses), then checks the count, then mutates. The predicate stays as a belt-and-suspenders
guard inside it. The invariant is defined over **active** admins — a `disabled` admin does
not satisfy it.

## 6. Engine API (new)

All under the existing service-bearer channel (`Authorization: Bearer
<HELPTHREAD_API_TOKEN>` still authenticates the *web app → engine* call). **Agent identity
rides inside** that channel via an acting-Agent assertion (§8); it does not replace the
service token. `agent-inbox-v1.md`'s existing endpoints are unchanged except `assignee`
(§3.3, §10).

Response envelopes (as built): a single Agent rides as `{ agent }` (`/setup`,
`/auth/verify`, `/auth/invite/accept`, `GET`/`PATCH /agents/{id}`), the roster as
`{ agents }`, provider discovery as `{ providers, needsSetup }` — object envelopes
throughout, extensible without breaking clients.

**Auth / bootstrap**

- **`GET /api/v1/auth/providers`** → `{ providers: AuthProviderDescriptor[], needsSetup:
  boolean }`. `needsSetup` = zero Agents exist. The web reads this to decide login vs.
  `/setup`, and to render the right controls.
- **`POST /api/v1/setup`** `{ name, email, password }` → creates the **first admin**
  (role=admin, status=active, a `password` identity). **Guarded atomically — a predicate
  alone is not enough:** under READ COMMITTED, two concurrent `INSERT ... WHERE NOT EXISTS
  (SELECT 1 FROM agents)` calls each see an empty table in their own snapshots and both
  insert (different emails, so no unique index saves it). The setup transaction takes the
  same **`pg_advisory_xact_lock`** §5 uses before the zero-Agents check + insert; the `WHERE
  NOT EXISTS` predicate stays as a guard inside it. Exactly one concurrent call wins; the
  other gets `409`. The one endpoint that creates an Agent without an acting admin.
- **`POST /api/v1/auth/verify`** `{ providerKey, ... }` → dispatches to the named provider's
  `authenticate`; returns `{ agent }` or a **generic `401`**. For `password`: `{
  providerKey:'password', email, password }`. **All failure modes return the same generic
  `401` with comparable timing** — unknown email, wrong password, an `invited` Agent with no
  password set, and a `disabled` Agent with a correct password are indistinguishable, so this
  endpoint leaks neither existence nor status (§9). The web calls this, then mints the
  session (§8).
- **`GET /api/v1/auth/me`** → the acting Agent (`{ id, email, name, role, timezone }`) when a
  valid acting-Agent header is present and the Agent is active; **`401` when the header is
  absent or the Agent is missing/disabled**. The UI uses it to know who it is (resolves
  "assign to me", gates admin controls) and treats `401` as "log in again."

**Agents (management)**

- **`GET /api/v1/agents`** (any active Agent) → `{ agents: Agent[] }`. *Not admin-only: the
  assignee UI lets any Agent assign any Agent (§5) and needs the roster to render names, so
  an admin-only list would make a non-admin's assignee menu impossible. The roster carries no
  secrets — no identities, no hashes. Every mutation below remains admin-gated.*
- **`POST /api/v1/agents`** (admin) `{ name, email, role, sendInvite, password? }` → creates
  an Agent (§8): with `sendInvite`, `status='invited'` and no password; with `password` (the
  admin-set fallback), a `password` identity and `status='active'` outright. Exactly one of
  the two paths per call.
- **`GET /api/v1/agents/{id}`** (admin, or self) → the Agent.
- **`PATCH /api/v1/agents/{id}`** (admin for anyone; self for own name/timezone) `{ name?,
  role?, status?, timezone? }`. **No `email`** — immutable in v1 (§3.2); re-create the Agent
  to change it. `role`/`status` changes are admin-only and bound by §5's last-admin
  invariant. **`status` is a lifecycle, not a free field:** PATCH may only toggle `active` ↔
  `disabled`. `invited` is neither a settable target nor a PATCH-able source — an `invited`
  Agent leaves that status only through invite acceptance, or by being deleted and
  re-created; any PATCH naming an `invited` Agent's `status` in either direction is `409`.
  This keeps §8's provisioning stories the only lifecycle paths: no admin edit can mint an
  `active` Agent with no credential, or strand an invite token against a status it can no
  longer transition.
- **`DELETE /api/v1/agents/{id}`** (admin) → **hard delete** (cascades identities; `ON DELETE
  SET NULL` un-assigns their conversations). Distinct from disable (`PATCH
  status='disabled'`, the reversible soft-off). Blocked for the last admin.
- **`POST /api/v1/agents/{id}/password`** (self, or admin reset) `{ password }` →
  sets/replaces the `password` identity's hash. **Refused (`409`) for an `invited` Agent** —
  a password on a record whose status gates login off would be an unusable credential with an
  invite token still armed against it; the invite path sets the first password atomically
  with activation, and the admin-set path creates `active` outright (§8). Allowed for
  `disabled` (an admin may rotate the password; login stays off until re-enabled).
- **`POST /api/v1/agents/{id}/invite`** (admin) → (re)send the invite email (§8), when a mail
  sender is configured.
- **`POST /api/v1/auth/invite/accept`** `{ token, password }` → validate the signed invite
  token, set the password, flip `invited`→`active`. **One-time, enforced atomically:** the
  acceptance is an `UPDATE agents SET status='active' ... WHERE id=$1 AND status='invited'`
  in the same transaction as the password write — two concurrent accepts, or a replay after
  the Agent is `active`, affect zero rows and are rejected, so the token cannot set a
  password twice. Returns the Agent; the web then mints the session.

**Mailbox access** (§3.4, all admin-only; the acting-Agent header is required)

- **`GET /api/v1/mailboxes`** → `{ mailboxes: [{ id, address, status }] }` — the roster the
  Permissions screen renders checkboxes from.
- **`GET /api/v1/agents/{id}/mailboxes`** → `{ mailboxIds: string[] }` — the target Agent's
  raw grants (returned as stored even for admin targets; the UI shows admins the
  implicit-access note instead of checkboxes).
- **`PUT /api/v1/agents/{id}/mailboxes`** `{ mailboxIds: string[] }` → replace-set in one
  transaction; every id must name an existing mailbox (`400` otherwise); unknown agent →
  `404`. Valid for any target status — grants are lifecycle-agnostic bookkeeping.

## 7. Web UI (screens, in our design system)

Composed from Helpthread's existing design-system primitives. Each is a **new designed
surface requiring the maintainer's fidelity sign-off** (same gate as the login screen) — the
Claude Design project has the login template but not these. Copy uses Agent/Team vocabulary
(§2), never "user".

1. **`/setup` — first run.** Shown when `needsSetup`. Create the first admin: name, email,
   password (+ confirm). One-shot; once an Agent exists, `/setup` redirects to `/login`.
2. **`/login` — per-Agent.** Extends the original login screen: **email + password** (was
   password only), verified against the engine. Renders whatever `/auth/providers` reports —
   a password form in core; premium builds add a "Sign in with …" button here.
3. **Team / Agents list** (e.g. `/settings/team`, admin-only): cards (avatar-or-initial,
   name, email, a role chip), a "New Agent" action, search.
4. **New Agent** (admin-only). Wizard: **Role** (Agent/Admin), First/Last name, Email, and
   provisioning — **"Send an invite email"** (default on, when a sender is configured) with
   the *"an invite can be sent later"* fallback, **or** an **admin-set password** when invite
   is off. No password field when inviting.
5. **Agent profile / edit** (`/settings/team/{id}`; admin for anyone, self for own). Role,
   **Disabled** ("prevent sign-in") toggle, name, **Change password** (self, or admin reset),
   timezone; **Save** and, for admins on others, **Delete** (destructive, two-step per our
   pattern — never `confirm`). **Email is displayed read-only** (immutable in v1, §3.2).
6. **`/invite/{token}` — accept invite.** Validate token → set password → signed in.
7. **Own profile & logout** — wire the avatar menu's existing "Your profile" and "Log out"
   stubs to #5 (self) and the existing `logoutAction`.

## 8. Session, acting-Agent trust model, and provisioning

**Session carries identity.** The cookie payload `{v:1, iat}` becomes `{v:2, iat, sub:
<agentId>}`; the `v` field exists for exactly this bump. Signing/verification (HMAC via Web
Crypto, Edge-safe middleware — which still only *verifies* the cookie, never touching the
Agent store, so the `node:crypto`-free Edge constraint holds), the route gate, and
open-redirect hardening carry over. **One thing does not:** the sliding-expiry re-stamp in
`middleware.ts` re-mints the cookie, so `mintSessionCookie` gains a **required** `sub`
parameter and the refresh path threads it from the just-verified session
(`mintSessionCookie(session.payload.sub)`). Required, so the compiler rejects any call that
would silently re-mint an identity-less cookie mid-session. Existing v1 cookies fail the
`v`-check closed and the operator re-logs in once.

**Acting-Agent trust model — and the `api.ts` change it requires.** The web verifies the
session cookie (getting `sub`) and asserts it to the engine as `X-Helpthread-Agent-Id:
<agentId>`. Today `web/src/lib/api.ts`'s `request` reads only server env and has no access to
the request's session, so this is a **real refactor, not a free carry-over**: `request`
(server-only already) reads and verifies the session cookie via `next/headers` and attaches
the header on calls that need it. Per-endpoint rule, pinned so neither side guesses:

- **Header required** on every `/agents/*` op, `/auth/me`, and `PUT
  /conversations/{id}/assignee` — the one existing inbox op that now records an Agent.
- **Other existing inbox endpoints stay service-bearer-only this increment** — requiring the
  header there would be a third breaking change §10 doesn't make, and they neither record nor
  authorize by Agent yet. Each future increment that adds Agent authorship to an inbox op
  moves that op into the header-required set. *Consequence, stated honestly: until then, a
  `disabled` Agent holding a still-valid cookie can read and act on conversations for up to
  the cookie lifetime. The bound on them is `/auth/me` — which the UI consults and which 401s
  a disabled Agent — plus session expiry. The admin surface and assignee are bounded
  immediately.*
- **Header forbidden/ignored** on the pre-session bootstrap endpoints — `/setup`,
  `/auth/verify`, `/auth/invite/accept`, and `GET /auth/providers`.
- **Absent where required → engine returns `401`.**

The engine, on every header-required call, **loads the asserted Agent and rejects with `401`
if the row is missing or `status='disabled'`** — this is what bounds a disabled or
hard-deleted Agent whose signed cookie is still valid (up to 7 days), since Edge middleware
cannot check the DB. Only then does it enforce role (§5) and record the actor.

The engine **trusts the header because the caller holds the service bearer token** — the web
is the trusted first-party that minted and verified the cookie and derives the header only
from the verified `sub`. Identity rides *inside* the service channel; it does not replace the
service token. A future public API issuing *per-Agent* tokens would authenticate Agents
directly; out of scope — the trust boundary is stated so it is a decision, not an accident.

**Provisioning (both paths, invite-primary).**

- **Invite (default, needs a configured sender):** `POST /agents` with `sendInvite` creates
  the Agent (`status='invited'`), and the engine mints a **signed, expiring, one-time invite
  token** on the same `Keyring`/HMAC pattern reply and Gmail-`state` tokens use (stateless,
  serverless-safe, `issuedAtMs` + nonce, carrying the `agentId`) — with a **distinct
  domain-separator prefix** (`hti.`, never reusing the reply-token `ht.` or Gmail-state
  `gmc.`) so an invite signature can never verify as another token type. The email goes out
  through the deployment's own **`EmailSender` transport** (`src/providers/email-sender.ts`),
  reached by building a fresh `OutboundEmail` and calling the sender directly. It does
  **not** go through `sendReply`/`src/mail/send.ts`, which is reply-specific — it mints a
  reply token, persists an outbound *thread*, snapshots `send_envelope`, and holds a delivery
  lease, and an invite has no conversation, so routing it there would create bogus thread
  rows. No new dependency: the sender is already core. Link → `/invite/{token}` → set
  password → `active` (the atomic transition, §6).
- **Admin-set password (fallback + first-run reality):** when invite is off, or no sender is
  connected yet (a fresh deploy cannot email before it can), the admin sets the initial
  password inline; the Agent signs in with it and may change it. Always available; the only
  path that works before a mailbox is connected. **This path creates the Agent directly as
  `active`** — it has a usable password from the moment it exists, and `invited` would be a
  lie the login path (§6) would then have to special-case. No invite token is ever minted for
  it. This is honestly an *admin-set* password, not a temporary one: v1 has no
  forced-change-on-first-login machinery or credential expiry (§11), so nothing forces
  rotation — the admin handing the password over out-of-band is the trust step.

**Retiring the shared password.** `HELPTHREAD_UI_PASSWORD` is *replaced*, not extended. On
deploy: if zero Agents exist, the web routes to `/setup`; the old single password stops being
consulted. `HELPTHREAD_UI_SESSION_SECRET` stays (it signs the now-identity-carrying cookie).
Document the retirement in the runbook and README.

## 9. Security

- **Password hashing at rest — now real.** The placeholder compared against a plaintext env
  value and used scrypt only as a length-blind; there is now a **hash at rest**
  (`agent_auth_identities.secret_hash`), so a slow KDF genuinely matters. Use **scrypt**
  (`node:crypto`, no new dep) with a **per-identity random salt** stored alongside the hash
  (encode salt + params + hash in one string). Verify in constant time. This satisfies
  CodeQL's `js/insufficient-password-hash`.
- **No account enumeration.** `POST /auth/verify` returns the same `401` and comparable
  timing whether the email is unknown or the password wrong — do the scrypt work against a
  dummy hash on a missing Agent.
- **Invite tokens:** signed (Keyring HMAC, distinct `hti.` prefix), short-lived, one-time —
  consumed by the atomic `invited`→`active` transition (§6), so a replay after `active`
  affects zero rows. Never a bare random in a URL without a signature; never logged. *No
  email-based reset token in v1 — admin reset is direct via `POST /agents/{id}/password`
  (§11). Self-service reset, if added later, acts on an already-`active` Agent and so cannot
  lean on the status transition for one-time-ness; it will need its own mechanism (e.g. a
  per-identity token nonce/version). Called out so it is not assumed free.*
- **Session crypto** remains HMAC using Web Crypto on Edge. Middleware only *verifies* the
  cookie — it never touches the Agent store, so the Edge/`node:crypto` constraint holds.
- **Rate limiting** remains a per-instance gap — more pressing with multiple accounts and a
  public login. Not solved here; called out.
- **Charter "own your data":** identity is entirely self-contained in the operator's own
  Postgres. No Helpthread-hosted identity service, ever. A premium Google-SSO module uses the
  *operator's own* Google Workspace (OIDC), not ours.
- **No secret in the client bundle:** password verification and hashing are server-only
  (engine); the web never sees a hash. `web/` gains no DB access.

## 10. Rollout

Two breaking changes, both coordinated in a single deployment:

1. **`assignee` shape** (§3.3): `PUT /conversations/{id}/assignee` body becomes `{
   assigneeAgentId: uuid | null }` (was `{ assignee: 'me' | null }`); the summary field
   likewise. The UI's "Assign to me" resolves `me` → the current Agent id client-side (from
   `/auth/me`). Existing `'me'` rows migrate to `NULL`.
2. **Session payload `v1`→`v2`** (§8): the operator re-logs in once.

Everything else is additive — new tables, new endpoints, new screens.
`HELPTHREAD_UI_PASSWORD` is retired (§8).

## 11. What this is NOT (scope)

- **No marketplace providers** (Google SSO, magic-link, SAML/enterprise SSO) — only the seam
  + the free `password` provider. Premium modules wait on the §7 exception text.
- **No passkey provider either** — passkey (WebAuthn) is core, not a marketplace module
  (decided 2026-07-18), but not built in this increment. It lands later as a second **core**
  auth provider on the §4 seam, wired in `root.ts` alongside `PasswordAuthProvider`.
- **No entitlement/licensing machinery** — separate marketplace infrastructure.
- **No enforcement of per-Agent mailbox scoping** (§3.4) — grants are managed, visibility
  filtering is deferred.
- **No teams/groups, granular permissions, or per-mailbox roles** — out of scope for a
  two-role v1.
- **No per-Agent API tokens / public multi-Agent API** — the acting-Agent assertion (§8) is
  the first-party trust model; a direct Agent-authenticated API is later.
- **No forced password change / credential expiry** — the admin-set-password fallback (§8)
  hands over a real password, not a temporary one.
- **No SCIM provisioning, audit log, or password-reset-by-email** for the forgotten case
  (admin reset covers v1; self-service email reset needs its own one-time mechanism, §9).

## 12. Decision points for the maintainer

1. **Roles:** Admin + Agent. *(Confirmed.)*
2. **First admin:** `/setup` first-run screen, zero-Agents-guarded. *(Confirmed.)*
3. **Provisioning:** both — invite-primary (via the core `EmailSender`) + admin-set-password
   fallback. *(Recommended.)*
4. **Per-Agent mailbox scoping (§3.4):** *(Confirmed — maintainer, 2026-07-18; **superseded
   the same day** — §3.4 now manages real grants, and only conversation-visibility
   enforcement stays deferred.)*
5. **Profile fields (§3.1):** lean v1 — name, email, password, role, disable, **timezone**;
   avatar, job title, phone, alternate-emails, language, time-format **deferred**. *(Open.)*
6. **Acting-Agent trust model (§8):** the web asserts the Agent id under the service token,
   vs. issuing per-Agent tokens now. *(Recommend the assertion model; per-Agent tokens
   later.)*

## Changelog

- **2026-07-19** (PR #82, PR #88): **Passkey login reclassified from marketplace to core**
  (§1, §3.2, §11). The module catalog made passkey login core the previous day — security
  hygiene is never paid — so it lands as a second **core** auth provider on the §4 seam
  rather than a marketplace module. Google SSO, magic-link, and SAML/enterprise SSO remain
  marketplace, unchanged. The provider-abstraction architecture (§3.2, §4) already supports
  multiple core providers.

  **§3.2 amended: a `passkey`/WebAuthn provider does not use `agent_auth_identities`.** It
  gets its own table, `webauthn_credentials` (`specs/auth/passkeys.md` §2.1). Two reasons
  carry it — mutable per-use state and an incompatible column shape. **Cardinality is not one
  of them.** Nothing defined by *this* spec changes.

- **2026-07-18** (PR #69): initial contract — data model (§3), auth-provider seam (§4), roles
  (§5), engine API (§6), UI screens (§7), session/trust/provisioning (§8), security (§9),
  rollout (§10). Replaces the former single-operator password as planned. Refined the same
  day:

  - **Mailbox access pinned** (§3.4, §6): admins implicit-all, auto-grant-on-create,
    admin-only grant endpoints. `agent_mailbox_access` holds **real managed grants**, not a
    schema-only placeholder. What stays deferred is *enforcement*: conversation-visibility
    filtering waits for the multi-mailbox increment, since conversations carry no `mailbox_id`
    yet (§12.4).
  - **`GET /agents` opened to any active Agent** (§6) — the assignee UI needs the roster.
    Mutations stay admin-gated.
  - **`status` is a closed lifecycle** (§6): PATCH may only toggle `active`↔`disabled`;
    `invited` exits solely via invite acceptance, or delete and re-create; password writes on
    an `invited` Agent are refused. This closes the incoherent states an unconstrained
    `status` field permitted — credential-less `active`, permanently-stranded invite,
    unusable password.
  - **The acting-Agent header rule is pinned per endpoint** (§8): required on `/agents/*`,
    `/auth/me`, and `PUT .../assignee`; other inbox endpoints stay bearer-only this
    increment, with the disabled-Agent consequence stated.
  - **Admin-set-password creates Agents directly `active`** (§8), resolving the
    `invited`-status contradiction: an Agent whose login is uniformly 401'd at `invited` could
    never activate on first login. Named honestly as admin-set, not temporary.
  - **One password identity per Agent** (§3.2) is a partial unique index plus an
    identity-service check.
  - **`/setup` and the last-admin guard are serialized** with `pg_advisory_xact_lock` — guard
    predicates alone race under READ COMMITTED.
  - **Hardening**: the session refresh path threads `sub` (it was silently dropping identity
    mid-session); the acting-Agent header is a real `api.ts` change with an engine-side status
    and existence re-check, bounding disabled or deleted Agents whose cookie is still valid;
    `/setup`, last-admin, and invite-accept are atomic; login returns a uniform `401` for
    unknown, wrong, invited, and disabled; the §7 boundary claim is scoped to the interface
    plus a provider-agnostic schema — not a module loader — and adds an identity-service seam
    so modules never write core tables directly; invites use the `EmailSender` *transport*,
    not `sendReply`, with a distinct `hti.` token prefix; email is immutable in v1; and the
    bearer-token-bypasses-role-checks boundary is stated plainly.
