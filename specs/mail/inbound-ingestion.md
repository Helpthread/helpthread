# Inbound ingestion pipeline

Status: draft (HT-34). Companion to [threading.md](./threading.md) (which conversation
an inbound message joins) and [sending.md](./sending.md) (how an outbound reply is
minted and delivered). This spec is the orchestration those two repeatedly defer to
as "the mail-ingestion pipeline, not yet built" (threading.md §5; store/conversations.md) —
the **provider-agnostic** path that turns one received message into a stored
conversation/thread. It is transport-agnostic by construction: the Gmail-push transport
([gmail-push.md](./gmail-push.md)) feeds it today, and the future forwarding-address
transport will feed the *same* pipeline unchanged.

## 1. Three invariants

Everything below serves three rules, in priority order:

1. **Parse exactly once, by our own code.** Inbound MIME is parsed by `parseInboundEmail`
   (`src/mail/parse.ts`, postal-mime) and nothing else. No transport, provider, or SDK
   parses the message into a shape the engine then threads on. This is charter §2's
   "boringly faithful on mail semantics" applied to the front door: a second, provider-
   specific parser in the ingest path is exactly the kind of divergence the charter's
   origin story warns against, and it would make threading depend on how faithfully a
   provider preserved headers we didn't control.
2. **Thread only on our token.** Which conversation a message joins is decided solely by
   `decideThreading` (threading.md) — never re-derived here, never influenced by the
   transport.
3. **At-least-once, idempotent, never dropped.** A received message is either stored,
   deliberately suppressed (§5), or parked in the dead-letter ledger for manual review
   (§4) — never silently lost (invariant #1). A re-delivery of a message we already
   processed is a no-op, never a duplicate conversation.

## 2. The provider boundary: raw bytes in, nothing pre-parsed

An inbound transport implements `InboundEmailProvider` (`src/providers/inbound-email.ts`).
Its job is narrow: **authenticate a delivery, and produce, per message, the raw RFC822
bytes (or a blob reference to them) plus provider metadata** — it does not parse the
message, and it does not extract attachments (both require parsing the MIME, which is the
pipeline's single `parseInboundEmail` call, §3).

Provider metadata is the minimum the pipeline needs and the transport authoritatively
knows:

- `mailboxId` — which connected mailbox this arrived at (the namespace anchor for
  storage, blobs, dedup, and — later — tenancy; HT-36). The transport resolves this to a
  known mailbox and rejects a delivery it cannot (gmail-push.md §3); the pipeline receives
  an already-resolved `mailboxId`, never a raw provider address.
- `providerMessageId` — the transport's own stable id for the message (for Gmail, the
  Gmail message id). This is the idempotency authority (§4), *not* the RFC `Message-ID`.
- `receivedAt` — when the transport recorded delivery (not a header-parsed `Date`).

> **Correction (HT-35).** The interface as first drafted returns a `NormalizedInboundEmail`
> — headers and body already parsed, attachments already blob-referenced. That is wrong
> under invariant #1: it puts the parse *inside the provider*, before the engine, in a
> provider-specific place, and hands attachment ownership to the transport. HT-35 changes
> the seam to yield raw bytes + metadata; this spec describes the corrected contract, and
> every transport is written against it.

## 3. The ingest procedure

Ordered, applied to each received message. Idempotent by step 1, so a whole re-run is safe.

1. **Claim, atomically.** Insert a delivery-ledger row keyed by the unique
   `(mailboxId, providerMessageId)` — `INSERT … ON CONFLICT (mailbox_id,
   provider_message_id) DO NOTHING RETURNING *`, the same atomic get-or-insert
   `appendThread` uses for outbound idempotency (sending.md §3a). A fresh insert means we
   own processing; a **conflict** means a concurrent or prior delivery already owns it, so
   we **stop and return that row's outcome** — a terminal `stored`/`suppressed` row is a
   completed replay, an in-flight `received` row **whose lease has not lapsed** is another
   worker's claim (do not double-process; §4's lease). A non-atomic read-then-insert would
   let two concurrent deliveries of the same key both pass a dedup check and both create a
   conversation; the unique-key claim is what closes that race.
2. **Parse.** `parseInboundEmail(raw) → ParsedEmail` (invariant #1). A message that cannot
   be parsed at all is a ledger `failed`/dead-letter case (§4), never a guess.
3. **Loop/auto-responder gate (§5).** A suppressed message is recorded `suppressed` and
   **creates and appends nothing** — but is not dropped (it stays visible in the ledger).
4. **Decide.** `decideThreading(parsed, keyring) → { kind: 'new' } | { kind: 'append',
   conversationId, threadId }` (threading.md §3). Never re-implemented here.
5. **Store and commit the outcome, atomically (§4).**
   - `new` → `createConversation` (its first thread is this inbound message).
   - `append` → `appendThread(conversationId, …)`. The store may answer `{ ok: false,
     reason: 'deleted' | 'not-found' }` (threading.md §5): on **`deleted`**, fall back to
     `createConversation` (a fresh conversation — the token pointed at a conversation an
     operator intentionally removed, so we neither resurrect it nor drop the mail); on
     **`not-found`**, likewise fall back to a fresh conversation (the token verified but no
     such row exists — pathological, but the mail is still ingested, never lost).
   - The store write **and** the ledger row's `received → stored` transition (recording the
     resulting `threadId`) commit in **one transaction** — see §4.

**Attachments belong to the pipeline, not the transport** (§2). After the parse (step 2),
attachment bytes are written to the `BlobStore` under a **mailbox-namespaced** key
(`src/providers/blob.ts` makes namespacing the caller's responsibility) as part of the
step-5 store, and the stored thread carries blob references, never inline bytes.

## 4. Idempotency, the delivery ledger, and retries

**The idempotency key is `(mailboxId, providerMessageId)` — deliberately not the RFC
`Message-ID`.** The inbound `Message-ID` is optional (`NewThread.messageId` permits
`null`, `src/store/conversations.ts`) and entirely sender-controlled, so it cannot be
the authority that decides "have we already ingested this." The transport's own message
id is stable and provider-issued. The RFC `Message-ID` is retained on the stored thread
as data and as a *secondary* duplicate signal, never as the dedup key.

**The delivery ledger** (a table, HT-36) is one row per `(mailboxId, providerMessageId)`
with a **unique constraint** on that pair, carrying `status` (`received` | `stored` |
`suppressed` | `failed` | `dead-letter`), `attempts`, `last_error`, and the resulting
`threadId` (the produced/appended thread; its conversation follows from
`threads.conversationId` and is not stored as a redundant second column). It is
simultaneously the **idempotency record** (§3 step 1),
the **claim/lease**, and the **retry queue**.

**The claim, the store write, and the outcome are one atomic unit.** The step-5 store write
(`createConversation`/`appendThread`) and the ledger's `received → stored` transition —
recording the resulting `threadId` — commit in a **single transaction**, so the ledger row *is*
the idempotency record: a retry re-hits the §3-step-1 claim, finds a `stored` row, and
returns its recorded outcome (its `threadId`) without re-writing. A crash *before* that commit
leaves the row at `received` and no conversation, and the retry redoes the whole unit
cleanly. This is what closes the "successful conversation write, then failed ledger update,
then duplicate conversation on retry" window — the write and its record are never
separately durable. It is the inbound mirror of the outbound get-or-insert in sending.md
§3a, keyed on `(mailboxId, providerMessageId)` rather than `(conversationId,
idempotencyKey)`.

**The claim carries a lease, so a crash mid-unit is reclaimed, not stranded (HT-45).** The
previous paragraph's "the retry redoes the whole unit cleanly" only holds if a retry's
§3-step-1 claim is actually willing to re-claim a `received` row that never made it to the
step-5 commit — a hard process crash (SIGKILL / OOM / redeploy) between the claim committing
`received` and that commit (or the catch-block's `markFailed`) otherwise strands the row at
`received` forever: nothing ever transitions it to `failed`, so an ordinary re-delivery finds
a `received` row and — correctly, per this section's own "in-flight, do not double-process"
rule — refuses to touch it, on every subsequent redelivery, permanently. The delivery ledger's
`claimed_until` column is what breaks that permanence: every successful claim (fresh insert,
or a `failed`/`received` reclaim) stamps a lease `leaseMs` into the future, and a `received`
row becomes reclaimable — by the ordinary §3-step-1 claim path, no separate sweep — once
`claimed_until IS NULL OR claimed_until < now()`. A single row-locked `UPDATE` performs the
reclaim, so two concurrent reclaim attempts on the same lapsed lease can never both win — the
same atomicity this ledger already relies on for the `failed`-row reclaim and that
`ConversationStore.claimThreadForDelivery` (sending.md) relies on for the outbound lease. The
retry that actually performs the reclaim is whatever next calls into ingest for this key: a
redelivered provider notification, or — since a stuck `received` row also blocks this
mailbox's transport cursor from advancing (gmail-push.md §4) — the transport's own history
replay re-fetching and re-ingesting the same still-un-advanced message, which recurs on every
subsequent reconcile run for as long as the cursor cannot pass it, bounded above by that
transport's own periodic maintenance sweep (gmail-push.md §6) even with no new mail at all.

**At-least-once, with honest partial-failure handling.** Ingest can still fail partway —
an unparseable message, a blob write that succeeds then a transaction that aborts, an
`append→deleted` whose fallback-create then fails. The pipeline mirrors the outbound
delivery worker's discipline (sending.md §3a): the per-message ingest is retryable as a
unit, a re-delivery of the same key is a no-op once `stored`, and a message that exhausts
its retry budget lands in **`dead-letter`** for manual review — visible and recoverable,
never silently dropped (invariant #1). As with sending (sending.md §3a), we cannot make
ingestion *at-most-once*; we make it at-least-once and idempotent, which for a support desk
is the safe asymmetry (a rare reprocessed message is deduped away; a dropped customer email
is unacceptable).

**Cursor advancement is transactional with persistence.** Where a transport keeps a
position cursor (Gmail's `historyId`, gmail-push.md §4), that cursor advances **only**
for messages this pipeline has confirmed `stored` or `suppressed`. The pipeline states
this as a contract the transport must honor: bias to re-fetch (dedup makes it free),
never to skip.

## 5. Loops, auto-responders, and one deliberate divergence

threading.md §5 left "Auto-Submitted mail creates conversations" cross-referenced to "a
future auto-responder spec." This is the ingest-gate half of that home.

**Loop suppression — new, and bounded by invariant #1.** Before threading, drop a message
only when it is *verifiably* one of our own outbound messages reflected back — established
by a **verifiable correlation**: our exact outbound `Message-ID` (which we minted and can
recognise) appearing as this message's `Message-ID`, or a valid, signature-verified **own
reply token** in a position indicating our mail was bounced or auto-answered. Our sending
identity in `From`/`Return-Path` is **only a supporting signal, never sufficient on its
own** — those headers are sender-controlled, so suppressing on identity alone could
silently drop a legitimate customer message (someone mailing *from* an address that
resembles ours, or a forwarded copy), which violates the never-dropped invariant (§1).
This rule is additive (no fixture speaks to it), but it lives strictly inside invariant #1:
when the correlation isn't verifiable, ingest. A per-sender/window **rate cap** is a
backstop against floods and reflection storms; a rate-capped message is deferred or flagged
for review, not dropped.

**Generic third-party auto-submitted / bulk mail — preserve the observed behavior.**
Here the sacred rule bites (charter §2: mail-behavior changes need fixture-proven
equivalence *or* explicit written justification). `fixtures/mail/observed/auto-submitted.json`
shows the reference helpdesk **ingesting** an `Auto-Submitted: auto-replied` message
normally — it created a conversation, it was **not** suppressed (threading.md §5). So the
**default is to ingest it**, matching the fixture: an out-of-office reply from a customer is
a real thing an Agent may want to see. What Helpthread must never do is *auto-respond* to
such mail (RFC 3834) — but Helpthread has no auto-responder today, so there is nothing to
loop yet; the suppression that matters now is the verifiable own-message loop rule above.

> **OPEN QUESTION (not blocking v1).** Should the pipeline *additionally* suppress
> third-party `Auto-Submitted != no` / `Precedence: bulk|list|junk` / mailing-list
> (`List-*`, RFC 2369/2919) mail from creating conversations? Doing so would **diverge
> from `auto-submitted.json`** and therefore needs its own written justification and,
> ideally, an acceptance fixture before it becomes load-bearing — it is not adopted here
> by default precisely because a fixture currently says the opposite. The likely resolution
> is a config-gated filter (route/label rather than hard-drop), decided alongside the
> auto-responder spec. Recorded here so the decision is explicit rather than smuggled in.

A suppressed message is recorded in the ledger (`suppressed`, with the reason) — visible,
auditable, never a silent drop.

## 6. Observability and the forged-token signal

Each ingest emits a structured record: `mailboxId`, `providerMessageId`, the transport
cursor position, the threading decision (`new`/`append` + target ids), `forgedTokenCount`,
suppression reason (if any), parse size, attachment count, and final ledger outcome.

`decideThreading` already emits `forgedTokenCount` (threading.md §3 rule 3, §5) but nothing
consumes it today. **This pipeline is where it is consumed:** a single forged token is
unremarkable; a burst against one conversation or sender is a security signal that must be
surfaced/alertable (the precise threshold remains threading.md §5's open question — this
spec provides the consumption point, not the threshold).

## 7. Scope and deferrals

- **Transport-specific concerns** — webhook authentication, Pub/Sub, history reconciliation,
  `watch()` — live in the transport spec ([gmail-push.md](./gmail-push.md)), not here.
- **The forwarding-address transport** is deferred (the external/GA default); it will
  implement the same §2 provider boundary and feed this pipeline **unchanged** — which is
  the point of keeping the pipeline provider-agnostic (charter §4's owned interfaces).
- **HTML sanitization on render** is not this spec's concern; storage keeps bodies verbatim
  (threading.md §5's `html-body.json` flag), and a sanitization spec owns the render-time
  guarantee. Inbound HTML is already sanitized at *render* in the web client
  (`SanitizedHtml`); the engine stores raw.
- **Multi-tenant enforcement** is out of scope; the schema carries `mailboxId` from day one
  (HT-36) so nothing bakes in a global singleton, but behavior is single-tenant for the
  dogfood.

## 8. Acceptance

Exercised end-to-end against the in-memory `InboundEmailProvider` fake (HT-35) and the
engine's existing store/keyring fakes — no cloud required:

- A fresh message (no valid token) → a new conversation.
- A valid-token reply → appends to that conversation (drives `decideThreading`; the
  threading.md §6 observed-fixture outcomes must still hold when reached *through* this
  pipeline, not just in `decideThreading`'s own unit tests).
- A re-delivery of the same `(mailboxId, providerMessageId)` → a no-op (one conversation,
  one thread; ledger shows a single `stored` row).
- Two concurrent deliveries of the same key → exactly one conversation (the §3-step-1
  atomic claim; the second returns the first's outcome).
- A simulated partial failure (transaction aborts after a blob write) → ledger `failed`,
  retried to `stored`, no orphaned/duplicate conversation.
- A verifiable own-message loop → `suppressed`, nothing created; a message that merely
  *claims* our `From` without a verifiable correlation → **ingested**, not dropped.
- `append→deleted` → falls back to a fresh conversation, mail never lost.
- A simulated crash (a delivery claimed, then never marked `stored`/`failed`) → while its
  lease still holds, re-delivery reports `in-progress` and touches nothing (indistinguishable
  from a genuinely concurrent in-flight claim); once the lease has lapsed, re-delivery
  reclaims and fully reprocesses it — exactly one conversation, ledger ends `stored` (§4's
  lease). Two concurrent re-deliveries of the same lapsed row → exactly one reclaim wins,
  same as the fresh-key concurrent-claim case above.
