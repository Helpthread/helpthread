# Mailbox connection — scheduled-fetch intake, IMAP/SMTP transport, and the connect screen

**Ticket:** HT-92 · **Status:** spec, implementation not started
**Charter dependency:** the scheduled-fetch amendment (CHARTER.md §7, 2026-07-20). This spec is unimplementable without it.

## 1. The problem

Getting email working on a fresh install takes ~26 steps across four consoles — 4–6 hours for an operator who knows Google Cloud, longer for one who doesn't. About half of those steps exist solely to make Gmail **push** work, and two of them fail silently:

- the domain-restricted-sharing org policy blocks the Pub/Sub IAM grant with no useful error
- a CLI-created push subscription needs an extra `roles/iam.serviceAccountTokenCreator` grant, without which push simply never arrives

There is also no UI for connecting a mailbox. The operator runs a raw `curl` against `POST /api/v1/inbound/gmail/connect` to obtain a consent URL (`specs/deploy/gmail-inbound-runbook.md`).

**Success criterion, stated as a test:** a new operator with an existing mailbox goes from deployed app to first ingested email in under five minutes, touching no DNS records, no cloud console, and no third-party signup.

## 2. What the spike established (2026-07-20, verified live)

**Scheduled fetch already ships.** `runGmailWatchMaintenance` (`src/mail/gmail-watch-maintenance.ts`, the daily cron in `vercel.json`) performs "a bounded reconciliation sweep" that enqueues *the same reconcile job the push path enqueues*. That job (`src/mail/gmail-reconcile.ts`) reads the mailbox's **stored cursor** — explicitly never the push notification's `historyId` — then calls `history.list` followed by `messages.get?format=raw`. It consumes nothing from the push payload.

Consequence: **push only makes the same job run sooner.** Making scheduled fetch the primary intake is a scheduling change, not new fetch code. The lease around `history.list` (`claimReconcileLease`) already prevents concurrent runs from double-fetching.

**IMAP + app password works.** Probed `help@resonantiq.app` directly: authenticated, `SELECT INBOX` (`UIDVALIDITY=1`, `UIDNEXT=32`, `EXISTS=29`), `UID FETCH BODY.PEEK[]` returned raw RFC822 for five messages in 1174 ms, connection closed on exit. A real reply's `References` chain carried the `ht.ht1.…` signed reply token intact — the CHARTER.md §2 threading anchor holds on this transport.

**SMTP + app password works.** Same credential, `smtp.gmail.com:465`, `AUTH PLAIN`, 1833 ms. Our own `Message-ID` was preserved verbatim, confirmed by an `rfc822msgid:` lookup at the recipient.

Worth recording: HT-49 exists because Gmail's `users.messages.send` **API** rewrites the `Message-ID` we set, which is why the reply token had to move into `References` (`src/mail/send.ts`). SMTP submission did not rewrite it. One observation is not proof of a general rule, and the `References` mechanism works on both transports — so this is a point in SMTP's favour, not a reason to change the threading model.

**Outbound needs no DNS.** Because replies go through the operator's own mail server, they are signed by that server's DKIM, from its IPs, on a domain whose SPF already authorises it. Every provider-webhook alternative considered (Postmark, Resend, SES, Cloudflare) would reintroduce SPF/DKIM/DMARC setup. This transport does not.

## 3. Provider support

Verified 2026-07-20. App-password availability gates the whole approach.

| Provider | App password | Notes |
|---|---|---|
| Gmail consumer | Yes | 2SV required; unavailable under Advanced Protection |
| Google Workspace | Yes | Unless admin blocks it or enforces security-key-only 2SV |
| Fastmail | Yes | The only IMAP method offered |
| Zoho / Yahoo / iCloud | Yes | 2FA required |
| cPanel / self-hosted | Yes | The mailbox password is the credential |
| **Microsoft 365 business** | **No** | Basic auth removed and unre-enablable — **OAuth mandatory** |
| Outlook.com consumer | Unresolved | Microsoft's own docs contradict; test before claiming support |

Two consequences:

1. **OAuth is a required second connector, not a nice-to-have** — Microsoft business mail is unreachable without it. The HT-40 OAuth machinery is reused, not rebuilt.
2. **Generic IMAP still earns its place** — it is what makes Helpthread work with any mailbox rather than only Google and Microsoft.

Watch item: Google documents app passwords as legacy with no committed lifetime. No announced EOL, but no commitment either; OAuth is the hedge.

**Recommended default per provider:** OAuth for Google and Microsoft (scoped, revocable, no security warning); app password everywhere else.

## 4. The connection screen

**Design authority.** Per `CLAUDE.md`, the Agent Inbox UI's pixel source of truth is the Claude Design prototype, and deviation requires explicit sign-off. This section defines **behaviour and contract only** — the visual design needs a design-project session before implementation. An engineer must not invent this layout.

Behavioural contract:

- **Provider presets.** Recognise the address's domain and prefill IMAP/SMTP hosts and ports. Unknown domains expand an Advanced section.
- **Method availability is provider-dependent.** For an M365 business domain the app-password option is disabled *with an explanation*, never silently absent.
- **`Check connection`** performs a real IMAP login + `SELECT INBOX` and a real SMTP handshake + `AUTH`, reporting each leg independently. It must never report success from a config-shape check alone.
- **`Send test email`** sends an actual message through the operator's SMTP and confirms it is observed back through the fetch path. This round trip is the single most valuable element on the screen, and it is what today's setup path has no equivalent of — which is why silent misconfiguration currently survives to production.
- **Errors surface verbatim** — the provider's actual IMAP/SMTP rejection text, plus a mapped hint for the common cases (2SV not enabled, app passwords blocked by admin policy, wrong port, mailbox not found). Never a bare "connection failed."

## 5. Transport behaviour

### Inbound — bounded scheduled fetch

A cron entry alongside the existing four in `vercel.json`. Each invocation: connect, `SELECT INBOX`, fetch messages above the stored UID cursor, hand raw bytes to the pipeline, persist the new cursor, disconnect.

- **No IDLE, no held connections, no resident process.** The connection opens and closes within the invocation. This is the charter constraint, and it must not be optimised away for latency later.
- **Track `UIDVALIDITY` alongside the UID cursor.** If the server changes `UIDVALIDITY`, every stored UID is meaningless and the cursor must be rebuilt. Skipping this silently drops or re-ingests mail.
- **Bound the batch.** `maxDuration` is 50 s (`vercel.json`). Cap messages per invocation and continue on the next tick rather than risk a timeout mid-fetch.
- **Fetch raw.** `FETCH BODY.PEEK[]` — full RFC822, `.PEEK` so `\Seen` is not set. This satisfies `src/providers/inbound-email.ts` natively: raw bytes in, parsed exactly once by `parseInboundEmail`. No IMAP library's convenience parser may touch the message.

### Outbound — the operator's own SMTP

Stated explicitly in the operator docs, because it is the quiet advantage: replies are sent through the mail server the operator already runs, so deliverability is already correct and requires no DNS work.

### Credentials

App passwords are long-lived secrets granting full mailbox access. They must be encrypted at rest via the existing `HELPTHREAD_TOKEN_ENC_KEY` path (`src/store/token-crypto.ts`, AES-256-GCM) already used for OAuth tokens, never logged, never returned by any API read, and write-only in the UI — show a "configured" state, never the value.

Note the asymmetry worth telling operators about: an app password cannot be scoped and does not expire; an OAuth token is scoped to `gmail.readonly` + `gmail.send` and is revocable from the account.

### Operational

**Connection churn is the risk, not fetch frequency.** No provider publishes a per-minute polling limit, but reconnecting every 60 s while the operator's own devices also hold connections is where limits bite. Gmail's documented ceiling is bandwidth (2,500 MB/day download), which only matters on large-attachment backfill. Make the interval configurable and default it conservatively.

## 6. Addressing — mail that arrives under another address

Operators commonly route `support@company.com` into the mailbox they connect, rather than connecting `support@` itself. This is entirely the operator's own plumbing — a forwarding rule, an alias, a group — and the engine cannot and should not distinguish it from directly-addressed mail. Both are just messages in the mailbox.

It does have one design consequence: such mail carries `To: support@company.com`, not the connected mailbox address. **The mailbox therefore needs a configured list of addresses the desk answers for**, or the engine may not recognise that mail as belonging to it.

That is a configuration detail on the mailbox record, not a transport concern.

## 7. Build order

1. **Drop the Pub/Sub dependency** — reschedule the existing reconcile sweep. Least new code, largest reduction in setup steps, removes both silent-failure traps and the billing requirement (Pub/Sub is what forced it).
2. **IMAP provider adapter** behind the existing `InboundEmailProvider` seam, with fixtures proving equivalence against the Gmail path.
3. **Migrations** — UID cursor + `UIDVALIDITY`; encrypted mailbox credential.
4. **SMTP sender** behind the existing `EmailSender` seam.
5. **The connection screen** — design session first, then implementation.
6. **`Check connection` / `Send test email`**, including the round-trip verification.
7. **Microsoft OAuth connector**, reusing the HT-40 machinery.
8. Demote Gmail push in the docs to the advanced low-latency option; keep it fully supported.

## 8. Out of scope — tracked separately

Roughly half the current setup burden is not email at all: Supabase project creation, 26 manual migrations, two separate Vercel projects with duplicated env vars, and four hand-minted `openssl` secrets.

The **Vercel Pro requirement** was assessed and dismissed as a blocker: three `*/1` crons already force it today, independent of mail intake, and Vercel's Hobby plan prohibits commercial use — so any company running Helpthread as a real support desk needs Pro by licence terms regardless. Evaluation friction is answered by managed hosting (CHARTER.md §7, HT-79), not by architecture.

Also found while mapping the current path, each needing its own ticket:

- **RLS is disabled on all 19 tables**, including `conversations` and `mailbox_oauth_tokens`. Exposure depends on whether the anon key is distributed; enabling RLS without policies would break the engine's own access, so this needs deliberate policy design.
- **Three doc-drift defects** in `specs/deploy/gmail-inbound-runbook.md`: it names an `api/[...path].ts` entrypoint that was tried and abandoned (the real file is `api/index.ts`, which documents why), says "three cron jobs" where `vercel.json` declares four, and omits `HELPTHREAD_UI_BASE_URL` and the entire web-project env set — so an operator following only the runbook gets a working engine and a non-functional UI.
- **No `.env.example`** anywhere in the repo; the 17-variable contract exists only as a prose table and as validation logic in `src/composition/config.ts`.
- **History-cursor expiry fallback** not audited. Gmail expires history cursors; the 404 path exists but has not been reviewed for a mailbox that goes quiet for an extended period.
