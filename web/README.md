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

## The fidelity mandate (TJ, 2026-07-12)

**The pixel source of truth is the Claude Design prototype** (`Helpthread
App.dc.html` in the "Helpthread Agent Inbox Design" project), and this app is
not done until it matches that design exactly — all of its surface, not a
subset. Deviations of any kind (visual, copy, interaction) need TJ's explicit
sign-off. See the "UI fidelity" section of the repo CLAUDE.md; the live gap
list is the fidelity checklist on
[HT-23](https://resonantiq.atlassian.net/browse/HT-23).

## Shipped so far

Persistent shell (folder rail + top bar, dark theme) · inbox folders
(Unassigned/Mine/Starred/Drafts/Assigned/Closed/Spam, keyset load-older) ·
conversation view with message bands (inbound / Agent reply / internal note
/ failed-delivery / customer-viewed) and the Customer context panel · tag
editing, assignee/Mine, star, four-state status (active/pending/closed/spam),
soft delete (two-step arm), toasts · a SUMMONED composer (hidden by default;
opens via the toolbar, `r`/`n`, or automatically when a saved draft exists)
with Reply/Note tabs, rich-text formatting (bold/italic/list/link, sent as
HTML alongside plain text), the closed-reopens-on-reply banner, localStorage
draft persistence (debounced, backing the Drafts folder), and the spec §4a
idempotency contract (one key per logical send, reused on retry, a fresh one
after a validation failure; honest send-failure copy with retry) · keyboard
shortcuts throughout (inbox j/k/Enter/x; conversation j/k/r/n/⌘+↵/cascading
Escape; global `?` overlay).

Still not wired: Forward, Merge, composing a NEW conversation from scratch
("New message"), and the Agent's own profile settings — all spec'd for v1
but not yet implemented. See the fidelity checklist on
[HT-23](https://resonantiq.atlassian.net/browse/HT-23) for the authoritative
list of remaining gaps.
