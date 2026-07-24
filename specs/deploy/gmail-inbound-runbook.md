# Gmail inbound — deployment & provisioning runbook

Status: executed 2026-07-17 and live-verified. The threading round-trip passed
on the second run, after the first run exposed two Gmail transport bugs fixed
the same day in PRs #52 and #53. These are the one-time operator steps required
to take the merged engine code live: a deployed Vercel environment where **RIQ's own
inbound Gmail flows end-to-end** into a Helpthread conversation. This is the
"deployed, end-to-end" acceptance path; the actual **real Google consent**
that connects the mailbox is the last step.

Nothing here is engine code — it is accounts, credentials, and console
clicks. **Every real credential and every consent screen is the operator's
action, never the assistant's.** The engine reads all secrets from
environment variables (never hardcoded); this runbook is how those env values
come to exist.

> Read alongside [gmail-push.md](../mail/gmail-push.md) §2/§7 (the webhook
> auth + the provisioning checklist this expands) and
> [gmail-connect.md](../mail/gmail-connect.md) §3 (the OAuth app + scopes).

## As deployed (RIQ dogfood, 2026-07-17)

The concrete, non-secret values from the live provisioning run (no client IDs,
no keys — those stay in Vercel env only):

- **GCP project**: `helpthread-desk` (org `resonantiq.app`). Not to be
  confused with the unrelated personal `gmail-mcp-personal` GCP project
  (personal-Gmail QA MCP, RIQAPP-1035) — different org, different purpose.
- **Pub/Sub topic**: `projects/helpthread-desk/topics/gmail-push`
- **Pub/Sub subscription**: `projects/helpthread-desk/subscriptions/gmail-push-sub`
- **Push service account**: `gmail-push-invoker@helpthread-desk.iam.gserviceaccount.com`
- **Vercel project**: `helpthread` (team Resonant IQ) → https://desk.resonantiq.app
- **Supabase project**: `Helpthread` (ref `ytpqyteltabveygzcfcq`, `us-east-1`)
- **Storage bucket**: `helpthread-blobs`
- **Mailbox**: `help@resonantiq.app` (alias `support@`)

## 0. Architecture being deployed

```text
Gmail mailbox ──watch──▶ Cloud Pub/Sub topic ──push sub (OIDC JWT)──▶
   POST /api/v1/inbound/gmail        (webhook: verify JWT → enqueue reconcile job → 2xx)
        │ enqueue (durable INSERT into the PG job queue — commits BEFORE the 2xx)
        ▼
   Vercel Cron ──GET /api/v1/internal/queue/drain (every minute)──▶ drain N jobs:
        reconcile (history.list → messages.get raw) → idempotent ingest → conversation
   Vercel Cron ──GET /api/v1/internal/cron/watch-maintenance (daily)──▶ re-arm watch + sweep

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
   Publisher** on that topic. (Without this, `watch` returns an error — this
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

> The initial `users.watch` (which points the mailbox at the topic) is armed
> automatically by the **connect flow** (Part E) — you do not call it by hand.

### A4. Console/CLI gotchas hit during live provisioning (2026-07-17)

1. **Domain-restricted sharing blocks the Gmail publisher grant.** If the org
   enforces `constraints/iam.allowedPolicyMemberDomains`, granting
   `gmail-api-push@system.gserviceaccount.com` (A3.2) fails — that principal
   isn't in the allowed domain. Fix: enable `orgpolicy.googleapis.com`, then
   add a **project-scoped** override on the constraint (allow-all) for this
   project only. The policy change propagates eventually (~90s observed) — the
   grant may fail once right after the override and just needs a retry.
   The override is deliberately left in place (project-scoped): IAM policy is
   checked at write time, but leaving it avoids surprises if the topic's IAM
   ever needs re-applying; revisit if the project ever holds anything beyond
   this push plumbing.
2. **CLI-created push subscriptions don't auto-grant the token-creator role.**
   Creating the subscription (A3.4) via `gcloud`/API, unlike the console flow,
   does **not** grant the Pub/Sub service agent
   (`service-<project-number>@gcp-sa-pubsub.iam.gserviceaccount.com`) the
   `roles/iam.serviceAccountTokenCreator` role on the OIDC service account
   (A3.3). Without it, Pub/Sub can't mint the push JWT and delivery fails
   silently (no error surfaced to the subscription). Grant that role on the
   service account explicitly.

---

## Part B — Supabase: Postgres + Storage

1. Create the Supabase project. From *Project Settings → Database → Connection
   string*, take the **transaction-mode pooler** URI (**port 6543**, host
   `...pooler.supabase.com`) → `DATABASE_URL`. (Port 6543, not 5432 — the
   serverless-correct pooled connection; see `src/db/postgres.ts`.)
2. **Run migrations** against that database once (from a machine with the URL):
   the engine's `migrate` applies every migration including the new job-queue
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
3. Deploy. `vercel.json` (in the repo) declares three Vercel Cron jobs:
   - `*/1 * * * *` → `GET /api/v1/internal/queue/drain` (drain the job queue —
     also delivers webhooks, : `WEBHOOK_DELIVERY_TOPIC` is handled here).
   - `*/1 * * * *` → `GET /api/v1/internal/outbox/drain` (turn
     `event_outbox` rows into webhook-delivery queue jobs — a SEPARATE tick
     from the queue drain above; that one then actually sends them).
   - `0 6 * * *` → `GET /api/v1/internal/cron/watch-maintenance` (daily renewal + sweep; UTC).
   Vercel Cron invokes these as HTTP GETs; the handlers require the
   `CRON_SECRET` (Vercel sends it as a bearer via the `Authorization` header on
   cron requests) and are idempotent + lease-bounded.
   > **Plan requirement:** the once-a-minute drain needs a **Vercel Pro** (or
   > higher) plan. On Hobby, cron jobs may only run **once per day**, and a
   > more-frequent expression *fails deployment* — so the ~1-minute delivery
   > latency this design targets is a Pro-tier feature.
4. **Vercel does not retry a failed cron invocation** — a transient non-2xx is
   simply retried on the *next* scheduled tick. The queue drain self-heals on
   the following minute; but the **daily** watch-maintenance job would go a full
   day between attempts, so **alert on its non-2xx responses** (Vercel's cron
   logs, or your log drain) rather than waiting to notice a stale mailbox.
5. **`maxDuration` must stay below the queue lease.** `vercel.json` caps the
   function at **50s**, under both the 60s job lease (`DEFAULT_LEASE_MS`,
   `src/providers/adapters/postgres-queue/`) and the 60s cron interval: the
   function is always killed *before* any lease it holds expires, so a
   still-running drain can never race a concurrent drain that reclaimed one of
   its rows. If you raise the lease, keep `maxDuration` comfortably under it.

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

## Part E — Connect the mailbox (operator action)

With the deploy live and env set:
1. `POST https://<domain>/api/v1/inbound/gmail/connect` with
   `Authorization: Bearer $HELPTHREAD_API_TOKEN` → returns `{ consentUrl }`.
2. Open `consentUrl` in a browser **signed into the mailbox's Google account**,
   grant consent. Google redirects to `/callback`, which exchanges the code,
   stores the encrypted refresh token, arms `watch`, and seeds the cursor.
   You should see a "Mailbox connected" page.
3. **This consent is the operator's action** — the assistant never completes it.

## Part F — Post-deploy smoke checklist

-  `GET /api/v1/conversations` with the Bearer token → `200` (API + DB reachable).
-  A wrong/no Bearer → `401`.
-  `POST /connect` → a `consentUrl` whose `redirect_uri` matches A2.3 exactly.
-  After connect: a `mailboxes` row (`status=active`), a `mailbox_oauth_tokens`
      row (ciphertext, not plaintext), a `gmail_watch_state` row with a `history_id`.
-  Send a test email **to** the connected mailbox → within ~1 min (the drain
      tick) a new conversation appears (`GET /api/v1/conversations`).
-  Pub/Sub subscription **oldest-unacked-message age** stays low (no backlog).
-  `GET /api/v1/internal/health` with `Authorization: Bearer $CRON_SECRET` →
      `200` with `"ok": true` (Part G — this one call covers the queue-age and
      dead-letter checks below, plus watch expiry and mailbox status).
-  The job-queue table: no *unexpected* dead-letter growth (retained
      `dead_lettered_at IS NOT NULL` rows are by design — inspect them by
      age/count/rate, not as a pass/fail), and oldest `ready` job age stays
      under a minute or two.
-  Reply from the Agent inbox → the reply arrives at the customer, and a
      reply back **threads** into the same conversation (the sacred outbound-token
      check — 's live proof).

## Part G — Ongoing monitoring & alerting

There is deliberately no Datadog/OTel stack in this deployment: Vercel's log
viewer is the aggregator for structured events, and the **health endpoint is
the one alertable surface** — designed so a dumb HTTP monitor is a complete
alerting stack.

### G1. The health endpoint

```text
GET https://<domain>/api/v1/internal/health
Authorization: Bearer $CRON_SECRET
```

Answers **`200` when healthy, `503` when any alert is tripped** (body is the
full JSON report either way: `ok`, `alerts[]`, and per-section detail —
queue stats, 24h ledger outcome counts, 24h forged-token aggregate,
per-mailbox status + Gmail `watch` expiry, and a `webhooks`
section: currently `auto_disabled` endpoints and 24h webhook-delivery
dead-letter count). Read-only and cheap — polling every minute is fine.

**Wiring a monitor:** point any status-code poller that can send one custom
header (UptimeRobot, Checkly, a `curl -fsS` in a cron you already own) at the
URL with the `Authorization` header, alerting on any non-`200`. This shares
the `CRON_SECRET` with the monitor — acceptable for the dogfood (the secret
guards idempotent internal endpoints, not customer data); rotate it via
Vercel env if the monitor is ever compromised.

### G2. Alert codes → first response

Each `alerts[]` entry is `<code>: <detail>`. The codes are stable:

| Code | Meaning | First response |
|---|---|---|
| `queue-drain-stalled` | Oldest ready job has waited past the threshold (default 300s) — the every-minute drain isn't keeping up or isn't running | Vercel → the project's cron runs + function logs for `/internal/queue/drain`; a failed tick self-heals, repeated failures don't |
| `queue-dead-letter-growth` | A queue job was dead-lettered in the last 24h | `SELECT topic, last_error, attempts FROM queue_jobs WHERE dead_lettered_at IS NOT NULL ORDER BY dead_lettered_at DESC` — parked rows are retained for exactly this review |
| `ingest-dead-letter-growth` | An inbound delivery exhausted its retry budget in the last 24h — a message an Agent has NOT seen | `SELECT provider_message_id, last_error, attempts FROM inbound_deliveries WHERE status = 'dead-letter' ORDER BY updated_at DESC`; the raw mail is still in Gmail — reprocess after fixing the cause |
| `forged-token-burst` | ≥ threshold (default 5) stored deliveries in 24h carried reply tokens that FAILED signature verification — someone is guessing/tampering with threading tokens (threading.md §5) | Search Vercel logs for `forged_token_detected` (WARN); review `senderAddress`/`conversationId` across events. The mail itself threaded safely (a forged token never appends) |
| `mailbox-needs-attention` | A mailbox is `paused` (cursor expired — gmail-push.md §5 rebaseline) or `needs_reconnect` (dead OAuth grant) — **inbound mail is not flowing** | `needs_reconnect`: re-run the Part E consent. `paused`: reconnect to rebaseline the cursor, then check for a gap |
| `watch-expiring` | An active mailbox's Gmail `watch` expires in < 72h (or was never armed) — the daily renewal has been failing for days | Function logs for `/internal/cron/watch-maintenance` (`gmail_watch_maintenance` events); a manual `GET` of that endpoint with the cron secret re-arms immediately |
| `webhook-endpoint-auto-disabled` | : a webhook endpoint hit 20 consecutive delivery failures and auto-disabled — a module (or an operator's own integration) has silently stopped receiving events | `SELECT id, url, consecutive_failures FROM webhook_endpoints WHERE status = 'auto_disabled'`; fix the receiving side, then `PATCH /api/v1/webhooks/{id}` with `{"status":"active"}` to re-enable (resets the counter) |
| `webhook-delivery-dead-letter-growth` | : a webhook delivery exhausted its retries in the last 24h (`WEBHOOK_DELIVERY_TOPIC` on `queue_jobs`) | `SELECT payload, last_error FROM queue_jobs WHERE topic = 'webhook.delivery' AND dead_lettered_at IS NOT NULL ORDER BY dead_lettered_at DESC` — `payload.endpointId` names the endpoint; this can precede (or accompany) an eventual auto-disable |

### G3. Structured log events (Vercel log search)

All JSON lines, searchable by `event` name: `inbound_ingest` (one per fresh
ingest outcome: threading decision, append-fallback reason, forgedTokenCount,
parse size, attachment count, ledger outcome), `forged_token_detected` (WARN
— the per-message security event behind `forged-token-burst`), `queue_drain`
(per drain tick that claimed work or fenced a stale worker: claimed/acked/
retried/deadLettered/staleSkipped; quiet ticks don't log — this is also
where webhook-delivery attempts surface, since `WEBHOOK_DELIVERY_TOPIC` is
handled by the SAME drain), `outbox_drain` (per outbox-drain tick
that claimed at least one `event_outbox` row — claimed/enqueued/dispatched;
quiet ticks don't log, same convention as `queue_drain`), `gmail_reconcile`
(per reconcile job: cursor positions, skip/retry/ack reasons), and
`gmail_watch_maintenance` (the daily renewal + sweep). Correlate transport
events to ingest events on `(mailboxId, providerMessageId)`
(inbound-ingestion.md §6).

## What this runbook does not cover

- The Agent Inbox **UI**  — this deploys the engine/API; the UI is separate.
- Multi-mailbox / GA onboarding — dogfood is one Workspace mailbox, Internal app.
- Vercel Queues — a future low-latency/managed `QueueProvider` adapter; the PG
  queue is the dogfood implementation of the same interface.
