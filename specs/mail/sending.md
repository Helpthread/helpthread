# Outbound sending & the reply-token lifecycle

Status: accepted (HT-15). Companion to [threading.md](./threading.md) — that spec
decides which conversation an *inbound* message joins; this one covers how an
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

## 5. Scope of the first increment (HT-15)

Deliberately narrow; each deferral below has a named later home:

- **Synchronous send only** — the persist→send→mark flow runs inline. No queue
  or retry worker yet; the `failed` status plus the stable id/`Message-ID` are
  the seam a later delivery worker (queue provider, already interfaced) picks up.
- **Reply to an existing conversation only.** Agent-*initiated* brand-new
  conversations are a separate later flow.
- **`In-Reply-To`/`References` are caller-supplied** (from the inbound message
  being answered). Deriving the full `References` chain from stored threads is a
  later refinement.
- **A missing or deleted conversation is refused** — the token is minted first
  (before `appendThread` resolves) and then discarded on refusal; only
  persistence and sending are skipped, and the sender is never called (mirrors
  the store's `appendThread` policy; threading.md §5).
