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
 * `'failed'` and returns a `{ reason: 'send-failed' }` result (it does not
 * throw — a rejected send is an expected outcome the caller must handle, not
 * an exception) — it does not swallow the failure, retry inline, or mint a
 * fresh token. A `failed` (or crash-orphaned `pending`) thread is meant to be
 * retried later using the SAME `threadId`/`messageId` already on the row —
 * either by a caller replaying the SAME `Idempotency-Key` (below), or by the
 * delivery worker's sweep (`src/mail/delivery-worker.ts`). Minting a fresh
 * token per attempt would spray multiple valid threading handles for one
 * logical message and risk a provider that de-dupes on `Message-ID` failing
 * to catch a double-send.
 *
 * Conversely, once the provider ACCEPTS the message, the delivery has
 * happened — so a subsequent failure to record `'sent'` resolves to a
 * SUCCESS result, not a failure. Reporting an already-delivered message as
 * failed would be worse than a stale status row: it would invite a resend.
 *
 * ## Send idempotency (HT-16)
 *
 * `SendReplyInput.idempotencyKey` is an OPTIONAL caller-supplied dedup key,
 * scoped per-conversation (`ConversationStore.appendThread`'s partial-unique-
 * index get-or-insert — see its doc comment and migration 003's). What
 * happens next depends on whether one was given and what it finds:
 *
 * 1. **No key.** The original, pre-HT-16 flow, UNCHANGED: mint, persist
 *    fresh, send, mark via `setThreadDeliveryStatus`. Two calls with no key
 *    are two independent sends — this is a deliberate "no key ⇒ no dedup
 *    protection" contract (see the regression-pinning test in
 *    `send.test.ts`), not an oversight; callers that need at-most-once
 *    semantics must supply a key.
 * 2. **Key matches a row already `delivery_status: 'sent'`.** A replay after
 *    success: return that row's original `threadId`/`messageId` as a SUCCESS
 *    result, WITHOUT calling the sender again.
 * 3. **Key matches a `pending`/`failed` row** (freshly inserted by THIS call,
 *    or found pre-existing from an earlier attempt — both cases converge
 *    here). The row is CLAIMED (`ConversationStore.claimThreadForDelivery`)
 *    before any send is attempted, so a concurrent duplicate call with the
 *    SAME key — or the delivery worker sweeping the same row — cannot also
 *    send it while this attempt is in flight. If the claim fails, the row is
 *    re-read to tell WHY: if it is now `'sent'` (someone else's concurrent
 *    attempt delivered it between this call's get-or-insert snapshot and the
 *    claim — the same TOCTOU `claimThreadForDelivery`'s `delivery_status`
 *    re-check closes at the store layer), this resolves to the same
 *    success-replay result as case 2 above, never a resend. Otherwise
 *    (someone else genuinely still holds the lease) this resolves to
 *    `{ reason: 'retry-in-progress' }` — nothing is sent, nothing is
 *    re-attempted here. If the claim succeeds, delivery is attempted using
 *    the row's ALREADY-PERSISTED `messageId` and `sendEnvelope` (never
 *    re-minted, never recomputed — see below), via
 *    {@link attemptDeliveryOfClaimedThread}, which is the exact helper the
 *    delivery worker also calls.
 *
 * The `sendEnvelope` snapshot (`{ to, cc?, subject, references? }`,
 * persisted once at insert, `src/store/conversations.ts`'s `SendEnvelope`)
 * is what makes a retry's mail byte-identical to the original attempt: it is
 * READ BACK verbatim, never recomputed from the conversation's current
 * thread list. Recomputing `references` on a retry could silently absorb an
 * inbound message that arrived between the original attempt and the retry —
 * exactly the kind of undocumented mail-semantics drift CHARTER.md invariant
 * #5 forbids. See migration 003's doc comment (`src/db/migrate.ts`) for the
 * full argument.
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
import type { ConversationStore, SendEnvelope, StoredThread } from '../store/conversations.js'
import { type Keyring, mintReplyMessageId } from './reply-token.js'

/**
 * Default lease duration for a delivery attempt (claim → send → mark).
 * Shared as the default for both `sendReply`'s own inline retry-claim and
 * `runDeliveryWorker`'s `leaseMs` option (`src/mail/delivery-worker.ts`) —
 * one number, one place, rather than two independently-tuned constants for
 * what is conceptually the same lease.
 *
 * ## The invariant this number exists to hold
 *
 * The lease MUST strictly exceed the worst-case duration of whatever
 * `EmailSender.send()` call it is protecting (specs/mail/sending.md §3a,
 * §4). A send that outlives its own lease can have its row re-claimed and
 * retried by a concurrent caller — a keyed replay, or the delivery worker —
 * while the original call is STILL in flight: a genuine double-send, with
 * no DB write, crash, or failure anywhere in the picture. This is a
 * different (and worse) hole than the "mark-sent write fails" case §3
 * already documents — that one is a single already-delivered send racing a
 * *later* retry of a row gone stale; this one is two live `send()` calls
 * for the same row overlapping in real time.
 *
 * `120_000` is chosen to comfortably clear a real provider HTTP call
 * (seconds, not minutes) with a wide margin — not tuned against any
 * measured worst case, because none has been measured here. Any
 * `EmailSender` used behind these retry paths (§4) MUST bound its own
 * `send()` call well below this lease — via its own request timeout — so
 * this margin is never actually spent. Raising this constant without also
 * checking every adapter's timeout against it re-opens the hole it exists
 * to close.
 */
export const DEFAULT_LEASE_MS = 120_000

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
  /**
   * Optional caller-supplied dedup key (HT-16), scoped per-conversation. See
   * the module doc's "Send idempotency" section for the full contract.
   * Omitted entirely means no dedup protection — a fresh send every call.
   */
  idempotencyKey?: string
}

/**
 * The outcome of {@link sendReply}. Every expected outcome is an explicit
 * discriminated result — including a provider SEND failure — so a caller can
 * respond precisely and never has to infer "what went wrong" from a thrown
 * error. `sendReply` only throws on a genuinely UNEXPECTED fault (e.g. the
 * initial `appendThread` DB write itself failing), which a caller should let
 * surface as an internal error.
 *
 * Critically, the failure shapes are DISTINCT so the caller does not
 * conflate them:
 * - `conversation-not-found` / `conversation-deleted` — refused; nothing was
 *   minted, persisted, or sent.
 * - `retry-in-progress` (HT-16) — a keyed call found a `pending`/`failed` row
 *   but could not claim its delivery lease, AND, on re-reading the row, it is
 *   genuinely still `pending`/`failed` (someone else already holds the
 *   lease — another concurrent call with the same key, or the delivery
 *   worker). Nothing was sent by THIS call; the in-flight attempt is
 *   expected to resolve the row on its own. If the re-read instead finds the
 *   row `'sent'`, that is NOT this reason — it resolves to `ok: true`
 *   instead (see {@link sendReply}'s claim-failure handling), because the
 *   message already went out.
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
  | { ok: false; reason: 'retry-in-progress' }
  | {
      ok: false
      reason: 'send-failed'
      threadId: string
      messageId: string
      persistedStatus: 'failed' | 'pending'
    }

/**
 * Send a reply to an existing conversation, per the persist→send→mark
 * ordering in the module doc. See there for the full ordering, retry, and
 * idempotency-key rationale.
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

  // The envelope snapshot is built from THIS call's inputs and persisted
  // verbatim on insert, keyed or not — persisting it unconditionally (not
  // only when idempotencyKey is set) is what lets the delivery worker
  // reconstruct ANY eligible outbound row later, regardless of whether its
  // original send carried a dedup key.
  const sendEnvelope: SendEnvelope = {
    to: input.to,
    ...(input.cc !== undefined ? { cc: input.cc } : {}),
    subject: input.subject,
    ...(input.references !== undefined ? { references: input.references } : {}),
  }

  const appended = await store.appendThread(input.conversationId, {
    id: threadId,
    direction: 'outbound',
    messageId,
    inReplyTo: input.inReplyTo ?? null,
    fromAddress: input.from,
    bodyText: input.text ?? null,
    bodyHtml: input.html ?? null,
    deliveryStatus: 'pending',
    idempotencyKey: input.idempotencyKey,
    sendEnvelope,
  })

  if (!appended.ok) {
    // Nothing was persisted; the minted token above is discarded unused.
    return {
      ok: false,
      reason: appended.reason === 'not-found' ? 'conversation-not-found' : 'conversation-deleted',
    }
  }

  if (input.idempotencyKey === undefined) {
    // No key: byte-identical to the pre-HT-16 flow. `appended.created` is
    // always `true` here (a NULL key can never conflict — see
    // ConversationStore.appendThread's doc comment), so there is no
    // existing-row case to handle; send fresh and mark via
    // setThreadDeliveryStatus, exactly as before this feature existed.
    return sendFreshAndMark(threadId, messageId, input, deps)
  }

  const { thread } = appended

  if (thread.deliveryStatus === 'sent') {
    // Replay after success: return the ORIGINAL outcome. The sender is never
    // touched — the message already went out.
    return {
      ok: true,
      threadId: thread.id,
      messageId: thread.messageId as string,
      delivery: 'sent',
    }
  }

  // `pending` or `failed` — whether just-created by THIS call or found
  // pre-existing from an earlier attempt, both converge here: claim the
  // delivery lease before sending, so a concurrent duplicate call (same key)
  // or the delivery worker cannot also be sending this row right now.
  const claimed = await store.claimThreadForDelivery(thread.id, DEFAULT_LEASE_MS)
  if (claimed === null) {
    // The claim can fail for two different reasons, and conflating them
    // would resurrect the double-send hole the claim's `delivery_status`
    // re-check (`ConversationStore.claimThreadForDelivery`'s doc comment)
    // exists to close:
    //
    // (a) someone else genuinely holds the lease right now — the row is
    //     still `pending`/`failed`, `claimed_until` is in the future. This
    //     IS `retry-in-progress`.
    // (b) the row reached `'sent'` between the snapshot captured above (this
    //     call's own `appended.thread`) and this claim call — e.g. a
    //     concurrent same-key call, or the delivery worker, already
    //     delivered it. The lease is free, but the claim's status re-check
    //     correctly refuses it. This is NOT "in progress" — it already
    //     succeeded — so reporting `retry-in-progress` would be a lie that
    //     could prompt a caller to retry a message that already went out.
    //
    // Re-reading the thread is the only way to tell these apart; a `'sent'`
    // reading resolves to the same success-replay result the early check
    // above returns.
    const current = await store.getConversation(input.conversationId)
    const currentThread = current?.threads.find((t) => t.id === thread.id)
    if (currentThread?.deliveryStatus === 'sent') {
      return {
        ok: true,
        threadId: currentThread.id,
        messageId: currentThread.messageId as string,
        delivery: 'sent',
      }
    }
    return { ok: false, reason: 'retry-in-progress' }
  }

  return attemptDeliveryOfClaimedThread(claimed, { store, sender })
}

/**
 * The original (pre-HT-16) fresh-send flow: send via the provider, then mark
 * `sent`/`failed` via `setThreadDeliveryStatus`. Used ONLY for the no-key
 * path — kept as its own function (rather than folded into the claimed-row
 * helper below) specifically so this code path, and the store method it
 * calls, stay untouched: `send.test.ts`'s pre-HT-16 tests override
 * `store.setThreadDeliveryStatus` directly to exercise the mark-failed and
 * sent-but-mark-fails cases, and must keep working unedited.
 */
async function sendFreshAndMark(
  threadId: string,
  messageId: string,
  input: SendReplyInput,
  deps: SendReplyDeps,
): Promise<SendReplyResult> {
  const { store, sender } = deps

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
    // thread to 'failed' so a later retry (a delivery worker, or a keyed
    // caller) can retry it with the SAME threadId/messageId (never re-mint).
    // If even that mark fails, the row is stuck 'pending'; report which, so
    // the caller doesn't claim a durable 'failed' state that isn't there.
    // Either way delivery did not happen, so a caller retry is safe.
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
  // reconciling that stale status is a delivery-worker concern, which treats
  // the stable Message-ID as the idempotency anchor rather than blindly
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

/**
 * Attempt delivery of an ALREADY-CLAIMED outbound row, then mark
 * `sent`/`failed` and release its lease. Shared by {@link sendReply}'s
 * keyed-retry path and `runDeliveryWorker`'s sweep
 * (`src/mail/delivery-worker.ts`) — the one place either caller rebuilds an
 * `OutboundEmail` from a stored row and calls the sender.
 *
 * `thread` must already be claimed (`ConversationStore.claimThreadForDelivery`
 * having returned it) — this function does not claim it itself, since the
 * two callers need to distinguish "claim failed" (report `retry-in-progress`
 * / skip this row) from "claim succeeded, now attempt delivery" differently.
 *
 * Throws if `thread.messageId` or `thread.sendEnvelope` is missing — both are
 * set unconditionally by every `sendReply` insert (keyed or not), so a
 * legitimately eligible row always has both; a row missing either is not
 * something this function should guess how to send (a `listDeliverableThreads`
 * caller already filters out `send_envelope IS NULL` rows for the same
 * reason — see that store method's doc comment — so this is a defensive
 * invariant check, not a path either current caller can hit in practice).
 */
export async function attemptDeliveryOfClaimedThread(
  thread: StoredThread,
  deps: { store: ConversationStore; sender: EmailSender },
): Promise<
  | { ok: true; threadId: string; messageId: string; delivery: 'sent' }
  | {
      ok: false
      reason: 'send-failed'
      threadId: string
      messageId: string
      persistedStatus: 'failed' | 'pending'
    }
> {
  const { store, sender } = deps

  if (thread.messageId === null || thread.sendEnvelope === null) {
    throw new Error(
      `attemptDeliveryOfClaimedThread: outbound thread ${thread.id} is missing messageId or sendEnvelope — cannot rebuild its OutboundEmail`,
    )
  }
  const messageId = thread.messageId
  const envelope = thread.sendEnvelope

  try {
    await sender.send({
      messageId,
      inReplyTo: thread.inReplyTo ?? undefined,
      references: envelope.references,
      from: thread.fromAddress,
      to: envelope.to,
      cc: envelope.cc,
      subject: envelope.subject,
      text: thread.bodyText ?? undefined,
      html: thread.bodyHtml ?? undefined,
    })
  } catch {
    let persistedStatus: 'failed' | 'pending' = 'pending'
    try {
      await store.releaseThreadLease(thread.id, 'failed')
      persistedStatus = 'failed'
    } catch (markErr) {
      console.error(
        '[attemptDeliveryOfClaimedThread] provider send failed AND marking the thread failed also failed; row left claimed',
        markErr,
      )
    }
    return { ok: false, reason: 'send-failed', threadId: thread.id, messageId, persistedStatus }
  }

  try {
    await store.releaseThreadLease(thread.id, 'sent')
  } catch (markErr) {
    // The row stays claimed (lease held) rather than released, but that is
    // NOT meaningful protection against a resend — the lease is a fraction
    // of `staleAfterMs` (delivery-worker.ts's default: 5 minutes vs.
    // `DEFAULT_LEASE_MS`'s 2), so it will have expired long before the
    // delivery worker would otherwise reconsider this stale-`pending` row
    // anyway. Staying claimed buys, at best, a small head start. The actual
    // backstop against double-delivering an already-sent message is the
    // `EmailSender` provider de-duplicating on `Message-ID`
    // (specs/mail/sending.md §3a, §4) — this log line exists purely so the
    // "sent but unmarked" case is observable, not because the claimed state
    // meaningfully delays anything.
    console.error(
      '[attemptDeliveryOfClaimedThread] message was sent but marking it sent failed; row left claimed (delivery still happened; see comment above — this is not a meaningful resend delay)',
      markErr,
    )
  }
  return { ok: true, threadId: thread.id, messageId, delivery: 'sent' }
}
