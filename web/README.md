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
- `HELPTHREAD_UI_SESSION_SECRET` — the HMAC secret signing the login session
  cookie (`src/lib/session.ts`), required to be at least 32 characters in
  production. Checked on every route by `src/middleware.ts`, which runs on
  Next's Edge runtime — hence Web Crypto (`crypto.subtle`) rather than
  `node:crypto` for the cookie's HMAC.

`HELPTHREAD_UI_PASSWORD` (HT-51's single shared operator password) is
**retired** (HT-54; `specs/auth/agents-and-auth.md` §8) — replaced by real
per-Agent accounts. There is no env-var password anymore: on a fresh
deployment (zero Agents), the app routes to `/setup` to create the first
Admin; from then on, each Agent signs in with their own email/password at
`/login`, verified by the engine (`POST /auth/verify`), never the web layer.

`HELPTHREAD_UI_SESSION_SECRET` has an obviously-dev-only fallback in local
development (matching the `HELPTHREAD_API_TOKEN` dev-default pattern above)
and is REQUIRED — with no fallback — once `NODE_ENV=production`.

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
- `src/middleware.ts` / `src/lib/session.ts` / `src/lib/auth-actions.ts` /
  `src/lib/next-path.ts` — the per-Agent login gate (HT-51, real identity
  since HT-54): every route requires a signed session cookie (carrying the
  signed-in Agent's id) except `/login`, `/setup`, and `/invite/{token}`. See
  `specs/auth/agents-and-auth.md` §8 for the session/trust model.
- `src/lib/agent-actions.ts` — the Agents & Authentication write path
  (HT-54): create/edit/disable/delete an Agent, resend an invite, change a
  password — all through the engine's acting-Agent header
  (`src/lib/api.ts`'s `actingAgent` option), never a raw client call.

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

Agents & Authentication (HT-54; `specs/auth/agents-and-auth.md`): real
per-Agent accounts — `/setup` (first admin), `/login` (email+password),
`/manage/agents` (roster, admin-only UI, reached via the top bar's `Manage ▾`
— admin-only scope), `/manage/agents/new` (invite or admin-set password),
`/manage/agents/{id}` (profile: name/timezone/role, disable, change/reset
password, delete) with a `/manage/agents/{id}/permissions` sidebar section
(admin-only mailbox-access grants — admins have implicit access to all
mailboxes), `/invite/{token}` (accept), and the real-Agent assignee control
(`ConversationScreen`'s roster picker, the Unassigned/Mine/Assigned folders
split by `assigneeAgentId`). The avatar menu is personal-scope only (Your
Profile, Log out); keyboard shortcuts live under Settings.

Still not wired: Forward, Merge, and composing a NEW conversation from
scratch ("New message") — all spec'd for v1 but not yet implemented. See the
fidelity checklist on [HT-23](https://resonantiq.atlassian.net/browse/HT-23)
for the authoritative list of remaining gaps.
