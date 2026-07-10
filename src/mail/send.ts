/**
 * Outbound send orchestration — mint, persist, send, mark (specs/mail/sending.md
 * §3; companion to specs/mail/threading.md, which this closes the loop on).
 *
 * This is the ONE place `mintReplyMessageId` (`src/mail/reply-token.ts`) is
 * called on the write path: every outbound reply's `Message-ID` originates
 * here, and every later inbound reply's threading decision
 * (`decideThreading`, `src/mail/thread.ts`) is only as trustworthy as this
 * function's ordering.
 *
 * ## Ordering: persist, THEN send, THEN mark (specs/mail/sending.md §3)
 *
 * 1. Generate `threadId` (a CSPRNG UUID, `crypto.randomUUID()`) and mint
 *    `messageId` from it — the id/token knot's resolution (specs/mail/sending.md
 *    §2): the thread's own primary key must exist before the row is
 *    inserted, because the `Message-ID` embeds it, and the `Message-ID` is a
 *    column ON that same row.
 * 2. Persist the outbound thread with `delivery_status = 'pending'` via
 *    `ConversationStore.appendThread`.
 * 3. Only once persisted, call the `EmailSender`.
 * 4. Mark `'sent'` or `'failed'` depending on the outcome.
 *
 * Send-then-persist is deliberately rejected by the spec: a crash after a
 * successful send but before persisting would lose the outbound message
 * from the conversation entirely — an unrecoverable data loss the
 * persist-first ordering here structurally cannot produce. The worst this
 * ordering can do is leave a thread stuck at `'pending'` (truthful: "may or
 * may not have been delivered"), never a false `'sent'`.
 *
 * ## Retries reuse, never re-mint (specs/mail/sending.md §3)
 *
 * When the provider `send()` call throws, this function marks the thread
 * `'failed'` and RE-THROWS — it does not swallow the error, retry inline, or
 * mint a fresh token. A `failed` (or crash-orphaned `pending`) thread is
 * meant to be retried later by a queue worker (not built in this increment
 * — specs/mail/sending.md §5) using the SAME `threadId`/`messageId` already
 * on the row. Minting a new token per attempt would spray multiple valid
 * threading handles for one logical message and risk a provider that
 * de-dupes on `Message-ID` failing to catch a double-send.
 *
 * ## Caller responsibility: idempotency is NOT yet handled here (HT-16)
 *
 * This increment has no idempotency key and no "retry an existing pending/
 * failed thread" path: each `sendReply` call mints a FRESH `threadId`/
 * `Message-ID` and sends. So a caller that retries the same logical reply
 * (an HTTP timeout, a double-clicked UI, a queue redelivery) will send a
 * SECOND email. Until the delivery-worker increment adds a real dedup key
 * (HT-16), callers MUST guarantee at-most-once invocation themselves —
 * `sendReply` must not be wired directly behind a retrying transport.
 *
 * ## Assumption: ids are canonical
 *
 * `conversationId` is expected to be a canonical (lowercase) id as produced
 * by the store — it is embedded verbatim into the token, so a non-canonical
 * spelling (e.g. an upper-cased UUID) would be what `decideThreading` later
 * recovers, even though the DB stores the canonical form. The store only ever
 * emits canonical ids and callers pass those straight through, so this holds
 * by construction; it is called out because the token carries the string, not
 * a parsed UUID.
 */

import { randomUUID } from 'node:crypto'
import type { EmailSender } from '../providers/index.js'
import type { ConversationStore } from '../store/conversations.js'
import { type Keyring, mintReplyMessageId } from './reply-token.js'

/** Dependencies `sendReply` needs, injected so it stays testable against fakes/in-memory stores. */
export interface SendReplyDeps {
  store: ConversationStore
  sender: EmailSender
  keyring: Keyring
  /** The domain minted into the outbound `Message-ID`'s `@domain` part (see `mintReplyMessageId`). */
  mailDomain: string
}

/** One outbound reply to an existing conversation (specs/mail/sending.md §5: reply-only in this increment). */
export interface SendReplyInput {
  conversationId: string
  from: string
  to: string[]
  cc?: string[]
  subject: string
  text?: string
  html?: string
  /** `In-Reply-To` of the inbound message being answered — caller-supplied (specs/mail/sending.md §5). */
  inReplyTo?: string
  /** `References` chain of the inbound message being answered — caller-supplied (specs/mail/sending.md §5). */
  references?: string[]
}

/**
 * The outcome of {@link sendReply}. Modeled as an explicit discriminated
 * result rather than throw/catch for the REFUSAL cases (missing/deleted
 * conversation) — mirroring `ConversationStore.appendThread`'s `AppendResult`
 * — because a reply aimed at a conversation that no longer accepts mail is
 * expected, not exceptional. A provider SEND failure is different: that
 * throws (see the module doc's "retries reuse, never re-mint" note), because
 * by that point the thread is already durably persisted and the failure is
 * the caller's problem to react to, not a routine control-flow branch.
 */
export type SendReplyResult =
  | { ok: true; threadId: string; messageId: string; delivery: 'sent' }
  | { ok: false; reason: 'conversation-not-found' | 'conversation-deleted' }

/**
 * Send a reply to an existing conversation, per the persist→send→mark
 * ordering in the module doc. See there for the full ordering and retry
 * rationale.
 *
 * Refusal (missing or deleted conversation): the token is minted before the
 * `appendThread` call resolves, then discarded when refusal is detected —
 * harmless, since it was never persisted or handed to the sender. The
 * `EmailSender` is NEVER invoked in a refusal case.
 */
export async function sendReply(
  input: SendReplyInput,
  deps: SendReplyDeps,
): Promise<SendReplyResult> {
  const { store, sender, keyring, mailDomain } = deps

  const threadId = randomUUID()
  const messageId = mintReplyMessageId(
    { conversationId: input.conversationId, threadId, mailDomain },
    keyring,
  )

  const appended = await store.appendThread(input.conversationId, {
    id: threadId,
    direction: 'outbound',
    messageId,
    inReplyTo: input.inReplyTo ?? null,
    fromAddress: input.from,
    bodyText: input.text ?? null,
    bodyHtml: input.html ?? null,
    deliveryStatus: 'pending',
  })

  if (!appended.ok) {
    // Nothing was persisted; the minted token above is discarded unused.
    return {
      ok: false,
      reason: appended.reason === 'not-found' ? 'conversation-not-found' : 'conversation-deleted',
    }
  }

  try {
    await sender.send({
      messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      from: input.from,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      text: input.text,
      html: input.html,
    })
  } catch (sendErr) {
    // Mark 'failed' best-effort, but never let a failure of the MARK bury the
    // original send failure — its cause is what a caller/operator needs to
    // act on. If the mark ALSO throws (e.g. a transient DB error right after
    // the provider rejected), surface both rather than silently swapping one
    // for the other.
    try {
      await store.setThreadDeliveryStatus(threadId, 'failed')
    } catch (markErr) {
      throw new AggregateError(
        [sendErr, markErr],
        'send failed, and marking the outbound thread failed also failed',
      )
    }
    throw sendErr
  }

  await store.setThreadDeliveryStatus(threadId, 'sent')
  return { ok: true, threadId, messageId, delivery: 'sent' }
}
