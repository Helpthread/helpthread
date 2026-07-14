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
