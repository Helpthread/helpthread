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
 */

import type { EmailSender } from '../providers/index.js'
import type { ConversationStore } from '../store/conversations.js'
import {
  assertLeaseExceedsSenderBound,
  attemptDeliveryOfClaimedThread,
  DEFAULT_LEASE_MS,
  type SelfEchoGuardDeps,
} from './send.js'

/** Default age a `'pending'` row must reach before this worker considers it stuck rather than merely in flight. */
const DEFAULT_STALE_AFTER_MS = 5 * 60_000

/** Default cap on how many rows one sweep will attempt — a bound on a single invocation's work and blast radius, not a pagination scheme. */
const DEFAULT_BATCH_SIZE = 50

/** Dependencies `runDeliveryWorker` needs, injected so it stays testable against fakes/in-memory stores. */
export interface DeliveryWorkerDeps {
  store: ConversationStore
  sender: EmailSender
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

  // Fail loudly on a lease/sender-timeout misconfiguration BEFORE listing or
  // claiming anything — see this helper's doc comment in send.ts.
  assertLeaseExceedsSenderBound(deps.sender, leaseMs)

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

    const result = await attemptDeliveryOfClaimedThread(claimed, {
      store: deps.store,
      sender: deps.sender,
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
