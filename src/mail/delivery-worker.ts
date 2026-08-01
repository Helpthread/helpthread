/**
 * The delivery worker (HT-16) — a periodic sweep that retries outbound
 * threads still stuck `pending` or `failed`, using the SAME `threadId`/
 * `Message-ID` each row already has (never re-minted; specs/mail/sending.md
 * §3, `src/mail/send.ts`'s module doc).
 *
 * ## A plain sweep function, not a queue/cron adapter
 *
 * `runDeliveryWorker` is deliberately a plain `async function`, not built on
 * `QueueProvider`/`SchedulerProvider` (`src/providers/`) — no such adapter
 * exists yet, and CHARTER.md §4's provider-seam discipline is exactly why
 * this stays a pure function of its dependencies rather than reaching for a
 * platform primitive that isn't wired up. Wiring a real schedule (Vercel Cron
 * calling this on an interval, or a future `SchedulerProvider` adapter) is
 * deferred to whenever that seam is built — at that point it is a one-line
 * call to this function, not a rewrite of it.
 *
 * ## What one sweep does
 *
 * 1. `ConversationStore.listDeliverableThreads` selects a batch of eligible
 *    outbound rows: `delivery_status = 'failed'`, OR `'pending'` older than
 *    `staleAfterMs` (a young `'pending'` row may just be a normal send still
 *    in flight elsewhere) — see that method's doc comment for the full
 *    eligibility rule, including why a row with no stored `send_envelope`
 *    (pre-HT-16 data) is never included.
 * 2. For each candidate, `ConversationStore.claimThreadForDelivery` attempts
 *    to take its delivery lease. A row can be eligible in the LISTING
 *    snapshot but already claimed by the time this worker gets to it — by a
 *    concurrent keyed `sendReply` retry, or another worker sweep — in which
 *    case the claim returns `null` and this sweep simply skips it; there is
 *    no retry-the-claim loop here, the next sweep will see it again if it's
 *    still eligible then.
 * 3. A successful claim is handed to `attemptDeliveryOfClaimedThread`
 *    (`src/mail/send.ts`) — the SAME helper `sendReply`'s own keyed-retry
 *    path uses — which rebuilds the exact `OutboundEmail` from the row
 *    (`messageId`, `fromAddress`, `bodyText`/`bodyHtml`, `inReplyTo`,
 *    `sendEnvelope`), calls the sender, and marks `sent`/`failed` while
 *    releasing the lease.
 *
 * ## Per-mailbox sender resolution (HT-101 Stage 2b-ii)
 *
 * Before this feature, every retried row was sent through ONE fixed
 * `EmailSender` regardless of which inbox its conversation belonged to. Now,
 * for each successfully-claimed row, this worker looks up its conversation
 * (`ConversationStore.getConversationByThreadId`, the same lookup HT-70's
 * draft-approval path uses to derive per-conversation state from only a
 * `threadId`) and resolves a sender bound to THAT conversation's OWN mailbox
 * via `SenderResolver` (`./sender-resolver.js`) — never the single global
 * default. `attemptDeliveryOfClaimedThread` itself is unchanged: it still
 * rebuilds `from` from the row's own persisted `fromAddress` (set at the
 * ORIGINAL `sendReply` call and never recomputed), so only WHICH transport
 * sends it varies here, never the envelope.
 *
 * A `SenderResolutionError` (the claimed row's mailbox has no usable IMAP
 * config/credential, or names no mailbox at all) is treated as a per-row
 * send failure — mirroring `attemptDeliveryOfClaimedThread`'s own
 * provider-rejection handling: the row is marked `'failed'` (or left
 * `'pending'` if even that mark fails) and the sweep continues with the next
 * candidate, rather than aborting the whole batch over one misconfigured
 * mailbox. Any OTHER fault from resolution (a lease/`maxSendMs`
 * misconfiguration `assertLeaseExceedsSenderBound` catches, or a genuinely
 * unexpected store error) is a wiring bug, not a routine per-row outcome —
 * it propagates and aborts the sweep, same as `listDeliverableThreads`
 * itself failing always has.
 */

import type { EmailSender } from '../providers/index.js'
import type { ConversationStore } from '../store/conversations.js'
import {
  assertLeaseExceedsSenderBound,
  attemptDeliveryOfClaimedThread,
  DEFAULT_LEASE_MS,
  type SelfEchoGuardDeps,
} from './send.js'
import { SenderResolutionError, type SenderResolver } from './sender-resolver.js'

/** Default age a `'pending'` row must reach before this worker considers it stuck rather than merely in flight. */
const DEFAULT_STALE_AFTER_MS = 5 * 60_000

/** Default cap on how many rows one sweep will attempt — a bound on a single invocation's work and blast radius, not a pagination scheme. */
const DEFAULT_BATCH_SIZE = 50

/** Dependencies `runDeliveryWorker` needs, injected so it stays testable against fakes/in-memory stores. */
export interface DeliveryWorkerDeps {
  store: ConversationStore
  /**
   * Resolves the sender for a claimed thread's OWN mailbox (HT-101 Stage
   * 2b-ii; `./sender-resolver.js`) — replaces the single fixed `EmailSender`
   * this worker used to retry every candidate through, regardless of which
   * inbox its conversation belonged to. See the module doc's "Per-mailbox
   * sender resolution" section.
   */
  senderResolver: SenderResolver
  /**
   * The same self-echo guard `sendReply` accepts (`./send.js`'s
   * `SelfEchoGuardDeps`, HT-49 review fix) — a retried send through THIS
   * worker's `attemptDeliveryOfClaimedThread` call is just as capable of
   * producing a self-echo as `sendReply`'s own retry path, so it needs the
   * same pre-suppression. ABSENT BY DEFAULT, a no-op when unset.
   */
  selfEchoGuard?: SelfEchoGuardDeps
}

/** Tuning knobs for one sweep; every field defaults, so `runDeliveryWorker(deps)` alone is a complete, reasonable call. */
export interface DeliveryWorkerOptions {
  /** How old a `'pending'` row must be before it's a retry candidate (default {@link DEFAULT_STALE_AFTER_MS}). */
  staleAfterMs?: number
  /**
   * Lease duration held while a candidate is being attempted (default
   * {@link DEFAULT_LEASE_MS}, shared with `sendReply`'s own retry-claim).
   * Must strictly exceed the sender's enforced per-`send()` bound
   * (`EmailSender.maxSendMs`) — asserted up front, before anything is
   * claimed (see `assertLeaseExceedsSenderBound`, `src/mail/send.ts`).
   */
  leaseMs?: number
  /** Hard cap on rows attempted in this one call (default {@link DEFAULT_BATCH_SIZE}). */
  batchSize?: number
}

/** What one `runDeliveryWorker` call did, for logging/observability by whatever schedules it. */
export interface DeliveryWorkerReport {
  /** Candidates for which a delivery was actually attempted (claimed successfully) — `sent + failed`. */
  attempted: number
  /** Attempts that ended `delivery_status = 'sent'`. */
  sent: number
  /** Attempts that ended `delivery_status = 'failed'` (or, rarely, left `'pending'` because even the mark-failed write failed). */
  failed: number
  /** Eligible candidates whose lease could not be claimed (already held by a concurrent attempt) — left for a later sweep. */
  skipped: number
}

/**
 * Run one delivery-retry sweep. See the module doc for the full behavior.
 * Never throws for an individual candidate's send failure (that is an
 * expected, counted outcome — see {@link DeliveryWorkerReport}); a genuinely
 * unexpected fault (e.g. `listDeliverableThreads` itself failing) propagates
 * to the caller, same as any other unexpected store error in this codebase.
 */
export async function runDeliveryWorker(
  deps: DeliveryWorkerDeps,
  options?: DeliveryWorkerOptions,
): Promise<DeliveryWorkerReport> {
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE

  // Unlike before HT-101 Stage 2b-ii, the sender is no longer a single fixed
  // value known upfront — it varies per claimed row's own mailbox — so
  // `assertLeaseExceedsSenderBound` can no longer run once before listing/
  // claiming anything. It still runs before EACH row's delivery is attempted
  // (below), immediately after that row's own sender is resolved.

  const candidates = await deps.store.listDeliverableThreads({ staleAfterMs, batchSize })

  let sent = 0
  let failed = 0
  let skipped = 0

  for (const candidate of candidates) {
    const claimed = await deps.store.claimThreadForDelivery(candidate.id, leaseMs)
    if (claimed === null) {
      skipped++
      continue
    }

    // HT-101 Stage 2b-ii: resolve THIS claimed thread's own mailbox, not a
    // single global sender — `getConversationByThreadId` is the same lookup
    // HT-70's draft-approval path uses to derive per-conversation state from
    // only a threadId (`src/store/conversations.ts`'s doc comment). A
    // dangling/missing conversation (structurally shouldn't happen — a
    // defensive fallback, not an expected path) resolves as `mailboxId:
    // null`, the same "deployment default" fallback `SenderResolver` gives
    // every pre-2b-i conversation.
    let sender: EmailSender
    try {
      const conversation = await deps.store.getConversationByThreadId(claimed.id)
      const resolved = await deps.senderResolver.resolve(conversation?.mailboxId ?? null)
      // Guard against a From/transport MISMATCH on retry. The row's persisted
      // `fromAddress` is the inbox the ORIGINAL send went out as. Sending when
      // the resolver now yields a DIFFERENT address would put one inbox's
      // address in `From` while another server transmits it — an SPF/DKIM
      // misalignment, and a silent change of authorship on an existing thread.
      // Refuse: treat it as an unresolvable row (failed below, sweep
      // continues), never a mismatched send.
      //
      // An earlier revision justified this by "the mailbox was hard-deleted,
      // so `mailbox_id` became null via ON DELETE SET NULL". That is no longer
      // reachable and never should have been: migration 029 ships
      // `ON DELETE RESTRICT` precisely so a mailbox owning conversations
      // cannot be deleted (review, 2026-07-31). The guard still earns its
      // place for the cases that ARE reachable — a pre-028 conversation whose
      // `mailbox_id` is null resolving to a deployment default that differs
      // from what the original send used, or the default address itself being
      // reconfigured between the first attempt and a retry. For every normal
      // row `resolved.from` equals the persisted `fromAddress` (both are the
      // mailbox's own address), so this only fires on a genuine mismatch.
      if (resolved.from !== claimed.fromAddress) {
        throw new SenderResolutionError(
          'mailbox-not-found',
          `thread ${claimed.id} was sent as ${claimed.fromAddress} but its mailbox now resolves to a different transport (${resolved.from}) — refusing to retry from a mismatched inbox`,
        )
      }
      sender = resolved.sender
      assertLeaseExceedsSenderBound(sender, leaseMs)
    } catch (err) {
      if (!(err instanceof SenderResolutionError)) {
        // A lease/maxSendMs misconfiguration, or a genuinely unexpected
        // fault (e.g. the store call itself failing) — a wiring bug, not a
        // routine per-row outcome; propagate and abort the sweep (see the
        // module doc's "Per-mailbox sender resolution" section).
        throw err
      }
      // This row cannot be sent as currently configured (its mailbox is
      // missing IMAP/SMTP config or credentials, or names no mailbox at
      // all) — an expected, per-row outcome. Treated exactly like a
      // provider send failure: mark 'failed' (or leave 'pending' if even
      // that mark fails) and move on to the next candidate, rather than
      // aborting the whole sweep over one misconfigured mailbox.
      console.error(
        `[runDeliveryWorker] could not resolve a sender for thread ${claimed.id}; marking failed`,
        err,
      )
      try {
        await deps.store.releaseThreadLease(claimed.id, 'failed')
      } catch (markErr) {
        console.error(
          '[runDeliveryWorker] provider sender resolution failed AND marking the thread failed also failed; row left claimed',
          markErr,
        )
      }
      failed++
      continue
    }

    const result = await attemptDeliveryOfClaimedThread(claimed, {
      store: deps.store,
      sender,
      selfEchoGuard: deps.selfEchoGuard,
    })
    if (result.ok) {
      sent++
    } else {
      failed++
    }
  }

  return { attempted: sent + failed, sent, failed, skipped }
}
