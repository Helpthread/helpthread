# Gmail OAuth connect / consent flow

Status: draft (HT-40). The **write-side** that the Gmail push transport
([gmail-push.md](./gmail-push.md)) deliberately stubbed: everything in
gmail-push.md assumes a *connected mailbox* already exists — a `mailboxes` row
(migration 009), an encrypted refresh token (migration 010, HT-38), and an
armed `watch()` with a baseline `gmail_watch_state.history_id` cursor
(migration 011). Nothing created any of those. **This flow does.**

It runs Google's OAuth2 **authorization-code** flow to obtain a long-lived
refresh token for a mailbox, persists it encrypted-at-rest, then arms the
initial `users.watch()` and seeds the baseline cursor the reconcile consumer
(gmail-push.md §3, HT-41) reads. gmail-push.md §7 names this as its own
deferred concern ("the connect/consent flow → HT-40"); this spec is that
concern.

This is the **workspace-native mode** (memory: inbound-email architecture
decision, 2026-07-13): a Google Workspace org connecting its own mailbox via
an **Internal** OAuth app — no CASA verification, no external-user consent
screen. The forwarding-address transport (the external/GA default) is separate
and later, and will need its own onboarding, not this OAuth flow.

## 1. The HT-40 / HT-42 split — stated once, authoritatively

`watch()` appears in two tickets, and the boundary matters:

- **HT-40 (this spec) owns the INITIAL arm.** gmail-push.md §6 bullet 1:
  "`watch()` is called when a mailbox is connected (OAuth, HT-40) and returns
  the initial `historyId` (the cursor's starting point) and an expiration
  (~7 days out)." So the first `watch()` call and the first
  `gmail_watch_state` row — the baseline cursor everything else resumes from —
  are minted **here, at connect**.
- **HT-42 owns RENEWAL** (the daily re-arm before the ~7-day expiry) and the
  reconciliation lease (gmail-push.md §6).

> **Corrects two already-merged comments.** HT-41's
> `src/mail/gmail-reconcile.ts` ("watch() (HT-42) seeds the baseline cursor at
> connect") and `src/store/gmail-watch-state.ts`'s module doc ("normally
> seeded by watch() (HT-42 …)") both attribute the baseline seed to HT-42.
> The spec (§6 bullet 1) and this ticket place the *initial* seed in **HT-40**;
> HT-42 only *renews* it. Those comments are corrected as part of landing this
> flow, since it makes them wrong.

## 2. Two routes, two authentication models

The operator initiates; Google redirects back. Those are two very different
callers, so they authenticate two different ways — the same split the API
already uses for its unauthenticated surfaces (the open-tracking pixel and the
push webhook are matched **before** the Bearer gate, `src/api/index.ts`).

### 2a. `POST /api/v1/inbound/gmail/connect` — Bearer-gated, returns the consent URL

Initiation is an **operator** action, so it sits **inside** the normal
service-Bearer API (`src/api/auth.ts`), in the authenticated route table
(`src/api/router.ts`). It does not redirect; it returns the Google consent URL
as JSON:

```
POST /api/v1/inbound/gmail/connect      Authorization: Bearer <service token>
  → 200 { "consentUrl": "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

The caller (an operator's tool, or the future Agent-inbox admin UI, HT-23)
then navigates the browser to `consentUrl`. Returning the URL as JSON rather
than a `302` is deliberate: a top-level browser navigation cannot carry the
`Authorization: Bearer` header, so gating a redirecting `GET` would force a
weaker initiate credential. Returning JSON keeps initiation fully inside the
Bearer scheme and lets the client perform the redirect itself.

### 2b. `GET /api/v1/inbound/gmail/callback?code&state` — pre-auth, signed-state protected

Google redirects the operator's browser here with `?code=…&state=…`. This
request carries **no** service Bearer token (it originates from Google, not
our client), so — exactly like the push webhook and the tracking pixel — it is
matched and handled **before** the Bearer gate and authenticates by its own
mechanism: the **signed `state`** minted in 2a.

`state` is an **HMAC-signed token off the existing `Keyring`**
(`src/mail/reply-token.ts`), the same stateless, server-session-free pattern
the reply-token and open-tracking-token surfaces already use — a natural fit
for a serverless deployment with no session store. It carries a random nonce
and an issued-at timestamp; the callback **rejects** a `state` whose signature
does not verify or whose age exceeds a short TTL (default 10 minutes). This is
the OAuth CSRF defence (RFC 6749 §10.12): without a valid `state` an attacker
cannot forge a callback that plants their own grant, and a leaked/replayed
`state` expires quickly.

The callback's response is a **minimal `text/html` page** (success or error),
since a human's browser lands on it — not the JSON envelope the rest of the
API returns. It never renders any token, `code`, `client_secret`, email
body, or other secret.

## 3. Scopes and consent parameters

The consent URL (`https://accounts.google.com/o/oauth2/v2/auth`) is built with:

- `client_id`, `redirect_uri` — the deployment's Internal OAuth app (injected
  config, never hardcoded — same discipline as the token encryption key and
  `client_secret`, `src/store/token-crypto.ts` / `src/mail/gmail-oauth.ts`).
  `redirect_uri` must exactly match `/api/v1/inbound/gmail/callback` on the
  deployment's public origin **and** a redirect URI registered on the OAuth
  client (operator runbook, HT-43).
- `response_type=code`.
- `scope` — **least privilege for the dogfood: `gmail.readonly` +
  `gmail.send`.** `gmail.readonly` is sufficient for `users.watch`,
  `users.history.list`, and `users.messages.get?format=raw` (the whole inbound
  path, gmail-push.md §3) and for `users.getProfile` (§4 below); `gmail.send`
  is what the outbound `EmailSender` already needs
  (`src/providers/adapters/gmail/sender.ts`). One grant covers both
  directions for the connected mailbox. Broader scopes (`gmail.modify`,
  `https://mail.google.com/`) are **not** requested — v1 inbound never mutates
  the mailbox. The scope set is injected config, so an operator who needs a
  wider grant configures it without a code change.
- `access_type=offline` **and** `prompt=consent` — **both required** to be
  handed a **refresh token** (RFC 6749 §6; Google issues a refresh token only
  for offline access, and re-issues one on re-consent only when
  `prompt=consent` forces the consent screen). A connect that comes back
  without a `refresh_token` is a hard error (§4), not a silently tokenless
  mailbox.

## 4. The callback sequence

Applied in order by `completeConnect` when a valid `state` verifies. The order
is chosen so that **nothing is persisted until the grant is proven usable** —
a failure before the final persist leaves no mailbox row, no stored token, and
no armed watch to clean up.

1. **Verify `state`.** Bad signature / expired → reject (§2b), nothing else
   runs.
2. **Exchange the code.** One `POST https://oauth2.googleapis.com/token`,
   `grant_type=authorization_code`, `code` + `client_id`/`client_secret`/
   `redirect_uri` — the authorization-code sibling of `gmail-oauth.ts`'s
   refresh call, same injected `fetch`, same "never log `client_secret` or any
   token" discipline. The response yields `access_token`, `expires_in`,
   `scope`, and — critically — `refresh_token`. **A response without a
   non-empty `refresh_token` is an error** (surfaced as a callback error page
   telling the operator to retry; a common cause is a prior grant that
   suppressed re-issue, which `prompt=consent` is set to avoid).
3. **Resolve the mailbox address** authoritatively from the grant:
   `users.getProfile` (`format` n/a) with the fresh access token →
   `emailAddress`. The address comes from Google, not operator input, so a
   connected `mailboxes.address` can never disagree with the account that
   actually granted access.
4. **Arm `watch()`** with the fresh access token: `POST
   users/{me}/watch { topicName }` → `{ historyId, expiration }` (topic is
   injected config, provisioned per HT-43). **This is done before any
   persistence**, so a `watch()` failure aborts the connect cleanly with
   nothing written. `historyId` here — **watch()'s**, not getProfile's — is
   the baseline cursor (gmail-push.md §6 bullet 1): it is the exact watermark
   from which `history.list` will resume, so using getProfile's separately-read
   `historyId` could straddle the arm and miss or replay a sliver of history.
5. **Persist, now that the grant is proven** — three writes keyed by the
   resolved mailbox, committed in **one `Db` transaction** (all-or-nothing: a
   mid-persist failure rolls back rather than leaving an `active` mailbox with
   no cursor — a partial state that is *worse* than no mailbox at all, since
   the webhook would then enqueue reconcile jobs for a mailbox whose cursor
   never gets seeded, silently no-op'ing every push the already-armed
   `watch()` delivers):
   - `MailboxStore.upsertConnectedMailbox({ address, provider: 'gmail' })` →
     the `mailboxes` row, `status = 'active'`. **Upsert by `address`** so a
     **reconnect** (a mailbox previously `needs_reconnect` or `paused`
     re-consenting) reactivates the existing row rather than colliding with its
     `UNIQUE(address)` constraint — this is the "transitioning back to
     `active`" the store's own module doc reserves for HT-40.
   - `MailboxTokenStore.upsertTokens(mailboxId, { refreshToken, accessToken,
     accessTokenExpiresAt, scopes })` — the refresh token **encrypted at rest**
     (AES-256-GCM, `src/store/token-crypto.ts`); this module is the only place
     plaintext tokens exist. **Sacred (invariant): the plaintext refresh token
     never touches the database, a log line, or an error message.**
   - `GmailWatchStateStore` baseline seed: `history_id = watch().historyId`
     **and** `watch_expiration = watch().expiration` (migration 011's
     `watch_expiration` column, which had no writer before this ticket).
6. **Success page.** The mailbox is live: push will now arrive (gmail-push.md
   §2), and the daily sweep + renewal (HT-42) will keep it so.

**`watch()` failure** (step 4): abort with an error page, nothing persisted —
the operator retries. (This differs from gmail-push.md §6's "mark
needs-reconnect" guidance, which concerns a *renewal* failure on an
*already-connected* mailbox; here there is no connected mailbox yet to mark.)

## 5. Idempotency and reconnect

The whole callback is **idempotent by mailbox address**: every persist in
step 5 is an upsert keyed by the resolved mailbox (`upsertConnectedMailbox` by
`address`; `upsertTokens` and the watch-state seed by `mailbox_id`). Re-running
connect for the same account — an operator reconnecting a `needs_reconnect`
mailbox, or simply retrying — reactivates the row, replaces the stored tokens,
re-arms `watch()`, and rebaselines the cursor to the fresh `historyId`.

A reconnect **rebaselines**: the new cursor is `watch()`'s current `historyId`,
so any history between a prior broken/expired state and the reconnect is *not*
back-filled — the same deliberate, gap-accepting manual rebaseline
gmail-push.md §5 describes for an expired cursor. Reconnect is the operator's
"make it live again from now," not a resync.

## 6. What this flow does not own

- **Token refresh / `invalid_grant` handling** → HT-38
  (`src/mail/gmail-oauth.ts`); this flow only mints and stores the *first*
  refresh token that service later reads.
- **`watch()` renewal + the reconciliation lease** → HT-42 (gmail-push.md §6);
  this flow only arms `watch()` *once*, at connect.
- **History reconciliation / raw fetch** → HT-41 (gmail-push.md §3); this flow
  seeds the cursor that consumer resumes from.
- **One-time GCP/Pub-Sub provisioning** (Internal OAuth app + client
  credentials; enable APIs; create the topic/subscription; grant the push
  service account) → operator runbook, HT-43. The engine assumes the OAuth
  client and Pub/Sub topic exist and its `redirect_uri` is registered.
- **Real Google consent + the live end-to-end proof** → HT-44 / the operator.
  Completing a real consent screen is an operator action, never the
  assistant's; this ticket ships the code and a fully faked test path, and
  defers real-credential verification to HT-44.

## 7. Acceptance

Against a **faked** Google (injected `fetch` standing in for the token
endpoint, `users.getProfile`, and `users.watch`) and the engine's in-memory
store fakes — no cloud, no real consent:

- `POST …/connect` with a valid service Bearer token → `200 { consentUrl }`
  whose query carries `access_type=offline`, `prompt=consent`, the configured
  scopes, `redirect_uri`, and a signed `state`. Without the Bearer token →
  `401`, no URL minted.
- A callback with a valid `state` + `code` → code exchanged → address resolved
  from `getProfile` → `watch()` armed → a `mailboxes` row (`active`), an
  **encrypted** `mailbox_oauth_tokens` row, and a `gmail_watch_state` row whose
  `history_id`/`watch_expiration` equal `watch()`'s response. Response is a
  `200` HTML success page.
- A callback whose `state` is missing / forged / expired → rejected, no code
  exchange, nothing persisted.
- A code exchange that returns **no** `refresh_token` → error page, nothing
  persisted.
- A `watch()` failure → error page, nothing persisted (no orphan mailbox or
  token row).
- A reconnect (second successful connect for the same address) → the existing
  mailbox row is reactivated, tokens replaced, cursor rebaselined — one
  mailbox row, not two (`UNIQUE(address)` upsert).
- The stored refresh token is never present in any log line or error message,
  and the database column holds ciphertext, not plaintext (the sacred check,
  verified directly).

The **live** proof — a real consent, a real `watch()`, a real push threading a
real reply — is HT-44's, not this fake-backed suite's.

## 8. Disconnect (HT-47) — the admin action that undoes §2-§5

The inverse of the connect flow above: an admin action that cleanly
disconnects a connected Gmail mailbox. Implemented by
`src/mail/gmail-disconnect.ts` (`GmailDisconnectService`), the `GmailWatchClient.stop`
method (`src/providers/adapters/gmail/watch.ts`), and migration 017 (extends
migration 009's `mailboxes.status` CHECK).

### 8a. `POST /api/v1/inbound/gmail/disconnect` — Bearer-gated, an ORDINARY route

Unlike `/callback` (§2b), disconnect has **no pre-auth carve-out at all**: it
is initiated by the same operator credential as `/connect` (§2a), sits in the
normal authenticated route table (`src/api/router.ts`), and needs no
alternate authentication mechanism — there is no third party (like Google's
redirect) landing on this path.

```
POST /api/v1/inbound/gmail/disconnect   Authorization: Bearer <service token>
  { "address": "mailbox@example.test" }
  → 200 { mailboxId, address, alreadyDisconnected, revoked, watchStopped }
```

The mailbox is identified by its connected `address` (the same resolution key
`MailboxStore.getMailboxByAddress` already serves elsewhere — the push
webhook, gmail-push.md §3), not an internal `mailboxId` an operator has no way
to know.

### 8b. The three steps, and the best-effort ordering decision

1. **Stop the watch** (`GmailWatchClient.stop`, `users.stop`) using a LIVE
   access token (`GmailOAuthTokenService.getAccessToken`, HT-38). This runs
   FIRST — see the ordering rationale below.
2. **Revoke the refresh token** (`revokeToken`, Google's
   `https://oauth2.googleapis.com/revoke`, RFC 7009 §2.1) — the grant itself.
3. **Deactivate locally, UNCONDITIONALLY**: mark the mailbox `disconnected`
   (migration 017) and delete its `mailbox_oauth_tokens` and
   `gmail_watch_state` rows, in ONE transaction — regardless of whether steps
   1/2 succeeded.

**Ordering decision**: `stop()` runs *before* revoke, not after, because
revoking the refresh token can invalidate every access token issued under
that grant immediately — calling `stop()` afterward would likely fail
against a token Google has already killed.

**Best-effort decision**: steps 1 and 2 are best-effort. A failure in either
is caught, reported on the response (`watchStopped`/`revoked: false`), and
does **not** abort step 3. This is the deliberate asymmetry with the connect
flow (§4, which aborts on the first failure and persists nothing): a
revoked-at-Google-but-active-locally mailbox is worse than the reverse. An
operator who disconnects a mailbox wants it OFF locally no matter what — a
Google-side hiccup (a network blip on revoke, a watch that already lapsed)
must never leave Helpthread still ingesting or sending as that mailbox.
**Local state always wins.**

### 8c. The `disconnected` status (migration 017)

The DEFAULT this ticket chose: keep the `mailboxes` row (don't delete it —
preserving the address's history and its `UNIQUE(address)` claim) and add a
FOURTH lifecycle status, `'disconnected'`, to migration 009's CHECK
(`active`/`paused`/`needs_reconnect`). `disconnected` is distinct from
`paused` (an automatic, resumable pause the ingest pipeline applies,
gmail-push.md §5) and `needs_reconnect` (a dead grant awaiting reconnection):
it only ever follows an explicit operator disconnect, and — unlike those two
— reconnecting from it goes through the same `upsertConnectedMailbox` path
(§4 step 5) as any other reconnect, since a fresh consent grant is required
either way.

### 8d. Idempotency and the unknown-mailbox case

Disconnecting an already-`disconnected` mailbox is a **no-op success**
(`200 { alreadyDisconnected: true, revoked: false, watchStopped: false }`):
no remote call is ever attempted against Google (a resurrected token row
still belongs to a grant this mailbox's FIRST disconnect already tried to
revoke — re-revoking on every retry would just be repeat work for no added
safety). Its token/watch-state rows are normally already gone too. A
`GmailOAuthTokenService.getAccessToken` refresh (`src/mail/gmail-oauth.ts`)
already in flight when a disconnect commits cannot resurrect a token row:
the refresh's status check and token write are ONE guarded SQL statement
(`MailboxTokenStore.upsertTokensUnlessDisconnected`, which locks the
`mailboxes` row), and the disconnect transaction takes that same row lock
FIRST (the status flip is its first statement) — every interleaving either
commits the refresh's row before disconnect's deletes sweep it, or writes
nothing (a review fix, in two rounds: a JS-level re-check narrowed the
race; moving the predicate into the write statement closed it). This
idempotent path STILL re-runs the step-3 deletes on every call, as cheap
defense-in-depth rather than a required recovery path. An unknown `address`
is `404 not_found`.

### 8e. Acceptance

Against a **faked** Google (injected `fetch` standing in for the revoke
endpoint and a faked `GmailWatchClient.stop`) and the engine's PGlite-backed
stores — no cloud, no real credentials:

- A connected mailbox, valid Bearer → `200`; the mailbox row's `status`
  becomes `disconnected`, its `mailbox_oauth_tokens` and `gmail_watch_state`
  rows are gone, and `revoked`/`watchStopped` are both `true`.
- `stop()` is called with a getAccessToken bound to THIS mailbox, and BEFORE
  the revoke call (the ordering decision above), proven directly.
- A revoke failure (non-2xx) → still `200`, still deactivated locally, still
  rows deleted; `revoked: false` reported.
- A `stop()` failure → still `200`, still deactivated locally, still rows
  deleted; `watchStopped: false` reported.
- Both failing → still `200`, still deactivated locally (local state always
  wins).
- Repeating disconnect on an already-`disconnected` mailbox → `200
  { alreadyDisconnected: true }`, no remote calls; a token row resurrected by
  a racing refresh in the meantime is deleted by this same call.
- An unknown address → `404 not_found`.
- Without the Bearer token → `401`, before the handler ever runs.
- The stored refresh token is never present in any log line or error message
  (the sacred check, verified directly) — revoke reads it once from
  `MailboxTokenStore.getTokens` and never logs it, even on a revoke failure.

The **live** proof — a real revoke, a real `users.stop`, confirmed against a
real Google account — is deferred the same way §7's live connect proof is
(HT-44 territory), not this fake-backed suite's.
