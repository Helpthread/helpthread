# Deploying Helpthread as one Vercel project

Status: the supported deployment shape. One Vercel project, rooted at `web/`, serves the
operator UI and the whole API from one origin. The split shape — the engine as its own
project from the repo root (`api/index.ts`) — still builds and is kept only for the
transition described at the end.

> Setting this up by hand? This document is the reference. Want the guided, fewer-clicks
> route instead? See [`deploy-with-vercel.md`](deploy-with-vercel.md) (alpha).

## How it fits together

- `web/src/engine/mount.ts` hands every `/api/**` request to the engine's composition root
  (`src/composition/root.ts`), unchanged. The engine's router, auth, and error envelopes do
  all the work. It is the one file in `web/` allowed to import the engine;
  `tests/web-engine-boundary.test.ts` fails if any other file mentions it.
- The engine is compiled first: `npm run build:engine` emits `src/**` to `dist/`, and the
  `@helpthread/engine` alias in `web/tsconfig.json` points at it. `web`'s `prebuild` and
  `predev` scripts run it, so `next build` and `next dev` never see a stale or missing `dist/`.
- The UI still calls the API over HTTP, at its own origin (`web/src/lib/api.ts`). On a
  non-production Vercel deployment it calls that deployment's own URL and forwards the
  viewer's Deployment Protection cookie, so a preview calls its own deployment rather than
  production's. Its engine still reaches whatever database the Preview environment's
  variables name — scope those to Production if previews must not touch production data.
- `web/vercel.json` declares the six cron schedules. Five run more than once a day, which
  Vercel allows on Pro and above, not Hobby.

## Configuration

| Variable | Role |
|---|---|
| `PUBLIC_BASE_URL` | The deployment's one origin. Forms the OAuth redirect URI, the Gmail push audience, invite links, and the passkey relying-party id. On Vercel, if unset on a Production deploy, derived from `VERCEL_PROJECT_PRODUCTION_URL` ([`deploy-with-vercel.md`](deploy-with-vercel.md)) — an explicit value always wins. |
| Every engine variable in [`gmail-inbound-runbook.md`](gmail-inbound-runbook.md#env-reference) Part D | Unchanged. [`.env.example`](../../.env.example) lists them all. |
| `HELPTHREAD_UI_SESSION_SECRET` | The UI's session-cookie secret (`web/README.md`). |
| `HELPTHREAD_API_URL`, `HELPTHREAD_UI_BASE_URL` | Optional overrides, for a split deployment or the local dev harness only. Leave unset. |

Passkeys bind to the `PUBLIC_BASE_URL` host and cannot be moved: set the final domain before
anyone registers one. A plain-http `PUBLIC_BASE_URL` off loopback boots with invites and
passkeys disabled (one warning at startup).

Vercel project settings: Root Directory `web`; the default build command; "Include source
files outside of the Root Directory" enabled (the default). `web/vercel.json` sets the install
command to `cd .. && npm ci`: Vercel installs the Root Directory alone, and the engine's
dependencies live in the workspace root.

## Migrations

**Production deploys migrate themselves, during the build.** `web/package.json`'s
`prebuild` runs `scripts/migrate-if-production.ts` after `build:engine`, which applies every
pending migration (the same idempotent, advisory-locked `migrate()`, `src/db/migrate.ts`)
whenever Vercel sets `VERCEL_ENV=production` — i.e. every Production deploy, before it goes
live. **Preview and development builds never touch the database**: `VERCEL_ENV` is
`preview`/`development`/unset there, and the step just logs why it skipped. A production
build that cannot migrate (`DATABASE_URL` missing, or a migration failing) **fails the
build** rather than deploying code against an unmigrated schema — the error names the fix.

**A split deployment's UI project also skips**, even in Production: `HELPTHREAD_API_URL`
being set (the Configuration table above — the split/dev-harness override) is the same
signal `web/src/lib/api.ts`'s `apiBaseUrl()` already uses to mean "the engine is somewhere
else," so this `web/` project doesn't own the database either. That separate engine
project's database keeps migrating manually, exactly as in
[gmail-inbound-runbook.md](gmail-inbound-runbook.md) Part B — this build-time step only ever
applies to the single-project shape. The root-level engine project (`api/index.ts`) is
unaffected regardless: its `package.json` has no `build`/`prebuild` script, so nothing here
ever runs there.

`DATABASE_URL` must be set as a Production environment variable for this to work at build
time. Get the connection string from the **Supabase dashboard → your project → Connect**
(the transaction-mode pooler URI, port 6543). Note that Vercel marks `DATABASE_URL`
**sensitive**, so `vercel env pull` returns it **empty** — that command is not how you
retrieve it; go to Supabase's Connect dialog instead.

For everywhere else (a non-Vercel install, or migrating ahead of a deploy by hand), run the
manual one-shot from any machine that can reach the database:

```
DATABASE_URL='postgres://…' npm run migrate
```

`scripts/migrate.ts` applies every migration in `src/db/migrate.ts` in order and is
idempotent — re-running it on an up-to-date database is a no-op, so it is safe to repeat
after each upgrade that adds one. Use the pooler URI (port 6543) as normal; the direct 5432
URI also works for the one-time DDL if your provider prefers it for schema changes.

**If the database still falls behind the code** (a non-Vercel install that skipped the
manual step, or a rollback), `GET /api/v1/internal/health` reports it plainly — an alert
like `schema-migration-pending: database is missing migration(s) 27, 28, 29; this build
expects through 29. Run \`npm run migrate\`.` — and every other request/cron tick answers a
clear `503 schema_migration_pending` naming the same gap instead of a generic `500`. Run
`npm run migrate` (or wait for the next production build) to clear it.

### New migrations must keep working with the code already running

Because a production deploy now migrates itself as part of the SAME build, the schema moves
ahead of the code for the length of that deploy — the release still going out briefly runs
against the new schema before its own rollout finishes. A migration is safe across that
window only if it is additive: code that has never heard of the change keeps working
unmodified against the migrated schema.

**A new migration must keep working with the previous release's code.** Removing or
tightening something — dropping a column, adding `NOT NULL` with no `DEFAULT`, narrowing a
`CHECK` — ships in two releases, not one: a first migration that only stops the old thing
being *required* (a `DEFAULT`, a widened constraint, a backfill), then a later migration,
once nothing still depends on the old shape, that actually removes it. This is a written
rule, not a mechanical check — nothing in CI enforces it.

Two migrations already in `src/db/migrate.ts` predate this rule and would have needed the
two-step: migration 018 (`agents_and_auth`) drops `conversations.assignee` outright in one
step, and migration 021 (`threads_actor_model`) adds `threads.author_kind` `NOT NULL` with no
`DEFAULT`, so an old-shaped `INSERT` into `threads` would fail against it. Both shipped
before this rule existed and are left as-is; new migrations are held to it going forward.

## Moving a split deployment onto one project

The UI project already has Root Directory `web`, so it becomes the single project.

1. Add the engine's variables to the UI project. Set `PUBLIC_BASE_URL` to the UI's origin.
   The crons in `web/vercel.json` fire from the first deploy of this change; until the
   variables exist each tick logs one boot failure (variable names, never values). Once they
   exist, both projects drain the same queue until step 4 — the queue's leases keep that
   safe, but do the steps in one sitting.
2. Google Cloud: add `${PUBLIC_BASE_URL}/api/v1/inbound/gmail/callback` to the OAuth client's
   redirect URIs; set the Pub/Sub push subscription's endpoint to
   `${PUBLIC_BASE_URL}/api/v1/inbound/gmail` and its OIDC audience to the same value.
3. Redeploy the UI project and verify `GET ${PUBLIC_BASE_URL}/api/v1/internal/health` with
   `CRON_SECRET`.
4. Pause the old engine project. Its crons stop with it; nothing else runs there.
5. Repoint the health monitor and any API consumer to the new origin.
