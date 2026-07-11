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
 * When the provider `send()` call fails, this function marks the thread
 * `'failed'` and returns a `{ reason: 'send-failed' }` result (it does NOT
 * throw — a rejected send is an expected outcome the caller must handle, not
 * an exception) — it does not swallow the failure, retry inline, or mint a
 * fresh token. A `failed` (or crash-orphaned `pending`) thread is meant to be
 * retried later by a queue worker (not built in this increment —
 * specs/mail/sending.md §5) using the SAME `threadId`/`messageId` already on
 * the row. Minting a new token per attempt would spray multiple valid
 * threading handles for one logical message and risk a provider that
 * de-dupes on `Message-ID` failing to catch a double-send.
 *
 * Conversely, once the provider ACCEPTS the message, the delivery has
 * happened — so a subsequent failure to record `'sent'` resolves to a
 * SUCCESS result, not a failure. Reporting an already-delivered message as
 * failed would be worse than a stale status row: it would invite a resend.
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
 * The outcome of {@link sendReply}. Every expected outcome is an explicit
 * discriminated result — including a provider SEND failure — so a caller can
 * respond precisely and never has to infer "what went wrong" from a thrown
 * error. `sendReply` only throws on a genuinely UNEXPECTED fault (e.g. the
 * initial `appendThread` DB write itself failing), which a caller should let
 * surface as an internal error.
 *
 * Critically, the three failure shapes are DISTINCT so the caller does not
 * conflate them:
 * - `conversation-not-found` / `conversation-deleted` — refused; nothing was
 *   minted, persisted, or sent.
 * - `send-failed` — the outbound thread was persisted (`pending`) but the
 *   provider rejected the message, so nothing was delivered. `persistedStatus`
 *   says whether the row was successfully moved to `'failed'` (retryable by a
 *   delivery worker) or is stuck `'pending'` because even that mark failed —
 *   so a caller never over-claims a durable `'failed'` state.
 *
 * There is deliberately NO failure result for "sent but couldn't record it":
 * once the provider accepts the message it IS delivered, so that path resolves
 * to `ok: true` (see {@link sendReply}) — reporting it as a failure would
 * invite a resend of an already-delivered message.
 */
export type SendReplyResult =
  | { ok: true; threadId: string; messageId: string; delivery: 'sent' }
  | { ok: false; reason: 'conversation-not-found' | 'conversation-deleted' }
  | {
      ok: false
      reason: 'send-failed'
      threadId: string
      messageId: string
      persistedStatus: 'failed' | 'pending'
    }

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
  } catch {
    // The provider REJECTED the message — nothing was delivered. Move the
    // thread to 'failed' so a delivery worker (HT-16) can retry it with the
    // SAME threadId/messageId (never re-mint). If even that mark fails, the
    // row is stuck 'pending'; report which, so the caller doesn't claim a
    // durable 'failed' state that isn't there. Either way delivery did not
    // happen, so a caller retry is safe.
    let persistedStatus: 'failed' | 'pending' = 'pending'
    try {
      await store.setThreadDeliveryStatus(threadId, 'failed')
      persistedStatus = 'failed'
    } catch (markErr) {
      console.error(
        '[sendReply] provider send failed AND marking the thread failed also failed; row left pending',
        markErr,
      )
    }
    return { ok: false, reason: 'send-failed', threadId, messageId, persistedStatus }
  }

  // The provider ACCEPTED the message — it is delivered. Recording 'sent' is
  // best-effort from here: if the mark throws, the email still went out, so we
  // MUST NOT report a delivery failure (that would prompt a resend of an
  // already-delivered message — the double-send hole). The row stays 'pending';
  // reconciling that stale status is a delivery-worker concern (HT-16), which
  // treats the stable Message-ID as the idempotency anchor rather than blindly
  // re-sending a 'pending' row.
  try {
    await store.setThreadDeliveryStatus(threadId, 'sent')
  } catch (markErr) {
    console.error(
      '[sendReply] message was sent but marking it sent failed; row left pending (delivery still happened)',
      markErr,
    )
  }
  return { ok: true, threadId, messageId, delivery: 'sent' }
}
