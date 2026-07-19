# Passkeys (WebAuthn) login for Agents

Status: **draft.2** (2026-07-19). HT-75. Extends the auth-provider seam
`specs/auth/agents-and-auth.md` (HT-54) built with exactly one provider,
`password` — this is the second provider, and the first thing to actually
exercise the seam's "marketplace boundary" claim (agents-and-auth.md §1, §4)
with real code. Spec only: no migrations, no implementation. Every schema
block below is a design artifact, not a runnable migration — same
convention agents-and-auth.md's own `CREATE TABLE` blocks use. **draft.2**
is a review-driven revision (lead-tier + Codex, 2026-07-19) — see the
Changelog for the full list of what changed and why; nothing in draft.1
survives unexamined, several conclusions reverse outright (§8 most
notably).

Read first: `specs/auth/agents-and-auth.md` §3.2 (`agent_auth_identities`
— **amended in this same review round**, §2.1 below), §4 (the seam), §8
(session/acting-Agent trust), §9 (security posture); `specs/mail/
gmail-connect.md` §2b (the signed-state, pre-auth pattern this spec's
challenge tokens reuse); `src/auth/provider.ts`, `src/auth/
password-provider.ts`, `src/auth/invite-token.ts`, `src/auth/invite-email.ts`
(the exact HMAC-token and notification-email shapes this spec mirrors);
`src/composition/config.ts` (`uiBaseUrl`/`publicBaseUrl` origin validation);
`src/composition/health.ts` (the HT-44 alertable surface §8 routes into).

## 1. Purpose & scope

Per agents-and-auth.md §1, `password` is the free-core provider; passkeys
are a **licensed marketplace module** — same boundary, same waiting-on-HT-5
posture (the AGPL §7 exception text must be counsel-final before this or any
premium module merges). This spec is written now so the boundary has a
second real provider to test itself against, exactly as agents-and-auth.md
§4 anticipated ("adding Google SSO later is still a core code edit... a
module targets [the interface]"). Building this spec does not authorize
merging the module ahead of HT-5.

**Additive only.** No existing Agent, provisioning path, or endpoint from
HT-54 changes. Every Agent still gets a `password` identity through the
unchanged invite or admin-set-password flow (agents-and-auth.md §8); a
passkey is something an **already-authenticated** Agent optionally adds from
their own profile. There is no passkey-only provisioning in v1 — corollary:
in this design an Agent can never legitimately reach a state with zero
password identity and one or more passkeys (§9.1 makes this precise, and
§10 treats it as a guard invariant, not an assumption).

## 2. Data model

Three new tables. Neither touches `agents` or `agent_auth_identities`.

### 2.1 Where credentials live — a new table, not `agent_auth_identities`

**Decision: `webauthn_credentials`, not a row per credential in
`agent_auth_identities`.** This is a deliberate departure from what
agents-and-auth.md §3.2 itself originally anticipated: that section's
`provider` column comment used to read `'password' (core); 'google',
'passkey',... (marketplace)`, and its prose used to say "An Agent may have
several rows (password + google + passkey)" — naming `passkey` as an
example provider whose rows would live in `agent_auth_identities`, written
before this spec existed. **§3.2 is corrected in this same review round**
(agents-and-auth.md's own changelog, draft.6) to point here instead.

Two reasons carry the departure — cardinality does **not**, and an earlier
draft of this section wrongly claimed it did:

1. **Per-credential state that mutates on every use.** A WebAuthn credential
   carries a signature counter and a last-used timestamp that update on
   every authentication (§7). `agent_auth_identities` is written rarely
   (mint once at provisioning, rewritten only on password change); giving it
   a row type that churns on every login turns a low-write table into a
   mixed-traffic one for no reason.
2. **The columns don't fit the shared shape.** `agent_auth_identities` has
   exactly one credential-shaped column, `secret_hash` (a scrypt string).
   A passkey needs a COSE public key, a counter, a transports array, two
   backup flags, and a user-assigned name — none of which has an analog for
   `password` or an OAuth-style provider. Repurposing `secret_hash` to hold
   a public key would put semantically different data behind one column
   name that `PasswordAuthProvider`'s own code already assumes is a scrypt
   string (`password-provider.ts` calls `verifyPassword(password,
   identity.secretHash)` unconditionally on that shape) — a live footgun,
   not a style nit. Adding five new nullable columns to the shared table
   instead pollutes it for every non-webauthn row, which is exactly what
   agents-and-auth.md §1's "zero core-schema change" promise for provider
   *additions* is written to prevent — a provider brings its own table.

**Cardinality was never the real argument, and this section no longer
claims it is.** Nothing in `agent_auth_identities`' schema restricts a
`provider='passkey'` value to one row per Agent — the partial unique index
(`agent_auth_identities_one_password_per_agent`) is specific to `password`;
several `passkey` rows would have been perfectly legal there. If reasons 1
and 2 didn't hold, cardinality alone would not have justified a separate
table.

Precedent for "a provider gets its own table": `mailbox_oauth_tokens`
(HT-38) holds Gmail's OAuth material rather than living in a shared
credentials table. Same move here.

```sql
CREATE TABLE webauthn_credentials (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                  uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  credential_id             text NOT NULL,             -- base64url, from the authenticator (WebAuthn's own id)
  public_key                bytea NOT NULL,            -- COSE_Key, raw bytes, as returned by attestationObject
  sign_count                bigint NOT NULL DEFAULT 0,
  transports                text[] NOT NULL DEFAULT '{}',  -- e.g. {internal,hybrid,usb,nfc,ble} (AuthenticatorTransport)
  backup_eligible           boolean NOT NULL,          -- BE flag, captured at registration (WebAuthn §6.1)
  backup_state              boolean NOT NULL,          -- BS flag, refreshed on every authentication
  name                      text NOT NULL,             -- Agent-assigned label ("MacBook Touch ID")
  sign_count_regression_at  timestamptz,               -- set on a Tier-2 counter regression (§8) — the HT-44 health check's signal
  created_at                timestamptz NOT NULL DEFAULT now(),
  last_used_at              timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON webauthn_credentials (credential_id);
CREATE INDEX webauthn_credentials_agent ON webauthn_credentials (agent_id);
```

`credential_id` is globally unique (not scoped to `agent_id`): WebAuthn
credential ids are the authenticator's own high-entropy identifiers, and the
authentication ceremony looks a credential up by id **before** it knows
which Agent is signing in (§6.2's discoverable-credential flow) — the
unique index is also the lookup path, not just an integrity constraint.
Deleting an Agent cascades their credentials (mirrors
`agent_auth_identities`).

**No mirrored row in `agent_auth_identities`.** The module doc on
`src/auth/provider.ts` sketches OAuth modules as mapping a verified external
subject to an Agent "via a core-owned identity service" reading that table.
Passkeys don't need that indirection: the credential id in the assertion
*is* the lookup key, resolved directly against `webauthn_credentials.agent_id`
— there is no external subject to map. Adding a parallel bookkeeping row
there would be state that can drift from the real source of truth for no
functional gain.

### 2.2 Challenge lifecycle store — `webauthn_challenges`

Needed for single-use enforcement; see §7 for the full reasoning. One row
per minted challenge, keyed by its nonce.

```sql
CREATE TABLE webauthn_challenges (
  nonce        text PRIMARY KEY,
  ceremony     text NOT NULL CHECK (ceremony IN ('registration', 'authentication', 'step-up')),
  agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,  -- set for registration/step-up (session-bound); NULL for authentication (pre-identification, §6.2)
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges (expires_at);
```

`ceremony` now has a third value, `'step-up'` (§5) — a re-authentication
ceremony run against an Agent's *own* existing credentials, distinct from
`'authentication'` (anonymous login) and `'registration'` (enrolling a new
credential).

**Volume, honestly stated — corrected from draft.1.** Draft.1 claimed "volume
tracks interactive login/registration events, not request volume" and used
that to justify skipping any cleanup mechanism. That was wrong, not just
imprecise: a row is minted on every `authentication/options` call, which
(§6.2) fires on every unauthenticated `/login` page mount that attempts
conditional UI — not on completed login attempts, on page *views*. §6.2's
staleness handling additionally re-mints on an interval below the challenge
TTL for any tab left open, so one long-lived login tab mints several rows
over its lifetime, not one. This is real request-volume. Retracted here
rather than quietly patched.

**Fix: opportunistic purge on every mint, no cron.** Each `INSERT` that
mints a new `webauthn_challenges` row (any of the three ceremonies) is
preceded, in the same transaction, by one extra statement: `DELETE FROM
webauthn_challenges WHERE expires_at < now()`, using the
`webauthn_challenges_expires` index already defined above. This keeps the
table's steady-state size bounded to roughly (mint-rate × TTL) rather than
growing without limit, with no separate sweep job, cron, or maintenance
process — the cost of self-cleaning is one indexed `DELETE` piggybacked on a
write that was happening anyway. (§2.3's `webauthn_stepup_tokens` gets the
identical treatment, for the same reason and the same simplicity argument,
even though its own mint volume is much lower — one mechanism, not two.)

### 2.3 Step-up proof store — `webauthn_stepup_tokens`

Backs §5's enrollment-hardening requirement. Same shape and discipline as
§2.2, a separate table because a step-up token is a different kind of
artifact (proof of an existing factor, not a WebAuthn ceremony challenge)
even though it reuses the identical signed-token-plus-DB-row mechanism.

```sql
CREATE TABLE webauthn_stepup_tokens (
  nonce        text PRIMARY KEY,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX webauthn_stepup_tokens_expires ON webauthn_stepup_tokens (expires_at);
```

## 3. Origin & RP ID policy

**The RP ID and expected origin come from `HELPTHREAD_UI_BASE_URL`
(`config.uiBaseUrl`) — never from the incoming request's own `Host` or
`Origin` header, and never hardcoded.** This is a hard security requirement,
not a style choice: WebAuthn's whole phishing-resistance property rests on
the Relying Party checking the browser-reported origin against a value the
RP itself controls (W3C WebAuthn: the RP ID scopes a credential to "only
that Relying Party... is able to employ" it — the credential is unusable
outside the domain it was bound to). Deriving the expected origin from
anything the caller supplies would let an attacker simply assert the origin
they want checked against, collapsing the protection to nothing.

- **`rpId`** = the hostname (no scheme, no port) of `HELPTHREAD_UI_BASE_URL`
  — e.g. `inbox.resonantiq.app`, the deployed Agent Inbox's own host.
  **Not** `desk.resonantiq.app`, the ENGINE's host — draft.1's worked
  example used the wrong one. This is not a cosmetic mistake: WebAuthn
  ceremonies run in whatever browser tab is actually showing the login
  page, so the real, browser-reported origin is always the UI's,
  `inbox.resonantiq.app`, never the engine's — the engine is never loaded
  in an Agent's browser at all. If `rpId`/`expectedOrigin` were ever
  misconfigured to the engine's host instead, `clientDataJSON.origin` would
  never match what the RP expects, and every single ceremony — registration
  and authentication alike — would fail closed. There is no partial-failure
  mode here: it's binary, works everywhere or nowhere, which at least makes
  the misconfiguration loud rather than silent.

  The exact hostname, not a stripped-down parent domain: WebAuthn allows an
  RP ID to be the origin's exact registrable domain or any of its parent
  domains, but the general guidance (and the simpler, safer default with no
  documented multi-subdomain need here) is the narrowest ID that covers the
  actual login surface — one hostname, one web deployment.
- **`expectedOrigin`** = `HELPTHREAD_UI_BASE_URL` verbatim (already validated
  by `config.ts` as a bare `https` origin — loopback `http` allowed only for
  local dev, per the existing validator's own comment: *"HELPTHREAD_UI_BASE_URL
  must use https... http is allowed only for loopback hosts"*). This already
  matches WebAuthn's own secure-context requirement (`https:`, or `http:` on
  `localhost`) — with one carve-out the general `config.ts` validator
  doesn't know about, next bullet.
- **Dev/local: `localhost` only, not a loopback IP literal.** `config.ts`'s
  `HELPTHREAD_UI_BASE_URL` validator broadly allows `http://` for "loopback
  hosts" for the UI in general — but WebAuthn's own RP ID requirement is
  narrower and checked separately: an RP ID must be a **domain-form
  hostname** (MDN's own documentation of `rp.id`: it "must be a domain
  name," equal to "the origin's effective domain, or a domain suffix
  thereof"). `localhost` qualifies — it's a syntactically valid, if
  single-label, domain name, and the value real WebAuthn dev tooling
  actually uses for exactly this reason. An IP address literal does not
  qualify, however browsers otherwise treat it as a secure context for
  other web-platform purposes. **`http://127.0.0.1` and `http://[::1]` are
  therefore unsupported for passkeys even though `config.ts` accepts them as
  a valid `HELPTHREAD_UI_BASE_URL` in general** — a deployment developing
  against a loopback IP gets every other HT-54 feature working and passkeys
  silently failing at the first ceremony. Stated here so it's a documented
  gap, not a support ticket waiting to happen: local passkey development
  must use `http://localhost:<port>`, never an IP literal.
- **`uiBaseUrl` becomes required-if-passkeys-are-enabled.** It is optional
  in `AppConfig` today (agents-and-auth.md's invite links degrade
  gracefully without it). The passkey provider cannot degrade the same way:
  there is no safe fallback origin to bind ceremonies to. `root.ts` refuses
  to wire `WebAuthnAuthProvider` when `config.uiBaseUrl` is unset — a
  deployment without a known UI origin simply doesn't get the passkey login
  option (`GET /auth/providers` omits the `webauthn` descriptor), same
  degrade-by-omission shape agents-and-auth.md already uses for invites.

## 4. The auth-provider seam extension

### 4.1 What changes in `src/auth/provider.ts`

Exactly one type-level change: `AuthProviderDescriptor.kind` widens from the
literal `'credentials'` to a union, `'credentials' | 'webauthn'`. The
module's own doc comment already names this as the expected extension
point ("deliberately not widened to anticipate an OAuth `kind` before a
module that needs one actually ships") — this is that module. No other
field is added to the descriptor: the login screen needs nothing beyond
`{ key: 'webauthn', label: 'Passkey', kind: 'webauthn' }` to know to render
a passkey control; every ceremony detail (rpId, challenge, algorithms) is
fetched fresh per-attempt from the options endpoints (§9), never baked into
the static descriptor.

`AuthAttempt` (`{ providerKey: string } & Record<string, unknown>`) and
`VerifiedIdentity` (`{ agentId: string }`) need **no change** — a webauthn
attempt's provider-specific fields (`response`, `challengeToken`) fit the
existing untyped `Record<string, unknown>` exactly the way `password`'s
`email`/`password` fields do.

### 4.2 What does *not* fit the seam as shipped, and why

`AuthProvider.authenticate(attempt)` is a **single-shot** contract: one call
resolves one attempt to an identity or `null`. `password` fits this exactly
— no state precedes it. WebAuthn ceremonies do not: registration,
authentication, and step-up are all two-step (mint options, then verify a
signed response), and the options step must hand the browser a fresh,
unpredictable `challenge` that the verify step later checks byte-for-byte.
`provider.ts` has no hook for "mint per-attempt state before authenticate()
runs" — nor should it grow one speculatively for a shape only one provider
needs (the same restraint the module doc already applies to the OAuth
"start URL" case, which is genuinely a different mechanism — a redirect to
a third party, not a same-origin JS ceremony — so this isn't a case of two
providers needing the same hook).

**Resolution: the options-minting step lives outside the `AuthProvider`
interface entirely**, as its own pre-auth (or session-bound, for
registration/step-up) endpoint pairs (§9). Only the *final* verify step for
login — cryptographic signature check, resolve to an Agent — goes through
`authenticate()`, dispatched via the existing generic `POST /auth/verify
{ providerKey, ... }`, exactly like `password`. This keeps the seam's one
formal contract (`authenticate`) doing the one thing every provider
genuinely shares — "verify an attempt, name who it is" — and puts
WebAuthn's extra pre-steps where they structurally belong: provider-specific
routes the seam doesn't need to know about.

### 4.3 How `verify` differs from `password`, concretely

- **No identifier is asserted by the caller.** `password`'s attempt carries
  `email`; the caller is claiming an identity up front. A webauthn
  authentication attempt carries no email or Agent id at all — the identity
  is *discovered* from `response.id` (the credential id in the assertion),
  looked up in `webauthn_credentials`. This is what makes the discoverable/
  conditional-UI flow possible (§6.2) — the server never needs to know who's
  signing in before the ceremony starts.
- **Verification is cryptographic, not a KDF comparison.** `password` scrypt-
  verifies a secret against a stored hash. WebAuthn verifies an ECDSA/RSA
  signature over the ceremony's own signed bytes against the stored COSE
  public key — there is no shared secret to protect, and no `DUMMY_HASH`-style
  timing-equalization trick is needed for the "unknown credential" case:
  unlike an email address, a credential id is a high-entropy value an
  attacker cannot feasibly guess or enumerate, so "credential not found" and
  "signature invalid" carry no comparable oracle risk to "this email has no
  account." The endpoint still returns a uniform generic `401` for both
  (hygiene and symmetry with `password`'s response shape), but the
  *justification* is different and is stated honestly here rather than
  copy-pasted. (One narrow, deliberate exception to "uniform 401": §6.2's
  `challenge_expired` code — see that section for why distinguishing it is
  safe.)
- **Extra checks with no `password` analog:** the signed challenge token
  and its ceremony discriminator (§7) and the counter/clone policy (§8) run
  inside `authenticate()` before it can return non-null.
- **The `agent.status === 'active'` gate is repeated independently.**
  `password`'s check lives naturally on the path through
  `agent_auth_identities`; `WebAuthnAuthProvider.authenticate()` doesn't
  touch that table, so it re-checks `agents.status` itself after resolving
  `agent_id` from `webauthn_credentials`. Same rule, enforced on a different
  path — an `invited`/`disabled` Agent's passkey (if one somehow exists) is
  refused exactly like their password would be.

### 4.4 Session minting — identical to `password`

On a non-null `VerifiedIdentity`, the web mints the session exactly as it
does today for `password`: `mintSessionCookie(agentId)`, same `{v:2, iat,
sub}` payload (`web/src/lib/session.ts`), same cookie options, same
`X-Helpthread-Agent-Id` derivation on subsequent requests (agents-and-
auth.md §8). Nothing about the session's shape or trust model changes —
passkeys are a second *way in*, not a second kind of session. (§10 states
plainly what that session shape does — and does not — let the deployment
do once minted.)

**Where shipped code constrains this:**

- `web/src/lib/api.ts`'s `postVerify` is typed narrowly to `{ providerKey:
  string; email: string; password: string }`, not a generic passthrough —
  despite the engine endpoint already being provider-generic. Consistent
  with this codebase's existing style (`postSetup`, `postVerify`,
  `acceptInvite` are three separate small typed wrappers over what could
  have been one generic POST helper), this spec adds a **new, sibling
  function** — `postVerifyWebAuthn(input: { response:
  AuthenticationResponseJSON; challengeToken: string }): Promise<{ agent:
  Agent }>` — rather than widening `postVerify` into a union. Same for
  `web/src/lib/auth-actions.ts`: a new `loginWithPasskeyAction`, not a
  reshaped `loginAction` (whose signature is password-shaped: `(providerKey,
  email, password, next)`).
- `web/src/lib/api-types.ts` carries the web's own local mirror of
  `AuthProviderDescriptor` (`kind: 'credentials'`, matching the engine's
  `src/auth/provider.ts` shape it was copied from). It needs the identical
  `'credentials' | 'webauthn'` widening described in §4.1 — the engine and
  web copies of this type have to move together, or the web's own
  TypeScript would reject a `kind: 'webauthn'` descriptor the engine
  legitimately returns.

## 5. Step-up re-authentication for passkey enrollment

Registering a **new** passkey is the one action in this spec that mints a
durable, independent credential — and §10 states plainly that a live
session alone is not strong enough proof to allow it: a stolen session
cookie already grants everything else this spec's endpoints do (list,
rename, revoke), but minting a *new* credential creates access that outlives
the stolen session's own natural expiry, even outlives a password rotation.
**Both `registration/options` and `registration/verify` require a fresh
step-up proof — evidence, no older than 5 minutes, that the caller can
currently produce an EXISTING factor (the Agent's current password, or an
assertion from an already-registered passkey) for the SAME Agent the
session claims to be.** A live session alone is deliberately insufficient.

### 5.1 Proving step-up

Two paths, mirroring the two factor types this spec and HT-54 already
support:

- **`POST /api/v1/auth/step-up/password`** (session-required) `{ password }`
  — resolves the ACTING Agent's own email from the session (`sub`), **never**
  from client input (so a caller cannot attempt to step up as anyone but
  themselves), and re-runs the same verification `PasswordAuthProvider.
  authenticate()` already performs (agents-and-auth.md §4) against that
  resolved email and the submitted password.
- **`POST /api/v1/auth/step-up/webauthn/options`** then **`POST
  /api/v1/auth/step-up/webauthn/verify`** (both session-required) — a
  *third* ceremony type, `'step-up'` (§2.2's `ceremony` column), distinct
  from `'registration'`/`'authentication'`. Unlike login's
  `authentication/options` (§6.2, pre-session, `allowCredentials` omitted
  for anonymous discoverable lookup), step-up's options call already knows
  who's asking — `allowCredentials` is populated with the ACTING Agent's own
  existing `webauthn_credentials` rows. `verify` additionally requires the
  resolved `agentId` (from the credential lookup) to equal the session's
  `sub` — proving a factor for a *different*, even genuinely valid, Agent
  does not step up *this* session.

Either path succeeding mints a **step-up token**:
`htsu.{keyId}.{payload-b64url}.{sig-b64url}`, the same `Keyring`/HMAC
discipline as every other token in this spec, payload `{ agentId,
issuedAtMs, nonce }`, a `webauthn_stepup_tokens` row (§2.3) inserted at mint
time, TTL **5 minutes**.

### 5.2 Spending it

`registration/options` requires `{ stepUpToken }` in its body: verify
signature + TTL + `payload.agentId === session.sub`, then **consume** it
(`UPDATE webauthn_stepup_tokens SET consumed_at = now() WHERE nonce = $1
AND consumed_at IS NULL AND expires_at > now()`; zero rows → reject) —
single-use, DB-backed, the same two-layer discipline §7 uses for challenge
tokens.

`registration/verify` **also** requires the same `{ stepUpToken }` in its
body and independently re-validates signature + TTL + `agentId` match — but
does **not** attempt to consume it again (it was already consumed at
`options` time; a second consume attempt would always fail, which is not
the property wanted here). This is deliberately the same "two independent
layers" shape §7 uses for challenge enforcement: `options` is where the
DB-backed single-use guarantee lives, `verify` is a second, cheap, stateless
re-check that closes the gap if `verify` were ever reachable through some
path that skipped `options` — belt and suspenders on a security-critical
path, not duplicated logic for its own sake.

### 5.3 On success: notify, out-of-band

On every successful `registration/verify` — a credential was actually
created — the engine sends a **"new passkey added"** email to the Agent's
own address, through the same core `EmailSender` transport the invite email
already uses. `src/auth/invite-email.ts`'s `buildInviteEmail` is the direct
precedent: build a fresh `OutboundEmail`, hand it to the configured
`EmailSender` directly, **not** through `sendReply`/`src/mail/send.ts` —
there is no conversation this belongs to, the exact same reasoning
`invite-email.ts`'s own module doc states for invites. Content: which
credential (its name), roughly when, and a one-line "if this wasn't you,
revoke it from your profile and change your password" — the out-of-band
channel §10 says an Agent needs, since nothing about the web UI itself will
proactively surface a planted passkey to them.

**Best-effort, non-blocking.** A mail-send failure is logged and does not
fail the registration response — the credential is already durably created
by the time the email is attempted, and failing the API call over a
notification would be a worse trade than a silent send failure (mirrors
`sendInvite`'s own `inviteSent: false`-on-failure posture, agents-and-auth.md
§6, rather than making the whole outcome all-or-nothing).

### 5.4 What step-up deliberately does not gate

Rename and revoke (`PATCH`/`DELETE .../webauthn-credentials/{id}`, §9) are
**not** step-up-gated. Revoking a credential shrinks an attacker's foothold,
it doesn't create one — gating it behind an extra factor would only slow
down the legitimate Agent trying to kick out a passkey they don't
recognize, exactly the incident-response speed §10 depends on. Registration
is the one action that mints new, durable access; that is the action
step-up exists to guard.

## 6. Ceremonies

All three use `@simplewebauthn/server` (§13) for the CBOR/COSE/signature
work; this section states what Helpthread configures and verifies, not the
library's internals.

### 6.1 Registration — `navigator.credentials.create()`

Session-required (an already-authenticated Agent adding a passkey from
their own profile, agents-and-auth.md §7 item 5's "Change password"
sibling control) **and step-up-required (§5)**. Options, generated via
`generateRegistrationOptions`:

| Option | Value | Why |
|---|---|---|
| `rpName` | deployment display name (config or a fixed string) | shown in the OS passkey UI |
| `rpID` | `config.uiBaseUrl` hostname (§3) | phishing-resistance binding |
| `userID` | the Agent's raw `agents.id` (uuid) bytes | opaque, already-unique per Agent; **never the email** — WebAuthn's own guidance is that `user.id` should not carry directly identifying data, since it is retained by the authenticator and can be visible in sync/backup metadata |
| `userName` | the Agent's email | shown in the OS account picker, matching the W3C example convention |
| `userDisplayName` | the Agent's `name` | shown alongside `userName` |
| `challenge` | 32 random bytes (§7) | the spec's own worked examples use a 32-byte challenge; well above any documented minimum |
| `attestationType` | **`'none'`** | see justification below |
| `authenticatorSelection.residentKey` | **`'required'`** | required for the conditional-UI login flow (§6.2) — a non-discoverable credential cannot be surfaced by autofill at all (confirmed against MDN's Web Authentication API guide: conditional mediation only ever returns discoverable credentials) |
| `authenticatorSelection.userVerification` | **`'required'`** | see justification below |
| `authenticatorSelection.authenticatorAttachment` | **unset** (allow both) | a support Agent may want Touch ID/Windows Hello *or* a hardware key; restricting to one attachment class excludes real, common cases with no compensating benefit |
| `excludeCredentials` | the Agent's existing `webauthn_credentials` rows (`{id: credential_id, transports}`) | stops re-registering the same physical authenticator as a duplicate row |
| `supportedAlgorithmIDs` | library default (Ed25519 `-8`, ES256 `-7`, RS256 `-257`) | no override — narrowing would only exclude authenticators for no stated benefit |

**Step-up required**, per §5: both this call and its `verify` counterpart
additionally require a valid `{ stepUpToken }` — a request-level
requirement, not a WebAuthn ceremony option, so it isn't in the table above;
folded into the endpoint surface in §9.

**Attestation `'none'` — justified.** Requesting attestation conveyance
would require verifying an attestation statement's certificate chain
against the FIDO Metadata Service to learn anything trustworthy about *which*
authenticator model was used — a large added surface (a metadata-fetching
subsystem, cert validation, revocation) that buys nothing this threat model
needs: Helpthread has no requirement to restrict *which* authenticator
models an Agent may use. `'none'` is `@simplewebauthn/server`'s own default
and the shape Apple/Google/Microsoft platform authenticators are built
around; requesting anything stronger here would be speculative hardening
against a threat (rogue/unapproved authenticator hardware in a small
support team) this deployment doesn't have.

**Verification (`verifyRegistrationResponse`).** `expectedChallenge` =
the challenge decoded from the signed token (§7); `expectedOrigin` =
`config.uiBaseUrl` (§3); `expectedRPID` = the same hostname; `requireUserVerification:
true` (matching the `'required'` request — see §6.3, the request is a hint,
verification is the actual guarantee). On success, `registrationInfo`
yields the credential id, COSE public key, initial counter, credential
device type (single-/multi-device — feeds `backup_eligible`), and
`backedUp` (feeds `backup_state`) — inserted as one new `webauthn_credentials`
row, and §5.3's notification email is sent. **Replay is naturally
single-use here without extra bookkeeping**: a replayed attestation
response can only ever re-submit the *same* credential id, and
`credential_id`'s `UNIQUE` index rejects a second insert outright —
registration replay fails closed on a plain constraint violation,
independent of the challenge token's own single-use enforcement (§7 still
applies it uniformly, for reasons stated there).

**A credential id already claimed by a different Agent.** If the newly
attested `credential_id` already exists in `webauthn_credentials` under a
*different* `agent_id` than the one registering, the insert is refused with
a generic `409 conflict` ("this passkey is already registered") — no
cross-account detail beyond that, matching the house no-enumeration
discipline (agents-and-auth.md §9): the response never names or otherwise
implies which other Agent holds it. (Re-registering a credential already
owned by the *same* Agent is what `excludeCredentials` above exists to stop
client-side; the `UNIQUE` index is what actually enforces it server-side
either way.)

### 6.2 Authentication — `navigator.credentials.get()`, conditional UI

**Pre-session** (no acting-Agent header — joins agents-and-auth.md §8's
bootstrap group: `/setup`, `/auth/verify`, `/auth/invite/accept`,
`GET /auth/providers`). Options, via `generateAuthenticationOptions`:

| Option | Value | Why |
|---|---|---|
| `rpID` | same as §6.1 | |
| `allowCredentials` | **omitted** | required for conditional UI: per MDN, "only discoverable credentials are included in calls that use conditional mediation, because the browser needs to request applicable credentials without knowing the credential ID values" — a populated `allowCredentials` list defeats autofill discovery |
| `challenge` | 32 random bytes (§7) | |
| `userVerification` | **`'required'`** | |

This endpoint takes **no input at all** — not even an email — so it has no
enumeration surface by construction (contrast a design that first asks "does
this email have a passkey," which would itself be an oracle; this spec
never adds one).

**Client side, HT-52-gap-aware** (`LoginScreen.tsx` already flags that the
email input isn't `ds/core/TextInput`-`type="email"`/`autoComplete`-capable
today): the login form's email field gets `autoComplete="username webauthn"`
(the exact value MDN's Web Authentication API guide specifies for autofill
UI), and on mount, if `PublicKeyCredential.isConditionalMediationAvailable()`
resolves `true`, the page calls `navigator.credentials.get({ publicKey:
options, mediation: 'conditional' })` in the background. A matching platform
passkey then appears in the browser's native autofill dropdown alongside
saved passwords; selecting it resolves the promise with a `PublicKeyCredential`
with no separate "sign in with a passkey" click required. Where conditional
mediation isn't supported (feature-detected `false`), the login screen falls
back to an explicit "Sign in with a passkey" button that calls the same
`get()` without `mediation: 'conditional'` (a normal modal WebAuthn prompt)
— stated so the flow is honestly degrading, not silently broken, on
unsupported browsers.

**Staleness: a long-lived login tab must not silently 401.** Conditional
mediation's own promise, per MDN, "remains pending until the user picks an
account" — a tab can sit open far longer than the 5-minute challenge TTL
(§7), and when the user finally interacts, the browser will still happily
complete a ceremony against a challenge our server has since expired (and,
per §2.2's opportunistic purge, may have already deleted the row for). Left
unhandled, this produces a confusing `401` for someone who did nothing
wrong. Two complementary layers, not a single either/or:

- **Proactive re-mint on an interval below the TTL.** The client holds an
  `AbortController` for its in-flight `navigator.credentials.get({
  mediation: 'conditional', signal })` call (the standard's own
  `CredentialRequestOptions.signal`) and, on a timer well under the
  5-minute TTL — every 3 minutes, 60% of TTL, leaving real margin — aborts
  it, calls `authentication/options` again for a fresh challenge, and
  re-issues `get()` with the new one. A tab left open indefinitely always
  has a fresh, live challenge whenever the user actually picks a
  credential.
- **Reactive fallback: re-mint and retry once on server-detected expiry.**
  The proactive timer alone is not fully reliable — browsers throttle
  `setTimeout`/`setInterval` in backgrounded tabs specifically to save CPU
  and battery, so a 3-minute re-arm can legitimately slip past the
  5-minute TTL in a tab the user isn't looking at. When §7's consume step
  affects zero rows *specifically because the row is missing or expired*
  (as opposed to a bad signature or an unknown credential id), the engine
  returns a distinguishable `challenge_expired` error code — safe to
  distinguish from every other failure mode without weakening
  no-enumeration (§4.3, §10), since this signal is about ceremony
  freshness, not account existence, and the nonce that expired was one OUR
  server minted for THIS client's own prior request, never anything an
  attacker could usefully probe with a guessed value. The client catches
  `challenge_expired` specifically, silently re-mints and retries the
  ceremony once, and only surfaces an error to the Agent if the retry also
  fails.

(The extra mint volume this proactive re-arming produces is accounted for
in §2.2's honestly-restated volume claim and its opportunistic-purge fix.)

**Verification (`verifyAuthenticationResponse`).** The handler first reads
`response.id` from the posted assertion and looks up `webauthn_credentials
WHERE credential_id = $1`; not found → `null` (generic `401`, §4.3). Found →
loads the stored `credential` (public key, counter, transports) as the
library's `credential` param, `expectedChallenge`/`expectedOrigin`/
`expectedRPID` as in §6.1, `requireUserVerification: true`. On success:
update `sign_count`, `backup_state`, `last_used_at` on the credential row
(§8 governs how a counter regression is handled), re-check
`agents.status === 'active'`, return `VerifiedIdentity { agentId }`.

**`userHandle` cross-check.** A discoverable-credential assertion also
returns `response.userHandle` — the same bytes minted as `userID` at
registration (§6.1's table: the Agent's raw `agents.id`). Per WebAuthn's
own authentication-verification procedure, once the credential is resolved
(here, by `credential_id` — **not** by `userHandle`, which this spec never
uses for primary lookup), `userHandle`, when present, must be compared
against the resolved row's `agent_id`: a mismatch is a hard rejection,
independent of whether the signature itself verifies. This is a
defense-in-depth consistency check, not the identity-resolution path — it
catches a resolved `webauthn_credentials` row whose `agent_id` has somehow
diverged from what the credential itself was bound to at registration (data
corruption, or a forged assertion asserting a different identity than the
credential's own history), rather than doing any of the actual identity
resolution work.

### 6.3 User verification: `'required'`, not `'preferred'` — justified

A WebAuthn credential with UV **not** required is a pure possession factor
— equivalent to a bearer token bound to a device, with no second factor
behind it. `password` login, by construction, is a knowledge factor. For
passkeys to be a *credible replacement* for password rather than a weaker
side door, they need to carry the assurance a password does: something the
Agent has (the authenticator) **and** something they are/know (the PIN or
biometric that unlocks it) — that pairing is exactly what the UV flag
attests. `'required'` also matches `@simplewebauthn/server`'s own verification
defaults (`requireUserVerification` defaults to `true` in both verify
functions per the library's published types) — this isn't an unusual
choice, it's the library's own baseline. Real-world cost: every mainstream
passkey provider (Apple/iCloud Keychain, Google Password Manager, Windows
Hello, and PIN-protected hardware keys) requires a PIN/biometric to use the
credential at all, so `'required'` excludes nothing a normal Agent would
actually try to register — the honest cost is falling back to `'preferred'`
would have bought no real usability gain, only a weaker credential.

**Requesting UV is a hint; the server must check the flag independently.**
`userVerification: 'required'` in the options only asks the client/authenticator
to enforce it — a WebAuthn response is still just bytes the server chooses
how to verify. `verifyRegistrationResponse`/`verifyAuthenticationResponse`'s
own `requireUserVerification` parameter is what makes the check load-bearing
(it inspects the UV bit in the returned authenticator data flags directly,
per WebAuthn §6.1) — this spec passes it explicitly rather than assuming the
request-side hint alone is enforcement.

## 7. Challenge lifecycle — signed, TTL'd, single-use, ceremony-bound

**Stateless minting, reusing the existing Keyring/HMAC discipline** — the
same pattern `src/auth/invite-token.ts` and `src/mail/gmail-connect.ts`'s
`state` already use (full HMAC-SHA256 off `Keyring`, base64url, current+retired
key rotation, constant-time verification, a domain-separator prefix so a
signature minted for one purpose can never verify as another).

```
htw.{keyId}.{payload-b64url}.{sig-b64url}
```

Payload: `{ ceremony: 'registration' | 'authentication' | 'step-up',
challengeB64: string, agentId: string | null, nonce: string, issuedAtMs:
number }`. `agentId` is the acting Agent for registration/step-up (bound at
mint time from the session, checked again at verify time — §7's replay note
below), `null` for authentication (pre-identification, §6.2). `htw.` is a
new domain separator, distinct from `hti.` (invite), `gmc.` (Gmail state),
`htsu.` (step-up, §5), and reply tokens' `ht.`. Default TTL **5 minutes** —
generous slack above the WebAuthn ceremony's own client-side `timeout` (60s
default) so a slow biometric retry doesn't get invalidated server-side
before the browser itself gives up, while still being short enough that a
captured, unused token doesn't stay live long.

**Single-use is NOT a property the signed token has on its own** — unlike
the invite token, whose one-time-ness comes from the atomic `invited`→`active`
status transition it triggers (invite-token.ts's own module doc is explicit
about this), a bare signature+TTL check can be satisfied twice: nothing
about verifying an HMAC and a timestamp prevents verifying the *same* token
a second time within its TTL.

**Registration doesn't need single-use tracking to be safe** — §6.1 already
established this: replaying a registration response can only re-insert the
same credential id, and the `UNIQUE` index rejects it. **Authentication
does**: replaying a captured, fully-valid authentication response would mint
a *second* session for the same Agent — a real (if narrow) escalation,
gated behind already having captured one complete valid exchange (a TLS
MITM, or XSS on the login page — a threat model where a single valid
authentication already leaked, but a second free session on top of it is
still strictly worse). Given the stakes — this endpoint mints a login
session, one of the two highest-value artifacts in this spec (the other
being §5's step-up token) — **the honest answer is that pure statelessness
cannot hold single-use here**, exactly the case this ticket's brief
anticipated.

**Resolution: `webauthn_challenges` (§2.2), one small row per minted
challenge.** Insert at options-mint time (`nonce`, `ceremony`, `agent_id`,
`expires_at = now() + 5m`), preceded by the opportunistic purge (§2.2).
Consume at verify time with a single guarded statement — **parameterized on
ceremony, not just nonce**:

```sql
UPDATE webauthn_challenges
SET consumed_at = now()
WHERE nonce = $1 AND ceremony = $2 AND consumed_at IS NULL AND expires_at > now()
```

Zero rows affected → reject as expired-or-already-used-or-wrong-ceremony,
independent of whether the HMAC/TTL check on the token itself also passed
— **two independent enforcement layers**, not one mechanism duplicated: a
bug in the signed-token TTL check doesn't silently disable single-use, and
vice versa (the same "a guard predicate alone is not enough" caution
agents-and-auth.md §5/§6 applies to the last-admin and `/setup` races,
applied here to a different kind of double-use).

**The `ceremony` discriminator is enforced, not just recorded — two
independent layers, the same discipline as the paragraph above.** Each
verify-side handler hardcodes which ceremony IT expects (`registration/
verify` expects `'registration'`; the `webauthn` case of `/auth/verify`
expects `'authentication'`; `step-up/webauthn/verify` expects `'step-up'`)
and checks it twice:

1. **Application-level:** after the HMAC signature and TTL check succeed,
   decode the payload and compare `payload.ceremony` to the endpoint's own
   hardcoded expectation — reject before ever touching the database or
   running any WebAuthn verification if they don't match.
2. **Database-level:** the consume statement above supplies `$2` from the
   *caller's own* hardcoded expectation (never from anything client-supplied)
   — so even a hypothetical future bug that skipped check 1 would still
   fail closed at the database, because a row minted for a different
   ceremony genuinely does not match the predicate.

Why this matters even though the practical exploit path is narrow: without
it, a validly-signed, unexpired token minted for one ceremony (say, an
Agent's own legitimate `registration` challenge) would still decode and
pass every *other* check if submitted to a different endpoint's verify
call. The WebAuthn response's own `type` field (`webauthn.create` vs
`webauthn.get`) independently prevents the underlying credential response
from being cross-used, but nothing about this spec's token format alone
prevented a `registration`-flavored token from being fed into an
`authentication` or `step-up` verify call before this fix. Cheap to close;
closed.

**One mechanism for all three ceremonies, deliberately, even though
registration doesn't strictly need single-use tracking.** Bifurcating the
challenge-verification code path by ceremony type would mean multiple
implementations of a security-critical check instead of one reviewed path
— a worse trade than the small, genuinely-redundant cost of consuming a
nonce row registration doesn't strictly require.

**Registration's and step-up's extra check:** at verify time, the token's
`payload.agentId` must equal the *currently authenticated* acting Agent
(from the session header, not from the request body) — defense in depth
beyond the token's own signature, so an options response minted for one
Agent's session can't be replayed against a different Agent's verify call
even if somehow captured and forwarded.

## 8. Counter & clone-detection policy

**Policy, revised from draft.1: exempt zero-history credentials; reject and
alert on regression for every credential that has ever reported a nonzero
counter.**

Draft.1 argued for log-only across the board, reasoning that most passkeys
are synced and counter-incoherent. That reasoning proved too much: the
zero-counter exemption below already removes every credential that behaves
that way — a synced/multi-device authenticator reporting `0` (WebAuthn's
own sentinel for "does not implement a counter") never leaves the exempt
tier in the first place. The credentials that *do* graduate out of it —
ones that have reported a genuine nonzero value — are, by definition, not
exhibiting the synced-and-incoherent behavior the original justification
worried about; they are demonstrating exactly the single-device, monotonic-
counter behavior WebAuthn's counter mechanism was designed to police.
Treating a regression on that population as low-quality noise was the
actual error. It isn't; it's a high-quality signal, and this spec now says
so plainly.

**The two tiers:**

- **Tier 1 — never reported nonzero.** A credential whose stored counter is
  still `0` is exempt from regression checks. `0` is the spec's own
  sentinel for "not tracked" — most synced/multi-device platform
  authenticators, honestly, will simply never leave this tier, and that's
  fine: it's the state the sentinel exists to describe.
- **Tier 2 — has reported ≥1 nonzero value, ever.** The moment a credential
  reports any nonzero counter, it permanently graduates to Tier 2 —
  *including* if a later report reverts to `0`: an authenticator that has
  already demonstrated it implements a counter reporting `0` afterward is
  not "reverting to the sentinel," it's a regression to the lowest possible
  value, and is treated exactly like any other regression. From this point
  forward: **any authentication reporting a counter ≤ the stored maximum is
  REJECTED** (the caller sees the same generic `401` every other
  authentication failure produces — §4.3's no-enumeration posture is
  unchanged; this is a server-side policy decision, not a new client-visible
  error class) **and the event is routed to the HT-44 alertable surface**,
  not left in a log nobody reads.

**Routing to `/internal/health` (HT-44, runbook Part G) — mirroring the
existing pattern exactly, not inventing a new one.** `src/composition/
health.ts`'s `runHealthCheck` already has this shape for a structurally
identical problem: `forgedTokens`/`forged-token-burst` counts
`inbound_deliveries` rows flagged in the last 24 hours and trips an alert
past a threshold constant (`FORGED_TOKEN_ALERT_THRESHOLD`), following the
module doc's own stated idiom ("dead-letter rows are retained by design...
so the signal is growth, never the standing count"). This spec adds a
directly analogous column and check:

- `webauthn_credentials.sign_count_regression_at` (§2.1, nullable) is set to
  `now()` whenever Tier 2 rejects a regression — overwritten on each new
  occurrence, a single timestamp, not a log table, matching the
  forged-token column's own "a count/marker, not an audit trail" shape.
- `runHealthCheck` gains one more check, the same idiom as every other one
  in that function: `SELECT count(*) FROM webauthn_credentials WHERE
  sign_count_regression_at > now() - interval '24 hours'`; any count `> 0`
  pushes a `webauthn-counter-regression: <n> credential(s) rejected for
  signature-counter regression in the last 24h — a high-quality clone
  signal for a non-synced credential; inspect and consider revoking
  (runbook Part G)` alert string, tripping the endpoint's existing
  `200`→`503` pivot exactly like every other alert already does. No new
  alerting channel, no new threshold-tuning exercise — the existing
  dumb-HTTP-monitor stack (the module doc's own words: "status-code
  polling... is a complete alerting stack") picks it up for free.
- The rejection is also still logged at the point it happens (matching
  forged-token detection's own "inspect the forged_token_detected log
  events" companion trail) — the DB column is what makes it *alertable*,
  the log line is what makes it *investigable*.

This is a real behavior change from draft.1's log-only stance, and an
honest reversal — stated plainly rather than silently revised.

## 9. Engine API (new)

All under the existing service-Bearer channel per agents-and-auth.md §6's
convention (Bearer authenticates web→engine; Agent identity rides inside
via the acting-Agent header where noted).

| Endpoint | Acting-Agent header | Notes |
|---|---|---|
| `POST /api/v1/auth/step-up/password` | **required** (self) | `{ password }`; re-verifies the acting Agent's own password (email resolved from the session, never client input); on success mints a `webauthn_stepup_tokens` row, returns `{ stepUpToken }` (§5.1) |
| `POST /api/v1/auth/step-up/webauthn/options` | **required** (self) | mints a `webauthn_challenges` row, `ceremony='step-up'`; `allowCredentials` = the Agent's own existing credentials (§5.1) |
| `POST /api/v1/auth/step-up/webauthn/verify` | **required** (self) | `{ response, challengeToken }`; requires resolved `agentId === session.sub`; on success mints a `webauthn_stepup_tokens` row, returns `{ stepUpToken }` (§5.1) |
| `POST /api/v1/auth/webauthn/registration/options` | **required** (self) | `{ stepUpToken }` — mints a registration challenge + `webauthn_challenges` row (`ceremony='registration'`); consumes the step-up token (§5.2) |
| `POST /api/v1/auth/webauthn/registration/verify` | **required** (self) | `{ response, challengeToken, stepUpToken, name? }` → inserts a `webauthn_credentials` row; re-validates (not re-consumes) `stepUpToken` (§5.2); sends the "new passkey added" notification email on success (§5.3); `409` if `credential_id` already claimed by a different Agent (§6.1) |
| `POST /api/v1/auth/webauthn/authentication/options` | **forbidden/ignored** (pre-session) | mints an authentication challenge (`ceremony='authentication'`), no `agent_id`; body: none |
| `POST /api/v1/auth/verify` `{ providerKey: 'webauthn', response, challengeToken }` | **forbidden/ignored** (pre-session) | reuses the existing generic dispatcher (§4.2); on challenge-expiry specifically, returns `challenge_expired` (§6.2) rather than the generic `401` — every other failure mode stays generic |
| `GET /api/v1/agents/{id}/webauthn-credentials` | **required** (self, or admin) | `{ credentials: [{ id, name, transports, backupEligible, backupState, createdAt, lastUsedAt }] }` — **never** the public key or the raw WebAuthn `credential_id`; the row's own `id` (uuid) is the API-facing handle for rename/revoke |
| `PATCH /api/v1/agents/{id}/webauthn-credentials/{credentialId}` | **required** (self, or admin) | `{ name }` — rename only; **not** step-up-gated (§5.4) |
| `DELETE /api/v1/agents/{id}/webauthn-credentials/{credentialId}` | **required** (self, or admin) | revoke; **not** step-up-gated (§5.4); see §9.1 for the last-credential guard |

The seven passkey-management rows above (everything except the two
pre-session ones) join agents-and-auth.md §8's "header required" set
alongside `/agents/*`, `/auth/me`, and `PUT .../assignee`. The two
pre-session rows (`authentication/options`, the `webauthn` case of `/auth/
verify`) join its "header forbidden/ignored" bootstrap set.

### 9.1 Revoke-last-credential policy

**In this design, an Agent can never reach zero credentials via passkey
revocation alone** — §1 established the invariant: passkeys are additive,
every Agent always has exactly one `password` identity from provisioning,
untouched by this spec. Revoking an Agent's only passkey always leaves them
with their password; it cannot lock them out.

**A defensive guard is still added, cheaply, rather than trusting that
invariant blindly forever** — mirroring agents-and-auth.md §5's own
reasoning for the last-admin guard (a predicate that's *currently* always
true is not the same as a predicate the code enforces). Before deleting a
`webauthn_credentials` row, the handler checks: does this Agent have a
`password` identity in `agent_auth_identities`, **or** at least one *other*
`webauthn_credentials` row? If neither, refuse with `409`. This is normally
unreachable dead code given the current invariant — cheap to add, and it
turns a would-be silent lockout (if some future increment ever allows
passkey-only provisioning, §11) into a loud, safe refusal instead of a
footgun someone has to remember to re-derive later.

## 10. Security

- **Origin/rpId binding** — §3; the load-bearing phishing-resistance
  property, sourced only from server config, never from request input.
- **Stolen session — what it can and cannot do, and why two new mitigations
  exist.** `ht_session` (agents-and-auth.md §8) is a **stateless,
  HMAC-signed cookie with no server-side revocation list**
  (`web/src/lib/session.ts`) — there is no mechanism to invalidate one
  specific already-issued cookie early. Exactly two things end a stolen
  session's access before its natural expiry (up to 7 days): an admin
  disabling the Agent (`status='disabled'`, re-checked live on every
  header-required request, agents-and-auth.md §8) or the cookie's own
  expiry. **Rotating a password does neither** — it changes what a *future*
  login needs; it does not touch the validity of any already-issued cookie.

  With that established: a stolen session already grants an attacker
  everything `POST /agents/{id}/password` (agents-and-auth.md §6) grants —
  full account takeover — so passkey list/rename/revoke (no secret material
  ever returned, §9's endpoint table) piggyback on an existing,
  already-comprehensive blast radius rather than widening it.

  **The one thing that does widen it: registering a new passkey mid-
  compromise creates access that outlives the stolen session entirely.**
  This is exactly why §5 exists: step-up re-authentication means a
  stolen-session-only attacker (no password, no existing passkey) cannot
  mint one, and the "new passkey added" notification email means that even
  if they somehow could, the legitimate Agent gets an out-of-band signal a
  UI-only mitigation can't guarantee they'll ever see (an Agent who never
  opens their profile page would otherwise never know). Both mitigations
  exist because of the same fact stated above — sessions don't revoke, so
  the two things worth protecting are (a) never letting a bare stolen
  session mint new durable access in the first place, and (b) making sure
  a successful mint is never silent.
- **No account enumeration** — §6.2's `authentication/options` endpoint
  takes no identifying input at all, which is a stronger position than
  `password`'s own no-enumeration design (agents-and-auth.md §9) rather
  than a parallel one; the credential-id lookup at verify time carries no
  comparable oracle risk either, for the reasons stated in §4.3. (§6.2's
  `challenge_expired` code is the one intentional, safe exception — see
  that section for why.)
- **Attestation `'none'`** (§6.1) means Helpthread never verifies *which*
  physical authenticator model produced a credential — only that a valid
  WebAuthn ceremony occurred. Stated plainly so it isn't assumed: this
  spec does not defend against a compromised authenticator *implementation*
  (e.g. malware-controlled software claiming to be a hardware key);
  attestation conveyance is the mechanism that would, and it's deliberately
  not used (§6.1's justification).
- **Rate limiting — same unresolved gap agents-and-auth.md §9 already
  names** ([HT-53](https://resonantiq.atlassian.net/browse/HT-53)): none
  of this spec's endpoints add rate limiting, and none is solved here. The
  pre-session endpoints (`authentication/options`, the `webauthn` case
  of `/auth/verify`) inherit exactly the same per-instance gap `password`'s
  `/auth/verify` already has — called out, not silently left implicit.
- **No secret ever leaves the server.** The COSE public key is, definitionally,
  not a secret, but it is still never returned by any endpoint in §9 — the
  list endpoint's response shape (§9's table) carries only display metadata.
  The web never touches a private key at any point — that key never leaves
  the authenticator, by WebAuthn's own design.
- **Charter "own your data"** (agents-and-auth.md §9's framing, unchanged
  here): all credential material lives in the operator's own Postgres; no
  Helpthread-hosted relying-party service or FIDO Metadata Service call is
  made (attestation `'none'` means no MDS integration exists to make one).

## 11. Rollout

- **No migration of existing Agents.** Every Agent from before this ships
  keeps working exactly as today (`password` unaffected); passkeys are a
  purely optional addition an Agent opts into from their own profile.
- **UI surfaces are new, flagged design-project-first** — same rule
  CLAUDE.md's UI-fidelity mandate already applies to every Agent Inbox
  screen: the passkey add/rename/revoke controls on `AgentProfileScreen.tsx`
  (`/manage/agents/{id}`) and the login screen's conditional-UI/fallback-button
  treatment are new designed surfaces with no existing Claude Design
  prototype, requiring TJ's sign-off before or alongside build, exactly as
  agents-and-auth.md §7 already requires for its own new screens.
- **Changing `HELPTHREAD_UI_BASE_URL`'s host silently invalidates every
  existing passkey.** `rpId` is derived from it (§3); WebAuthn credentials
  are permanently bound to the RP ID they were created under, with no
  migration path — a domain change (the UI re-platformed to a new host, a
  rebrand) makes every previously-registered passkey unusable at the next
  login attempt, with no error at the change itself, only later, one Agent
  at a time, when they try to authenticate. Password login is entirely
  unaffected (it has no origin binding) — the fallback survives — but
  operators changing this value should be warned explicitly (a runbook
  note, not built here) that every Agent's passkeys need re-registering
  afterward.
- **Escalation path, named but not built:** passkey-only provisioning (no
  password at all) is explicitly out of scope (§12) and would need §9.1's
  guard revisited if ever built; session revocation (§10's finding) is a
  real, natural follow-up this spec doesn't take on (§12).

## 12. What this is NOT (scope)

- **No passkey-only provisioning.** Every Agent still gets a password from
  the unchanged HT-54 invite/admin-set-password flow; a passkey is always
  an addition to, never a replacement for, that password (§1, §9.1).
- **No attestation verification / FIDO Metadata Service integration**
  (§6.1, §10) — `'none'` conveyance only.
- **No forced re-registration or credential expiry** for existing passkeys
  — same "no forced rotation" posture agents-and-auth.md §11 already takes
  for passwords.
- **No cross-device "hybrid" transport UX design** beyond what the browser
  provides natively (QR-code phone-as-security-key is a WebAuthn/CTAP
  platform feature this spec doesn't need to do anything special to
  support — `transports` simply records `hybrid` when reported — but no
  bespoke UI is designed around it here).
- **No entitlement/licensing enforcement** for this being a paid module —
  same carve-out agents-and-auth.md §11 already states for the seam
  generally; separate marketplace infrastructure.
- **No rate limiting** (§10) — HT-53, unresolved, called out not solved.
- **No session revocation / active-session management for Agents.** §10
  states plainly that a session cannot be individually invalidated today;
  building that (a session table, a "sign out everywhere" control) is a
  real, natural next step this spec deliberately does not take on — flagged
  here because §10's review made the gap concrete for the first time, not
  because it was already planned.

## 13. Library decision & provenance

**`@simplewebauthn/server`** (npm, current `13.3.2`). License verified
directly against the published package and its GitHub source, per CHARTER.md's
"license verified at adoption" rule:

- `npm view @simplewebauthn/server license` → `MIT`.
- GitHub API (`gh api repos/MasterKale/SimpleWebAuthn`) → `license.spdx_id:
  "MIT"`; the repository's `LICENSE.md` is the standard MIT text, copyright
  Matthew Miller (the maintainer), 2020.
- **Transitive runtime dependencies checked too, not just the top-level
  package**: `@hexagon/base64`, `@levischuck/tiny-cbor`, and the `@peculiar/
  asn1-*`/`@peculiar/x509` family (used for ASN.1/X.509 parsing in the
  attestation path) — every one of them `MIT` per `npm view <pkg> license`.
  No copyleft anywhere in the dependency tree as installed.

**Exact functions used**, verified against the package's own published type
declarations (`unpkg.com/@simplewebauthn/server@13.3.2/esm/.../*.d.ts`, not
assumed from memory): `generateRegistrationOptions`,
`verifyRegistrationResponse`, `generateAuthenticationOptions`,
`verifyAuthenticationResponse` — the four functions §6 configures and calls.

**Why not hand-roll:** this is CBOR decoding, COSE key parsing, and (for a
future attestation-verification increment, not this one) ASN.1/X.509
certificate-chain handling — precisely the class of security-critical
binary-format parsing where a hand-rolled implementation is a bad trade
against a maintained, widely-used, permissively-licensed library. This
isn't a new kind of trade for this codebase: `jose` (also MIT, already a
runtime dependency — `package.json`) is the same move for JWT/JOSE crypto.
`@simplewebauthn/server` is the same call for WebAuthn.

**Charter provenance compliance:** CHARTER.md's line is explicit — "the
core is our own code, built on permissively-licensed foundations... with
each license verified at adoption." This section *is* that verification,
performed against the actual published artifacts (npm registry, GitHub
API, unpkg-hosted type declarations), not asserted from training-data
recollection of the package's reputation.

## 14. Decision points for TJ

1. **Credential storage: new `webauthn_credentials` table**, not rows in
   `agent_auth_identities` — a deliberate departure from what agents-and-
   auth.md §3.2 originally anticipated, corrected there in this same review
   round. *(§2.1 — recommend as specified; the mutable per-use state and
   column-shape mismatch carry it on their own — cardinality does not, and
   this draft no longer claims it does.)*
2. **Step-up re-authentication gates passkey enrollment** (password OR an
   existing passkey, bound to the session's `sub`, 5-minute TTL), plus a
   best-effort "new passkey added" notification email on every successful
   registration — gating registration only, not rename/revoke. *(§5 —
   added in this review round; recommend as specified. §10's finding —
   sessions don't revoke — is exactly why both pieces are needed: step-up
   stops a bare stolen session from minting new durable access, the email
   is the out-of-band signal if it happens anyway.)*
3. **User verification: `'required'`**, not `'preferred'`. *(§6.3 —
   recommend; every mainstream passkey provider already satisfies this, so
   the real-world cost is near zero and the alternative is a materially
   weaker credential.)*
4. **Counter/clone policy: two-tier — exempt while zero-history, reject
   and alert once a credential has ever shown a nonzero counter.** *(§8 —
   revised from this draft's own earlier log-only-across-the-board stance
   after review: the zero-counter exemption already filters out the
   synced/incoherent population log-only was meant to protect, so a
   regression on the remaining, graduated population is a genuinely
   high-quality clone signal, not noise. Recommend as now specified —
   reject-on-regression-for-graduated-credentials is the real, load-bearing
   default here, not a strawman alternative to log-only.)*
5. **Challenge single-use: signed token + a `webauthn_challenges` DB row,
   ceremony-discriminated at both the application and database layers**,
   applied uniformly to all three ceremonies even though registration alone
   doesn't need single-use tracking. *(§7 — recommend; one reviewed code
   path beats several for a security-critical check, and the row is
   cheap.)*
6. **Revoke-last-credential: no functional block needed (invariant holds),
   defensive `409` guard added anyway.** *(§9.1 — recommend; matches the
   last-admin-guard precedent's own reasoning.)*
7. **Attestation: `'none'`.** *(§6.1 — recommend; matches the library
   default and mainstream platform posture; no stated need for stronger
   conveyance here.)*
8. **`HELPTHREAD_UI_BASE_URL` becomes required-for-passkeys**, and must
   resolve to a domain-form hostname — `localhost` is fine for dev, a
   loopback IP literal (`127.0.0.1`, `[::1]`) is not, even though
   `config.ts` accepts the latter for the UI's base URL generally. *(§3 —
   recommend; there is no safe fallback origin to invent, and the IP-literal
   gap is a real WebAuthn constraint, not a stricter-than-necessary choice
   this spec is adding on top.)*
9. **Library: `@simplewebauthn/server`, not hand-rolled.** *(§13 —
   recommend; CBOR/COSE/attestation-object parsing is exactly the kind of
   security-critical binary-format work this codebase's own provenance
   discipline argues for taking from a maintained, permissively-licensed
   dependency rather than reimplementing.)*

## Changelog

- **draft.2 (2026-07-19, lead-tier + Codex review):** Enrollment hardening
  added — step-up re-authentication (§5, new section) gates
  `registration/options` **and** `registration/verify`, plus a best-effort
  "new passkey added" notification email on every successful registration
  (§5.3); §10 now states plainly that sessions are stateless HMAC cookies
  with no revocation, and that this is precisely why both mitigations
  exist. Conditional-mediation staleness handling specified — proactive
  re-mint on an interval below the TTL, plus a reactive `challenge_expired`
  retry-once fallback for backgrounded-tab timer throttling (§6.2). The
  `ceremony` discriminator is now enforced at both the application and
  database layers, not just recorded (§7). Counter/clone policy reversed
  from log-only to a two-tier exempt/reject-and-alert policy, with
  rejections routed to the existing HT-44 `/internal/health` alertable
  surface via a new `webauthn_credentials.sign_count_regression_at` column
  (§8) — an honest correction of draft.1's own reasoning, not a quiet
  patch. The challenge-row volume claim (§2.2) is corrected from "low,
  interactive-event-scale" (false — a row mints on every login-page mount)
  to an honest statement plus an opportunistic-purge fix, no cron. §3's
  worked example corrected (`inbox.resonantiq.app`, the UI's own host — not
  `desk.resonantiq.app`, the engine's), and a `localhost`-only,
  no-IP-literal dev carve-out added. §2.1's justification corrected —
  cardinality was never a valid reason to avoid `agent_auth_identities`
  (nothing there restricts multiple `passkey` rows); the departure is now
  argued on the two reasons that actually hold, and flagged explicitly
  against agents-and-auth.md §3.2's own (now-corrected, that document's
  draft.6) anticipation that passkeys would live there. Added: a
  `userHandle`-vs-`agent_id` consistency check at authentication verify
  (§6.2), a generic-`409` error contract for a `credential_id` already
  claimed by a different Agent (§6.1), and `web/src/lib/api-types.ts`'s
  descriptor-`kind` widening to §4.4's list of web-side changes. A new
  scope note (§12) naming session revocation as a real, un-taken next step.
- **draft.1 (2026-07-19):** initial contract — data model (§2:
  `webauthn_credentials` as its own table, `webauthn_challenges` for
  single-use), origin/RP-ID policy sourced from `HELPTHREAD_UI_BASE_URL`
  (§3), the seam extension and its honest limit (options-minting sits
  outside `AuthProvider`, §4), registration/authentication ceremonies with
  UV `'required'` and attestation `'none'` (§6), the signed-token + DB-nonce
  challenge lifecycle (§7), a log-only zero-counter-exempt clone policy
  (§8, later reversed in draft.2), the endpoint surface and last-credential
  guard (§9), security posture including the planted-passkey-survives-
  password-rotation risk (§10), rollout (§11), scope (§12), the
  `@simplewebauthn/server` license verification (§13), and decision points
  (§14).
