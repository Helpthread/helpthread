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
resolve which mailbox it is for, then **reconcile** from our own stored cursor via
`users.history.list` to discover exactly which messages changed, and fetch each as raw MIME.
The notification is a *hint that something changed*; the stored cursor is the source of
truth. That is precisely the charter's "bounded reconciliation fetch."

Push is **best-effort, not guaranteed** — Gmail rate-limits notifications to ~1/second per
watched mailbox and may drop or delay them under load. Correctness therefore never rests on
push alone: a scheduled bounded reconciliation (§6) is the safety net Google's own guidance
requires, and the idempotent ingest pipeline (inbound-ingestion.md §4) makes the overlap
between push and sweep free of duplicates.

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
  `email` is the specific push service account we configured for the subscription;
  **`email_verified` is `true`** (Google's push-auth guidance is explicit that the signed
  `email` claim is only trustworthy when `email_verified` is set — a valid signature and
  audience do not by themselves bind the identity); `exp` not passed.
- **Bind to our subscription** — compare the push envelope's top-level `subscription` field
  (`projects/{project}/subscriptions/{name}`, present on every Pub/Sub push body) against
  the exact subscription we provisioned, and reject anything else. A valid Google JWT is
  necessary but not sufficient; the delivery must also be *our* subscription, not merely
  some authenticated Pub/Sub push.
- **Envelope limits** — `POST` + `application/json` only; a body-size cap; a uniform
  response that does not leak *which* check failed; replay tolerance (a re-POST is safe
  because ingestion is idempotent — inbound-ingestion.md §4 — but abusive repeats are
  rate-capped).

This surface is materially costlier than the pixel: a single accepted POST can trigger
Gmail API fetches, blob writes, and DB writes. So it does **no heavy work inline** — it
authenticates, records the notification, acks Pub/Sub with a fast 2xx, and lets the
reconciliation step (§3) do the fetching.

**Recording the notification is a durable enqueue, not an in-process continuation.** The
endpoint **enqueues a "reconcile mailbox X" job onto the `QueueProvider`**
(`src/providers/queue.ts`; Vercel Queues per charter §4), then acks. A `QueueProvider`
consumer runs §3. This is deliberate, and it is the near-real-time path — the §6 daily sweep
is the 24h-bounded *fallback*, not the primary trigger — so the hand-off must not rely on a
`waitUntil`/after-response continuation, which a serverless runtime does not guarantee to
execute: a dropped continuation would silently degrade push to "eventually caught by the
sweep" with no signal, whereas a durable queue job cannot vanish that way. It also keeps the
"no heavy work inline" property intact — the endpoint only enqueues and acks; the consumer
does the fetching.

Returning 2xx quickly also prevents Pub/Sub's own redelivery from amplifying load; a non-2xx
tells Pub/Sub to redeliver, which idempotency (§4, inbound-ingestion.md §4) makes safe but
which we don't want to invite needlessly.

## 3. History reconciliation and raw fetch (HT-41)

**Resolve the mailbox first.** The notification carries `emailAddress`, **not** a
`mailboxId`. Before recording any cursor or calling `history.list`, resolve `emailAddress`
to a known, active connected mailbox and **reject the notification if it does not map to
one** — this stops a misrouted, stale, or spoofed push from advancing or querying the wrong
mailbox. Everything downstream keys off the resolved `mailboxId`, never the raw
`emailAddress`. (The JWT's `email` claim in §2 is the *push service account*; the payload's
`emailAddress` is the *watched mailbox* — two different identities, both checked.)

Then, from the resolved mailbox and its stored cursor:

- `users.history.list?startHistoryId=<stored cursor>` — enumerate `messagesAdded` since
  **our stored cursor**, not the notification's `historyId` (which is the *new* watermark:
  starting from it returns nothing, because there are no changes newer than the current
  state — the stored cursor is the source of truth). Page through all results.
- For each new message id: `users.messages.get?format=raw` → the raw RFC822 bytes. `raw` is
  mandatory; a parsed/`full` fetch would reintroduce the second-parser problem
  (inbound-ingestion.md §1).
- Hand each message to the ingest pipeline as `{ raw, mailboxId, providerMessageId =
  <Gmail message id>, receivedAt }` (inbound-ingestion.md §2–3). **The transport never
  parses — and therefore never extracts attachments.** Parsing the MIME and writing
  attachments to the `BlobStore` is the pipeline's job (inbound-ingestion.md §2–3),
  downstream of the single `parseInboundEmail` call; the transport only moves raw bytes.

## 4. The cursor: monotonic, transactional with persistence

Each mailbox stores a `historyId` cursor (HT-36). Its one rule: **it advances only after
the ingest pipeline confirms every message in the batch is `stored` or `suppressed`**
(inbound-ingestion.md §4). A crash mid-batch leaves the cursor where it was; the next
notification (or the §6 reconciliation sweep) re-lists from there, re-fetches, and the
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
silent failure. (This is distinct from the §6 sweep, which reconciles from a *live* cursor;
here the cursor itself is unrecoverable.)

> **OPEN QUESTION (deferred with the forwarding/GA work).** The external default likely
> needs an *automatic bounded* rebaseline — e.g. re-arm `watch()` for a fresh cursor and
> ingest only messages received after the pause timestamp, accepting a bounded gap rather
> than a full resync. Specced when GA onboarding is, not now.

## 6. `watch()` renewal and periodic reconciliation (HT-42; reconciliation lease → HT-48)

- `watch()` is called when a mailbox is connected (OAuth, HT-40) and returns the initial
  `historyId` (the cursor's starting point) and an expiration (~7 days out).
- **`watch()` expires and MUST be re-armed at least every 7 days, or notifications silently
  stop** — no error on either side, mail just keeps arriving with nothing telling us. A
  daily `SchedulerProvider` cron (`registerCron`, `src/providers/scheduler.ts`) re-arms
  `watch()` for every active mailbox. Daily (not every-6-days) buys a safety margin against
  a missed run; `watch()` is idempotent, so re-arming early is free.
- **The same daily cron also runs a bounded reconciliation `history.list` from each active
  mailbox's stored cursor.** This is not optional polish: because push is best-effort (§1),
  a dropped or delayed notification — most damagingly the *last* one before a quiet spell —
  can otherwise leave a mailbox stale indefinitely, since nothing else triggers a fetch. The
  sweep is the charter's exact "bounded reconciliation fetch, never a long-running poller"
  (§4, phase-1): it reuses the §3–§4 fetch/cursor path, is bounded per run, and fires on the
  same once-daily tick — it is a scheduled catch-up, not a polling loop. It feeds the
  identical idempotent ingest pipeline, so any message already delivered by push is deduped,
  never doubled (inbound-ingestion.md §4). (Cadence is a tuning knob: daily bounds worst-case
  staleness to ~24h for a dropped tail notification; a tighter interval trades quota for
  freshness and can be revisited without changing the design.)
- **Reconciliation is serialized per mailbox by a reconciliation lease (HT-48,
  implemented).** Push-triggered reconciliation (§2–§3) and the daily sweep both advance
  the same mailbox's cursor, so a mailbox's reconciliation runs are serialized by a
  **reconciliation lease** — the inbound analogue of the outbound delivery lease
  (sending.md §3a) — held on `gmail_watch_state.claimed_until` (migration 016,
  `src/store/gmail-watch-state.ts`'s `claimReconcileLease`/`releaseReconcileLease`);
  different mailboxes still reconcile concurrently, since the lease is keyed by
  `mailboxId`. This is an efficiency guard, **not** a correctness one — §4 already makes
  each run's cursor advance independently safe, so a push landing mid-sweep is deduped,
  never doubled — it only avoids redundant `history.list`/`messages.get` work.

  The lease lives entirely in the reconcile job's **consumer** (`src/mail/gmail-
  reconcile.ts`), not in either producer (the push webhook or this sweep): a run claims
  the lease once it has a confirmed stored cursor and before calling `history.list`; a run
  that cannot claim it (another holder's lease is still live) SKIPS its own Gmail work and
  acks immediately — the holder in flight will advance the cursor. The lease is released in
  a `finally` around the `history.list`/fetch/ingest/cursor-advance block, so it is released
  on every exit — the happy-path ack, the expired-cursor pause, the blocked-retry, and an
  unexpected thrown error alike — *before* that error propagates to the handler's own
  top-level catch. This was a deliberate choice: because the lease is a pure efficiency
  guard, the one failure mode it must never produce is a mailbox permanently (or even
  needlessly long) locked out of reconciliation after a crash; releasing on every path,
  including a throw, means the next trigger can reconcile the mailbox immediately rather
  than waiting out the lease's duration. The lease's own expiry remains as a backstop for
  the one case a `finally` cannot reach — the process being killed outright before it runs.
- **Failure handling — the token layer owns `needs_reconnect`.** A dead grant
  (revoked/expired, admin change) surfaces as an `invalid_grant` when the OAuth token
  service refreshes, and *that* is what marks the mailbox **needs-reconnect** (HT-38,
  `getAccessToken`) — it catches every dead grant within the access token's cache lifetime
  (~1h), across both push-triggered reconcile and this cron. So the renewal cron does **not**
  itself mark `needs_reconnect` on a generic `watch()` failure: past a valid token, a
  `watch()` error is treated as **transient** (logged, counted, retried on the next daily
  tick — the ~7-day expiry leaves ample margin for a few missed runs), rather than halting a
  healthy mailbox on a transient Gmail blip. The cron is **failure-isolated per mailbox** —
  one mailbox's token or `watch()` failure never stops the others (HT-38/HT-40). (This
  refines the earlier "watch() failure → needs-reconnect" wording, which predates HT-38's
  token layer owning that transition; the dead-grant outcome is unchanged, only *where* it
  is decided.)

## 7. What this transport does not own

- **Parsing, threading, storage, idempotency, attachment extraction, loop-suppression,
  observability** → inbound-ingestion.md. This transport hands over raw bytes and provider
  metadata and stops.
- **OAuth token acquisition/refresh** → HT-38; the **connect/consent flow**
  (authorization-code grant, initial `watch()` arm, baseline cursor seed) →
  HT-40, [gmail-connect.md](./gmail-connect.md).
- **One-time GCP/Pub-Sub provisioning** (Internal OAuth app; enable the Gmail + Pub/Sub APIs;
  create the topic; grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher
  role; create the push subscription → our endpoint) is an **operator runbook** (HT-43), not
  engine code — the engine assumes the topic/subscription exist and its credentials can call
  `watch()`/`history.list`/`messages.get`.

## 8. Acceptance

Against a **faked** Gmail API + Pub/Sub push (no cloud):

- A push with a valid OIDC JWT (correct `aud`, service-account `email`, `email_verified`,
  and matching `subscription`) → mailbox resolved from `emailAddress` → a reconcile job
  enqueued → the consumer runs `history.list` → `messages.get?format=raw` → the raw bytes
  reach the ingest pipeline with correct `{ mailboxId, providerMessageId, receivedAt }`.
- A forged / wrong-`aud` / wrong-service-account / `email_verified:false` / expired JWT, or
  a notification whose `subscription` isn't ours, or whose `emailAddress` resolves to no
  known mailbox → rejected, uniform response, nothing enqueued, no fetch triggered.
- A duplicate push (same `historyId`) → no duplicate ingestion (dedup, inbound-ingestion.md §4).
- A mid-batch failure → the cursor does not advance past the unstored message.
- A 404 on `history.list` → the mailbox is paused and flagged, no resync attempted.
- The daily reconciliation sweep re-lists from the stored cursor and ingests a message a
  *dropped* push never delivered — with no duplication of messages push already delivered.

The **live** end-to-end proof against real Gmail — send via the Gmail API, assert the
delivered message carries our verbatim token-bearing `Message-ID`, reply from a real Gmail
account, assert the reply threads into the same conversation — is the sacred check owned by
**HT-44**, not this fake-backed suite.
