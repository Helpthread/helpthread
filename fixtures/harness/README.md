# Black-box mail-behavior fixture harness

Feeds crafted emails into a **live** FreeScout helpdesk mailbox (a real
Gmail inbox, polled by FreeScout over IMAP roughly every 60 seconds), then
observes the resulting conversations through FreeScout's REST API, and
writes sanitized JSON fixtures to `fixtures/mail/observed/`. Those fixtures
become the acceptance suite Helpthread's own mail engine has to reproduce —
see CHARTER.md §2 ("boringly faithful on mail semantics") and invariant #5.

This is pure black-box testing: send mail in over SMTP, read conversations
out over the FreeScout REST API. The harness contains no FreeScout code and
reads none — see `CLAUDE.local.md` (gitignored) for why that boundary is
load-bearing for provenance.

## This sends real email and creates real helpdesk conversations

Running `npm run fixtures:run` (without `--dry-run`) sends real messages
through Gmail's SMTP servers to a real support mailbox and creates real
conversations in a real FreeScout instance. There is no sandbox mode for
the live path. Use `--dry-run` first to see the plan. Use a Gmail account
and FreeScout instance you are comfortable spamming with test traffic —
ideally a dedicated test mailbox, not anyone's daily inbox.

## Required environment variables

Set these in your shell before running (no `.env` support by design — see
`fixtures/harness/env.mjs`; this repo avoids a dotenv dependency):

| Variable | Meaning |
|---|---|
| `HARNESS_SMTP_USER` | Gmail address used to send probe emails and to read back the helpdesk's outbound replies via IMAP. |
| `HARNESS_SMTP_PASS` | Gmail **app password** for that account (not the account password) — generate one at https://myaccount.google.com/apppasswords. Requires 2-Step Verification on the account. |
| `HARNESS_HELPDESK_ADDR` | The support mailbox address probe emails are sent TO (the address FreeScout polls). |
| `HARNESS_FS_BASE_URL` | Base URL of the FreeScout instance, e.g. `https://support.example.com`. |
| `HARNESS_FS_API_KEY` | FreeScout REST API key, sent as the `X-FreeScout-API-Key` header. |
| `HARNESS_FS_USER_ID` | *(optional, default `1`)* FreeScout user id to post agent replies as. |

Missing variables produce one clear error listing everything that's absent
— the harness fails fast rather than dying deep inside a scenario.

## Running

```sh
npm install
npm run fixtures:run                 # all five scenarios, live
npm run fixtures:run -- --only reply-with-reference
npm run fixtures:run -- --dry-run    # prints the plan; sends nothing, needs no credentials
```

Each scenario gets up to 4 minutes of polling per wait (FreeScout's IMAP
ingestion cycle is ~60s, and Gmail delivery/search indexing adds its own
latency) — a full run of all five scenarios can take 15–20+ minutes. The
harness runs scenarios **sequentially**, on purpose: they share one mailbox,
and parallel sends would confound which IMAP poll result belongs to which
scenario.

## What gets written where

- `fixtures/mail/observed/<scenarioId>.json` — one fixture per scenario,
  overwritten on every run. Shape:
  ```json
  {
    "scenario": "reply-with-reference",
    "title": "...",
    "expectation": "...",
    "runId": "a1b2c3d4",
    "recordedAt": "2026-07-09T...",
    "sent": [ /* redacted sendMail() results */ ],
    "observed": { /* redacted FreeScout API responses / IMAP reads */ },
    "notes": "..."
  }
  ```
  On scenario failure or timeout, the fixture is still written, with
  `"outcome": "timeout-or-error"` and an `"error"` message instead of
  `sent`/`observed`/`notes` — a scenario failing does not stop the run.

- Nothing is written outside `fixtures/mail/observed/`. No deletes, no
  mutation of pre-existing conversations — see Safety rules below.

## Safety rules (enforced in code, not just convention)

- **Marker-scoped everything.** Every scenario embeds a unique
  `[HT7-<runId>-<scenarioId>]` marker in every subject it sends. All reads
  (`listConversations`, `pollForConversation`) filter strictly by that
  marker, so a run can never observe a conversation it didn't create.
- **Marker-gated mutation.** `postAgentReply` (the harness's only write
  against the live helpdesk) fetches the target conversation first and
  refuses to post unless the conversation's subject contains the caller's
  marker. There is no other mutating call in the harness.
- **No delete operations anywhere.** Not implemented, not exposed.
- `runId` is generated with `crypto.randomBytes`, not `Date.now()` alone,
  so concurrent or rapid reruns can't collide on the same marker.

## License verification (charter: "licenses verified at adoption")

Both `devDependencies` were checked with `npm view <pkg> license` before
being added, per CHARTER.md §3 provenance rule (permissively-licensed
dependencies only):

- `nodemailer` — `npm view nodemailer license` → **`MIT-0`** (MIT No
  Attribution — a permissive MIT variant, even less restrictive than plain
  MIT). Compliant.
- `imapflow` — `npm view imapflow license` → **`MIT`**. Compliant.

Both are strictly `devDependencies`: the harness is a testing tool that
never ships as part of the Helpthread engine or its runtime dependency
tree.

## Design notes

- No MIME parsing dependency: `inbox.mjs` fetches the raw RFC822 source
  over IMAP and parses headers (and a best-effort body snippet) with a
  small hand-rolled parser, per the "don't add more deps" instruction. The
  body snippet is not MIME-aware (no multipart/base64/quoted-printable
  decoding) — it's provenance for a fixture, not a assertion target.
- `redact.mjs` never touches ids, timestamps, statuses, or JSON structure —
  only string values that look like the harness's own Gmail address (and
  its plus-variants) or the helpdesk address get replaced with stable
  `*.example.test` placeholders.
