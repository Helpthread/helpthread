# Gmail push inbound transport

Status: draft (HT-34). The Gmail-specific transport that feeds the provider-agnostic
[inbound-ingestion.md](./inbound-ingestion.md) pipeline. It implements the corrected
`InboundEmailProvider` seam (HT-35, inbound-ingestion.md §2) for Gmail: authenticate a
Cloud Pub/Sub push, reconcile it to the raw RFC822 messages that changed, and hand those
raw bytes to the ingest pipeline. It is the first realization of charter §4's "inbound mail
arrives via push webhooks (Gmail push through Pub/Sub) … not a process sitting in a loop"
and phase-1's "event-driven ingestion (bounded reconciliation fetches, never a long-running
poller)."

This transport is the **workspace-native mode** (memory: inbound-email architecture
decision, 2026-07-13): the intended default for a Google Workspace org running Helpthread
against its own mailbox via an **Internal** OAuth app. The forwarding-address transport —
the external/GA default — is separate and later.

## 1. Shape: push notification, then bounded reconciliation fetch

Gmail push has two moving parts, and the split matters:

1. `users.watch()` registers a mailbox to publish change notifications to a Cloud Pub/Sub
   topic; a Pub/Sub **push subscription** POSTs each notification to our HTTPS endpoint.
2. A notification's payload is only `{ emailAddress, historyId }` (base64url in the Pub/Sub
   envelope's `message.data`) — **it does not contain the message.** `historyId` is a
   watermark, not a message id.

So receipt is never "parse the webhook body into an email." It is: authenticate the push,
then **reconcile** from our own stored cursor via `users.history.list` to discover exactly
which messages changed, and fetch each as raw MIME. The notification is a *hint that
something changed*; the stored cursor is the source of truth. That is precisely the
charter's "bounded reconciliation fetch."

## 2. Webhook receipt and security (HT-39)

The endpoint — `POST /api/v1/inbound/gmail` — is the **second** unauthenticated surface in
the API (the first is the open-tracking pixel, `matchOpenTrackingPixel` /
`src/api/index.ts`). It carries no service Bearer token — Gmail/Pub/Sub cannot present ours
— so, exactly like the pixel, it MUST be matched and handled **before** the Bearer-auth
gate, and authenticated by its own mechanism: the Google-signed OIDC JWT that Pub/Sub
attaches to an authenticated push subscription.

Required checks, all of them (a failure of any is a uniform rejection):

- **Verify the OIDC JWT** on the request (`Authorization: Bearer <jwt>`): signature against
  Google's published certs; `iss` is Google; `aud` equals **our exact endpoint URL**;
  `email` is the specific push service account we configured for the subscription; `exp`
  not passed.
- **Bind to our subscription/project** — reject a notification that did not originate from
  the Pub/Sub subscription we created. A valid Google JWT is necessary but not sufficient;
  it must be *our* push identity.
- **Envelope limits** — `POST` + `application/json` only; a body-size cap; a uniform
  response that does not leak *which* check failed; replay tolerance (a re-POST is safe
  because ingestion is idempotent — inbound-ingestion.md §4 — but abusive repeats are
  rate-capped).

This surface is materially costlier than the pixel: a single accepted POST can trigger
Gmail API fetches, blob writes, and DB writes. So it does **no heavy work inline** — it
authenticates, records the notification (a durable "history advanced for mailbox X to
`historyId` Y" marker), acks Pub/Sub with a fast 2xx, and lets the reconciliation step (§3)
do the fetching. Returning 2xx quickly also prevents Pub/Sub's own redelivery from
amplifying load; a non-2xx tells Pub/Sub to redeliver, which idempotency (§4,
inbound-ingestion.md §4) makes safe but which we don't want to invite needlessly.

## 3. History reconciliation and raw fetch (HT-41)

From a recorded notification (a `mailboxId` and a new `historyId` watermark):

- `users.history.list?startHistoryId=<stored cursor>` — enumerate `messagesAdded` since
  **our stored cursor**, not merely since the notification's `historyId`. Page through all
  results.
- For each new message id: `users.messages.get?format=raw` → the raw RFC822 bytes. `raw` is
  mandatory; a parsed/`full` fetch would reintroduce the second-parser problem
  (inbound-ingestion.md §1). Attachments present in the raw MIME are written to the
  `BlobStore` under a **mailbox-namespaced** key before hand-off (blob.ts).
- Hand each message to the ingest pipeline as `{ raw, mailboxId, providerMessageId =
  <Gmail message id>, receivedAt }` (inbound-ingestion.md §2–3). The transport never parses.

## 4. The cursor: monotonic, transactional with persistence

Each mailbox stores a `historyId` cursor (HT-36). Its one rule: **it advances only after
the ingest pipeline confirms every message in the batch is `stored` or `suppressed`**
(inbound-ingestion.md §4). A crash mid-batch leaves the cursor where it was; the next
notification (or the watch-renewal re-baseline) re-lists from there, re-fetches, and the
pipeline dedups on `(mailboxId, providerMessageId)`. Advancing the cursor *before*
persistence would silently drop any message that failed to store — the one outcome
invariant #1 forbids — so we always bias to re-fetch, never to skip.

## 5. Expired history cursor — the dangerous case, and a dogfood decision

`users.history.list` returns **404** when `startHistoryId` is older than Gmail's retention
window (documented as "typically at least a week," but "in rare cases only a few hours").
Once that happens there is no incremental path forward: the only API-level recovery is a
full re-list of the mailbox.

**Decision (dogfood):** on a 404-expired cursor, **pause the mailbox and flag it for manual
rebaseline** — do **not** trigger an automatic full-mailbox resync. Rationale: an unbounded
resync would re-enumerate the entire mailbox, leaning on dedup to absorb mass duplicates and
doing work bounded only by mailbox size — exactly the kind of surprising, hard-to-bound
behavior the charter's serverless posture avoids, and a real risk to the sacred no-drop /
no-storm guarantees if dedup or blob writes hiccup at scale. For RIQ-watching-itself, a
paused mailbox is a visible, operator-resolvable state (re-baseline deliberately), not a
silent failure.

> **OPEN QUESTION (deferred with the forwarding/GA work).** The external default likely
> needs an *automatic bounded* rebaseline — e.g. re-arm `watch()` for a fresh cursor and
> ingest only messages received after the pause timestamp, accepting a bounded gap rather
> than a full resync. Specced when GA onboarding is, not now.

## 6. `watch()` lifecycle and renewal (HT-42)

- `watch()` is called when a mailbox is connected (OAuth, HT-40) and returns the initial
  `historyId` (the cursor's starting point) and an expiration (~7 days out).
- **`watch()` expires and MUST be re-armed at least every 7 days, or notifications silently
  stop** — no error on either side, mail just keeps arriving with nothing telling us. A
  daily `SchedulerProvider` cron (`registerCron`, `src/providers/scheduler.ts`) re-arms
  `watch()` for every active mailbox. Daily (not every-6-days) buys a safety margin against
  a missed run; `watch()` is idempotent, so re-arming early is free. This is the charter's
  sanctioned low-frequency **cron trigger** (§4), not a polling loop — it fires once a day
  regardless of mail volume and fetches nothing itself.
- On `watch()` failure (revoked/expired grant, admin change): mark the mailbox
  **needs-reconnect** and surface it — never crash the cron for other mailboxes (OAuth
  handling, HT-38/HT-40).

## 7. What this transport does not own

- **Parsing, threading, storage, idempotency, loop-suppression, observability** →
  inbound-ingestion.md. This transport hands over raw bytes and provider metadata and stops.
- **OAuth token acquisition/refresh** → HT-38; the **connect/consent flow** → HT-40.
- **One-time GCP/Pub-Sub provisioning** (Internal OAuth app; enable the Gmail + Pub/Sub APIs;
  create the topic; grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher
  role; create the push subscription → our endpoint) is an **operator runbook** (HT-43), not
  engine code — the engine assumes the topic/subscription exist and its credentials can call
  `watch()`/`history.list`/`messages.get`.

## 8. Acceptance

Against a **faked** Gmail API + Pub/Sub push (no cloud):

- A push with a valid OIDC JWT → `history.list` → `messages.get?format=raw` → the raw bytes
  reach the ingest pipeline with correct `{ mailboxId, providerMessageId, receivedAt }`.
- A forged / wrong-`aud` / wrong-service-account / expired JWT, or a notification not bound
  to our subscription → rejected, uniform response, no fetch triggered.
- A duplicate push (same `historyId`) → no duplicate ingestion (dedup, inbound-ingestion.md §4).
- A mid-batch failure → the cursor does not advance past the unstored message.
- A 404 on `history.list` → the mailbox is paused and flagged, no resync attempted.

The **live** end-to-end proof against real Gmail — send via the Gmail API, assert the
delivered message carries our verbatim token-bearing `Message-ID`, reply from a real Gmail
account, assert the reply threads into the same conversation — is the sacred check owned by
**HT-44**, not this fake-backed suite.
