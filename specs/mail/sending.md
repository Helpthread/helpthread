# Outbound sending & the reply-token lifecycle

Status: accepted. Companion to [threading.md](./threading.md) — that spec decides which
conversation an *inbound* message joins; this one covers how an *outbound* reply is minted,
persisted, and sent, and is where the threading model's authority originates.

## 1. Why sending is the load-bearing step

Threading is *outbound-anchored* (threading.md §2): an inbound reply is threaded **only** on
a signed reply token the engine minted into one of its own outbound `Message-ID`s. Nothing
about inbound `In-Reply-To`/`References` is trusted on its own. Every outbound message is
therefore a promise: the token it carries is the sole future handle on this conversation. If
sending mints a token that doesn't match what's stored, or stores a token for a message that
never went out, the thread breaks — so sending is held to the same "correctness outranks
velocity" bar as the threading decision itself (the charter's "Conversation integrity" rule).

## 2. The id/token knot, and its resolution

The outbound `Message-ID` must embed a token over `{conversationId, threadId}` (threading.md
§2). But a thread's `threadId` is its storage primary key and the `Message-ID` is a column on
that same row, so the id must exist *before* the row is inserted. Letting the database
generate the id at insert time is circular.

**Resolution (option A):** the application generates the outbound thread's UUID
(`crypto.randomUUID` — a CSPRNG) *before* persistence, mints the token from it, and inserts
the row with `id` **and** `message_id` set together in one write.

- **`threadId` in the token identifies the outbound thread that carries it** — the specific
  outbound message. A later verified inbound reply therefore names the exact message it is
  answering (useful for lineage, audit, and future per-thread routing), even though
  `decideThreading` today routes on `conversationId` alone.
- **App-generated ids are safe in the HMAC.** The token's integrity is the signature, never
  the unguessability of the id (threading.md §2). A DB-generated id would be no safer.
- **UUIDs are token-safe.** `reply-token.ts`'s id charset is `[A-Za-z0-9_-]`, which admits
  UUID hex-and-hyphens; UUIDs contain no `.`/`@`, the token's structural delimiters.

## 3. Outbound threads are outbox items

An outbound thread carries an explicit **delivery status**: `pending`, `sent`, or `failed`.
(Inbound threads have no delivery status — the column is `NULL`.) This makes "persisted" and
"delivered" distinct facts, which keeps a mid-flight failure from lying.

**Ordering — persist, then send, then mark:**

1. Generate `threadId`; mint the token → `messageId`.
2. Persist the outbound thread with `delivery_status = 'pending'` and `message_id =
   messageId`.
3. Call the sender provider (§4).
4. On success → `delivery_status = 'sent'`; on failure → `'failed'`.

A crash at any point leaves a truthful record: a thread stuck at `pending` means "we may or
may not have delivered it," never a false `sent`. Send-*then*-persist is rejected — a crash
after a successful send would lose the outbound message from the conversation entirely.

**Retries reuse, never re-mint.** A `failed` (or orphaned `pending`) outbound thread is
re-attempted with the **same** `threadId` and the **same** `Message-ID`. Minting a fresh
token per attempt would spray multiple valid threading handles for one logical message and
risk double-sends. The stable `Message-ID` is the idempotency anchor: a provider that
de-dupes on `Message-ID` will not double-deliver a retried send.

## 3a. Send idempotency + delivery leasing

§3's rule says what a retry must DO; this section is how a retry gets recognized and kept
safe under concurrency.

**Caller-supplied idempotency key, scoped per conversation.** A caller needing at-most-once
delivery (`agent-inbox-v1.md` §4a) supplies an `idempotencyKey`.
`src/store/conversations.ts`'s `appendThread` resolves it as an atomic **get-or-insert**:
`INSERT ... ON CONFLICT (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL
DO NOTHING RETURNING *`, falling back to a `SELECT` of the pre-existing row on conflict —
inside the same transaction holding the conversation row's `FOR UPDATE` lock, so two callers
racing with the identical key on the identical conversation are serialized rather than
double-inserting. Omitting the key is still legal: a fresh send every call, no dedup — a
deliberate, permanently-tested contract for callers that don't need it.

**The envelope is a snapshot, never a recomputation.** Every outbound send (keyed or not)
persists a `send_envelope` — `{ to, cc?, subject, references? }` — verbatim at insert. A
retry, whether replayed by the original caller or picked up by the delivery worker, resends
EXACTLY that stored envelope and never re-derives `to`/`subject`/`references` from the
conversation's current thread list. Time passes between an attempt and its retry, and inbound
mail can arrive in that gap: recomputing `References` at retry time could silently absorb a
message that wasn't part of the original send (the charter's "Conversation integrity" rule).
The snapshot makes a retry byte-identical to the attempt it retries, by construction.

**A lease keeps at most one attempt in flight per row.** Before either a keyed retry or the
delivery worker sends a `pending`/`failed` row, it must claim the row's delivery lease
(`claimThreadForDelivery`: an atomic `UPDATE ... WHERE claimed_until IS NULL OR claimed_until
< now`). A failed claim means someone else holds it; the caller does not send and reports
back rather than retrying the claim. A successful attempt releases the lease as it marks
`sent`/`failed`.

This holds **only if the lease strictly outlives the send it protects.** `DEFAULT_LEASE_MS`
(`src/mail/send.ts`) MUST strictly exceed the worst-case duration of the configured
`EmailSender`'s `send` call; a send that outlives its own lease can be re-claimed and retried
while the original call is still in flight — a genuine concurrent double-send. Enforced
mechanically, not by convention: the `EmailSender` contract requires each implementation to
declare the bound it itself enforces (`maxSendMs`, `src/providers/email-sender.ts`), and both
retry paths assert `maxSendMs < leaseMs` before claiming a row
(`assertLeaseExceedsSenderBound`, `src/mail/send.ts`) — a violating combination throws up
front, claiming and sending nothing.

**Delivery is at-least-once, not at-most-once.** The idempotency key, envelope snapshot, and
lease close off *spurious* re-sends, but none of them lets the engine observe what the
provider did with a send it already accepted. The residual case: the provider accepts the
message — the customer's mailbox already has it — and then the write marking the row `'sent'`
fails, leaving it `pending` with a live, already-delivered envelope. Once that row goes stale
and its lease frees, the delivery worker's sweep or a keyed replay will find it eligible and
re-send an already-delivered message. The engine cannot distinguish "crashed before the
provider was ever called" from "the provider succeeded but the mark-sent write failed" — both
leave an identical stale `pending` row, and both are correctly retried. **At-most-once is not
something the engine can produce on its own; it holds only to the extent the `EmailSender`
de-duplicates on the outbound `Message-ID`** (§4).

**The delivery worker (`src/mail/delivery-worker.ts`) is a plain, invocable sweep function** —
`runDeliveryWorker(deps, options?)` — not built on a queue or scheduler provider (no such
adapter exists yet; §5). One call selects a bounded batch of eligible rows (`delivery_status
= 'failed'`, or `'pending'` older than a staleness threshold, with a free lease and a stored
envelope — rows predating the envelope snapshot are left for manual handling rather than
guessed at), claims each in turn, and retries via the same "rebuild `OutboundEmail` from the
row, send, mark" helper a keyed `sendReply` retry uses. Wiring a real schedule around it is
deferred; at that point it is a one-line call, not a rewrite.

## 4. What a sender provider must guarantee

The `EmailSender` provider (`src/providers/`) is handed a fully-formed outbound message and
MUST transmit the engine-supplied `Message-ID` **verbatim** as the RFC 5322 `Message-ID`
header — never generating or overwriting its own. A provider that cannot set `Message-ID` is
unusable for Helpthread. `In-Reply-To` and `References` are likewise engine-set and must be
transmitted as given.

The interface can state this contract but cannot enforce it. Therefore **every real
`EmailSender` adapter MUST ship with a wire-level contract test** asserting the exact
`Message-ID`/`In-Reply-To`/`References` it emits, against the raw MIME or provider-API
payload it produces. An adapter whose SDK silently rewrites `Message-ID` would pass
`sendReply` — the thread is marked `sent` — while every future reply fails to thread. Prefer
provider APIs that accept raw MIME; reject any that will not carry `Message-ID` unaltered.
The in-repo fake proves only that `sendReply` *passes* the value to the seam, not that an
adapter preserves it on the wire.

**A compliant adapter is not sufficient — the provider's OWN infrastructure can still rewrite
`Message-ID` after transmission (live production evidence, 2026-07-17).** Gmail's
`users.messages.send` accepted the adapter's verbatim `Message-ID` on the request and
substituted its own generated id on the wire — downstream of transmission, outside the
adapter's control, and not a contract violation (the adapter's wire-level test still passes;
it proves what it sends, not what Gmail's server does afterward). See threading.md §2a for
the fix: `sendReply` now ALSO places its own minted `messageId` as the final entry of that
reply's `References` header — a channel Gmail does not rewrite.

**The adapter contract for `References`**: every atom transmitted is transmitted verbatim and
in its given order — never rewritten, reordered, or substituted. Unlike `Message-ID`, the
ancestor portion carries attacker-influenced inbound msg-ids, so an adapter MAY sanitize by
DROPPING an individual unsafe atom (header-injection / oversize defense — the Gmail adapter's
`isSafeMsgId` filter, `src/providers/adapters/gmail/mime.ts`, does exactly this rather than
letting one crafted stored ancestor id block every future reply). The engine-minted final
entry passes any such filter by construction (`reply-token.ts`'s bounded `[A-Za-z0-9_-]` /
`.` / `@` charset has no control characters and stays far under the octet bound) and MUST
reach the wire intact — an adapter that drops or alters IT is as unusable as one that
rewrites `Message-ID`.

**A self-reflecting transport requires ALSO suppressing the sent message's own echo.**
Placing the reply token in `References` unconditionally has a consequence: Gmail (confirmed
live) delivers the SENT message back into the mailbox it was sent from, and that self-echo
now carries a verifiable token — one `inbound-ingestion.md` §5's `Message-ID`-only loop guard
cannot recognize, since Gmail rewrites the echo's `Message-ID` too. Left alone, the echo
would `append` into its own conversation as a phantom inbound message. `sendReply` closes
this immediately after a successful send: if `EmailSender.send` returned an
`EmailSendResult.providerMessageId` — the SAME id the transport later reports during
reconcile — it resolves `SendReplyInput.from` to its `MailboxRecord` and pre-seeds
`(mailboxId, providerMessageId)` as an already-`suppressed` row in the inbound delivery
ledger (`InboundDeliveryStore.preSuppressOwnSend`; `inbound-ingestion.md` §5 has the
mechanism and its one known residual race). OPTIONAL (`SendReplyDeps.selfEchoGuard`) and a
no-op wherever absent or wherever the sender reports no `providerMessageId`.

**Recommended: a provider SHOULD de-duplicate on `Message-ID`.** Not a precondition —
at-least-once delivery (§3a) holds either way — but it is the one thing standing between
structural at-least-once and true at-most-once from the operator's point of view. Where a
provider does not de-duplicate, the operator is knowingly accepting at-least-once: the
residual "accepted, then unmarked, then re-sent" case will occasionally reach the customer's
mailbox twice, identical down to the `Message-ID`, and nothing in the engine can prevent it.
An adapter's wire-level contract test should note whether the provider is known to de-dupe,
so this is a documented property of a deployment rather than a production surprise.

**A lease that outlives the provider's `send` call is a precondition too.** §3a's lease only
holds if `send` reliably returns well inside the lease window — an adapter whose HTTP call
has no timeout, or one comparable to the lease, can outlive its own claim and collide with a
re-claimed retry. Every `EmailSender` declares `maxSendMs` — the bound it really enforces (a
mechanical timeout on its own call, e.g. the Gmail adapter's `timeoutMs` feeding
`AbortSignal.timeout`), not an estimate — and the retry paths refuse to claim under a lease
that does not strictly exceed it.

## 5. Scope

Deliberately narrow; each deferral has a named later home:

- **Synchronous send only** — persist→send→mark runs inline within one `sendReply` call.
  Retrying a stuck row is covered (§3a); what's deferred is wiring a real *schedule* around
  that sweep (Vercel Cron, or a future `SchedulerProvider` adapter). Today it is only invoked
  directly, never on a timer.
- **Reply to an existing conversation only.** Agent-*initiated* new conversations are a
  separate later flow.
- **`In-Reply-To`/`References` are caller-supplied ANCESTOR ids** (from the inbound message
  being answered; `agent-inbox-v1.md` §4a's `deriveReplyHeaders` derives them from stored
  threads). `sendReply` then APPENDS its own freshly-minted `messageId` as the final
  `References` entry unconditionally (threading.md §2a) — the caller-supplied field is never
  the reply's own id. Once persisted into `send_envelope` that full chain, own id included,
  is authoritative for every retry.
- **A missing or deleted conversation is refused** — the token is minted first (before
  `appendThread` resolves) and then discarded; only persistence and sending are skipped, and
  the sender is never called (mirrors `appendThread`'s policy; threading.md §5).
- **No cross-conversation or cross-Agent idempotency-key reuse policy.** A key is scoped to
  one conversation; reusing the same string across different conversations creates
  independent rows, by design — there is no global key registry.
