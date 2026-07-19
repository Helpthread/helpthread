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
 *
 * ## References carries the reply token, not just Message-ID (HT-49)
 *
 * Live production evidence (2026-07-17, first HT-44 run against real Gmail):
 * Gmail's `users.messages.send` accepted our verbatim-set `Message-ID` on the
 * request but REPLACED it on the wire with a Gmail-generated id
 * (`<CAKWkAL3...@mail.gmail.com>`) — confirmed from the raw copy Gmail itself
 * returned on reconcile of the sent message's self-echo. Every
 * `EmailSender` adapter is still required to transmit `OutboundEmail.messageId`
 * verbatim (`src/providers/email-sender.ts`'s module doc) — this is a
 * provider-side rewrite downstream of that verbatim transmission, not a
 * violation of it, and no adapter change closes it. The customer's reply
 * therefore carried `In-Reply-To`/`References` pointing at GMAIL's id, with
 * our minted token nowhere on the wire — `decideThreading` correctly found no
 * verified token and (per invariant #5) started a NEW conversation instead of
 * appending, splitting the thread.
 *
 * `References`, unlike `Message-ID`, is NOT rewritten by Gmail — and an
 * RFC-5322-compliant reply's own `References` is built as
 * `{original References} + {original Message-ID}` (§3.6.4). So this function
 * appends its own freshly-minted `messageId` as the FINAL entry of the
 * outbound `References` chain, after any ancestor ids — giving the token a
 * second, provider-durable channel out onto the wire. When the customer
 * replies, their client's own References becomes
 * `[...ourReferences, gmailRewrittenId]` — i.e.
 * `[...ancestors, ourMintedToken, gmailRewrittenId]` — and `decideThreading`'s
 * existing newest-first scan (`src/mail/thread.ts`, `buildCandidates`) skips
 * the foreign trailing id (no token, not ours to judge) and finds our token
 * immediately behind it. `In-Reply-To` is left untouched: it still names the
 * specific ancestor message being answered, not this reply's own id — see
 * `specs/mail/threading.md` §2a for the full spec of this fix, and
 * `specs/mail/sending.md`/`specs/api/agent-inbox-v1.md` §4a for the
 * corresponding header-derivation wording. Zero threading-decision code
 * changed: verified, not assumed — `src/mail/thread.ts` is untouched by this
 * fix, and a fixture reproducing tonight's exact failure (`src/mail/
 * ingest.test.ts`) threads correctly through the existing scan unmodified.
 *
 * ## The reply token's own self-echo, and how it is suppressed (HT-49 review fix)
 *
 * Putting a verifiable token in EVERY outbound reply's `References` (above)
 * has a sharp edge: some transports (Gmail, confirmed live) deliver the SENT
 * message back into the very mailbox it was sent from, where the reconcile
 * pipeline (`src/mail/gmail-reconcile.ts`) ingests it like any other inbound
 * message. `src/mail/ingest.ts`'s loop guard (`isOwnMessageReflection`) only
 * recognizes a reflection whose OWN `Message-ID` is our token — but Gmail
 * rewrites the wire `Message-ID` (this file's own module doc, above), so the
 * guard never fires for this transport. Without a second guard, that
 * self-echo carries our valid token as the LAST `References` entry,
 * `decideThreading` finds it and returns `'append'`, and the agent's own
 * reply gets stored a second time as a phantom `direction: 'inbound'`
 * message in the very conversation it belongs to — reopening it if it was
 * closed (`appendThreadInTx`, `src/store/conversations.ts`).
 *
 * `selfEchoGuard` (optional — {@link SelfEchoGuardDeps}) closes this WITHOUT
 * touching `decideThreading` or adding a threading heuristic: immediately
 * after a successful send, if the sender returned a `providerMessageId`
 * (`EmailSendResult.providerMessageId` — Gmail's `body.id`, the SAME id
 * `gmail-reconcile.ts` will later see for this exact message during
 * `history.list`), this module resolves `input.from` to its `MailboxRecord`
 * (`MailboxStore.getMailboxByAddress`) and pre-seeds `(mailboxId,
 * providerMessageId)` as an already-`suppressed` row in the inbound delivery
 * ledger (`InboundDeliveryStore.preSuppressOwnSend`, `src/store/inbound-
 * deliveries.ts`). When reconcile later lists that SAME provider id and
 * calls `ingestInboundMessage`, its `claim()` finds the pre-seeded
 * `suppressed` row and reports the terminal outcome as-is — the existing
 * "do not double-process a terminal row" path, never a new code path in
 * `ingest.ts`. This is best-effort and never affects the send's own outcome
 * (the message is already delivered by the time this runs) — see {@link
 * suppressSelfEcho}'s doc comment for the failure modes this accepts.
 */

import { randomUUID } from 'node:crypto'
import type { EmailSender } from '../providers/index.js'
import type { ConversationStore, SendEnvelope, StoredThread } from '../store/conversations.js'
import type { InboundDeliveryStore } from '../store/inbound-deliveries.js'
import type { MailboxStore } from '../store/mailboxes.js'
import { injectTrackingPixel, mintViewToken, pixelUrlFor } from './open-tracking.js'
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
 * this margin is never actually spent.
 *
 * This relationship is enforced mechanically, not by convention: every
 * `EmailSender` declares the bound it enforces (`maxSendMs`,
 * `src/providers/email-sender.ts`), and both retry paths assert
 * `maxSendMs < leaseMs` via {@link assertLeaseExceedsSenderBound} before
 * claiming a row. Changing this constant, an adapter's timeout, or a
 * worker's `leaseMs` option into a violating combination therefore throws
 * at the call site instead of silently re-opening the hole.
 */
export const DEFAULT_LEASE_MS = 120_000

/**
 * Assert the invariant {@link DEFAULT_LEASE_MS}'s doc comment exists to
 * hold: the delivery lease strictly exceeds the sender's own enforced
 * per-`send()` bound (`EmailSender.maxSendMs`). Called by both retry paths
 * — `sendReply`'s keyed claim and `runDeliveryWorker`'s sweep
 * (`src/mail/delivery-worker.ts`) — BEFORE any row is claimed, so a
 * violating configuration fails loudly up front: nothing is claimed,
 * nothing is sent, and the throw names both numbers.
 *
 * A violation is a wiring bug (an adapter timeout raised to/past the lease,
 * or a lease tuned down below an adapter's timeout), never an expected
 * runtime outcome — hence a throw, not a discriminated result, matching
 * `sendReply`'s "only throw on genuinely unexpected faults" contract.
 */
export function assertLeaseExceedsSenderBound(sender: EmailSender, leaseMs: number): void {
  if (!(sender.maxSendMs < leaseMs)) {
    throw new Error(
      `delivery lease (${leaseMs}ms) must strictly exceed the sender's enforced send() bound ` +
        `(maxSendMs: ${sender.maxSendMs}ms), or a re-claimed retry can race a still-in-flight ` +
        `send into a concurrent double-send (specs/mail/sending.md §3a) — ` +
        `raise the lease or lower the sender's timeout`,
    )
  }
}

/**
 * Dependencies for the self-echo guard (module doc's "The reply token's own
 * self-echo" section, HT-49 review fix). Optional in {@link SendReplyDeps} —
 * a deployment with no Gmail (or other self-reflecting) transport configured
 * simply never sets this, and every existing test/caller is unaffected: with
 * it absent, {@link suppressSelfEcho} is a complete no-op, byte-identical to
 * before this guard existed.
 */
export interface SelfEchoGuardDeps {
  /** Resolves `SendReplyInput.from` to the mailbox it belongs to (`MailboxStore.getMailboxByAddress`). */
  mailboxStore: MailboxStore
  /** Where the pre-seeded suppression row is written (`InboundDeliveryStore.preSuppressOwnSend`). */
  inboundDeliveryStore: InboundDeliveryStore
}

/** Dependencies `sendReply` needs, injected so it stays testable against fakes/in-memory stores. */
export interface SendReplyDeps {
  store: ConversationStore
  sender: EmailSender
  keyring: Keyring
  /** The domain minted into the outbound `Message-ID`'s `@domain` part (see `mintReplyMessageId`). */
  mailDomain: string
  /**
   * Open tracking (spec §4g, v1.1 — HT-32). ABSENT BY DEFAULT, and absence
   * means byte-identical mail to before the feature existed: no pixel, no
   * change to any body. When present, each outbound reply's HTML body (and
   * ONLY the HTML body — a text-only reply is never given a fabricated HTML
   * part) gets a 1×1 pixel whose URL carries a signed view token bound to
   * this reply's threadId (`src/mail/open-tracking.ts`), served under
   * `publicBaseUrl`. Injection happens BEFORE persist, so the stored
   * `bodyHtml` is exactly what was sent — and every retry path (keyed replay,
   * delivery worker), which rebuilds from the stored row, carries the same
   * pixel with no extra logic.
   */
  openTracking?: { publicBaseUrl: string }
  /** See {@link SelfEchoGuardDeps}. ABSENT BY DEFAULT — see that interface's doc comment. */
  selfEchoGuard?: SelfEchoGuardDeps
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
  /**
   * `References` chain of the inbound message being answered — caller-supplied
   * ANCESTOR ids only (specs/mail/sending.md §5). `sendReply` appends this
   * call's own freshly-minted `messageId` as the FINAL entry before sending or
   * persisting (HT-49; see the module doc's "References carries the reply
   * token" section) — this field should never itself include the reply's own
   * id, and the outbound `References` actually transmitted is always this
   * array plus one more entry, even when this field is omitted entirely.
   */
  references?: string[]
  /**
   * Optional caller-supplied dedup key (HT-16), scoped per-conversation. See
   * the module doc's "Send idempotency" section for the full contract.
   * Omitted entirely means no dedup protection — a fresh send every call.
   */
  idempotencyKey?: string
  /**
   * The acting Agent's id, when known (HT-70; specs/plugins/substrate-v1.md
   * §3's author-identity forward-carry) — becomes `threads.author_agent_id`
   * on the inserted row via `ConversationStore.appendThread`'s existing
   * `NewThread.authorAgentId`. Omitted/`undefined` (every pre-HT-70 caller)
   * behaves BYTE-IDENTICALLY to before this field existed: `appendThread`
   * already defaults a missing `authorAgentId` to `null`, so passing
   * `undefined` through unconditionally below is a no-op change to the
   * persisted row.
   */
  authorAgentId?: string | null
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

  // HT-49: append this reply's OWN minted messageId as the FINAL References
  // entry, after any ancestor ids the caller supplied — see the module doc's
  // "References carries the reply token" section for why. Unconditional and
  // always non-empty (even a first reply with no ancestors gets a one-element
  // References: [messageId]): the token needs this durable channel onto the
  // wire regardless of how many ancestors precede it.
  const references = [...(input.references ?? []), messageId]

  // Open tracking (spec §4g): with the feature OFF (the default), the body
  // passes through UNTOUCHED — this line is the whole off-path, and the
  // byte-identical-mail guarantee rests on it. With it on, only the HTML
  // body changes, before persist (see SendReplyDeps.openTracking). On a
  // keyed REPLAY the modified body is irrelevant either way — appendThread
  // returns the ORIGINAL row's persisted body (§4a's replay rule). References
  // is always overridden to the HT-49 chain above, independent of tracking.
  const effectiveInput: SendReplyInput = {
    ...(deps.openTracking !== undefined && input.html !== undefined
      ? {
          ...input,
          html: injectTrackingPixel(
            input.html,
            pixelUrlFor(deps.openTracking.publicBaseUrl, mintViewToken(threadId, keyring)),
          ),
        }
      : input),
    references,
  }

  // The envelope snapshot is built from THIS call's inputs and persisted
  // verbatim on insert, keyed or not — persisting it unconditionally (not
  // only when idempotencyKey is set) is what lets the delivery worker
  // reconstruct ANY eligible outbound row later, regardless of whether its
  // original send carried a dedup key. `references` (never `input.references`)
  // is always set, per HT-49 above.
  const sendEnvelope: SendEnvelope = {
    to: input.to,
    ...(input.cc !== undefined ? { cc: input.cc } : {}),
    subject: input.subject,
    references,
  }

  const appended = await store.appendThread(input.conversationId, {
    id: threadId,
    direction: 'outbound',
    messageId,
    inReplyTo: input.inReplyTo ?? null,
    fromAddress: input.from,
    bodyText: input.text ?? null,
    bodyHtml: effectiveInput.html ?? null,
    deliveryStatus: 'pending',
    idempotencyKey: input.idempotencyKey,
    sendEnvelope,
    authorAgentId: input.authorAgentId ?? null,
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
    return sendFreshAndMark(threadId, messageId, effectiveInput, deps)
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
  assertLeaseExceedsSenderBound(sender, DEFAULT_LEASE_MS)
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

  return attemptDeliveryOfClaimedThread(claimed, {
    store,
    sender,
    selfEchoGuard: deps.selfEchoGuard,
  })
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
  let sendResult: Awaited<ReturnType<EmailSender['send']>>

  try {
    sendResult = await sender.send({
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
  await suppressSelfEcho(input.from, sendResult.providerMessageId, deps.selfEchoGuard)
  return { ok: true, threadId, messageId, delivery: 'sent' }
}

/**
 * Best-effort: pre-seed the pending self-echo of this JUST-SENT message as
 * suppressed in the inbound delivery ledger — module doc's "The reply
 * token's own self-echo" section. A no-op when `guard` is absent (no
 * self-reflecting transport configured) or `providerMessageId` is absent
 * (the sender didn't report one — nothing to correlate against later).
 *
 * Deliberately never throws: this runs AFTER the message is already
 * delivered (`sendFreshAndMark`/`attemptDeliveryOfClaimedThread` only call it
 * once `sender.send()` has resolved), so a failure here must never turn an
 * already-successful send into a reported failure — it would invite a
 * resend of mail that already went out. Losing this race (or a lookup/write
 * error) just means the pre-HT-49-fix failure mode (a phantom inbound
 * self-echo, if this transport reflects sent mail back to its own mailbox)
 * can still occur for this one send — logged, not silently swallowed.
 */
async function suppressSelfEcho(
  fromAddress: string,
  providerMessageId: string | undefined,
  guard: SelfEchoGuardDeps | undefined,
): Promise<void> {
  if (guard === undefined || providerMessageId === undefined) return

  try {
    const mailbox = await guard.mailboxStore.getMailboxByAddress(fromAddress)
    if (mailbox === null) return
    await guard.inboundDeliveryStore.preSuppressOwnSend(
      mailbox.id,
      providerMessageId,
      'own-outbound-self-echo',
    )
  } catch (err) {
    console.error(
      "[sendReply] failed to pre-suppress this send's self-echo in the inbound delivery " +
        'ledger; if this transport reflects sent mail back into its own mailbox, reconcile may ' +
        'ingest it as a phantom inbound message (HT-49)',
      err,
    )
  }
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
  deps: { store: ConversationStore; sender: EmailSender; selfEchoGuard?: SelfEchoGuardDeps },
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
  let sendResult: Awaited<ReturnType<EmailSender['send']>>

  try {
    sendResult = await sender.send({
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
  await suppressSelfEcho(thread.fromAddress, sendResult.providerMessageId, deps.selfEchoGuard)
  return { ok: true, threadId: thread.id, messageId, delivery: 'sent' }
}
