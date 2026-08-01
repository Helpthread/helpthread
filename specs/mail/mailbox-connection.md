# Mailbox connection — scheduled-fetch intake, IMAP/SMTP transport, and the connect screen

**Status: DRAFT — built against in HT-101 (2026-07-31); see the status box below.**
**Promotion to `accepted` is an open decision, not made by this change.**
**Charter dependency:** the scheduled-fetch amendment (CHARTER.md §7, 2026-07-20).

> ## Status of the three blocking questions (updated 2026-07-31, HT-101)
>
> Adversarial review (2026-07-20) found three gaps, all of which sit on the
> **mail-semantics invariant** (CHARTER.md §2). HT-101 answered two and
> *contained* the third. The original text of each is preserved below; this
> box records what shipped against it.
>
> | # | Question | Status after HT-101 |
> |---|---|---|
> | 1 | Self-echo suppression on SMTP+IMAP | **Resolved** — `isOwnMessageReflection` (`src/mail/ingest.ts`) suppresses on our own signed `Message-ID`, and deliberately never reads `In-Reply-To`/`References`, so the `auto-submitted.json` fixture (a customer's out-of-office reply *is* ingested) still holds. |
> | 2 | `providerMessageId` undefined for IMAP | **Contained, NOT resolved** — see below. |
> | 3 | The named seam is the wrong shape | **Resolved by declining the seam** — the fetch is a data-contract function (`src/providers/adapters/imap/fetch.ts`), not an `InboundEmailProvider`. §5/§7's claim that it fits behind that webhook-shaped seam was wrong; the adapter documents why. |
>
> **On #2 — containment, stated plainly.** IMAP still has no transport-stable
> id. The adapter mints a placeholder `imap:{uidValidity}:{uid}`, stable only
> *within* one UIDVALIDITY epoch, and its own doc states it does not resolve
> this question. What prevents the silent duplication the ledger exists to
> stop is `src/mail/imap-fetch.ts`'s **SACRED** rule: on a UIDVALIDITY reset
> the mailbox is **paused** — no ingest, no cursor advance — until a human
> rebaselines it. The system stops rather than guessing, which satisfies
> CHARTER.md §2's never-lose/never-corrupt invariants but leaves the
> underlying identity problem open. **A durable answer is still owed** before
> IMAP intake can be called complete.
>
> ### Original text of the three questions
>
> **1. Self-echo suppression has no mechanism on SMTP+IMAP.**
> `src/store/inbound-deliveries.ts`'s `preSuppressOwnSend` pre-seeds the
> delivery ledger with the send's `providerMessageId` — "the SAME id the
> transport will later report for that exact message." Gmail's API supplies
> that shared id. **SMTP submission returns no id a later IMAP `FETCH` will
> report.** Without an answer, every agent reply lands back in the connected
> mailbox and is ingested as a new inbound customer message. Earlier self-echo
> bugs of this class were found *live*.
> Candidate answer to evaluate: suppress on our own minted `Message-ID`, which
> we control on the outbound side (CHARTER.md §2's threading authority) and
> which SMTP submission was observed to preserve verbatim — but "observed
> once" is not "proven," and this needs a fixture.
>
> **2. `providerMessageId` is undefined for IMAP.**
> `specs/mail/inbound-ingestion.md` makes `(mailboxId, providerMessageId)` the
> unique-constrained idempotency key and requires `providerMessageId` to be
> "the transport's own **stable** id." §5 of this document states that a
> `UIDVALIDITY` change makes every stored UID meaningless — so a UID-keyed
> ledger re-ingests the entire mailbox on a `UIDVALIDITY` reset, the exact
> silent duplication the ledger exists to prevent. IMAP UIDs are also only
> unique per-folder, not per-account.
>
> **3. The named seam is the wrong shape.**
> §5 and §7 place the IMAP adapter "behind the existing `InboundEmailProvider`
> seam." That interface is webhook-shaped in both methods —
> `verifySignature(request: Request)` and `receiveDelivery(request: Request)`.
> A cron-driven fetch has no `Request`. The *data* contract
> (`RawInboundMessage`, raw bytes, a single `parseInboundEmail`) is
> satisfiable; the *interface* is not. The claims "least new code" and "not new
> fetch code" both rest on this and are therefore overstated.
>
> Superseded by the status table above: §4–§7 are no longer a sketch. They
> were built against in HT-101, and where the built code diverged from this
> text (question #3's seam), the code is right and this document was wrong.
> §2's spike results and §3's provider matrix remain independently verified.

## 1. The problem

Getting email working on a fresh install takes ~26 steps across four consoles — 4–6 hours for an operator who knows Google Cloud, longer for one who doesn't. About half of those steps exist solely to make Gmail **push** work, and two of them fail silently:

- the domain-restricted-sharing org policy blocks the Pub/Sub IAM grant with no useful error
- a CLI-created push subscription needs an extra `roles/iam.serviceAccountTokenCreator` grant, without which push simply never arrives

There is also no UI for connecting a mailbox. The operator runs a raw `curl` against `POST /api/v1/inbound/gmail/connect` to obtain a consent URL (`specs/deploy/gmail-inbound-runbook.md`).

**Success criterion, stated as a test:** a new operator with an existing mailbox goes from deployed app to first ingested email in under five minutes, touching no DNS records, no cloud console, and no third-party signup.

## 2. What the spike established (2026-07-20, verified live)

**GMAIL scheduled reconciliation already ships — not a generic scheduled fetch.** This distinction is load-bearing and the earlier wording blurred it. What exists today is Gmail *history* reconciliation: a cursor-based `history.list` walk against the Gmail API. It proves that cursor-driven, cron-triggered intake is architecturally sound and already in production, which is what the charter amendment rests on. It does **not** provide a byte of the IMAP UID-cursor fetch this document specifies — that adapter, its cursor semantics, its `UIDVALIDITY` handling, and its idempotency key are all new work, and substantial. Read the paragraph below as "the pattern is proven," never as "the transport is built."

`runGmailWatchMaintenance` (`src/mail/gmail-watch-maintenance.ts`, the daily cron in `vercel.json`) performs "a bounded reconciliation sweep" that enqueues *the same reconcile job the push path enqueues*. That job (`src/mail/gmail-reconcile.ts`) reads the mailbox's **stored cursor** — explicitly never the push notification's `historyId` — then calls `history.list` followed by `messages.get?format=raw`. It takes only `mailboxId` from the job payload; the payload's `historyId` is logged and never acted on.

Note the field is a latent hazard rather than a clean equivalence: the webhook writes the notification's *new* watermark into `historyId`, while a sweep writes the *stored cursor* — semantically opposite values in the same field. Harmless while nothing reads it, and a trap for anything that later does.

Consequence: **push only makes the same job run sooner.** Making scheduled fetch a fully-supported intake path (rather than only a reconciliation backstop) is a scheduling change, not new fetch code. The lease around `history.list` (`claimReconcileLease`) already prevents concurrent runs from double-fetching.

**IMAP + app password works.** Probed `help@resonantiq.app` directly: authenticated, `SELECT INBOX` (`UIDVALIDITY=1`, `UIDNEXT=32`, `EXISTS=29`), `UID FETCH BODY.PEEK[]` returned raw RFC822 for five messages in 1174 ms, connection closed on exit. A real reply's `References` chain carried the `ht.ht1.…` signed reply token intact — the CHARTER.md §2 threading anchor holds on this transport.

**SMTP + app password works.** Same credential, `smtp.gmail.com:465`, `AUTH PLAIN`, 1833 ms. Our own `Message-ID` was preserved verbatim, confirmed by an `rfc822msgid:` lookup at the recipient.

Worth recording: Gmail's `users.messages.send` **API** rewrites the `Message-ID` we set,
which is why the reply token had to move into `References` (`src/mail/send.ts`). SMTP
submission did not rewrite it. One observation is not proof of a general rule, and the
`References` mechanism works on both transports — so this is a point in SMTP's favour,
not a reason to change the threading model.

**Outbound needs no NEW DNS.** Replies go through the operator's own mail server, so they are signed by whatever DKIM that server already uses, from its IPs, under its existing SPF record. Every provider-webhook alternative considered (Postmark, Resend, SES, Cloudflare) requires the operator to add records for a *new* sending identity; this transport requires none.

Stated precisely, because the earlier wording overclaimed: this does **not** guarantee deliverability. It inherits whatever the operator's domain already has. A domain with no SPF, a broken DKIM selector, or a `p=reject` DMARC record misaligned with its own sender will deliver just as badly through Helpthread as it does through the operator's normal mail client — the point is that we add no new DNS burden, not that we fix an existing one. Where deliverability is already broken, that is the operator's pre-existing mail configuration and should be diagnosed as such rather than as a Helpthread fault.

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

1. **OAuth is a required second connector, not a nice-to-have** — Microsoft business mail is unreachable without it. The existing OAuth machinery is reused, not rebuilt.
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

  It must not be able to manufacture a customer conversation. Requirements:
  - **Addressed to the connected mailbox itself**, never to an operator-typed
    recipient — a setup screen must not become a way to send mail to arbitrary
    third parties.
  - **Carries a unique correlation marker** (a nonce in a custom header and in
    the minted `Message-ID`) that the screen polls for.
  - **The ingestion pipeline recognises and drops it** on that marker, at the
    same point it suppresses our own outbound echo. A test message must never
    create a conversation, and must not be re-processed on later ticks.
  - **Rate-limited**, so the button cannot be used as a send amplifier.
- **Errors are mapped, never echoed raw.** The user sees a sanitized, escaped
  message plus a diagnostic code for the common cases (2SV not enabled, app
  passwords blocked by admin policy, wrong port, mailbox not found, auth
  rejected). The provider's raw IMAP/SMTP text goes to server-side logs only,
  redacted — it routinely carries hostnames, account addresses, and
  authentication detail that must not reach a browser. Never a bare
  "connection failed" either: an unmapped failure shows its diagnostic code so
  a support conversation can start from something specific.

## 5. Transport behaviour

### Inbound — bounded scheduled fetch

A cron entry alongside the existing four in `vercel.json`. Each invocation: connect, `SELECT INBOX`, fetch messages above the stored UID cursor, hand raw bytes to the pipeline, persist the new cursor, disconnect.

- **No IDLE, no held connections, no resident process.** The connection opens and closes within the invocation. This is the charter constraint, and it must not be optimised away for latency later.
- **Track `UIDVALIDITY` alongside the UID cursor.** If the server changes `UIDVALIDITY`, every stored UID is meaningless and the cursor must be rebuilt. Skipping this silently drops or re-ingests mail. Rebuilding safely depends on the unresolved `providerMessageId` question at the top of this document — a UID-keyed ledger cannot survive the reset it is supposed to recover from.
- **The cursor advances on COMMIT, not on fetch.** A UID may only move the stored cursor once that message has been durably committed by the ingestion pipeline. On a partial failure the cursor stays at the last committed UID and the batch is retried — re-fetching an already-committed message is harmless (ingest is idempotent), whereas advancing past an uncommitted one loses mail silently, which the mail-semantics invariant does not permit.
- **Bound the batch, and bound the clock.** `maxDuration` is 50 s (`vercel.json`). Cap messages per invocation and continue on the next tick rather than risk a timeout mid-fetch. Separately, every network operation — IMAP connect, login, `SELECT`, each `FETCH`, and every SMTP step — carries its own timeout derived from the remaining invocation budget, and the worker stops *starting* new work once too little budget remains to finish it. Connections are closed on success, timeout, and failure alike. Without this a single hung `FETCH` consumes the whole invocation and the tick accomplishes nothing, every minute, indefinitely.
- **Fetch raw.** `FETCH BODY.PEEK[]` — full RFC822, `.PEEK` so `\Seen` is not set. This satisfies `src/providers/inbound-email.ts` natively: raw bytes in, parsed exactly once by `parseInboundEmail`. No IMAP library's convenience parser may touch the message.

### Outbound — the operator's own SMTP

Stated explicitly in the operator docs, because it is the quiet advantage: replies are sent through the mail server the operator already runs, so deliverability is already correct and requires no DNS work.

### Credentials

App passwords are long-lived secrets granting full mailbox access. They must be encrypted at rest via the existing `HELPTHREAD_TOKEN_ENC_KEY` path (`src/store/token-crypto.ts`, AES-256-GCM) already used for OAuth tokens, never logged, never returned by any API read, and write-only in the UI — show a "configured" state, never the value.

**Encryption is not sufficient on its own.** The credential table needs
deny-by-default server-only authorization, not merely ciphertext at rest. That
answer now exists (see §8): migration 027 enables RLS on every table and revokes
the PostgREST role grants, so a new table inherits protection only if it does the
same. This table must enable RLS in the migration that creates it.

**Lifecycle — app passwords die quietly.** Unlike an OAuth grant, there is no
revocation signal and no refresh failure to classify. They stop working when
the account owner changes their password, when a Workspace admin disables app
passwords or enforces security-key-only 2SV, or when the account enrols in
Advanced Protection. The connection simply starts failing authentication. So:
- Auth failure on a scheduled fetch marks the mailbox `needs_reconnect`, the
  same state a dead OAuth grant produces, so one operator-facing concept covers
  both.
- The reconnect path is re-entering a credential, not a consent redirect — the
  screen must say which, per provider, rather than offering an OAuth button to
  a Fastmail user.
- This asymmetry is worth stating in the operator docs: OAuth is revocable and
  observable; an app password is neither, and its failure mode is silence.

Note the asymmetry worth telling operators about: an app password cannot be scoped and does not expire; an OAuth token is scoped to `gmail.readonly` + `gmail.send` and is revocable from the account.

### Operational

**Connection churn is the risk, not fetch frequency.** No provider publishes a per-minute polling limit, but reconnecting every 60 s while the operator's own devices also hold connections is where limits bite. Gmail's documented ceiling is bandwidth (2,500 MB/day download), which only matters on large-attachment backfill. Make the interval configurable and default it conservatively.

## 6. Addressing — mail that arrives under another address

Operators commonly route `support@company.com` into the mailbox they connect, rather than connecting `support@` itself. This is entirely the operator's own plumbing — a forwarding rule, an alias, a group — and the engine cannot and should not distinguish it from directly-addressed mail. Both are just messages in the mailbox.

It does have one design consequence: such mail carries `To: support@company.com`, not the connected mailbox address. **The mailbox therefore needs a configured list of addresses the desk answers for**, or the engine may not recognise that mail as belonging to it.

That is a configuration detail on the mailbox record, not a transport concern.

## 7. Build order

1. **Make Pub/Sub optional — not unsupported.** Reschedule the existing Gmail reconcile sweep so it can carry intake on its own, and let the engine boot with no `GMAIL_PUBSUB_*` vars. Neither transport is designated primary — per CHARTER §2, the operator chooses at setup. The Gmail push adapter, the webhook, and the `watch()` renewal all remain fully supported for operators who want sub-minute latency; what changes is that they stop being *mandatory setup*. This removes both silent-failure traps and the billing requirement (Pub/Sub is what forced it). Least new code of any item here — and note this is Gmail-only, per §2: it does nothing for IMAP.
2. **IMAP provider adapter** as a cron-shaped *data-contract* function (`fetchImapInboundMessages`), **not** behind the `InboundEmailProvider` seam — that interface is webhook-shaped (`verifySignature(request)` / `receiveDelivery(request)`) and a scheduled fetch has no `Request` to give it. What is shared with the Gmail path is the *data* contract (`RawInboundMessage`, raw bytes, one `parseInboundEmail`) and the ingest pipeline below it; equivalence fixtures prove that shared path, not a shared interface. Corrected 2026-07-31 — this step previously named the seam, which is blocking question #3 at the top of this document.
3. **Migrations** — UID cursor + `UIDVALIDITY`; encrypted mailbox credential.
4. **SMTP sender** behind the existing `EmailSender` seam.
5. **The connection screen** — design session first, then implementation.
6. **`Check connection` / `Send test email`**, including the round-trip verification.
7. **Microsoft OAuth connector**, reusing the existing OAuth machinery.
8. Demote Gmail push in the docs to the advanced low-latency option; keep it fully supported.

## 8. Out of scope — tracked separately

Roughly half the current setup burden is not email at all: Supabase project creation, 26 manual migrations, two separate Vercel projects with duplicated env vars, and four hand-minted `openssl` secrets.

The **Vercel Pro requirement** was assessed and dismissed as a blocker: three `*/1` crons
already force it today, independent of mail intake, and Vercel's Hobby plan prohibits
commercial use — so any company running Helpthread as a real support desk needs Pro by
licence terms regardless. Evaluation friction should be addressed through setup automation
and documentation, not by changing Helpthread's operator-deployed model.

Also found while mapping the current path, each requiring separate follow-up:

- **RLS was disabled on all 19 tables** — addressed by migration 027, which enables RLS on every table and revokes the `anon`/`authenticated` grants. The concern recorded here that "enabling RLS without policies would break the engine's own access" was wrong *given how the engine actually connects*: it connects as the role that owns the tables, and an owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set. No policy design was needed, because nothing should reach these tables through PostgREST at all. Note the deployment invariant this promotes: `DATABASE_URL` must connect as the table-owning role. Pointing it at a dedicated least-privilege role instead breaks the engine, and the two halves break differently: reads go *quiet* (RLS with no policies returns zero rows rather than raising, so the symptom is an empty inbox) while every write hard-errors with `new row violates row-level security policy`. Expect the loud signal first — inbound ingest fails immediately — with silently empty reads alongside it. Standing rule: a migration adding a table must also enable RLS on it. See [docs/decisions/README.md](../../docs/decisions/README.md).
- **Three doc-drift defects** in `specs/deploy/gmail-inbound-runbook.md`: it names an `api/[...path].ts` entrypoint that was tried and abandoned (the real file is `api/index.ts`, which documents why), says "three cron jobs" where `vercel.json` declares four, and omits `HELPTHREAD_UI_BASE_URL` and the entire web-project env set — so an operator following only the runbook gets a working engine and a non-functional UI.
- **No `.env.example`** anywhere in the repo; the 17-variable contract exists only as a prose table and as validation logic in `src/composition/config.ts`.
- **History-cursor expiry fallback** not audited. Gmail expires history cursors; the 404 path exists but has not been reviewed for a mailbox that goes quiet for an extended period.
