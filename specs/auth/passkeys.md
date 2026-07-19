# Passkeys (WebAuthn) login for Agents

Status: **draft** (2026-07-19). HT-75. Extends the auth-provider seam
`specs/auth/agents-and-auth.md` (HT-54) built with exactly one provider,
`password` — this is the second provider, and the first thing to actually
exercise the seam's "marketplace boundary" claim (agents-and-auth.md §1, §4)
with real code. Spec only: no migrations, no implementation. Every schema
block below is a design artifact, not a runnable migration — same
convention agents-and-auth.md's own `CREATE TABLE` blocks use.

Read first: `specs/auth/agents-and-auth.md` §3.2 (`agent_auth_identities`),
§4 (the seam), §8 (session/acting-Agent trust), §9 (security posture);
`specs/mail/gmail-connect.md` §2b (the signed-state, pre-auth pattern this
spec's challenge tokens reuse); `src/auth/provider.ts`, `src/auth/
password-provider.ts`, `src/auth/invite-token.ts` (the exact HMAC-token
shape this spec's challenge tokens mirror); `src/composition/config.ts`
(`uiBaseUrl`/`publicBaseUrl` origin validation).

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
password identity and one or more passkeys (§8.1 makes this precise, and
§9 treats it as a guard invariant, not an assumption).

## 2. Data model

Two new tables. Neither touches `agents` or `agent_auth_identities`.

### 2.1 Where credentials live — a new table, not `agent_auth_identities`

**Decision: `webauthn_credentials`, not a row per credential in
`agent_auth_identities`.** Three reasons, in order of weight:

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
3. **Cardinality.** An Agent may register many passkeys (laptop, phone,
   hardware key); `agent_auth_identities` enforces at most one `password`
   row per Agent via a partial unique index (§3.2) — the shape assumes
   "one row per method," which passkeys break by design.

Precedent for "a provider gets its own table": `mailbox_oauth_tokens`
(HT-38) holds Gmail's OAuth material rather than living in a shared
credentials table. Same move here.

```sql
CREATE TABLE webauthn_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  credential_id    text NOT NULL,             -- base64url, from the authenticator (WebAuthn's own id)
  public_key       bytea NOT NULL,            -- COSE_Key, raw bytes, as returned by attestationObject
  sign_count       bigint NOT NULL DEFAULT 0,
  transports       text[] NOT NULL DEFAULT '{}',  -- e.g. {internal,hybrid,usb,nfc,ble} (AuthenticatorTransport)
  backup_eligible  boolean NOT NULL,          -- BE flag, captured at registration (WebAuthn §6.1)
  backup_state     boolean NOT NULL,          -- BS flag, refreshed on every authentication
  name             text NOT NULL,             -- Agent-assigned label ("MacBook Touch ID")
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_used_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON webauthn_credentials (credential_id);
CREATE INDEX webauthn_credentials_agent ON webauthn_credentials (agent_id);
```

`credential_id` is globally unique (not scoped to `agent_id`): WebAuthn
credential ids are the authenticator's own high-entropy identifiers, and the
authentication ceremony looks a credential up by id **before** it knows
which Agent is signing in (§7.2's discoverable-credential flow) — the
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
functional gain. Flagged here because it is a genuine, deliberate departure
from the pattern the sibling module doc's comment implies, not an oversight.

### 2.2 Challenge lifecycle store — `webauthn_challenges`

Needed for single-use enforcement; see §6 for the full reasoning. One row
per minted challenge, keyed by its nonce.

```sql
CREATE TABLE webauthn_challenges (
  nonce        text PRIMARY KEY,
  ceremony     text NOT NULL CHECK (ceremony IN ('registration', 'authentication')),
  agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,  -- set for registration (session-bound); NULL for authentication (pre-identification, §5.2)
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges (expires_at);
```

No sweep job in v1: rows are small, short-lived (§6's TTL), and volume
tracks interactive login/registration events, not request volume — a
maintenance job to prune expired rows is a reasonable later addition
(§10), not built here (stated explicitly so the gap is a decision, not an
oversight, matching agents-and-auth.md's own "called out, not silently
taken" discipline).

## 3. Origin & RP ID policy

**The RP ID and expected origin come from `HELPTHREAD_UI_BASE_URL`
(`config.uiBaseUrl`) — never from the incoming request's own `Host` or
`Origin` header, and never hardcoded.** This is a hard security requirement,
not a style choice: WebAuthn's whole phishing-resistance property rests on
the Relying Party checking the browser-reported origin against a value the
RP itself controls (W3C WebAuthn §5.4/§7: "the RP ID... [is] scoped to...
only that Relying Party... is able to employ the public key credential" —
the credential is unusable outside the domain it was bound to). Deriving
the expected origin from anything the caller supplies would let an attacker
simply assert the origin they want checked against, collapsing the
protection to nothing.

- **`rpId`** = the hostname (no scheme, no port) of `HELPTHREAD_UI_BASE_URL`
  — e.g. `desk.resonantiq.app`. The exact hostname, not a stripped-down
  parent domain: WebAuthn allows an RP ID to be the origin's exact
  registrable domain or any of its parent domains, but the general guidance
  (and the simpler, safer default with no documented multi-subdomain need
  here) is the narrowest ID that covers the actual login surface — one
  hostname, one web deployment.
- **`expectedOrigin`** = `HELPTHREAD_UI_BASE_URL` verbatim (already validated
  by `config.ts` as a bare `https` origin — loopback `http` allowed only for
  local dev, per the existing validator's own comment: *"HELPTHREAD_UI_BASE_URL
  must use https... http is allowed only for loopback hosts"*). This already
  matches WebAuthn's own secure-context requirement (`https:`, or `http:` on
  `localhost`) exactly — no new validation logic needed, the existing
  validator is sufficient and is reused as-is.
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
fetched fresh per-attempt from the options endpoints (§8), never baked into
the static descriptor.

`AuthAttempt` (`{ providerKey: string } & Record<string, unknown>`) and
`VerifiedIdentity` (`{ agentId: string }`) need **no change** — a webauthn
attempt's provider-specific fields (`response`, `challengeToken`) fit the
existing untyped `Record<string, unknown>` exactly the way `password`'s
`email`/`password` fields do.

### 4.2 What does *not* fit the seam as shipped, and why

`AuthProvider.authenticate(attempt)` is a **single-shot** contract: one call
resolves one attempt to an identity or `null`. `password` fits this exactly
— no state precedes it. WebAuthn ceremonies do not: both registration and
authentication are two-step (mint options, then verify a signed response),
and the options step must hand the browser a fresh, unpredictable
`challenge` that the verify step later checks byte-for-byte. `provider.ts`
has no hook for "mint per-attempt state before authenticate() runs" —
nor should it grow one speculatively for a shape only one provider needs
(the same restraint the module doc already applies to the OAuth
"start URL" case, which is genuinely a different mechanism — a redirect to
a third party, not a same-origin JS ceremony — so this isn't a case of two
providers needing the same hook).

**Resolution: the options-minting step lives outside the `AuthProvider`
interface entirely**, as its own pre-auth endpoint pair (§8). Only the
*final* verify step — cryptographic signature check, resolve to an
Agent — goes through `authenticate()`, dispatched via the existing generic
`POST /auth/verify { providerKey, ... }`, exactly like `password`. This
keeps the seam's one formal contract (`authenticate`) doing the one thing
every provider genuinely shares — "verify an attempt, name who it is" — and
puts WebAuthn's extra pre-step where it structurally belongs: provider-specific
routes the seam doesn't need to know about, the same way an OAuth module's
redirect/callback dance would live in its own routes rather than in
`provider.ts`.

### 4.3 How `verify` differs from `password`, concretely

- **No identifier is asserted by the caller.** `password`'s attempt carries
  `email`; the caller is claiming an identity up front. A webauthn
  authentication attempt carries no email or Agent id at all — the identity
  is *discovered* from `response.id` (the credential id in the assertion),
  looked up in `webauthn_credentials`. This is what makes the discoverable/
  conditional-UI flow possible (§5.2) — the server never needs to know who's
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
  copy-pasted.
- **Two extra checks with no `password` analog:** the signed challenge token
  (§6) and the counter/clone policy (§7) run inside `authenticate()` before
  it can return non-null.
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
passkeys are a second *way in*, not a second kind of session.

**Where shipped code constrains this:** `web/src/lib/api.ts`'s `postVerify`
is typed narrowly to `{ providerKey: string; email: string; password:
string }`, not a generic passthrough — despite the engine endpoint already
being provider-generic. Consistent with this codebase's existing style
(`postSetup`, `postVerify`, `acceptInvite` are three separate small typed
wrappers over what could have been one generic POST helper), this spec adds
a **new, sibling function** — `postVerifyWebAuthn(input: { response:
AuthenticationResponseJSON; challengeToken: string }): Promise<{ agent:
Agent }>` — rather than widening `postVerify` into a union. Same for
`web/src/lib/auth-actions.ts`: a new `loginWithPasskeyAction`, not a
reshaped `loginAction` (whose signature is password-shaped: `(providerKey,
email, password, next)`).

## 5. Ceremonies

Both use `@simplewebauthn/server` (§12) for the CBOR/COSE/signature work;
this section states what Helpthread configures and verifies, not the
library's internals.

### 5.1 Registration — `navigator.credentials.create()`

Session-required (an already-authenticated Agent adding a passkey from
their own profile, agents-and-auth.md §7 item 5's "Change password"
sibling control). Options, generated via `generateRegistrationOptions`:

| Option | Value | Why |
|---|---|---|
| `rpName` | deployment display name (config or a fixed string) | shown in the OS passkey UI |
| `rpID` | `config.uiBaseUrl` hostname (§3) | phishing-resistance binding |
| `userID` | the Agent's raw `agents.id` (uuid) bytes | opaque, already-unique per Agent; **never the email** — WebAuthn's own guidance is that `user.id` should not carry directly identifying data, since it is retained by the authenticator and can be visible in sync/backup metadata |
| `userName` | the Agent's email | shown in the OS account picker, matching the W3C example convention |
| `userDisplayName` | the Agent's `name` | shown alongside `userName` |
| `challenge` | 32 random bytes (§6) | the spec's own worked examples use a 32-byte challenge; well above any documented minimum |
| `attestationType` | **`'none'`** | see justification below |
| `authenticatorSelection.residentKey` | **`'required'`** | required for the conditional-UI login flow (§5.2) — a non-discoverable credential cannot be surfaced by autofill at all (confirmed against MDN's Web Authentication API guide: conditional mediation only ever returns discoverable credentials) |
| `authenticatorSelection.userVerification` | **`'required'`** | see justification below |
| `authenticatorSelection.authenticatorAttachment` | **unset** (allow both) | a support Agent may want Touch ID/Windows Hello *or* a hardware key; restricting to one attachment class excludes real, common cases with no compensating benefit |
| `excludeCredentials` | the Agent's existing `webauthn_credentials` rows (`{id: credential_id, transports}`) | stops re-registering the same physical authenticator as a duplicate row |
| `supportedAlgorithmIDs` | library default (Ed25519 `-8`, ES256 `-7`, RS256 `-257`) | no override — narrowing would only exclude authenticators for no stated benefit |

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
the challenge decoded from the signed token (§6); `expectedOrigin` =
`config.uiBaseUrl` (§3); `expectedRPID` = the same hostname; `requireUserVerification:
true` (matching the `'required'` request — see §5.3, the request is a hint,
verification is the actual guarantee). On success, `registrationInfo`
yields the credential id, COSE public key, initial counter, credential
device type (single-/multi-device — feeds `backup_eligible`), and
`backedUp` (feeds `backup_state`) — inserted as one new `webauthn_credentials`
row. **Replay is naturally single-use here without extra bookkeeping**: a
replayed attestation response can only ever re-submit the *same* credential
id, and `credential_id`'s `UNIQUE` index rejects a second insert outright —
registration replay fails closed on a plain constraint violation, independent
of the challenge token's own single-use enforcement (§6 still applies it
uniformly, for reasons stated there).

### 5.2 Authentication — `navigator.credentials.get()`, conditional UI

**Pre-session** (no acting-Agent header — joins agents-and-auth.md §8's
bootstrap group: `/setup`, `/auth/verify`, `/auth/invite/accept`,
`GET /auth/providers`). Options, via `generateAuthenticationOptions`:

| Option | Value | Why |
|---|---|---|
| `rpID` | same as §5.1 | |
| `allowCredentials` | **omitted** | required for conditional UI: per MDN, "only discoverable credentials are included in calls that use conditional mediation, because the browser needs to request applicable credentials without knowing the credential ID values" — a populated `allowCredentials` list defeats autofill discovery |
| `challenge` | 32 random bytes (§6) | |
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

**Verification (`verifyAuthenticationResponse`).** The handler first reads
`response.id` from the posted assertion and looks up `webauthn_credentials
WHERE credential_id = $1`; not found → `null` (generic `401`, §4.3). Found →
loads the stored `credential` (public key, counter, transports) as the
library's `credential` param, `expectedChallenge`/`expectedOrigin`/
`expectedRPID` as in §5.1, `requireUserVerification: true`. On success:
update `sign_count`, `backup_state`, `last_used_at` on the credential row
(§7 governs how a counter regression is handled), re-check
`agents.status === 'active'`, return `VerifiedIdentity { agentId }`.

### 5.3 User verification: `'required'`, not `'preferred'` — justified

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

## 6. Challenge lifecycle — signed, TTL'd, single-use

**Stateless minting, reusing the existing Keyring/HMAC discipline** — the
same pattern `src/auth/invite-token.ts` and `src/mail/gmail-connect.ts`'s
`state` already use (full HMAC-SHA256 off `Keyring`, base64url, current+retired
key rotation, constant-time verification, a domain-separator prefix so a
signature minted for one purpose can never verify as another).

```
htw.{keyId}.{payload-b64url}.{sig-b64url}
```

Payload: `{ ceremony: 'registration' | 'authentication', challengeB64:
string, agentId: string | null, nonce: string, issuedAtMs: number }`.
`agentId` is the acting Agent for registration (bound at mint time from the
session, checked again at verify time — §6's replay note below), `null` for
authentication (pre-identification, §5.2). `htw.` is a new domain separator,
distinct from `hti.` (invite), `gmc.` (Gmail state), and reply tokens' `ht.`.
Default TTL **5 minutes** — generous slack above the WebAuthn ceremony's own
client-side `timeout` (60s default) so a slow biometric retry doesn't get
invalidated server-side before the browser itself gives up, while still
being short enough that a captured, unused token doesn't stay live long.

**Single-use is NOT a property the signed token has on its own** — unlike
the invite token, whose one-time-ness comes from the atomic `invited`→`active`
status transition it triggers (invite-token.ts's own module doc is explicit
about this), a bare signature+TTL check can be satisfied twice: nothing
about verifying an HMAC and a timestamp prevents verifying the *same* token
a second time within its TTL.

**Registration doesn't need single-use tracking to be safe** — §5.1 already
established this: replaying a registration response can only re-insert the
same credential id, and the `UNIQUE` index rejects it. **Authentication
does**: replaying a captured, fully-valid authentication response would mint
a *second* session for the same Agent — a real (if narrow) escalation,
gated behind already having captured one complete valid exchange (a TLS
MITM, or XSS on the login page — a threat model where a single valid
authentication already leaked, but a second free session on top of it is
still strictly worse). Given the stakes — this endpoint mints a login
session, the highest-value artifact in this spec — **the honest answer is
that pure statelessness cannot hold single-use here**, exactly the case
this ticket's brief anticipated.

**Resolution: `webauthn_challenges` (§2.2), one small row per minted
challenge.** Insert at options-mint time (`nonce`, `ceremony`, `agent_id`,
`expires_at = now() + 5m`). Consume at verify time with a single guarded
statement: `UPDATE webauthn_challenges SET consumed_at = now() WHERE nonce
= $1 AND consumed_at IS NULL AND expires_at > now()`. Zero rows affected →
reject as expired-or-already-used, independent of whether the HMAC/TTL
check on the token itself also passed — **two independent enforcement
layers**, not one mechanism duplicated: a bug in the signed-token TTL check
doesn't silently disable single-use, and vice versa (the same "a guard
predicate alone is not enough" caution agents-and-auth.md §5/§6 applies to
the last-admin and `/setup` races, applied here to a different kind of
double-use).

**One mechanism for both ceremonies, deliberately, even though registration
doesn't strictly need it.** Bifurcating the challenge-verification code path
by ceremony type would mean two implementations of a security-critical check
instead of one reviewed path — a worse trade than the small, genuinely-redundant
cost of consuming a nonce row registration doesn't strictly require.

**Registration's extra check:** at verify time, the token's `payload.agentId`
must equal the *currently authenticated* acting Agent (from the session
header, not from the request body) — defense in depth beyond the token's
own signature, so a registration-options response minted for one Agent's
session can't be replayed against a different Agent's registration/verify
call even if somehow captured and forwarded.

## 7. Counter & clone-detection policy

**Policy: log, don't block, with a zero-counter exemption.**

WebAuthn's own guidance (`@simplewebauthn/server`'s own published docs
state this in `registrationInfo.counter`'s description: "Should be kept in
a DB for later reference to help prevent replay attacks") assumes a
monotonically increasing counter is a meaningful clone signal. In practice
this holds cleanly only for **single-device, non-synced** authenticators
(most hardware security keys). The majority of passkeys shipping today are
**synced/multi-device** (iCloud Keychain, Google Password Manager, Windows
Hello with cloud sync) — and WebAuthn's own spec explicitly allows an
authenticator to report a signature counter of **`0`** to mean "this
authenticator does not implement a counter," a state synced platform
authenticators commonly use permanently, since a counter can't be
meaningfully kept in sync across every device sharing one passkey. A naive
"reject if returned counter ≤ stored counter" policy would either (a) be a
harmless no-op forever for a `0`-counter credential, or worse, (b) produce
real false-positive lockouts for legitimate multi-device Agents whose synced
counter genuinely doesn't move monotonically across devices — exactly the
failure mode a support tool's login cannot afford, since a locked-out Agent
during an incident is the scenario this whole system exists to support.

Concretely:

- **A credential whose stored counter is currently `0` is exempt from
  regression checks entirely** — `0` is the spec's own sentinel for "not
  tracked," so `0 ≤ 0` is correctly a no-op, never flagged.
- **Once a credential has reported a nonzero counter**, a later
  authentication reporting a counter **≤** the last stored value is logged
  as a security event (Agent id, credential id, stored vs. reported value,
  timestamp) — server-side log only in v1, no UI surfacing, no automatic
  session revocation — but the authentication is **not blocked**.
- **Why not block:** a counter anomaly alone, absent a forged signature
  (which verification already catches independently — the counter check
  runs only *after* the signature has already verified against the stored
  public key), is far more likely to be synced-authenticator counter
  incoherence than an actual cloned/extracted credential — cloning a modern
  platform authenticator's private key material at all is already a much
  harder attack than what a counter check would be defending against. Hard-
  blocking trades a routine multi-device usability break for a weak,
  already-covered-elsewhere signal (§8 covers what a genuinely stolen
  credential can and can't do).

This is a place to be honest about a real trade-off rather than default to
the textbook-strict answer: a self-hosted deployment that wants harder
enforcement can escalate log-only to reject-on-regression later (§10)
without a schema change — the counter is already stored either way.

## 8. Engine API (new)

All under the existing service-Bearer channel per agents-and-auth.md §6's
convention (Bearer authenticates web→engine; Agent identity rides inside
via the acting-Agent header where noted).

| Endpoint | Acting-Agent header | Notes |
|---|---|---|
| `POST /api/v1/auth/webauthn/registration/options` | **required** (self) | mints a registration challenge + `webauthn_challenges` row; body: none (Agent comes from the session) |
| `POST /api/v1/auth/webauthn/registration/verify` | **required** (self) | `{ response, challengeToken, name? }` → inserts a `webauthn_credentials` row; `name` defaults to a generic label ("Passkey — {date}") if omitted, renamable after |
| `POST /api/v1/auth/webauthn/authentication/options` | **forbidden/ignored** (pre-session) | mints an authentication challenge, no `agent_id`; body: none |
| `POST /api/v1/auth/verify` `{ providerKey: 'webauthn', response, challengeToken }` | **forbidden/ignored** (pre-session) | reuses the existing generic dispatcher (§4.2); same endpoint `password` already uses |
| `GET /api/v1/agents/{id}/webauthn-credentials` | **required** (self, or admin) | `{ credentials: [{ id, name, transports, backupEligible, backupState, createdAt, lastUsedAt }] }` — **never** the public key or the raw WebAuthn `credential_id`; the row's own `id` (uuid) is the API-facing handle for rename/revoke |
| `PATCH /api/v1/agents/{id}/webauthn-credentials/{credentialId}` | **required** (self, or admin) | `{ name }` — rename only |
| `DELETE /api/v1/agents/{id}/webauthn-credentials/{credentialId}` | **required** (self, or admin) | revoke; see §8.1 for the last-credential guard |

The four passkey-management rows (`registration/*`, `GET`/`PATCH`/`DELETE
.../webauthn-credentials`) join agents-and-auth.md §8's "header required"
set alongside `/agents/*`, `/auth/me`, and `PUT .../assignee`. The two
pre-session rows (`authentication/options`, the `webauthn` case of `/auth/
verify`) join its "header forbidden/ignored" bootstrap set.

### 8.1 Revoke-last-credential policy

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
passkey-only provisioning, §10) into a loud, safe refusal instead of a
footgun someone has to remember to re-derive later.

## 9. Security

- **Origin/rpId binding** — §3; the load-bearing phishing-resistance
  property, sourced only from server config, never from request input.
- **Stolen session — what it can and cannot do to credentials.** A stolen
  `ht_session` cookie (§4.4; up to the existing 7-day sliding window,
  agents-and-auth.md §8) already grants an attacker the ability to *list*,
  *rename*, and *revoke* the Agent's passkeys (no secret material is ever
  returned by the list endpoint — public keys and counters stay
  server-side) through the same header-required surface as every other
  self-service profile action. This is not a new capability the passkey
  feature introduces: a stolen session can already fully take over the
  account today via `POST /agents/{id}/password` (agents-and-auth.md §6),
  so passkey management piggybacks on an existing, already-comprehensive
  blast radius rather than widening it.

  **One genuinely new risk, stated plainly:** if an attacker with a stolen
  session *registers their own passkey* during the compromise window
  (§8's `registration/*` endpoints, session-required — a stolen session
  satisfies that), that credential is **independent of the stolen session's
  own lifetime**. The existing incident-response move — the Agent notices,
  changes their password — does **not** revoke a passkey the attacker
  planted; the attacker keeps full account access via their own passkey
  indefinitely, until someone finds and deletes it from the profile screen.
  **Mitigation, stated as a UI requirement, not just a caveat:** the profile
  screen's credential list (§8's `GET .../webauthn-credentials`) must be
  presented prominently enough that "rotate password" and "check for
  unrecognized passkeys" read as one combined incident-response action, not
  two — an Agent who only rotates their password after a suspected
  compromise has not actually finished the job if an attacker also planted
  a passkey. This is the single highest-value thing a reviewer of this spec
  should scrutinize: whether the eventual UI actually makes this visible,
  not buried under a rarely-opened settings sub-page.
- **No account enumeration** — §4.3's authentication-options endpoint takes
  no identifying input at all, which is a stronger position than `password`'s
  own no-enumeration design (agents-and-auth.md §9) rather than a parallel
  one; the credential-id lookup at verify time carries no comparable oracle
  risk either, for the reasons stated in §4.3.
- **Attestation `'none'`** (§5.1) means Helpthread never verifies *which*
  physical authenticator model produced a credential — only that a valid
  WebAuthn ceremony occurred. Stated plainly so it isn't assumed: this
  spec does not defend against a compromised authenticator *implementation*
  (e.g. malware-controlled software claiming to be a hardware key);
  attestation conveyance is the mechanism that would, and it's deliberately
  not used (§5.1's justification).
- **Rate limiting — same unresolved gap agents-and-auth.md §9 already
  names** ([HT-53](https://resonantiq.atlassian.net/browse/HT-53)): none
  of this spec's endpoints add rate limiting, and none is solved here. The
  two pre-session endpoints (`authentication/options`, the `webauthn` case
  of `/auth/verify`) inherit exactly the same per-instance gap `password`'s
  `/auth/verify` already has — called out, not silently left implicit.
- **No secret ever leaves the server.** The COSE public key is, definitionally,
  not a secret, but it is still never returned by any endpoint in §8 — the
  list endpoint's response shape (§8's table) carries only display metadata.
  The web never touches a private key at any point — that key never leaves
  the authenticator, by WebAuthn's own design.
- **Charter "own your data"** (agents-and-auth.md §9's framing, unchanged
  here): all credential material lives in the operator's own Postgres; no
  Helpthread-hosted relying-party service or FIDO Metadata Service call is
  made (attestation `'none'` means no MDS integration exists to make one).

## 10. Rollout

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
- **Escalation path, named but not built:** counter policy (§7) could move
  from log-only to reject-on-regression later without a schema change; a
  `webauthn_challenges` sweep job (§2.2) is a reasonable later addition;
  passkey-only provisioning (no password at all) is explicitly out of scope
  (§11) and would need §8.1's guard revisited if ever built.

## 11. What this is NOT (scope)

- **No passkey-only provisioning.** Every Agent still gets a password from
  the unchanged HT-54 invite/admin-set-password flow; a passkey is always
  an addition to, never a replacement for, that password (§1, §8.1).
- **No attestation verification / FIDO Metadata Service integration**
  (§5.1, §9) — `'none'` conveyance only.
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
- **No rate limiting** (§9) — HT-53, unresolved, called out not solved.
- **No `webauthn_challenges` sweep/GC job** (§2.2) — a later addition.

## 12. Library decision & provenance

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
`verifyAuthenticationResponse` — the four functions §5 configures and calls.

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

## 13. Decision points for TJ

1. **Credential storage: new `webauthn_credentials` table**, not rows in
   `agent_auth_identities`. *(§2.1 — recommend as specified; the mutable
   per-use state and column-shape mismatch make this the load-bearing
   reason, not just cardinality.)*
2. **User verification: `'required'`**, not `'preferred'`. *(§5.3 —
   recommend; every mainstream passkey provider already satisfies this, so
   the real-world cost is near zero and the alternative is a materially
   weaker credential.)*
3. **Counter/clone policy: log-only, zero-counter exempt**, not
   reject-on-regression. *(§7 — recommend; hard-blocking would produce real
   false-positive lockouts against common synced-passkey behavior for a
   weak, already-covered-elsewhere signal.)*
4. **Challenge single-use: signed token + a `webauthn_challenges` DB row**,
   applied uniformly to both ceremonies even though registration alone
   doesn't need it. *(§6 — recommend; one reviewed code path beats two for
   a security-critical check, and the row is cheap.)*
5. **Revoke-last-credential: no functional block needed (invariant holds),
   defensive `409` guard added anyway.** *(§8.1 — recommend; matches the
   last-admin-guard precedent's own reasoning.)*
6. **Attestation: `'none'`.** *(§5.1 — recommend; matches the library
   default and mainstream platform posture; no stated need for stronger
   conveyance here.)*
7. **`HELPTHREAD_UI_BASE_URL` becomes required-for-passkeys** (provider
   simply doesn't wire up without it), rather than inventing a fallback
   origin. *(§3 — recommend; there is no safe fallback to invent.)*
8. **Library: `@simplewebauthn/server`, not hand-rolled.** *(§12 —
   recommend; CBOR/COSE/attestation-object parsing is exactly the kind of
   security-critical binary-format work this codebase's own provenance
   discipline argues for taking from a maintained, permissively-licensed
   dependency rather than reimplementing.)*

## Changelog

- **draft (2026-07-19):** initial contract — data model (§2: `webauthn_credentials`
  as its own table, `webauthn_challenges` for single-use), origin/RP-ID
  policy sourced from `HELPTHREAD_UI_BASE_URL` (§3), the seam extension and
  its honest limit (options-minting sits outside `AuthProvider`, §4),
  registration/authentication ceremonies with UV `'required'` and
  attestation `'none'` (§5), the signed-token + DB-nonce challenge lifecycle
  (§6), a log-only zero-counter-exempt clone policy (§7), the endpoint
  surface and last-credential guard (§8), security posture including the
  planted-passkey-survives-password-rotation risk (§9), rollout (§10),
  scope (§11), the `@simplewebauthn/server` license verification (§12),
  and decision points (§13).
