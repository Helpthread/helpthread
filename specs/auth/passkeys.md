# Passkeys (WebAuthn) login for Agents

Status: **draft** (2026-07-19). Spec only — no migrations, no implementation.
Every schema block below is a design artifact, not a runnable migration.

Adds a second provider on the auth-provider seam of
`specs/auth/agents-and-auth.md`, which shipped with exactly one (`password`).

Read first: `specs/auth/agents-and-auth.md` §3.2 (`agent_auth_identities` —
**amended by this spec**, §2.1 below), §4 (the seam), §8 (session/acting-Agent
trust), §9 (security posture); `specs/mail/gmail-connect.md` §2b (the
signed-state pattern this spec's challenge tokens reuse); `src/auth/provider.ts`,
`src/auth/password-provider.ts`, `src/auth/invite-token.ts`,
`src/auth/invite-email.ts` (the HMAC-token and notification-email shapes this
spec mirrors); `src/composition/config.ts` (`uiBaseUrl`/`publicBaseUrl` origin
validation); `src/composition/health.ts` (the alertable surface §8 routes into).

## 1. Purpose & scope

**Passkey login is core, not a marketplace module** — the one deliberate
exception to the core/marketplace boundary (agents-and-auth.md §1; module
catalog, 2026-07-18: "Security hygiene is always free"). Nothing in this spec
sits behind an entitlement check. The AGPL §7 module exception gates in-process
third-party modules and external contributions — Google SSO, magic-link, and
SAML/enterprise SSO remain marketplace and wait on it (agents-and-auth.md §11).
It does not gate first-party core code.

**Additive only.** No existing Agent, provisioning path, or endpoint changes.
Every Agent still gets a `password` identity through the unchanged invite or
admin-set-password flow (agents-and-auth.md §8); a passkey is something an
**already-authenticated** Agent optionally adds from their own profile. There is
no passkey-only provisioning in v1, so an Agent can never legitimately reach zero
password identities with one or more passkeys (§9.1 enforces this as a guard,
§12 keeps it out of scope).

## 2. Data model

Three new tables. None touches `agents` or `agent_auth_identities`.

### 2.1 Credentials live in a new table, not `agent_auth_identities`

**Decision: `webauthn_credentials`.** A reader would reasonably expect
`provider='passkey'` rows in the general auth-provider table instead;
**agents-and-auth.md §3.2 is amended to point here** (see its changelog).

Two reasons carry the departure:

1. **Per-credential state that mutates on every use.** A WebAuthn credential
   carries a signature counter and a last-used timestamp that update on every
   authentication (§7). `agent_auth_identities` is written rarely (mint once at
   provisioning, rewritten only on password change); a row type that churns on
   every login turns a low-write table into a mixed-traffic one.
2. **The columns don't fit the shared shape.** `agent_auth_identities` has one
   credential-shaped column, `secret_hash` (a scrypt string). A passkey needs a
   COSE public key, a counter, a transports array, two backup flags, and a
   user-assigned name. Repurposing `secret_hash` for a public key is a live
   footgun — `password-provider.ts` calls `verifyPassword(password,
   identity.secretHash)` unconditionally on that shape. Adding five nullable
   columns instead pollutes the table for every non-webauthn row, which is what
   agents-and-auth.md §1's "zero core-schema change" promise for provider
   *additions* exists to prevent: a provider brings its own table.

**Cardinality is not one of the reasons.** Nothing in `agent_auth_identities`
restricts an Agent to a single `passkey` row — the partial unique index
(`agent_auth_identities_one_password_per_agent`) is specific to `password`.
Precedent for "a provider gets its own table": `mailbox_oauth_tokens` holds
Gmail's OAuth material rather than a shared credentials table.

```sql
CREATE TABLE webauthn_credentials (   id                        uuid PRIMARY KEY DEFAULT gen_random_uuid,
  agent_id                  uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  credential_id             text NOT NULL,             -- base64url, from the authenticator (WebAuthn's own id)
  public_key                bytea NOT NULL,            -- COSE_Key, raw bytes, as returned by attestationObject
  sign_count                bigint NOT NULL DEFAULT 0,
  transports                text[] NOT NULL DEFAULT '{}',  -- e.g. {internal,hybrid,usb,nfc,ble} (AuthenticatorTransport)
  backup_eligible           boolean NOT NULL,          -- BE flag, captured at registration (WebAuthn §6.1)
  backup_state              boolean NOT NULL,          -- BS flag, refreshed on every authentication
  name                      text NOT NULL,             -- Agent-assigned label ("MacBook Touch ID")
  sign_count_regression_at  timestamptz,               -- set on a Tier-2 counter regression (§8) — the health check's signal
  created_at                timestamptz NOT NULL DEFAULT now,
  last_used_at              timestamptz,
  updated_at                timestamptz NOT NULL DEFAULT now
);
CREATE UNIQUE INDEX webauthn_credentials_credential_id_key ON webauthn_credentials (credential_id);
CREATE INDEX webauthn_credentials_agent ON webauthn_credentials (agent_id);
```

`credential_id` is globally unique, not scoped to `agent_id`: the authentication
ceremony looks a credential up by id **before** it knows which Agent is signing
in (§6.2), so the unique index is also the lookup path. Deleting an Agent
cascades their credentials, mirroring `agent_auth_identities`.

**No mirrored row in `agent_auth_identities`.** The credential id in the
assertion *is* the lookup key, resolved directly against
`webauthn_credentials.agent_id` — there is no external subject to map, unlike the
OAuth-module shape `src/auth/provider.ts` sketches. A parallel bookkeeping row
would be state that can drift from the source of truth.

### 2.2 Challenge store — `webauthn_challenges`

Backs single-use enforcement (§7). One row per minted challenge, keyed by nonce.

```sql
CREATE TABLE webauthn_challenges (   nonce        text PRIMARY KEY,
  ceremony     text NOT NULL CHECK (ceremony IN ('registration', 'authentication', 'step-up')),
  agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,  -- set for registration/step-up (session-bound); NULL for authentication (pre-identification, §6.2)
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges (expires_at);
```

`'step-up'` (§5) is a re-authentication ceremony against an Agent's *own*
existing credentials, distinct from `'authentication'` (anonymous login) and
`'registration'`.

**Volume tracks requests, not logins.** A row is minted on every
`authentication/options` call, which fires on every unauthenticated `/login`
page mount attempting conditional UI — page views, not completed logins — and
§6.2 re-mints on an interval below the TTL, so one long-lived tab mints several
rows.

**Purge opportunistically on every mint; no cron.** Each `INSERT` that mints a
row (any ceremony) is preceded, in the same transaction, by `DELETE FROM
webauthn_challenges WHERE expires_at < now`, using the index above. Steady-state
size stays bounded to roughly (mint-rate × TTL) at the cost of one indexed
`DELETE` on a write that was happening anyway. `webauthn_stepup_tokens` (§2.3)
gets the identical treatment — one mechanism, not two.

### 2.3 Step-up proof store — `webauthn_stepup_tokens`

Backs §5. A separate table because a step-up token proves an existing factor
rather than being a WebAuthn ceremony challenge, though it reuses the identical
signed-token-plus-DB-row mechanism.

```sql
CREATE TABLE webauthn_stepup_tokens (   nonce        text PRIMARY KEY,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX webauthn_stepup_tokens_expires ON webauthn_stepup_tokens (expires_at);
```

## 3. Origin & RP ID policy

**The RP ID and expected origin come from `HELPTHREAD_UI_BASE_URL`
(`config.uiBaseUrl`) — never from the request's own `Host` or `Origin` header,
and never hardcoded.** WebAuthn's phishing resistance rests entirely on the
Relying Party checking the browser-reported origin against a value the RP itself
controls; deriving it from caller input collapses the protection to nothing.

- **`rpId`** = the hostname (no scheme, no port) of `HELPTHREAD_UI_BASE_URL` —
  the deployed Agent Inbox's host, e.g. `inbox.example.com`. **Not the engine's
  host.** Ceremonies run in the tab showing the login page, so the
  browser-reported origin is always the UI's; the engine is never loaded in an
  Agent's browser. A misconfiguration here fails every ceremony closed — binary,
  works everywhere or nowhere.

  Use the exact hostname, not a parent domain: WebAuthn permits any registrable
  parent, but the narrowest ID covering the actual login surface is the safer
  default with no multi-subdomain need here.
- **`expectedOrigin`** = `HELPTHREAD_UI_BASE_URL` verbatim, already validated by
  `config.ts` as a bare `https` origin (loopback `http` allowed only for local
  dev). This satisfies WebAuthn's secure-context requirement, with one carve-out
  below.
- **Dev: `localhost` only, never a loopback IP literal.** An RP ID must be a
  domain-form hostname; `localhost` qualifies, an IP address literal does not.
  **`http://127.0.0.1` and `http://[::1]` are unsupported for passkeys even
  though `config.ts` accepts them as a valid `HELPTHREAD_UI_BASE_URL`** — a
  deployment developing against a loopback IP gets everything else working and
  passkeys failing at the first ceremony. Local passkey development must use
  `http://localhost:<port>`.
- **`uiBaseUrl` becomes required-if-passkeys-are-enabled.** It is optional in
  `AppConfig` today (invite links degrade without it). There is no safe fallback
  origin to bind ceremonies to, so `root.ts` refuses to wire
  `WebAuthnAuthProvider` when it is unset and `GET /auth/providers` omits the
  `webauthn` descriptor — the same degrade-by-omission shape agents-and-auth.md
  already uses for invites.

## 4. The auth-provider seam extension

### 4.1 What changes in `src/auth/provider.ts`

One type-level change: `AuthProviderDescriptor.kind` widens from `'credentials'`
to `'credentials' | 'webauthn'`. No other descriptor field is added — the login
screen needs only `{ key: 'webauthn', label: 'Passkey', kind: 'webauthn' }`;
every ceremony detail is fetched fresh per-attempt from the options endpoints
(§9), never baked into the static descriptor.

`AuthAttempt` (`{ providerKey: string } & Record<string, unknown>`) and
`VerifiedIdentity` (`{ agentId: string }`) need **no change** — a webauthn
attempt's `response` and `challengeToken` fit the existing untyped record exactly
as `password`'s `email`/`password` do.

### 4.2 What does not fit the seam, and why

`AuthProvider.authenticate(attempt)` is single-shot: one call resolves one
attempt. WebAuthn ceremonies are two-step — mint options, then verify a signed
response — and the options step must hand the browser a fresh, unpredictable
`challenge` the verify step checks byte-for-byte. `provider.ts` has no hook for
minting per-attempt state, and should not grow one for a shape only one provider
needs.

**Resolution: options-minting lives outside the `AuthProvider` interface**, as
its own pre-auth (or session-bound) endpoint pairs (§9). Only the final verify
step for login goes through `authenticate`, dispatched via the existing generic
`POST /auth/verify { providerKey, ... }`, exactly like `password`.

### 4.3 How `verify` differs from `password`

- **No identifier is asserted by the caller.** A webauthn attempt carries no
  email or Agent id; the identity is *discovered* from `response.id`, looked up
  in `webauthn_credentials`. This is what makes the discoverable/conditional-UI
  flow possible (§6.2).
- **Verification is cryptographic, not a KDF comparison.** WebAuthn verifies a
  signature against the stored COSE public key. No `DUMMY_HASH`-style timing
  equalization is needed for the unknown-credential case: a credential id is
  high-entropy and unenumerable, so "not found" and "signature invalid" carry no
  oracle risk comparable to "this email has no account." The endpoint still
  returns a uniform generic `401` for both, for symmetry with `password`. (§6.2's
  `challenge_expired` is the one deliberate exception.)
- **Extra checks with no `password` analog:** the signed challenge token and its
  ceremony discriminator (§7), and the counter/clone policy (§8), both run inside
  `authenticate` before it can return non-null.
- **The `agent.status === 'active'` gate is repeated independently.**
  `WebAuthnAuthProvider.authenticate` never touches `agent_auth_identities`, so
  it re-checks `agents.status` after resolving `agent_id` — an
  `invited`/`disabled` Agent's passkey is refused exactly like their password.

### 4.4 Session minting — identical to `password`

On a non-null `VerifiedIdentity`, the web mints the session exactly as today:
`mintSessionCookie(agentId)`, same `{v:2, iat, sub}` payload
(`web/src/lib/session.ts`), same cookie options, same `X-Helpthread-Agent-Id`
derivation (agents-and-auth.md §8). Passkeys are a second *way in*, not a second
kind of session.

Two web-side additions, matching this codebase's existing style of small typed
wrappers rather than one generic helper:

- `web/src/lib/api.ts` gains a sibling `postVerifyWebAuthn(input: { response:
  AuthenticationResponseJSON; challengeToken: string }): Promise<{ agent: Agent
  }>` rather than widening the password-shaped `postVerify` into a union. Same
  for `web/src/lib/auth-actions.ts`: a new `loginWithPasskeyAction`, not a
  reshaped `loginAction`.
- `web/src/lib/api-types.ts` carries the web's local mirror of
  `AuthProviderDescriptor` and needs the identical widening from §4.1. The engine
  and web copies must move together or the web rejects a `kind: 'webauthn'`
  descriptor the engine legitimately returns.

## 5. Step-up re-authentication for passkey enrollment

Registering a **new** passkey is the one action here that mints durable,
independent credentials — access that outlives a stolen session's expiry and even
a password rotation (§10). **Both `registration/options` and
`registration/verify` require a fresh step-up proof: evidence, no older than 5
minutes, that the caller can currently produce an existing factor (the Agent's
current password, or an assertion from an already-registered passkey) for the
same Agent the session claims to be.** A live session alone is deliberately
insufficient.

### 5.1 Proving step-up

- **`POST /api/v1/auth/step-up/password`** (session-required) `{ password }` —
  resolves the acting Agent's email from the session (`sub`), **never** from
  client input, and re-runs the verification `PasswordAuthProvider.authenticate`
  already performs.
- **`POST /api/v1/auth/step-up/webauthn/options`** then **`.../verify`** (both
  session-required) — ceremony `'step-up'`. Unlike login's options call, this one
  already knows who is asking, so `allowCredentials` is populated with the acting
  Agent's own credentials. `verify` requires the resolved `agentId` to equal the
  session's `sub`: proving a factor for a different, even genuinely valid, Agent
  does not step up *this* session.

Either path mints a **step-up token**
`htsu.{keyId}.{payload-b64url}.{sig-b64url}` — same `Keyring`/HMAC discipline as
every other token here — payload `{ agentId, issuedAtMs, nonce }`, a
`webauthn_stepup_tokens` row inserted at mint time, TTL **5 minutes**.

### 5.2 Spending it

`registration/options` requires `{ stepUpToken }`: verify signature + TTL +
`payload.agentId === session.sub`, then **consume** it (`UPDATE
webauthn_stepup_tokens SET consumed_at = now WHERE nonce = $1 AND consumed_at IS
NULL AND expires_at > now`; zero rows → reject).

`registration/verify` **also** requires the same token and independently
re-validates signature + TTL + `agentId`, but does **not** consume it again. Same
two-layer shape as §7: `options` holds the DB-backed single-use guarantee,
`verify` is a cheap stateless re-check closing the gap if `verify` were ever
reachable by a path that skipped `options`.

### 5.3 On success: notify out-of-band

Every successful `registration/verify` sends a **"new passkey added"** email to
the Agent's own address through the core `EmailSender` transport directly — not
through `sendReply`/`src/mail/send.ts`, since there is no conversation this
belongs to (`src/auth/invite-email.ts` is the precedent). Content: which
credential, roughly when, and "if this wasn't you, revoke it from your profile
and change your password."

**Best-effort, non-blocking.** A send failure is logged and does not fail the
registration response — the credential is already durably created, mirroring
`sendInvite`'s `inviteSent: false`-on-failure posture.

### 5.4 What step-up deliberately does not gate

Rename and revoke (§9) are **not** step-up-gated. Revoking shrinks an attacker's
foothold rather than creating one; gating it would only slow the legitimate Agent
kicking out a passkey they don't recognize.

## 6. Ceremonies

All three use `@simplewebauthn/server` (§13) for the CBOR/COSE/signature work;
this section states what Helpthread configures and verifies.

### 6.1 Registration — `navigator.credentials.create`

Session-required and step-up-required (§5). Options, via
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

**Attestation `'none'`.** Requesting attestation conveyance would require
verifying a certificate chain against the FIDO Metadata Service — a
metadata-fetching subsystem, cert validation, revocation — to learn which
authenticator model was used. Helpthread has no requirement to restrict which
models an Agent may use. `'none'` is the library default and the shape the
mainstream platform authenticators are built around.

**Verification (`verifyRegistrationResponse`).** `expectedChallenge` = the
challenge decoded from the signed token (§7); `expectedOrigin` =
`config.uiBaseUrl` (§3); `expectedRPID` = the same hostname;
`requireUserVerification: true` (§6.3). On success, `registrationInfo` yields the
credential id, COSE public key, initial counter, credential device type (feeds
`backup_eligible`), and `backedUp` (feeds `backup_state`) — inserted as one
`webauthn_credentials` row. **`name` is required at the database (§2.1) but
optional on the wire** (§9): an omitted or blank `name` is replaced with a
server-computed `"Passkey — {date}"` before the `INSERT`. **Registration replay
fails closed without extra bookkeeping**: a replayed attestation can only
re-submit the same credential id, which `credential_id`'s `UNIQUE` index rejects
(§7 still applies single-use uniformly, for reasons stated there).

**A credential id already claimed by a different Agent** is refused with a
generic `409` ("this passkey is already registered") — the response never names
or implies which other Agent holds it (agents-and-auth.md §9's no-enumeration
discipline).

### 6.2 Authentication — `navigator.credentials.get`, conditional UI

**Pre-session** — joins agents-and-auth.md §8's bootstrap group (`/setup`,
`/auth/verify`, `/auth/invite/accept`, `GET /auth/providers`). Options, via
`generateAuthenticationOptions`:

| Option | Value | Why |
|---|---|---|
| `rpID` | same as §6.1 | |
| `allowCredentials` | **omitted** | required for conditional UI: per MDN, "only discoverable credentials are included in calls that use conditional mediation, because the browser needs to request applicable credentials without knowing the credential ID values" — a populated `allowCredentials` list defeats autofill discovery |
| `challenge` | 32 random bytes (§7) | |
| `userVerification` | **`'required'`** | |

This endpoint takes **no input at all** — not even an email — so it has no
enumeration surface by construction.

**Client side.** The login form's email field gets `autoComplete="username
webauthn"`, and on mount, if `PublicKeyCredential.isConditionalMediationAvailable`
resolves `true`, the page calls `navigator.credentials.get({ publicKey: options,
mediation: 'conditional' })` in the background; a matching platform passkey then
appears in the browser's native autofill dropdown. Where conditional mediation is
unsupported (feature-detected `false`), the screen falls back to an explicit
"Sign in with a passkey" button calling the same `get` without `mediation`.
(`LoginScreen.tsx` today flags that the email input is not yet
`ds/core/TextInput`-`type="email"`/`autoComplete`-capable.)

**Staleness: a long-lived login tab must not silently 401.** Conditional
mediation's promise "remains pending until the user picks an account," so a tab
can outlive the 5-minute challenge TTL and complete a ceremony against a
challenge the server has expired and purged. Two complementary layers:

- **Proactive re-mint below the TTL.** The client holds an `AbortController` for
  its in-flight `get({ mediation: 'conditional', signal })` and, every 3 minutes
  (60% of TTL), aborts it, calls `authentication/options` for a fresh challenge,
  and re-issues `get`.
- **Reactive retry once on server-detected expiry.** Browsers throttle timers in
  backgrounded tabs, so a 3-minute re-arm can slip past the TTL. When §7's
  consume affects zero rows *specifically because the row is missing or expired*
  — as opposed to a bad signature or unknown credential — the engine returns a
  distinguishable `challenge_expired` code. This is safe to distinguish: it is
  about ceremony freshness, not account existence, and the nonce was one our own
  server minted for this client's prior request. The client silently re-mints,
  retries once, and only then surfaces an error.

**Verification (`verifyAuthenticationResponse`).** The handler reads
`response.id` and looks up `webauthn_credentials WHERE credential_id = $1`; not
found → `null` (generic `401`, §4.3). Found → passes the stored credential
(public key, counter, transports) plus `expectedChallenge`/`expectedOrigin`/
`expectedRPID` as in §6.1, `requireUserVerification: true`. That first read is
unlocked — it only hands the public key to the library, and a stale read there is
harmless.

**The counter check and its persistence are one atomic unit.** On successful
signature verification the handler re-reads the same row with `SELECT ... FOR
UPDATE` inside a transaction, applies §8's comparison against **that freshly
locked read**, and only if it passes updates `sign_count`, `backup_state`, and
`last_used_at` before committing. Without the lock, two concurrent, independently
valid authentications (a double-tap, two open tabs — each carries its own
single-use challenge, so both can be genuinely valid) could both judge themselves
non-regressive against the same stale read, and the write landing second — even
carrying the lower counter — would overwrite the higher one, understating the
maximum every future §8 check rests on. `agents.status === 'active'` is
re-checked inside the same transaction before it returns `VerifiedIdentity`.

**`userHandle` cross-check.** A discoverable-credential assertion returns
`response.userHandle` — the bytes minted as `userID` at registration. Once the
credential is resolved by `credential_id` (**not** by `userHandle`, which is never
the primary lookup), a present `userHandle` must equal the resolved row's
`agent_id`; a mismatch is a hard rejection independent of signature validity.
Defense in depth against a row whose `agent_id` has diverged from what the
credential was bound to.

### 6.3 User verification: `'required'`, not `'preferred'`

A credential without UV is a pure possession factor — a bearer token bound to a
device. For passkeys to replace passwords rather than be a weaker side door they
must carry both something the Agent has (the authenticator) and something they
are or know (the PIN or biometric unlocking it). `'required'` also matches
`@simplewebauthn/server`'s own `requireUserVerification` default. Every
mainstream passkey provider — iCloud Keychain, Google Password Manager, Windows
Hello, PIN-protected hardware keys — already requires a PIN or biometric, so this
excludes nothing an Agent would realistically register.

**Requesting UV is a hint; the server checks the flag independently.**
`userVerification: 'required'` in the options only asks the authenticator to
enforce it. The library's `requireUserVerification` parameter, which inspects the
UV bit in the returned authenticator data, is what makes the check load-bearing —
this spec passes it explicitly.

## 7. Challenge lifecycle — signed, TTL'd, single-use, ceremony-bound

**Stateless minting on the existing Keyring/HMAC discipline** — the pattern
`src/auth/invite-token.ts` and `gmail-connect.ts`'s `state` already use:
HMAC-SHA256 off `Keyring`, base64url, current+retired key rotation, constant-time
verification, a domain-separator prefix.

```
htw.{keyId}.{payload-b64url}.{sig-b64url}
```

Payload: `{ ceremony: 'registration' | 'authentication' | 'step-up',
challengeB64: string, agentId: string | null, nonce: string, issuedAtMs: number
}`. `agentId` is the acting Agent for registration/step-up, `null` for
authentication (pre-identification). `htw.` is distinct from `hti.` (invite),
`gmc.` (Gmail state), `htsu.` (step-up, §5), and `ht.` (reply tokens). TTL **5
minutes** — slack above the ceremony's own 60s client-side `timeout` so a slow
biometric retry isn't invalidated server-side, short enough that a captured
unused token doesn't stay live.

**Single-use is not a property the signed token has on its own.** Unlike the
invite token, whose one-time-ness comes from the atomic `invited`→`active`
transition it triggers, an HMAC + timestamp check can be satisfied twice within
the TTL.

Registration does not need single-use tracking to be safe (§6.1: the `UNIQUE`
index rejects a replayed credential id). **Authentication does**: replaying a
captured valid response would mint a *second* session — a narrow but real
escalation, gated behind having already captured one complete exchange.

**Resolution: one `webauthn_challenges` row per minted challenge** (§2.2).
Insert at options-mint time (`nonce`, `ceremony`, `agent_id`, `expires_at = now +
5m`), preceded by the opportunistic purge. Consume at verify time —
**parameterized on ceremony, not just nonce**:

```sql
UPDATE webauthn_challenges
SET consumed_at = now
WHERE nonce = $1 AND ceremony = $2 AND consumed_at IS NULL AND expires_at > now
```

Zero rows affected → reject as expired-or-used-or-wrong-ceremony, independent of
whether the token's own HMAC/TTL check passed. **Two independent enforcement
layers**, not one mechanism duplicated: a bug in the TTL check does not silently
disable single-use, and vice versa.

**The `ceremony` discriminator is enforced at both layers.** Each verify handler
hardcodes the ceremony it expects (`registration/verify` → `'registration'`; the
`webauthn` case of `/auth/verify` → `'authentication'`; `step-up/webauthn/verify`
→ `'step-up'`) and checks it twice:

1. **Application-level:** after signature and TTL succeed, compare
   `payload.ceremony` to the endpoint's hardcoded expectation — reject before
   touching the database or running any WebAuthn verification.
2. **Database-level:** the consume statement supplies `$2` from that same
   hardcoded expectation, never from client input, so a bug skipping check 1
   still fails closed.

Without this, a validly-signed, unexpired token minted for one ceremony would
pass every other check at a different endpoint's verify call. The WebAuthn
response's own `type` field (`webauthn.create` vs `webauthn.get`) independently
prevents the underlying credential response from being cross-used, but nothing in
the token format did.

**One mechanism for all three ceremonies**, even though registration does not
strictly need single-use tracking: bifurcating a security-critical check by
ceremony type would mean several implementations instead of one reviewed path.

**Registration's and step-up's extra check:** at verify time the token's
`payload.agentId` must equal the currently authenticated acting Agent, taken from
the session header rather than the request body — so an options response minted
for one Agent's session cannot be replayed against another's verify call.

## 8. Counter & clone-detection policy

**Exempt zero-history credentials; reject and alert on regression for every
credential that has ever reported a nonzero counter.**

- **Tier 1 — never reported nonzero.** A credential whose stored counter is still
  `0` is exempt. `0` is WebAuthn's own sentinel for "does not implement a
  counter"; most synced/multi-device platform authenticators never leave this
  tier, which is exactly the state the sentinel describes.
- **Tier 2 — has reported ≥1 nonzero value, ever.** The credential permanently
  graduates, *including* if a later report reverts to `0` — an authenticator that
  has demonstrated it implements a counter reporting `0` afterward is a
  regression to the lowest possible value, not a return to the sentinel. From
  then on, **any authentication reporting a counter ≤ the stored maximum is
  rejected** (the caller sees the same generic `401`; §4.3's no-enumeration
  posture is unchanged) **and the event is routed to the alertable surface**.
  "The stored maximum" is the value read under §6.2's `SELECT ... FOR UPDATE`,
  compared and updated inside that same locked transaction — that atomicity is
  what stops two concurrent requests racing past it.

A credential that has graduated is, by definition, exhibiting the single-device
monotonic-counter behavior the counter mechanism was designed to police, so a
regression on that population is a high-quality clone signal rather than
synced-authenticator noise.

**Routing to `/internal/health` (runbook Part G)**, mirroring the existing
`forgedTokens`/`forged-token-burst` check in `src/composition/health.ts` rather
than inventing a pattern:

- `webauthn_credentials.sign_count_regression_at` (§2.1) is set to `now` on each
  Tier 2 rejection — overwritten each time, a single timestamp, not a log table,
  matching the forged-token column's "a marker, not an audit trail" shape.
- `runHealthCheck` gains one check in the same idiom: `SELECT count(*) FROM
  webauthn_credentials WHERE sign_count_regression_at > now - interval '24
  hours'`; any count `> 0` pushes a `webauthn-counter-regression: <n>
  credential(s) rejected for signature-counter regression in the last 24h — a
  high-quality clone signal for a non-synced credential; inspect and consider
  revoking (runbook Part G)` alert, tripping the endpoint's existing `200`→`503`
  pivot. No new alerting channel and no threshold tuning: the existing
  status-code-polling stack picks it up for free.
- The rejection is still logged where it happens — the column makes it
  *alertable*, the log line makes it *investigable*.

## 9. Engine API (new)

All under the existing service-Bearer channel (agents-and-auth.md §6): Bearer
authenticates web→engine; Agent identity rides in the acting-Agent header where
noted.

| Endpoint | Acting-Agent header | Notes |
|---|---|---|
| `POST /api/v1/auth/step-up/password` | **required** (self) | `{ password }`; re-verifies the acting Agent's own password (email resolved from the session, never client input); on success mints a `webauthn_stepup_tokens` row, returns `{ stepUpToken }` (§5.1) |
| `POST /api/v1/auth/step-up/webauthn/options` | **required** (self) | mints a `webauthn_challenges` row, `ceremony='step-up'`; `allowCredentials` = the Agent's own existing credentials (§5.1) |
| `POST /api/v1/auth/step-up/webauthn/verify` | **required** (self) | `{ response, challengeToken }`; requires resolved `agentId === session.sub`; on success mints a `webauthn_stepup_tokens` row, returns `{ stepUpToken }` (§5.1) |
| `POST /api/v1/auth/webauthn/registration/options` | **required** (self) | `{ stepUpToken }` — mints a registration challenge + `webauthn_challenges` row (`ceremony='registration'`); consumes the step-up token (§5.2) |
| `POST /api/v1/auth/webauthn/registration/verify` | **required** (self) | `{ response, challengeToken, stepUpToken, name? }` — `name` is optional in the *request*; the server defaults an omitted or blank value to `"Passkey — {date}"` before insertion, so the `webauthn_credentials.name` column's `NOT NULL` (§2.1) is never at risk from a client that skips it → inserts a `webauthn_credentials` row; re-validates (not re-consumes) `stepUpToken` (§5.2); sends the "new passkey added" notification email on success (§5.3); `409` if `credential_id` already claimed by a different Agent (§6.1) |
| `POST /api/v1/auth/webauthn/authentication/options` | **forbidden/ignored** (pre-session) | mints an authentication challenge (`ceremony='authentication'`), no `agent_id`; body: none |
| `POST /api/v1/auth/verify` `{ providerKey: 'webauthn', response, challengeToken }` | **forbidden/ignored** (pre-session) | reuses the existing generic dispatcher (§4.2); on challenge-expiry specifically, returns `challenge_expired` (§6.2) rather than the generic `401` — every other failure mode stays generic |
| `GET /api/v1/agents/{id}/webauthn-credentials` | **required** (self, or admin) | `{ credentials: [{ id, name, transports, backupEligible, backupState, createdAt, lastUsedAt }] }` — **never** the public key or the raw WebAuthn `credential_id`; the row's own `id` (uuid) is the API-facing handle for rename/revoke |
| `PATCH /api/v1/agents/{id}/webauthn-credentials/{credentialId}` | **required** (self, or admin) | `{ name }` — rename only; **not** step-up-gated (§5.4) |
| `DELETE /api/v1/agents/{id}/webauthn-credentials/{credentialId}` | **required** (self, or admin) | revoke; **not** step-up-gated (§5.4); see §9.1 for the last-credential guard |

The seven passkey-management rows join agents-and-auth.md §8's "header required"
set alongside `/agents/*`, `/auth/me`, and `PUT .../assignee`. The two
pre-session rows join its "header forbidden/ignored" bootstrap set.

### 9.1 Revoke-last-credential policy

**An Agent can never reach zero credentials via passkey revocation alone** — §1's
invariant means every Agent always has their `password` identity, untouched by
this spec.

**A defensive guard is added anyway**, mirroring agents-and-auth.md §5's
last-admin reasoning: a predicate that is currently always true is not the same
as one the code enforces. Before deleting a `webauthn_credentials` row, the
handler checks that the Agent has a `password` identity in
`agent_auth_identities` **or** at least one other credential; if neither, refuse
with `409`. Unreachable under the current invariant, and it turns a silent
lockout into a loud refusal if passkey-only provisioning is ever built (§11).

## 10. Security

- **Origin/rpId binding** — §3; the load-bearing phishing-resistance property,
  sourced only from server config.
- **A stolen session cannot be revoked.** `ht_session` is a stateless,
  HMAC-signed cookie with no server-side revocation list
  (`web/src/lib/session.ts`). Exactly two things end a stolen session before its
  natural expiry (up to 7 days): an admin disabling the Agent
  (`status='disabled'`, re-checked live on every header-required request) or the
  cookie expiring. **Rotating a password does neither.**

  A stolen session already grants everything `POST /agents/{id}/password` grants
  — full account takeover — so passkey list/rename/revoke (no secret material
  ever returned, §9) piggyback on an existing blast radius rather than widening
  it. **The one thing that does widen it is registering a new passkey
  mid-compromise**, which creates access outliving the stolen session entirely.
  That is why §5 exists: step-up means a session-only attacker cannot mint one,
  and §5.3's email means a successful mint is never silent.
- **No account enumeration** — §6.2's options endpoint takes no identifying input
  at all, a stronger position than `password`'s own no-enumeration design; the
  credential-id lookup carries no comparable oracle risk (§4.3). `challenge_expired`
  is the one intentional, safe exception.
- **Attestation `'none'`** (§6.1) means Helpthread never verifies *which* physical
  authenticator produced a credential, only that a valid ceremony occurred. This
  spec does not defend against a compromised authenticator implementation.
- **Rate limiting: the same unresolved gap agents-and-auth.md §9 names.** None of
  these endpoints add it. The pre-session ones inherit exactly the per-instance
  gap `password`'s `/auth/verify` already has.
- **No secret leaves the server.** The COSE public key is not a secret but is
  still never returned by any §9 endpoint. No private key ever reaches the web —
  it never leaves the authenticator.
- **Charter "own your data"**: all credential material lives in the operator's own
  Postgres. No Helpthread-hosted relying party, and no FIDO Metadata Service call
  (attestation `'none'` means no MDS integration exists).

## 11. Rollout

- **No migration of existing Agents.** `password` is unaffected; passkeys are an
  optional addition an Agent opts into from their profile.
- **New UI surfaces are design-project-first** — the passkey add/rename/revoke
  controls on `AgentProfileScreen.tsx` (`/manage/agents/{id}`) and the login
  screen's conditional-UI/fallback treatment have no existing prototype and
  require the maintainer's sign-off before or alongside build, per CLAUDE.md's
  UI-fidelity mandate.
- **Changing `HELPTHREAD_UI_BASE_URL`'s host silently invalidates every existing
  passkey.** `rpId` derives from it (§3), and credentials are permanently bound to
  the RP ID they were created under with no migration path. There is no error at
  the change itself — only later, one Agent at a time, at their next login.
  Password login is unaffected, so the fallback survives, but operators need an
  explicit runbook warning (not built here) that every passkey needs
  re-registering.
- **Named but not built:** passkey-only provisioning (§12) would need §9.1's guard
  revisited; session revocation (§10) is a natural follow-up this spec does not
  take on.

## 12. What this is NOT (scope)

- **No passkey-only provisioning.** A passkey is always an addition to, never a
  replacement for, the password every Agent gets at provisioning (§1, §9.1).
- **No attestation verification / FIDO Metadata Service integration** (§6.1, §10)
  — `'none'` conveyance only.
- **No forced re-registration or credential expiry**, matching agents-and-auth.md
  §11's no-forced-rotation posture for passwords.
- **No cross-device "hybrid" transport UX.** `transports` records `hybrid` when
  reported; QR-code phone-as-security-key works as a platform feature, with no
  bespoke UI designed around it.
- **No entitlement/licensing enforcement — none is needed.** Passkey login is core
  (§1). Genuine marketplace providers (Google SSO, magic-link, SAML) do wait on
  the §7 exception text and on entitlement infrastructure that does not yet exist
  (agents-and-auth.md §11).
- **No rate limiting** (§10).
- **No session revocation / active-session management.** §10 states that a session
  cannot be individually invalidated today; building that (a session table, a
  "sign out everywhere" control) is a real next step this spec does not take on.

## 13. Library decision & provenance

**`@simplewebauthn/server`** (npm, current `13.3.2`). License verified against the
published package and its GitHub source, per CHARTER.md's "license verified at
adoption" rule:

- `npm view @simplewebauthn/server license` → `MIT`.
- `gh api repos/MasterKale/SimpleWebAuthn` → `license.spdx_id: "MIT"`; the
  repository's `LICENSE.md` is the standard MIT text, copyright Matthew Miller,
  2020.
- **Transitive runtime dependencies checked too**: `@hexagon/base64`,
  `@levischuck/tiny-cbor`, and the `@peculiar/asn1-*`/`@peculiar/x509` family —
  every one `MIT` per `npm view <pkg> license`. No copyleft in the tree as
  installed.

**Exact functions used**, verified against the package's published type
declarations (`unpkg.com/@simplewebauthn/server@13.3.2/esm/.../*.d.ts`):
`generateRegistrationOptions`, `verifyRegistrationResponse`,
`generateAuthenticationOptions`, `verifyAuthenticationResponse`.

**Why not hand-roll:** CBOR decoding, COSE key parsing, and (for any future
attestation increment) ASN.1/X.509 chain handling — security-critical
binary-format parsing, where a maintained permissively-licensed library beats a
hand-rolled one. `jose` (MIT, already a runtime dependency) is the same call for
JWT/JOSE crypto.

## 14. Decision points for the maintainer

1. **Credential storage: new `webauthn_credentials` table**, not rows in
   `agent_auth_identities`, with agents-and-auth.md §3.2 amended to match. *(§2.1
   — recommend as specified.)*
2. **Step-up re-authentication gates passkey enrollment** (password OR an existing
   passkey, bound to the session's `sub`, 5-minute TTL), plus a best-effort "new
   passkey added" email on every successful registration — gating registration
   only, not rename/revoke. *(§5 — recommend. Sessions do not revoke, so step-up
   stops a bare stolen session minting durable access and the email is the
   out-of-band signal if it happens anyway.)*
3. **User verification `'required'`**, not `'preferred'`. *(§6.3 — recommend; every
   mainstream provider already satisfies it, so the real-world cost is near zero
   and the alternative is a materially weaker credential.)*
4. **Counter/clone policy: two-tier — exempt while zero-history, reject and alert
   once a credential has ever shown a nonzero counter.** *(§8 — recommend; the
   zero-counter exemption already filters out the synced/incoherent population, so
   a regression on the graduated remainder is a genuine clone signal.)*
5. **Challenge single-use: signed token + a `webauthn_challenges` row,
   ceremony-discriminated at both the application and database layers**, applied
   uniformly to all three ceremonies. *(§7 — recommend; one reviewed code path
   beats several for a security-critical check, and the row is cheap.)*
6. **Revoke-last-credential: no functional block needed (the invariant holds),
   defensive `409` guard added anyway.** *(§9.1 — recommend; matches the
   last-admin-guard precedent.)*
7. **Attestation `'none'`.** *(§6.1 — recommend; matches the library default and
   mainstream platform posture.)*
8. **`HELPTHREAD_UI_BASE_URL` becomes required-for-passkeys** and must resolve to
   a domain-form hostname — `localhost` is fine for dev, a loopback IP literal is
   not, even though `config.ts` accepts the latter generally. *(§3 — recommend;
   there is no safe fallback origin to invent, and the IP-literal gap is a real
   WebAuthn constraint.)*
9. **Library `@simplewebauthn/server`, not hand-rolled.** *(§13 — recommend.)*

## Changelog

- **2026-07-19** (PR #85, PR #88): initial version. Data model (§2:
  `webauthn_credentials` as its own table, `webauthn_challenges` for single-use),
  origin/RP-ID policy sourced from `HELPTHREAD_UI_BASE_URL` (§3), the seam
  extension and its honest limit — options-minting sits outside `AuthProvider`
  (§4), step-up re-authentication gating registration (§5), registration and
  authentication ceremonies with UV `'required'` and attestation `'none'` (§6),
  the signed-token plus DB-nonce challenge lifecycle (§7), the two-tier
  exempt/reject-and-alert counter and clone policy (§8), the endpoint surface and
  last-credential guard (§9), security posture including the
  planted-passkey-survives-password-rotation risk (§10), rollout (§11), scope
  (§12), the `@simplewebauthn/server` license verification (§13), and decision
  points (§14).
