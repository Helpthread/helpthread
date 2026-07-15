# Gmail inbound — deployment & provisioning runbook (HT-43)

Status: draft (HT-43). The one-time operator steps to take the merged engine
code (HT-34…HT-42) live: a deployed Vercel environment where **RIQ's own
inbound Gmail flows end-to-end** into a Helpthread conversation. This is the
"deployed, end to end" acceptance HT-43 owns; the actual **real Google
consent** that connects the mailbox is the last step and is tracked as
**HT-44**.

Nothing here is engine code — it is accounts, credentials, and console
clicks. **Every real credential and every consent screen is the operator's
action, never the assistant's.** The engine reads all secrets from
environment variables (never hardcoded); this runbook is how those env values
come to exist.

> Read alongside [gmail-push.md](../mail/gmail-push.md) §2/§7 (the webhook
> auth + the provisioning checklist this expands) and
> [gmail-connect.md](../mail/gmail-connect.md) §3 (the OAuth app + scopes).

## 0. Architecture being deployed

```
Gmail mailbox ──watch()──▶ Cloud Pub/Sub topic ──push sub (OIDC JWT)──▶
   POST /api/v1/inbound/gmail        (webhook: verify JWT → enqueue reconcile job → 2xx)
        │ enqueue (durable INSERT into the PG job queue — commits BEFORE the 2xx)
        ▼
   Vercel Cron ──GET /api/v1/internal/queue/drain (every minute)──▶ drain N jobs:
        reconcile (history.list → messages.get raw) → idempotent ingest → conversation
   Vercel Cron ──GET /api/v1/internal/cron/watch-maintenance (daily)──▶ re-arm watch() + sweep

Operator connect:  POST /api/v1/inbound/gmail/connect (Bearer) → consentUrl
                   → browser → Google consent → GET /callback → mailbox connected
Storage: Supabase Postgres (conversations, threads, mailboxes, tokens, job queue)
         + Supabase Storage (attachment + oversized-raw blobs)
```

The queue is a **Postgres-backed, cron-drained durable queue** (not Vercel
Queues — which is still beta): the webhook's enqueue is a durable `INSERT`
that commits before the endpoint acks Pub/Sub, and a once-a-minute Vercel Cron
leases and processes a bounded batch. ~1-minute worst-case delivery latency is
well within a support desk's needs; the durability (never ack Pub/Sub before
the row commits) is what protects invariant #1.

## Prerequisites

- A **Google Workspace** account for the mailbox to connect (e.g.
  `support@resonantiq.app`) — Workspace, because the OAuth app is **Internal**
  (no CASA verification, no external-user consent screen).
- A **Google Cloud project** with billing (Pub/Sub needs a billing account;
  volume here is negligible/free-tier).
- A **Supabase** project (Postgres + Storage).
- A **Vercel** project connected to this repo.
- The `gcloud` CLI (optional but the steps below give both console + CLI).

---

## Part A — Google Cloud: OAuth app + Gmail + Pub/Sub

Do this in the Google Cloud project that will own the push topic.

### A1. Enable the APIs
Console → *APIs & Services → Enable APIs* → enable **Gmail API** and **Cloud
Pub/Sub API**. (CLI: `gcloud services enable gmail.googleapis.com pubsub.googleapis.com`.)

### A2. The Internal OAuth app + client credentials
1. *APIs & Services → OAuth consent screen* → **Internal** user type. Fill
   app name / support email. No scopes need adding on the screen for an
   Internal app, but the app must be in **Published**/In-use state for your org.
2. *APIs & Services → Credentials → Create credentials → OAuth client ID* →
   **Web application**.
3. Under **Authorized redirect URIs** add **exactly**:
   `https://<your-vercel-domain>/api/v1/inbound/gmail/callback`
   (must byte-match `PUBLIC_BASE_URL` + `/api/v1/inbound/gmail/callback`; see
   gmail-connect.md §3.)
4. Save the **Client ID** → `GMAIL_OAUTH_CLIENT_ID` and **Client secret** →
   `GMAIL_OAUTH_CLIENT_SECRET`. **These are the operator's to hold — never
   commit them, never paste them to the assistant.**

Scopes the connect flow requests (no console action; requested at consent
time): `https://www.googleapis.com/auth/gmail.readonly` +
`https://www.googleapis.com/auth/gmail.send` (gmail-connect.md §3, least
privilege).

### A3. The Pub/Sub topic + push subscription
1. *Pub/Sub → Topics → Create topic*, e.g. `gmail-push`. Full name
   `projects/<project>/topics/gmail-push` → `GMAIL_PUBSUB_TOPIC`.
2. **Grant Gmail permission to publish** to the topic: add principal
   **`gmail-api-push@system.gserviceaccount.com`** with role **Pub/Sub
   Publisher** on that topic. (Without this, `watch()` returns an error — this
   is the single most common setup miss.)
3. Create a **service account** the push subscription will present as its OIDC
   identity, e.g. `gmail-push-invoker@<project>.iam.gserviceaccount.com` →
   `GMAIL_PUSH_SERVICE_ACCOUNT`.
4. *Pub/Sub → Subscriptions → Create subscription* on that topic:
   - Delivery type **Push**.
   - Endpoint URL: `https://<your-vercel-domain>/api/v1/inbound/gmail`.
   - **Enable authentication** → the service account from A3.3; audience =
     the **exact** endpoint URL above (the webhook checks `aud` equals its own
     URL — gmail-push.md §2).
   - Full subscription name `projects/<project>/subscriptions/<name>` →
     `GMAIL_PUBSUB_SUBSCRIPTION` (the webhook rejects a push whose
     `subscription` field isn't this exact value — gmail-push.md §2).

> The initial `users.watch()` (which points the mailbox at the topic) is armed
> automatically by the **connect flow** (Part E) — you do not call it by hand.

---

## Part B — Supabase: Postgres + Storage

1. Create the Supabase project. From *Project Settings → Database → Connection
   string*, take the **transaction-mode pooler** URI (**port 6543**, host
   `...pooler.supabase.com`) → `DATABASE_URL`. (Port 6543, not 5432 — the
   serverless-correct pooled connection; see `src/db/postgres.ts`.)
2. **Run migrations** against that database once (from a machine with the URL):
   the engine's `migrate()` applies every migration including the new job-queue
   table. (A `scripts/migrate.ts` one-shot is provided with the composition
   root; or run against the direct 5432 URL for the one-time DDL.)
3. *Storage → Create bucket*, e.g. `helpthread-blobs` (**private**) →
   `HELPTHREAD_BLOB_BUCKET`.
4. *Project Settings → API* → `SUPABASE_URL` and the **service_role** key →
   `SUPABASE_SERVICE_ROLE_KEY` (server-side only; grants full storage access —
   treat like a password, never expose to a browser).

---

## Part C — Vercel: env vars, deploy, cron

1. Set every variable from the [env reference](#env-reference) in *Project
   Settings → Environment Variables* (Production). Generate the two secrets you
   mint yourself:
   - `HELPTHREAD_TOKEN_ENC_KEY` — a 32-byte key, base64 (`openssl rand -base64 32`).
     Encrypts refresh tokens at rest; **losing/rotating it orphans every stored
     token** (mailboxes must reconnect).
   - `HELPTHREAD_API_TOKEN` — the Agent-inbox Bearer token (`openssl rand -base64 24`; ≥16 chars).
   - `HELPTHREAD_SIGNING_SECRET` — the HMAC keyring backing reply/state/view
     tokens (`openssl rand -base64 32`; ≥32 chars). Rotating it breaks
     threading of replies to already-sent mail (single-secret dogfood limit).
   - `CRON_SECRET` — guards the internal cron/drain endpoints (`openssl rand -base64 24`; ≥16 chars).
2. `PUBLIC_BASE_URL` = your production URL (e.g. `https://desk.resonantiq.app`),
   matching the OAuth redirect URI (A2.3) and the Pub/Sub push endpoint (A3.4).
   No trailing slash (the composition root strips one defensively either way).
3. Deploy. `vercel.json` (in the repo) declares the two Vercel Cron jobs:
   - `*/1 * * * *` → `GET /api/v1/internal/queue/drain` (drain the job queue).
   - `0 6 * * *` → `GET /api/v1/internal/cron/watch-maintenance` (daily renewal + sweep; UTC).
   Vercel Cron invokes these as HTTP GETs; the handlers require the
   `CRON_SECRET` (Vercel sends it as a bearer via the `Authorization` header on
   cron requests) and are idempotent + lease-bounded.
   > **Plan requirement:** the once-a-minute drain needs a **Vercel Pro** (or
   > higher) plan. On Hobby, cron jobs may only run **once per day**, and a
   > more-frequent expression *fails deployment* — so the ~1-minute delivery
   > latency this design targets is a Pro-tier feature.

All engine code is served by a single catch-all Vercel Function
(`api/[...path].ts`, the Node runtime — NOT Edge, since the engine needs
`node:crypto`) that hands every request to the composition root; no per-route
function files. The cron paths above resolve through that same function.

<a name="env-reference"></a>
## Env reference

| Var | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Supabase B1 | 6543 pooler URI |
| `SUPABASE_URL` | Supabase B4 | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase B4 | server-only secret |
| `HELPTHREAD_BLOB_BUCKET` | Supabase B3 | private bucket name |
| `GMAIL_OAUTH_CLIENT_ID` | Google A2 | |
| `GMAIL_OAUTH_CLIENT_SECRET` | Google A2 | secret |
| `GMAIL_PUBSUB_TOPIC` | Google A3.1 | `projects/…/topics/…` |
| `GMAIL_PUBSUB_SUBSCRIPTION` | Google A3.4 | `projects/…/subscriptions/…` |
| `GMAIL_PUSH_SERVICE_ACCOUNT` | Google A3.3 | the push SA email (JWT `email` claim) |
| `HELPTHREAD_TOKEN_ENC_KEY` | you mint (C1) | 32-byte base64; encrypts tokens at rest |
| `HELPTHREAD_API_TOKEN` | you mint (C1) | Agent-inbox Bearer, ≥16 chars |
| `CRON_SECRET` | you mint (C1) | guards internal cron endpoints |
| `PUBLIC_BASE_URL` | Vercel C2 | your prod origin, no trailing slash |
| `HELPTHREAD_MAIL_DOMAIN` | you choose | domain minted into outbound Message-IDs |
| `HELPTHREAD_SUPPORT_ADDRESS` | the mailbox | e.g. `support@resonantiq.app` |
| `HELPTHREAD_SIGNING_SECRET` | you mint | ≥32 chars; HMAC keyring for reply/state/view tokens |

## Part E — Connect the mailbox (HT-44, operator action)

With the deploy live and env set:
1. `POST https://<domain>/api/v1/inbound/gmail/connect` with
   `Authorization: Bearer $HELPTHREAD_API_TOKEN` → returns `{ consentUrl }`.
2. Open `consentUrl` in a browser **signed into the mailbox's Google account**,
   grant consent. Google redirects to `/callback`, which exchanges the code,
   stores the encrypted refresh token, arms `watch()`, and seeds the cursor.
   You should see a "Mailbox connected" page.
3. **This consent is the operator's action** — the assistant never completes it.

## Part F — Post-deploy smoke checklist

- [ ] `GET /api/v1/conversations` with the Bearer token → `200` (API + DB reachable).
- [ ] A wrong/no Bearer → `401`.
- [ ] `POST /connect` → a `consentUrl` whose `redirect_uri` matches A2.3 exactly.
- [ ] After connect: a `mailboxes` row (`status=active`), a `mailbox_oauth_tokens`
      row (ciphertext, not plaintext), a `gmail_watch_state` row with a `history_id`.
- [ ] Send a test email **to** the connected mailbox → within ~1 min (the drain
      tick) a new conversation appears (`GET /api/v1/conversations`).
- [ ] Pub/Sub subscription **oldest-unacked-message age** stays low (no backlog).
- [ ] The job-queue table: no rows stuck `dead_lettered_at IS NOT NULL`;
      oldest `ready` job age stays under a minute or two.
- [ ] Reply from the Agent inbox → the reply arrives at the customer, and a
      reply back **threads** into the same conversation (the sacred outbound-token
      check — HT-44's live proof).

## What this runbook does not cover

- The Agent Inbox **UI** (HT-23) — this deploys the engine/API; the UI is separate.
- Multi-mailbox / GA onboarding — dogfood is one Workspace mailbox, Internal app.
- Vercel Queues — a future low-latency/managed `QueueProvider` adapter; the PG
  queue is the dogfood implementation of the same interface.
