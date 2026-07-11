# Outbound sending & the reply-token lifecycle

Status: accepted (HT-15, HT-16). Companion to [threading.md](./threading.md) — that
spec decides which conversation an *inbound* message joins; this one covers how an
*outbound* reply is minted, persisted, and sent, and is where the threading
model's authority actually originates.

## 1. Why sending is the load-bearing step

Threading is *outbound-anchored* (threading.md §2): an inbound reply is threaded
**only** on a signed reply token the engine minted into one of its own outbound
`Message-ID`s. Nothing about inbound `In-Reply-To`/`References` is trusted on its
own. That means every outbound message is a promise: the token it carries is the
sole future handle on this conversation. If sending mints a token that doesn't
match what's stored, or stores a token for a message that never went out, the
thread breaks. So sending is held to the same "correctness outranks velocity"
bar as the threading decision itself (CHARTER.md invariant #3).

## 2. The id/token knot, and its resolution

The outbound `Message-ID` must embed a token over `{conversationId, threadId}`
(threading.md §2). But a thread's `threadId` is its storage primary key, and the
`Message-ID` is a column stored on that same row — so the id must exist *before*
the row is inserted. The database generating the id at insert time is circular.

**Resolution (option A):** the application generates the outbound thread's UUID
(`crypto.randomUUID()` — a CSPRNG) *before* persistence, mints the token from it,
and inserts the row with `id` **and** `message_id` set together in one write.

- **`threadId` in the token identifies the outbound thread that carries it** —
  the specific outbound message. A later verified inbound reply therefore names
  the exact message it is answering (useful for lineage, audit, and future
  per-thread routing), even though `decideThreading` today routes on
  `conversationId` alone.
- **App-generated ids are safe in the HMAC.** The token's integrity is the
  signature, never the unguessability of the id (threading.md §2). A v4 UUID is
  a perfectly good identifier here; a DB-generated one would be no safer.
- **UUIDs are token-safe.** `reply-token.ts`'s id charset is `[A-Za-z0-9_-]`,
  which admits UUID hex-and-hyphens; UUIDs contain no `.`/`@`, the token's
  structural delimiters. So a real store UUID mints and verifies unchanged.

## 3. Outbound threads are outbox items

An outbound thread carries an explicit **delivery status**: `pending`, `sent`,
or `failed`. (Inbound threads have no delivery status — the column is `NULL`
for them.) This makes "persisted" and "delivered" distinct facts, which is what
keeps a mid-flight failure from lying.

**Ordering — persist, then send, then mark:**

1. Generate `threadId`; mint the token → `messageId`.
2. Persist the outbound thread with `delivery_status = 'pending'` and
   `message_id = messageId`.
3. Call the sender provider (§4).
4. On success → `delivery_status = 'sent'`; on failure → `'failed'`.

A crash at any point leaves a truthful record: a thread stuck at `pending` means
"we may or may not have delivered it," never a false `sent`. Send-*then*-persist
is rejected — a crash after a successful send would lose the outbound message
from the conversation entirely.

**Retries reuse, never re-mint.** A `failed` (or orphaned `pending`) outbound
thread is re-attempted with the **same** `threadId` and the **same**
`Message-ID`. Minting a fresh token per attempt would spray multiple valid
threading handles for one logical message and risk double-sends. The stable
`Message-ID` is the idempotency anchor: a provider that de-dupes on `Message-ID`
will not double-deliver a retried send.

## 3a. Send idempotency + delivery leasing (HT-16)

§3's "retries reuse, never re-mint" rule describes what a retry must DO once
one is recognized; this section is how a retry gets recognized and kept safe
under concurrency, closing the increment §5 of the HT-15 version of this spec
left open.

**Caller-supplied idempotency key, scoped per conversation.** A caller that
needs at-most-once delivery (the Agent Inbox API, `agent-inbox-v1.md` §4a)
supplies an `idempotencyKey` alongside the reply. `src/store/conversations.ts`'s
`appendThread` resolves it as an atomic **get-or-insert**: `INSERT ... ON
CONFLICT (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL
DO NOTHING RETURNING *`, falling back to a `SELECT` of the pre-existing row on
conflict — inside the same transaction that holds the conversation row's `FOR
UPDATE` lock, so two callers racing with the identical key on the identical
conversation are serialized rather than double-inserting. Omitting the key is
still legal and unchanged from HT-15: a fresh send every call, no dedup
protection — a deliberate, permanently-tested contract for callers that don't
need it.

**The envelope is a snapshot, never a recomputation.** Every outbound send
(keyed or not) now persists a `send_envelope` — `{ to, cc?, subject,
references? }` — verbatim at insert. A retry (whether replayed by the
original caller with the same key, or picked up by the delivery worker below)
resends EXACTLY that stored envelope, never re-derives `to`/`subject`/
`references` from the conversation's current thread list. This matters
because time passes between an attempt and its retry, and inbound mail can
arrive in that gap: recomputing `References` at retry time could silently
absorb a message that wasn't part of the original send, changing what goes
out without anyone deciding it should (CHARTER.md invariant #5). The
persisted snapshot makes a retry byte-identical to the attempt it retries, by
construction.

**A lease keeps at most one attempt in flight per row.** Before either a
keyed retry or the delivery worker sends a `pending`/`failed` row, it must
first claim the row's delivery lease (`claimThreadForDelivery`: an atomic
`UPDATE ... WHERE claimed_until IS NULL OR claimed_until < now()`). A failed
claim means someone else already holds it; the caller does not send and
reports back accordingly rather than retrying the claim itself. A successful
attempt releases the lease as it marks `sent`/`failed`. This is what makes
"exactly one send in flight per row" hold even when a caller retries the
same key concurrently with the delivery worker sweeping the same row —
**but only if the lease strictly outlives the send it is protecting.** The
lease duration (`DEFAULT_LEASE_MS`, `src/mail/send.ts`) MUST strictly exceed
the worst-case duration of the configured `EmailSender`'s `send()` call; a
send that outlives its own lease can be re-claimed and retried by another
attempt while the original call is still in flight — a genuine concurrent
double-send, not merely a race over which of two callers marks the outcome.
Every `EmailSender` used behind these retry paths must therefore bound its
own call time well below this lease (see §4).

**Delivery is at-least-once, not at-most-once — and nothing above changes
that.** The idempotency key, the envelope snapshot, and the lease all close
off *spurious* re-sends — a retry racing another retry, or a caller
deliberately replaying — but none of them lets the engine observe what the
provider actually did with a send it already accepted. The residual case
(§3's "sent but unmarked" asymmetry, sharpened): the provider accepts the
message — the customer's mailbox already has it — and then the write that
marks the row `'sent'` fails, so the row remains `pending` with a live,
already-delivered envelope on it. If nothing revisits that row for a while,
it goes stale; once it is stale (and its lease has freed), the delivery
worker's sweep or a keyed replay's claim will find it eligible and re-send
an already-delivered message. The engine has no way to distinguish "crashed
before the provider was ever called" from "the provider was called and
succeeded, but the mark-sent write failed" — both leave the identical
stale `pending` row with a stored envelope, and both are, correctly,
retried. So: **at-least-once is the actual guarantee this system provides.
At-most-once is not something the engine can produce on its own — it holds
only to the extent the `EmailSender` provider de-duplicates on the outbound
`Message-ID`** (§4).

**The delivery worker (`src/mail/delivery-worker.ts`) is a plain, invocable
sweep function** — `runDeliveryWorker(deps, options?)` — not built on a
queue or scheduler provider (no such adapter exists yet; see §5). One call
selects a bounded batch of eligible rows (`delivery_status = 'failed'`, or
`'pending'` older than a staleness threshold, with a free lease and a stored
envelope — pre-HT-16 rows with no envelope are left for manual handling
rather than guessed at), claims each in turn, and retries it via the exact
same "rebuild `OutboundEmail` from the row, send, mark" helper a keyed
`sendReply` retry uses. Wiring a real schedule around it (Vercel Cron, or a
future `SchedulerProvider` adapter) is deferred — at that point it is a
one-line call to this function, not a rewrite of it.

## 4. What a sender provider must guarantee

The `EmailSender` provider (`src/providers/`) is handed a fully-formed outbound
message and MUST transmit the engine-supplied `Message-ID` **verbatim** as the
RFC 5322 `Message-ID` header — not generate or overwrite its own. Threading
depends on it; a provider that cannot set `Message-ID` is unusable for
Helpthread. `In-Reply-To` and `References` are likewise engine-set and must be
transmitted as given.

The interface can only state this contract; it cannot enforce it. Therefore
**every real `EmailSender` adapter MUST ship with a wire-level contract test**
asserting the exact `Message-ID`/`In-Reply-To`/`References` it emits (against
the raw MIME or provider-API payload it produces), because an adapter whose SDK
silently rewrites `Message-ID` would pass `sendReply` (the thread is marked
`sent`) while every future reply fails to thread. Prefer provider APIs that
accept raw MIME; reject any that will not carry `Message-ID` unaltered. The
in-repo fake used by the engine tests proves only that `sendReply` *passes* the
value to the seam — not that any given adapter preserves it on the wire.

**Precondition: a provider SHOULD de-duplicate on `Message-ID` (HT-16).** This
is not an aside — it is the one thing standing between this system's
structural at-least-once delivery (§3a) and true at-most-once delivery from
the operator's point of view. Where a provider does not de-duplicate on the
`Message-ID` it is handed verbatim, the operator is knowingly accepting
at-least-once delivery: the residual "accepted, then unmarked, then
re-sent" case (§3a) will occasionally reach the customer's mailbox twice,
identical down to the `Message-ID`, and nothing in the engine can prevent
that without provider-side dedup. A provider adapter's wire-level contract
test (above) should note whether the provider is known to de-dupe, so this
gap is a documented, deliberate property of a given deployment rather than
a surprise discovered in production.

**A lease that outlives the provider's `send()` call is a precondition
too.** §3a's lease only holds "at most one attempt in flight per row" if the
provider's `send()` reliably returns well inside the lease window — an
adapter whose HTTP call has no timeout (or one comparable to or longer than
the lease) can outlive its own claim and collide with a re-claimed retry.
See each adapter's own timeout documentation for its bound.

## 5. Scope

Deliberately narrow; each deferral below has a named later home:

- **Synchronous send only** — the persist→send→mark flow runs inline within
  one `sendReply` call. Retrying a stuck row is now covered (§3a: a keyed
  replay, or the delivery worker's sweep) — what's still deferred is wiring a
  real *schedule* around that sweep (Vercel Cron, or a future
  `SchedulerProvider` adapter, CHARTER.md §4) — today it is only invoked
  directly (e.g. from a test or a manual trigger), never on a timer.
- **Reply to an existing conversation only.** Agent-*initiated* brand-new
  conversations are a separate later flow.
- **`In-Reply-To`/`References` are caller-supplied** (from the inbound message
  being answered). Deriving the full `References` chain from stored threads is a
  later refinement. Once persisted into `send_envelope` (§3a) that snapshot is
  authoritative for every retry regardless of how it was originally derived.
- **A missing or deleted conversation is refused** — the token is minted first
  (before `appendThread` resolves) and then discarded on refusal; only
  persistence and sending are skipped, and the sender is never called (mirrors
  the store's `appendThread` policy; threading.md §5).
- **No cross-conversation or cross-Agent idempotency-key reuse policy.** A key
  is scoped to one conversation (§3a); reusing the same string across
  different conversations is unrelated and creates independent rows, by
  design — there is no global key registry.
