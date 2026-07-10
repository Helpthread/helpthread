# Conversation Store Spec

Status: draft, implemented (HT-14). Governs how conversations and threads are
persisted once a threading decision (specs/mail/threading.md) has been made.

## 1. Scope

A conversation has many threads; a thread is exactly one message (inbound
customer mail, or outbound agent/assistant mail). This spec covers the store
layer only — `src/store/conversations.ts`, `ConversationStore`. It does not
decide which conversation a message belongs to; that decision is
`decideThreading` (`src/mail/thread.ts`), a pure function with no I/O. This
layer persists what it's handed and owns exactly one further decision: what
happens when the target conversation isn't in a state that can simply accept
a new thread (§3).

## 2. Operations

- **`createConversation(input)`** — creates a conversation and its first
  thread in one transaction. Atomic: a failure inserting the first thread
  (e.g. a constraint violation) leaves zero conversation rows, never a
  conversation with no threads.
- **`appendThread(conversationId, thread)`** — adds a thread to an existing
  conversation, applying the status policy in §3. Also bumps the
  conversation's `updated_at` on any successful insert.
- **`getConversation(conversationId)`** — reads one conversation with its
  threads ordered oldest-first (`created_at, id`, the `id` tiebreak keeping
  order stable for threads inserted within the same timestamp tick). `null`
  if the conversation doesn't exist.

## 3. Status policy on append

`appendThread` resolves specs/mail/threading.md §5's open question on
replying to a closed/deleted/missing conversation:

| conversation status | effect |
|---|---|
| `open` | thread inserted |
| `closed` | thread inserted, conversation reopened (`status` → `open`) |
| `deleted` | nothing inserted; `{ ok: false, reason: 'deleted' }` |
| missing (no such id) | nothing inserted; `{ ok: false, reason: 'not-found' }` |

Reopen-on-reply matches the charter's Help Scout-like ease-of-use bar
(CHARTER.md §1): a customer reply to a resolved ticket should land back in
the same conversation, not silently vanish or fork a duplicate. A deleted or
missing target is different — there is no live conversation to reopen — so
the caller (the mail-ingestion pipeline) is expected to fall back to
starting a fresh conversation rather than resurrecting one an operator
removed, or one that never existed. Either way, mail is never silently
dropped (CHARTER.md invariant #1): the result is always a typed outcome the
caller must handle, never a thrown exception or a swallowed failure.

The whole read-check-write is one transaction, with the conversation row
locked (`SELECT ... FOR UPDATE`) for its duration, so two concurrent replies
to the same closed conversation both observe and reopen deterministically
rather than racing into an inconsistent status.

## 4. Portability

Built entirely on the raw-SQL seam in `src/db/client.ts` (`Db`/`Queryable`):
parameterized `$1`-style SQL only, no ORM. The same SQL runs against PGlite
locally/in tests and against Supabase's hosted Postgres in production — see
that module's doc for why.
