# Deploy with Vercel (alpha install path)

Status: **alpha, developer preview** (issues #151/#153). This is a guided one-click route into
a real Helpthread deployment — it still asks you for real secrets and a mailbox, but it removes
almost every manual setup step in [`single-project.md`](single-project.md) and
[`gmail-inbound-runbook.md`](gmail-inbound-runbook.md). A live install through the button on
2026-09-23 confirmed the deploy through first boot (see the `POSTGRES_URL` note below);
sending/receiving mail and creating the first admin through `/setup` were not part of that test.
If something here doesn't match what Vercel shows you, please open an issue.

The button (README, top) does three things in one flow:

1. Creates a Vercel project rooted at `web/` from this repository.
2. Attaches the Vercel Marketplace's Supabase integration, which provisions a new Supabase
   project (Postgres + Storage + API keys) and writes its connection details into the new
   Vercel project's environment automatically.
3. Prompts you for the handful of values below that neither Vercel nor Supabase can generate
   for you.

**Two things a live install surfaced:** when you reach the Supabase integration step, leave
"Public Environment Variables Prefix" alone — that field is for Supabase's own variables, not
Helpthread's. Helpthread's values (below) go in the separate per-variable fields Vercel shows
for your project, not in that prefix field. Separately, the new repository Vercel creates for
you may carry over the source repository's dependabot branches, and Vercel will build preview
deployments for them — a failed preview there does not affect your production deployment.

## What Vercel/Supabase fill in for you

The Supabase integration writes these variables into your project automatically. Helpthread's
engine (`src/composition/config.ts`) accepts them directly — you never need to copy anything
between dashboards:

| Integration writes | Helpthread reads it as | Notes |
|---|---|---|
| `POSTGRES_URL` | `DATABASE_URL` (fallback) | The pooled Postgres connection string. An explicit `DATABASE_URL` always wins if you set one yourself. |
| `SUPABASE_URL` | `SUPABASE_URL` | Same name — no fallback needed. |
| `SUPABASE_SECRET_KEY` | `SUPABASE_SERVICE_ROLE_KEY` (fallback) | The integration's current name for the server-only key. An explicit `SUPABASE_SERVICE_ROLE_KEY` always wins. |
| `SUPABASE_SERVICE_ROLE_KEY` | `SUPABASE_SERVICE_ROLE_KEY` | Same name — the integration also writes this one directly, so `SUPABASE_SECRET_KEY` above is only a fallback. |

> **Not independently confirmed:** Supabase's own Vercel-integration docs did not spell out
> `POSTGRES_URL`'s pooling mode (transaction vs. session) or port number in the terms
> `src/db/postgres.ts` cares about. This document assumes it follows the same convention
> Vercel's other Postgres-compatible marketplace integrations use — `POSTGRES_URL` pooled,
> `POSTGRES_URL_NON_POOLING` direct — which is also the shape `DATABASE_URL` already expects
> from a hand-copied Supabase pooler URI (`specs/deploy/gmail-inbound-runbook.md` Part B1).
> Supporting evidence, still unconfirmed against a real button install: Supabase's own
> [serverless-drivers guide](https://supabase.com/docs/guides/database/connecting-to-postgres/serverless-drivers)
> tells users to set `POSTGRES_URL` to the Transaction pooler URI (port 6543). If your
> deployment's queries behave oddly under load, check the actual value Vercel wrote and
> compare it against the Supabase dashboard's **Connect** dialog's pooler URI. (The pooling
> mode/port itself is still unconfirmed — see below for what a real install did confirm.)
>
> The `POSTGRES_URL` fallback also carries `?sslmode=require`. Helpthread rewrites that to
> `sslmode=require&uselibpqcompat=true` before connecting (`src/composition/postgres-url-compat.ts`),
> matching Supabase's own meaning for `require`: the connection is encrypted, but the server
> certificate chain (which chains to Supabase's own CA, not one in Node's default trust store —
> see [Supabase's SSL enforcement docs](https://supabase.com/docs/guides/platform/ssl-enforcement))
> is not verified. If you want full chain verification instead, set `DATABASE_URL` explicitly
> with `sslmode=verify-full` and Supabase's CA certificate — an explicit `DATABASE_URL` is never
> rewritten.
>
> **Confirmed by a live install (2026-09-23):** this path works end to end against a fresh
> Supabase database. The production build log showed
> `scripts/migrate-if-production: production build — all migrations applied.` running against
> `POSTGRES_URL` through this same TLS-compat rewrite, then `next build` succeeded and the
> deployment went READY. At runtime, `/setup` correctly rendered its "Set up your team" form —
> which only renders when the engine's live `countAgents()` query returns 0 — confirming the
> app reads the database through this same path in production, not just at build time. Not
> covered by this test: sending/receiving mail and creating the first admin through `/setup`.

Vercel also sets `VERCEL_PROJECT_PRODUCTION_URL`, which Helpthread uses to fill in
`PUBLIC_BASE_URL` automatically on your first Production deploy — see below.

## What you're asked for, and how to generate it

The button's environment-variable prompt covers exactly these — nothing else, and never a
secret's value in the URL you clicked:

| Variable | What it is | How to generate it |
|---|---|---|
| `HELPTHREAD_TOKEN_ENC_KEY` | Encrypts stored mailbox OAuth tokens at rest. | `openssl rand -base64 32` |
| `HELPTHREAD_API_TOKEN` | The Agent Inbox API's Bearer token. | `openssl rand -hex 32` |
| `HELPTHREAD_SIGNING_SECRET` | HMAC keyring for reply/state/view tokens. | `openssl rand -hex 32` |
| `CRON_SECRET` | Guards the internal cron/drain endpoints. | `openssl rand -hex 32` |
| `HELPTHREAD_UI_SESSION_SECRET` | The operator UI's session-cookie secret. | `openssl rand -hex 32` |
| `HELPTHREAD_SETUP_SECRET` | Gates `/setup` — see "First visit" below. | `openssl rand -hex 32` |
| `HELPTHREAD_MAIL_DOMAIN` | The domain minted into outbound `Message-ID`s (e.g. `example.com`). | You choose it. |
| `HELPTHREAD_SUPPORT_ADDRESS` | The address customers write to (e.g. `support@example.com`). | The mailbox you plan to connect. |
| `HELPTHREAD_BLOB_BUCKET` | The private Supabase Storage bucket name for attachments. | See "Storage bucket" below. |

Every generated value only needs to be long and random — the exact command doesn't matter as
long as the result meets the length floor `src/composition/config.ts` enforces (16-32
characters depending on the field; `openssl rand -hex 32` clears all of them).

## Storage bucket (⚠️ INFERRED)

`HELPTHREAD_BLOB_BUCKET` names a **private** Supabase Storage bucket for email attachments.
The Supabase Marketplace integration provisions Postgres, but it does **not** create a Storage
bucket for you, and the engine's Storage adapter (`src/providers/adapters/supabase-storage/`)
does not create one either — it only ever references the bucket name it's given.

Given the choice between having the engine create the bucket automatically on first use (more
convenient, but a behavior change to the shared production Storage adapter no maintainer has
signed off on) and simply asking for the name up front with clear instructions, this alpha path
takes the smaller, safer option: **you create the bucket yourself.**

1. In your Supabase project dashboard: **Storage → Create bucket**.
2. Name it exactly what you put in `HELPTHREAD_BLOB_BUCKET` (a reasonable default: `helpthread-blobs`).
3. Leave it **private** (do not enable public access).

If you deploy before creating the bucket, the app still boots — attachment storage will fail
the first time it's actually used (a message with an attachment arrives, or an oversized raw
message is stored) rather than at boot. Create the bucket before connecting a mailbox to avoid
that.

## `PUBLIC_BASE_URL` — derived automatically, with a passkey caveat

You are **not** asked for `PUBLIC_BASE_URL`. On your first Production deploy, if it's unset,
the engine derives it from Vercel's own `VERCEL_PROJECT_PRODUCTION_URL` system variable (your
project's `*.vercel.app` domain), so the deployment has a working origin immediately. Setting
`PUBLIC_BASE_URL` explicitly always overrides this.

**Caveat:** passkeys (WebAuthn) bind to whichever host was `PUBLIC_BASE_URL` at the moment
someone registers one, and cannot be moved afterward
([`single-project.md`](single-project.md)). If you plan to attach a custom domain later, set
`PUBLIC_BASE_URL` to that domain **before** anyone registers a passkey — ideally before the
first `/setup` visit. The same applies to the Gmail OAuth redirect URI and Pub/Sub push
endpoint, if you later configure Gmail push.

## Gmail is optional

`GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET` are **not** in the button's prompt and are
not required to deploy. If you leave them unset, the deployment boots with Gmail connect
disabled (`POST/GET .../inbound/gmail/connect|callback|disconnect` all 404, and one warning is
logged at boot) — IMAP/SMTP mailbox connections work unaffected. Set both later and redeploy if
you want to connect a Gmail mailbox; see
[`gmail-inbound-runbook.md`](gmail-inbound-runbook.md) Part A for the Google Cloud side.

## Vercel plan requirement

Helpthread needs a **Vercel Pro** plan or above. Five of the six cron schedules in
`web/vercel.json` run more than once a day (several every minute), which the Hobby plan does
not allow — a more-frequent cron expression fails deployment outright on Hobby.

## First visit: `/setup`, then mailbox connection

Once deployed, open your project's URL. The first thing you'll see is `/setup`: create the
first Agent account using the `HELPTHREAD_SETUP_SECRET` you set above as the setup key. Without
it set, `/setup` refuses outright (`409 setup_locked`) — this is deliberate: a public deployment
with no setup secret is one visit away from anyone becoming its permanent admin. You may remove
`HELPTHREAD_SETUP_SECRET` from the project's environment once the first admin exists.

After setup, connect a mailbox:

- **IMAP/SMTP** — from the Agent Inbox's mailbox settings, using your mail provider's IMAP/SMTP
  credentials. No Google Cloud setup needed.
- **Gmail** — requires `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET` to be set (see
  "Gmail is optional" above) and the Google Cloud steps in
  [`gmail-inbound-runbook.md`](gmail-inbound-runbook.md) Part A, then
  `POST /api/v1/inbound/gmail/connect`.

## Open questions this document does not resolve

- The Supabase Marketplace integration's exact `stores` parameters
  (`integrationSlug`/`productSlug`, both `"supabase"`) worked in the 2026-09-23 live install —
  don't change the button URL.
- `POSTGRES_URL`'s pooling mode — see the callout above.
