# Deploying Helpthread as one Vercel project

Status: the supported deployment shape. One Vercel project, rooted at `web/`, serves the
operator UI and the whole API from one origin. The split shape — the engine as its own
project from the repo root (`api/index.ts`) — still builds and is kept only for the
transition described at the end.

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
| `PUBLIC_BASE_URL` | The deployment's one origin. Forms the OAuth redirect URI, the Gmail push audience, invite links, and the passkey relying-party id. |
| Every engine variable in [`gmail-inbound-runbook.md`](gmail-inbound-runbook.md) Part D | Unchanged. |
| `HELPTHREAD_UI_SESSION_SECRET` | The UI's session-cookie secret (`web/README.md`). |
| `HELPTHREAD_API_URL`, `HELPTHREAD_UI_BASE_URL` | Optional overrides, for a split deployment or the local dev harness only. Leave unset. |

Passkeys bind to the `PUBLIC_BASE_URL` host and cannot be moved: set the final domain before
anyone registers one. A plain-http `PUBLIC_BASE_URL` off loopback boots with invites and
passkeys disabled (one warning at startup).

Vercel project settings: Root Directory `web`; the default build command; "Include source
files outside of the Root Directory" enabled (the default). `web/vercel.json` sets the install
command to `cd .. && npm ci`: Vercel installs the Root Directory alone, and the engine's
dependencies live in the workspace root.

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
