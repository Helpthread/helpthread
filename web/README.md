# Helpthread — Agent Inbox UI (`@helpthread/web`)

The Agent Inbox web app (HT-23): a Next.js client of the Agent Inbox API and
nothing more — per CHARTER.md's API-first rule, anything this UI does, the
typed public API does. It composes the design system handed back from the
Claude Design project (`src/components/ds/**`, ported verbatim) into working
screens.

## Run it

From the repo root, in two terminals:

```sh
npm run dev:api           # the HT-24 harness: real engine, seeded data, :8787
npm run -w web dev        # the app on :3000
```

The app's dev defaults match the harness (`http://localhost:8787`,
`helpthread-dev-token`). A deployment sets both env vars:

- `HELPTHREAD_API_URL` — the Agent Inbox API's base URL.
- `HELPTHREAD_API_TOKEN` — the service Bearer token. **Server-side only**: the
  API client (`src/lib/api.ts`) imports `server-only`, so the token can never
  reach a client bundle; every API call runs in a server component or server
  action.

## Where things live

- `src/components/ds/**` — the design system, verbatim from the hand-back
  (each component with its `.d.ts`). Edits belong upstream in the design
  system, not here; a scoped biome override relaxes lint for these files.
- `src/theme/` — the token/theme CSS chain. Rebrand = edit token values in
  ONE place (`tokens/colors.css` accent + neutrals); no component changes.
- `src/lib/api.ts` / `api-types.ts` — the typed API client, 1:1 with
  `specs/api/agent-inbox-v1.md` (v1.1). `nextCursor` stays opaque; no mail
  headers are ever composed client-side.
- `src/lib/actions.ts` — server actions, the only write path.
- `src/components/SanitizedHtml.tsx` — the ONE place inbound email HTML is
  rendered: DOMPurify always (spec §5's stored-XSS contract), remote images
  stripped.

## v1 scope shipped here (and what's next)

Inbox folders (Open/Closed/Spam) · conversation view with message bands
(inbound / Agent reply / internal note / failed-delivery / customer-viewed) ·
reply composer with the spec §4a idempotency contract (one key per logical
send, reused on retry; honest failure copy; draft always preserved) ·
close/reopen.

Not yet wired (API exists for all of them): notes composer, tag editing,
assignee/Mine, soft delete (two-step arm), keyboard shortcuts, dark-theme
toggle, settings page, load-older pagination polish, an accessibility pass
over the design-system components.
