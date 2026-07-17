/**
 * `createGmailReconcileHandler` — the `QueueMessageHandler<GmailReconcileJob>`
 * that consumes the reconcile jobs the Gmail push webhook (HT-39, `src/api/
 * gmail-webhook.ts`) enqueues onto `GMAIL_RECONCILE_TOPIC`. This is HT-41:
 * specs/mail/gmail-push.md §3's "history reconciliation and raw fetch" — the
 * ONLY place in this transport that calls `users.history.list`/
 * `users.messages.get`. Per inbound-ingestion.md §7, history reconciliation
 * is transport-specific (owned by gmail-push.md, not the provider-agnostic
 * pipeline), which is why this file — like `./gmail-oauth.ts` beside it —
 * lives in `src/mail/` as Gmail-specific orchestration rather than under
 * `src/providers/adapters/gmail/` as a thin single-purpose HTTP adapter.
 *
 * ## What one job run does, in order (gmail-push.md §3-§5)
 *
 * 1. Re-read the mailbox's CURRENT status — never trust the enqueue-time
 *    snapshot the job carries. Not `active` (or gone entirely) → ack,
 *    nothing fetched: a paused/needs_reconnect mailbox must not be swept.
 * 2. Acquire a live access token for it. A failure here is either the
 *    mailbox's grant being genuinely dead (the token service already
 *    marked it `needs_reconnect` — gmail-oauth.ts's `getAccessToken`
 *    contract — so retrying cannot help: ack) or transient (retry).
 * 3. Read the mailbox's STORED cursor — never the job's `historyId` (gmail-
 *    push.md §3: the notification's `historyId` is the NEW watermark;
 *    starting `history.list` from it would return nothing, since nothing
 *    is newer than the current state — the stored cursor is the source of
 *    truth). No stored cursor yet → ack (`watch()` seeds the baseline at
 *    connect — HT-40, gmail-connect.md §4 steps 4-5; HT-42 only renews it,
 *    gmail-connect.md §1, gmail-push.md §6). A push arriving before that
 *    baseline exists is a no-op here, not an error.
 * 4. `history.list` from that cursor. A 404 means the cursor expired
 *    (gmail-push.md §5) — pause the mailbox, do NOT advance the cursor,
 *    ack (a human must rebaseline; retrying a 404 forever helps nobody).
 * 5. For each added message: first the self-echo filter (below) — a
 *    SENT-not-INBOX message is skipped with no `messages.get`/`ingest` call
 *    at all. Otherwise `messages.get?format=raw`. A 404 here means the
 *    message was deleted between list and get — skip it, nothing to ingest
 *    or retry. Raw bytes at or under `maxInlineRawBytes` are handed to
 *    `ingest` inline; larger ones are written to `blobStore` first and
 *    handed over as a `blobRef` — the OOM guard on the RAW MESSAGE itself
 *    (`RawMessageContent`'s own module doc, `src/providers/inbound-
 *    email.ts`, names exactly this "one large message inside a Gmail
 *    history batch" scenario), distinct from — and upstream of — the
 *    ingest pipeline's own, separate attachment-blob writes
 *    (inbound-ingestion.md §3).
 * 6. Advance the cursor to the new watermark, but ONLY if every message's
 *    ingest outcome is TERMINAL and durably ledgered: `stored`,
 *    `suppressed`, or `dead-letter` (see below for why `dead-letter` is
 *    included here — gmail-push.md §4's prose names only
 *    `stored`/`suppressed`). Any `failed`/`in-progress` outcome blocks the
 *    advance and the WHOLE batch is retried next attempt — dedup
 *    (inbound-ingestion.md §4, keyed on `(mailboxId, providerMessageId)`)
 *    makes re-listing/re-fetching the already-terminal messages free, so
 *    biasing to "retry the batch" over "skip the stuck message" never
 *    drops anything.
 *
 * Any OTHER unexpected throw (network, timeout, a non-404 non-2xx from the
 * Gmail client, a `blobStore`/`ingest`/store failure) is caught at the top
 * and reported as `{ kind: 'retry' }` — never as `ack`, and never after
 * advancing the cursor.
 *
 * ## The reconciliation lease (HT-48; gmail-push.md §6)
 *
 * Between step 3 (a confirmed, non-null stored cursor) and step 4
 * (`history.list`), this run claims `mailboxId`'s reconciliation lease
 * (`GmailWatchStateStore.claimReconcileLease`, `claimed_until` on
 * `gmail_watch_state`, migration 016) — the inbound analogue of the
 * outbound delivery lease (`ConversationStore.claimThreadForDelivery`,
 * sending.md §3a). It exists ONLY to stop a push-triggered reconcile
 * (HT-41) and the daily sweep (HT-42) from doing the SAME `history.list`/
 * `messages.get` work concurrently when both land on one mailbox at once —
 * gmail-push.md §6 is explicit this is an efficiency guard, not a
 * correctness one: step 6's cursor-advance rule and the ingest pipeline's
 * dedup on `(mailboxId, providerMessageId)` (inbound-ingestion.md §4)
 * already make either ordering safe with no lease at all. Different
 * mailboxes never contend — the lease is keyed by `mailboxId`.
 *
 * A run that cannot claim the lease (another holder's `claimed_until` is
 * still in the future) does NOT ack — it returns `{ kind: 'retry',
 * backoffSeconds: DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS }` and does
 * no Gmail work of its own this attempt.
 *
 * ## Why a failed claim retries instead of acking (correction, flagged in review)
 *
 * An earlier version of this handler acked on a failed claim, reasoning
 * "the holder will advance the cursor — there is nothing this run needs to
 * do that the holder won't already do." That reasoning is false for
 * anything that arrives AFTER the holder's `history.list` snapshot: the
 * holder's `listAddedMessageIds` call fixes its batch and its eventual
 * `newHistoryId` the moment it runs; a message that lands in Gmail's
 * history a moment later is invisible to that in-flight run and will not
 * be swept up by its cursor advance. Concretely — a sweep-triggered run
 * claims the lease and lists history up to `H1`, then spends the
 * fetch/ingest phase on that batch; a NEW customer message arrives at
 * `H2 > H1` and Gmail pushes a notification for it; that push's reconcile
 * job is consumed by a second run WHILE the first still holds the lease,
 * so the second run's claim fails. Acking there — as this handler used
 * to — discards that notification outright: the holder's `setCursor` only
 * advances to `H1`, so the message at `H2` is not reconciled until the
 * NEXT trigger (a further push, or the daily sweep, gmail-push.md §6) —
 * up to ~24h of silent added latency on an otherwise-quiet mailbox. This
 * is a correctness-adjacent latency regression, not covered by the
 * `(mailboxId, providerMessageId)` ingest dedup (inbound-ingestion.md §4),
 * which guards against DOUBLING work, not against a run's snapshot simply
 * predating the message. Returning `retry` with a short backoff instead
 * means the SAME job is redelivered after the holder has very likely
 * released (see {@link DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS} for
 * how the backoff is sized against `reconcileLeaseMs` and the queue's own
 * `maxAttempts` dead-letter ceiling); that retried attempt claims the
 * now-free lease and runs its OWN `history.list` from the cursor the
 * holder just advanced to, which trivially and cheaply picks up `H2`. The
 * lease therefore remains a pure efficiency guard in the COMMON case (no
 * new mail mid-run: the retry's `history.list` comes back empty, `newHistoryId`
 * unchanged) while no longer silently dropping the promptness of the RARE
 * arrives-mid-run case.
 *
 * The lease is released in a `finally` wrapped around steps 4-6, so it is
 * released on every path out of that block: the happy-path ack, the
 * expired-cursor pause, the blocked-retry (non-terminal ingest outcome),
 * AND an unexpected thrown error (network, Gmail client, ingest, store) —
 * release happens BEFORE the throw propagates to this handler's own
 * top-level catch. This is a deliberate choice: because the lease is purely
 * an efficiency guard (never a correctness one), the failure mode it must
 * never produce is "a mailbox that just threw is locked out of
 * reconciliation until the lease naturally expires" — releasing
 * immediately on every exit path, including a throw, means the NEXT
 * trigger (a fresh push, or tomorrow's sweep) can reconcile this mailbox
 * right away rather than waiting out `reconcileLeaseMs`. The release call
 * itself is wrapped in its own try/catch that only logs — a release
 * failure (a genuine DB error) must not override this run's own outcome
 * (`ack`/`retry`) with something else, and IS still covered by the lease's
 * own expiry as a backstop for the one case a `finally` block cannot help:
 * the process being killed outright before the `finally` ever runs.
 *
 * The release itself is now scoped to the exact lease this run was granted
 * (`GmailWatchStateStore.claimReconcileLease`'s returned token, passed back
 * to `releaseReconcileLease`) rather than an unconditional clear — see that
 * store module's doc comment for the stale-holder scenario (an overrunning
 * run's release clobbering a legitimate successor's live lease) this
 * closes.
 *
 * ## The self-echo filter (HT-50)
 *
 * **Live-proven failure (2026-07-17, first HT-44 live run):** `history.list`
 * surfaces the mailbox's OWN outbound sends — an Agent's reply, sent through
 * Gmail — as `messagesAdded` entries exactly like a genuine inbound message.
 * Ingesting one spawns a ghost `new` conversation "from" the desk's own
 * address, because nothing upstream of `ingest` had ever distinguished "a
 * message that arrived" from "a message we just sent that Gmail is
 * reflecting back through history."
 *
 * The fix: before `messages.get`/`ingest` for a given added message, check
 * the `labelIds` {@link GmailHistoryClient.listAddedMessageIds} already
 * carried for it (`../providers/adapters/gmail/history.ts`'s module doc) —
 * skip when `SENT` is present and `INBOX` is not, OR when `DRAFT` is present
 * at all (see {@link isSelfEchoMessage}). This is a pure Gmail-label check,
 * not a mail-semantics decision: it runs entirely on transport metadata,
 * before the raw bytes are even fetched, so it never touches
 * `parseInboundEmail` or `decideThreading` (charter invariant #5) and is
 * unrelated to inbound-ingestion.md §5's own (different) loop-suppression
 * rule, which runs INSIDE the pipeline on a verifiable Message-ID/reply-token
 * correlation — that rule exists for the "our mail bounced or was
 * auto-answered" case; this one exists for "Gmail's own history conflates
 * sent and received."
 *
 * A self-ADDRESSED message (an Agent emailing the shared mailbox itself)
 * carries BOTH labels — `SENT` (we sent it) and `INBOX` (it also landed in
 * the inbox) — and is deliberately NOT skipped: it is exactly the shape of a
 * customer message and Gmail gives us no other signal to tell the two apart
 * at the transport layer. Getting this case wrong in the other direction —
 * skipping anything with `SENT` at all — would silently drop that message
 * forever, which invariant #1 forbids.
 *
 * **`DRAFT` (review round 2, HT-50):** the `SENT`/`INBOX` check alone leaves
 * a gap the initial version of this filter did not cover — an Agent hitting
 * Reply in the Gmail web UI and typing for a while. Gmail autosaves that
 * compose as a NEW message id on every pause, each carrying `labelIds:
 * ["DRAFT"]` (no `SENT`, no `INBOX`) and each surfacing in `history.list`
 * before the Agent ever sends anything — every autosave would otherwise be
 * ingested as a half-written "customer" message, potentially several per
 * reply. Unlike the `SENT`/`INBOX` case this has no ambiguous edge to
 * protect: genuine inbound mail can never carry the system `DRAFT` label, so
 * skipping on its presence alone is safe in the drop direction with no risk
 * to invariant #1. The final SENT copy (a different message id) is still
 * caught by the existing `SENT`-without-`INBOX` check.
 *
 * **Alternative considered and rejected:** track the Gmail message id
 * `users.messages.send` returns (`../providers/adapters/gmail/sender.ts`)
 * and skip exactly those ids on reconcile. This is more precise for sends
 * this engine itself issued, but it has a hole the label filter doesn't: an
 * Agent replying directly from the Gmail web UI (not through Helpthread's
 * own send path) produces a message this engine never minted an id for, so
 * it would sail through un-filtered and become the exact same ghost
 * conversation. `SENT`-not-`INBOX` (plus the `DRAFT` check above) catches
 * BOTH origins — our own API sends and an Agent's direct Gmail-UI replies,
 * autosaved drafts included — because Gmail applies these labels identically
 * regardless of which client sent or drafted the mail.
 *
 * A skipped message is treated exactly like the existing "deleted between
 * list and get" case (step 5): no `ingest` call, so no `inbound_deliveries`
 * ledger row is ever created for it, and it contributes no outcome to the
 * batch that step 6's cursor-advance check inspects (gmail-push.md §4 scopes
 * "the batch" to messages actually handed to the pipeline for exactly this
 * reason) — the cursor still advances past it normally, and it can never
 * itself block or reclaim anything (nothing was ever leased or left
 * `in-progress` on its behalf, so HT-45's stuck-received reclaim has
 * nothing to reclaim here).
 *
 * **On the `SENT`+`INBOX` snapshot assumption (review round 2, HT-50):**
 * this filter's `SENT`-without-`INBOX` check assumes a self-addressed send's
 * `messagesAdded` record carries BOTH labels in one snapshot. If Gmail ever
 * instead records `SENT` at send time and applies `INBOX` via a LATER,
 * separate history event, this check alone would misread the message as a
 * pure self-echo and skip it — a silent, permanent drop, which invariant #1
 * forbids. `../providers/adapters/gmail/history.ts`'s `listAddedMessageIds`
 * hardens against exactly that ordering by also reading `labelsAdded`
 * history records for the same message id within the listed window and
 * merging their added-label deltas in — see that module's doc for the
 * mechanism. This has not been confirmed against a live self-addressed send
 * (flagged in this ticket's report as still open); the hardening below is a
 * defense against the *possible* split-record ordering, not a replacement
 * for that live verification.
 *
 * ## Never drop a message (charter §2; gmail-push.md §4)
 *
 * The cursor is the only thing that can make a message permanently
 * unreachable — advancing it past a message this run failed to durably
 * record would silently drop that message forever (the next
 * `history.list` starts AFTER it). Every path that cannot confirm every
 * message terminal returns `retry` WITHOUT advancing; the worst case is
 * redundant re-listing/re-fetching, never a skipped message.
 *
 * ## `dead-letter` advances the cursor — a deliberate extension beyond
 * gmail-push.md §4's literal prose
 *
 * gmail-push.md §4 says the cursor "advances only after the ingest
 * pipeline confirms every message HANDED TO IT is `stored` or `suppressed`,"
 * without mentioning `dead-letter`. This handler treats
 * `dead-letter` as ALSO cursor-advancing, because `dead-letter` (inbound-
 * ingestion.md §4) is itself a TERMINAL, durably-recorded ledger outcome —
 * "a message that exhausts its retry budget lands in dead-letter for
 * manual review — visible and recoverable, never silently dropped." The
 * never-drop invariant is about the message being durably recorded
 * SOMEWHERE reachable, not about it reaching `stored` specifically; a
 * dead-lettered message already satisfies that. Treating `dead-letter` as
 * NON-advancing instead would wedge the cursor on that one poison message
 * forever (every future reconcile run re-lists the same batch, re-fetches
 * the same message, gets the same permanent `dead-letter` outcome again,
 * and never advances past it) — which would also block every OTHER,
 * healthy message behind it in history order from ever being reached by a
 * FRESH batch. Flagged here explicitly for review, per this ticket's brief.
 */

import type { GmailReconcileJob } from '../api/gmail-webhook.js'
// Type-only: engine modules never take a RUNTIME dependency on a concrete
// adapter (src/providers/README.md's rule). The interface type is erased at
// compile time; the concrete `createGmailHistoryClient` is wired in at the
// composition root and injected as `createHistoryClient` below.
import type { GmailHistoryClient } from '../providers/adapters/gmail/index.js'
import type { BlobStore, RawInboundMessage, RawMessageContent } from '../providers/index.js'
import type { QueueHandlerResult, QueueMessage, QueueMessageHandler } from '../providers/queue.js'
import type { GmailWatchStateStore } from '../store/gmail-watch-state.js'
import type { MailboxStore } from '../store/mailboxes.js'
import type { GmailOAuthTokenService } from './gmail-oauth.js'
import type { IngestOutcome } from './ingest.js'

/**
 * Raw messages at or under this size (decoded bytes) are handed to
 * `ingest` inline; larger ones are written to `blobStore` first (see the
 * module doc, step 5). Not pinned to any spec number — chosen as a
 * judgment call (flagged in this ticket's report): ordinary support-desk
 * email (plain text/HTML, maybe a small inline image) is typically tens of
 * KB, so the inline fast path covers the overwhelming majority of
 * messages; anything past 1 MiB is exactly the "large message" case
 * `RawMessageContent.blobRef` exists for (`src/providers/inbound-
 * email.ts`'s module doc).
 */
export const DEFAULT_MAX_INLINE_RAW_BYTES = 1_000_000

/**
 * How long one mailbox's reconciliation lease (module doc's "The
 * reconciliation lease" section, HT-48) is held for. Not pinned to any spec
 * number — chosen as a judgment call (flagged in this ticket's report),
 * matching `./delivery-worker.ts`'s `DEFAULT_STALE_AFTER_MS` (5 minutes):
 * long enough to cover a realistic `history.list` page plus a batch of
 * `messages.get`/`ingest` calls, short enough that a crashed holder (the
 * one case the `finally`-release in the module doc cannot reach) does not
 * lock a mailbox out of reconciliation for long. Because this is a pure
 * efficiency guard (never a correctness one — module doc), the exact value
 * only trades a little redundant Gmail API work against lock-out latency,
 * never data safety.
 */
export const DEFAULT_RECONCILE_LEASE_MS = 5 * 60_000

/**
 * `backoffSeconds` hint returned with `{ kind: 'retry' }` when a run cannot
 * claim the reconciliation lease (module doc's "Why a failed claim retries
 * instead of acking"). Not pinned to any spec number — chosen as a judgment
 * call (flagged in this ticket's report), sized against TWO other numbers
 * this file does not otherwise control:
 *
 * - `DEFAULT_RECONCILE_LEASE_MS` (5 minutes) — the longest a legitimate
 *   holder can keep the lease before releasing it.
 * - The queue adapter's retry-until-dead-letter ceiling
 *   (`createPostgresQueue`'s `maxAttempts`, default 5, and its exponential
 *   backoff growth — `src/providers/adapters/postgres-queue/index.ts`):
 *   returning `backoffSeconds: b` makes `b` the exponential BASE for this
 *   job's own subsequent retries (`b, 2b, 4b, 8b` before the 5th and final
 *   attempt), so the total window this job keeps retrying before the queue
 *   gives up and dead-letters it is `15b` seconds.
 *
 * `25` seconds makes that total window `375s` (~6.25 minutes) — comfortably
 * longer than `DEFAULT_RECONCILE_LEASE_MS`, so a claim that keeps losing the
 * race against a legitimately slow holder still gets one attempt after that
 * holder is GUARANTEED to have released (its lease cannot outlive
 * `reconcileLeaseMs`). Even in the pathological case where every retry
 * still loses the race and the job is eventually dead-lettered, no message
 * is dropped: cursor-advance (step 6) and ingest dedup (inbound-
 * ingestion.md §4) mean the next trigger — a further push, or the daily
 * sweep (gmail-push.md §6) — reconciles this mailbox from wherever the
 * holder left the cursor, exactly as before this lease existed at all. This
 * constant only trades a little redundant queue churn against how quickly a
 * message that arrived mid-holder-run gets reconciled, never data safety.
 * If `reconcileLeaseMs` is overridden well above its default at the
 * composition root, this constant (or the queue's own `maxAttempts`/backoff
 * options) should be reconsidered alongside it.
 */
export const DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS = 25

/** Dependencies {@link createGmailReconcileHandler} needs. */
export interface GmailReconcileHandlerDeps {
  /** Resolves a live Gmail API access token for one mailbox at a time (`./gmail-oauth.ts`). */
  tokenService: GmailOAuthTokenService

  /** Mailbox lookups + lifecycle-status mutations (`../store/mailboxes.ts`). */
  mailboxStore: MailboxStore

  /** The per-mailbox Gmail history cursor (`../store/gmail-watch-state.ts`). */
  watchStateStore: GmailWatchStateStore

  /**
   * Where an oversized raw message is written before being handed to
   * `ingest` as a `blobRef` (module doc, step 5). This is a DIFFERENT use
   * of `BlobStore` than any attachment blob the ingest pipeline itself
   * writes after parsing (inbound-ingestion.md §3) — this one holds the
   * whole unparsed raw message and is written by THIS transport, before
   * `ingest` ever runs.
   */
  blobStore: BlobStore

  /**
   * Runs the ingest pipeline for one raw message. A production
   * composition root passes `(raw) => ingestInboundMessage(raw,
   * ingestDeps)` (`./ingest.js`); tests pass a fake returning canned
   * outcomes directly, with no need to construct a full `IngestDeps` (db,
   * ledger store, blob store, keyring) just to exercise this handler's OWN
   * control flow — see this ticket's report for why `ingest` is injected
   * directly rather than `IngestDeps`.
   */
  ingest: (raw: RawInboundMessage) => Promise<IngestOutcome>

  /**
   * Builds a {@link GmailHistoryClient} bound to a per-mailbox
   * `getAccessToken`. REQUIRED and injected — deliberately NOT defaulted to
   * the concrete `createGmailHistoryClient` here, because `src/providers/
   * README.md`'s rule is that engine modules never `import` an adapter (they
   * only ever see the interface type). The composition root (HT-43) is where
   * the real `createGmailHistoryClient` (`../providers/adapters/gmail/`) is
   * constructed and wired in — exactly as HT-39's `gmail-webhook.ts` takes
   * its `verifySignature` closure with no default, for this same rule.
   * Tests pass a factory returning a fake, faking either at the client level
   * or (via a real client + a fake `fetchImpl`) the fetch level.
   */
  createHistoryClient: (getAccessToken: () => Promise<string>) => GmailHistoryClient

  /** See {@link DEFAULT_MAX_INLINE_RAW_BYTES}. */
  maxInlineRawBytes?: number

  /** See {@link DEFAULT_RECONCILE_LEASE_MS}. */
  reconcileLeaseMs?: number

  /** See {@link DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS}. */
  reconcileLeaseRetryBackoffSeconds?: number
}

/** Build the `QueueMessageHandler<GmailReconcileJob>`. See the module doc for the full control flow. */
export function createGmailReconcileHandler(
  deps: GmailReconcileHandlerDeps,
): QueueMessageHandler<GmailReconcileJob> {
  const {
    tokenService,
    mailboxStore,
    watchStateStore,
    blobStore,
    ingest,
    createHistoryClient,
    maxInlineRawBytes = DEFAULT_MAX_INLINE_RAW_BYTES,
    reconcileLeaseMs = DEFAULT_RECONCILE_LEASE_MS,
    reconcileLeaseRetryBackoffSeconds = DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS,
  } = deps

  return async (message: QueueMessage<GmailReconcileJob>): Promise<QueueHandlerResult> => {
    const { mailboxId, historyId: notifiedHistoryId } = message.payload
    try {
      return await reconcileOneMailbox(mailboxId, notifiedHistoryId, {
        tokenService,
        mailboxStore,
        watchStateStore,
        blobStore,
        ingest,
        createHistoryClient,
        maxInlineRawBytes,
        reconcileLeaseMs,
        reconcileLeaseRetryBackoffSeconds,
      })
    } catch (err) {
      // Any unexpected throw (network, timeout, a non-404 non-2xx from the
      // Gmail client, a store/blob/ingest failure) is retry semantics —
      // never advance the cursor on an unhandled failure (module doc). Safe
      // to log err's message: every thrown error reachable here (Gmail
      // client errors, gmail-oauth.ts's own errors) is documented to never
      // include the access token — see history.ts's and gmail-oauth.ts's
      // module docs.
      logReconcileEvent('error', {
        mailboxId,
        outcome: 'retry',
        reason: 'unexpected-error',
        error: err instanceof Error ? err.message : String(err),
      })
      return { kind: 'retry' }
    }
  }
}

/** Dependencies {@link reconcileOneMailbox} needs — the same set as {@link GmailReconcileHandlerDeps}, with defaults already resolved. */
interface ReconcileDeps {
  tokenService: GmailOAuthTokenService
  mailboxStore: MailboxStore
  watchStateStore: GmailWatchStateStore
  blobStore: BlobStore
  ingest: (raw: RawInboundMessage) => Promise<IngestOutcome>
  createHistoryClient: (getAccessToken: () => Promise<string>) => GmailHistoryClient
  maxInlineRawBytes: number
  reconcileLeaseMs: number
  reconcileLeaseRetryBackoffSeconds: number
}

/** Run steps 1-6 (module doc) for one mailbox's reconcile job. */
async function reconcileOneMailbox(
  mailboxId: string,
  notifiedHistoryId: string,
  deps: ReconcileDeps,
): Promise<QueueHandlerResult> {
  const {
    tokenService,
    mailboxStore,
    watchStateStore,
    blobStore,
    ingest,
    createHistoryClient,
    maxInlineRawBytes,
    reconcileLeaseMs,
    reconcileLeaseRetryBackoffSeconds,
  } = deps

  // --- Step 1: re-read CURRENT status — never trust the job's snapshot. ---
  const mailbox = await mailboxStore.getMailboxById(mailboxId)
  if (mailbox === null || mailbox.status !== 'active') {
    logReconcileEvent('info', {
      mailboxId,
      outcome: 'ack',
      reason: 'mailbox-not-active',
      status: mailbox?.status ?? 'unknown',
    })
    return { kind: 'ack' }
  }

  // --- Step 2: acquire a token; distinguish dead-grant from transient. ---
  const getAccessToken = () => tokenService.getAccessToken(mailboxId)
  try {
    await getAccessToken()
  } catch {
    // Deliberately never logs the caught error's own content here — see
    // the module doc's "never log or leak an access token" discipline;
    // the mailbox's CURRENT status (re-read below) is the authoritative
    // signal, not this error's message.
    const current = await mailboxStore.getMailboxById(mailboxId)
    if (current?.status === 'needs_reconnect') {
      logReconcileEvent('warn', {
        mailboxId,
        outcome: 'ack',
        reason: 'token-acquisition-failed-needs-reconnect',
      })
      return { kind: 'ack' }
    }
    logReconcileEvent('warn', {
      mailboxId,
      outcome: 'retry',
      reason: 'token-acquisition-failed-transient',
    })
    return { kind: 'retry' }
  }

  // --- Step 3: the STORED cursor, never the job's historyId. ---
  const cursor = await watchStateStore.getCursor(mailboxId)
  if (cursor === null) {
    logReconcileEvent('warn', {
      mailboxId,
      outcome: 'ack',
      reason: 'no-baseline-cursor',
      notifiedHistoryId,
      note: 'watch() (HT-40, gmail-connect.md §4) seeds the baseline cursor at connect; HT-42 only renews it — a push before that baseline exists is a no-op',
    })
    return { kind: 'ack' }
  }

  // --- Step 3a: claim the reconciliation lease (HT-48; module doc's "The
  // reconciliation lease" section). A run that cannot claim it retries
  // shortly rather than acking — module doc's "Why a failed claim retries
  // instead of acking" explains why acking here can silently drop a
  // message that arrived after the holder's own history.list snapshot. ---
  const leaseToken = await watchStateStore.claimReconcileLease(mailboxId, reconcileLeaseMs)
  if (leaseToken === null) {
    logReconcileEvent('info', {
      mailboxId,
      outcome: 'retry',
      reason: 'reconcile-lease-held',
      backoffSeconds: reconcileLeaseRetryBackoffSeconds,
      note: "another in-flight reconcile (push or sweep) holds this mailbox lease; retrying shortly rather than acking, so anything past the holder's own history.list snapshot is not silently dropped — gmail-push.md §6, HT-48",
    })
    return { kind: 'retry', backoffSeconds: reconcileLeaseRetryBackoffSeconds }
  }

  try {
    // --- Step 4: history.list from the stored cursor. ---
    const client = createHistoryClient(getAccessToken)
    const listed = await client.listAddedMessageIds(cursor)
    if (listed.kind === 'expired') {
      await mailboxStore.markPaused(mailboxId)
      logReconcileEvent('warn', {
        mailboxId,
        outcome: 'ack',
        reason: 'cursor-expired',
        cursor,
        note: 'cursor expired (404); mailbox paused for manual rebaseline per gmail-push.md §5',
      })
      return { kind: 'ack' }
    }

    // --- Step 5: filter, then fetch + ingest each added message, in order. ---
    const outcomes: IngestOutcome[] = []
    for (const { id: messageId, labelIds } of listed.messages) {
      if (isSelfEchoMessage(labelIds)) {
        // Either the mailbox's own outbound send reflected back through
        // history, or an Agent's in-progress Gmail-UI draft — skip before
        // ever calling messages.get/ingest (module doc's "The self-echo
        // filter (HT-50)"). No ledger row, no outcome, no effect on the
        // cursor advance below.
        logReconcileEvent('info', {
          mailboxId,
          outcome: 'skip',
          reason: labelIds.includes('DRAFT') ? 'draft' : 'self-echo',
          providerMessageId: messageId,
          labelIds,
        })
        continue
      }

      const fetched = await client.getRawMessage(messageId)
      if (fetched === null) {
        // Deleted between list and get — nothing to ingest, nothing to
        // retry; skip (module doc, step 5).
        continue
      }

      const content = await buildRawMessageContent(fetched.rawBytes, {
        mailboxId,
        messageId,
        maxInlineRawBytes,
        blobStore,
      })

      const raw: RawInboundMessage = {
        content,
        mailboxId,
        providerMessageId: messageId,
        receivedAt: fetched.receivedAt,
      }
      outcomes.push(await ingest(raw))
    }

    // --- Step 6: advance the cursor iff every outcome is terminal & ledgered. ---
    const blocking = outcomes.find((o) => o.kind === 'failed' || o.kind === 'in-progress')
    if (blocking !== undefined) {
      logReconcileEvent('warn', {
        mailboxId,
        outcome: 'retry',
        reason: 'non-terminal-ingest-outcome',
        blockingOutcomeKind: blocking.kind,
        blockingProviderMessageId: blocking.providerMessageId,
        batchSize: listed.messages.length,
      })
      return { kind: 'retry' }
    }

    await watchStateStore.setCursor(mailboxId, listed.newHistoryId)
    logReconcileEvent('info', {
      mailboxId,
      outcome: 'ack',
      reason: 'reconciled',
      messageCount: listed.messages.length,
      previousCursor: cursor,
      newHistoryId: listed.newHistoryId,
    })
    return { kind: 'ack' }
  } finally {
    // Release on every exit from the try above — success, the
    // expired-cursor pause, the blocked-retry, AND an unexpected throw
    // (which this `finally` runs BEFORE the exception propagates to
    // createGmailReconcileHandler's own top-level catch). See the module
    // doc's "The reconciliation lease" section for why this must never be
    // conditioned on the outcome: the lease is a pure efficiency guard, so
    // a mailbox that just threw must not be locked out of reconciliation
    // until reconcileLeaseMs elapses.
    try {
      // Scoped to `leaseToken` — the exact lease THIS run was granted — so
      // an overrunning run's release can never clobber a legitimate
      // successor's live lease (`GmailWatchStateStore.releaseReconcileLease`'s
      // doc comment for the stale-holder scenario this closes).
      await watchStateStore.releaseReconcileLease(mailboxId, leaseToken)
    } catch (releaseErr) {
      // A release failure must not override this run's own outcome (ack/
      // retry, or the throw already in flight) — logged only. The lease's
      // own expiry remains the backstop (module doc).
      logReconcileEvent('error', {
        mailboxId,
        outcome: 'lease-release-failed',
        reason: 'unexpected-error',
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      })
    }
  }
}

/**
 * True when `labelIds` (from `history.list`'s per-message data,
 * `../providers/adapters/gmail/history.ts`) mark this as something that was
 * never genuinely received mail — see the module doc's "The self-echo
 * filter (HT-50)" section for the full reasoning, including why a
 * self-addressed message (both `SENT` and `INBOX`) is deliberately NOT
 * matched here. Two independent conditions, either sufficient on its own:
 *
 * - `SENT` without `INBOX` — the mailbox's own outbound send, reflected
 *   back through history exactly like a genuine inbound message.
 * - `DRAFT` present at all — an Agent's in-progress Gmail-UI compose or
 *   reply. Gmail autosaves a draft as a NEW `DRAFT`-labeled message id on
 *   every edit, each one surfacing in `history.list` before anything is
 *   sent; unlike the `SENT`/`INBOX` case there is no ambiguous edge here —
 *   genuine inbound mail can never carry the system `DRAFT` label, so this
 *   check is safe in the drop direction with no risk of losing a real
 *   message (invariant #1).
 */
function isSelfEchoMessage(labelIds: string[]): boolean {
  if (labelIds.includes('DRAFT')) return true
  return labelIds.includes('SENT') && !labelIds.includes('INBOX')
}

/**
 * Build the `RawMessageContent` handed to `ingest` for one fetched raw
 * message: `inline` at or under `maxInlineRawBytes`, otherwise written to
 * `blobStore` first — this ticket's OOM guard on the RAW MESSAGE itself
 * (module doc, step 5).
 */
async function buildRawMessageContent(
  rawBytes: Uint8Array,
  ctx: { mailboxId: string; messageId: string; maxInlineRawBytes: number; blobStore: BlobStore },
): Promise<RawMessageContent> {
  if (rawBytes.byteLength <= ctx.maxInlineRawBytes) {
    return { kind: 'inline', bytes: rawBytes }
  }

  // Mailbox-namespaced (src/providers/blob.ts's key-namespacing contract).
  // This is a DIFFERENT blob than any attachment blob the ingest pipeline
  // writes after parsing (src/providers/inbound-email.ts's module doc).
  const blobKey = `inbound/raw/${ctx.mailboxId}/${ctx.messageId}`
  await ctx.blobStore.put(blobKey, rawBytes, {
    contentType: 'message/rfc822',
    contentLength: rawBytes.byteLength,
  })
  return { kind: 'blobRef', blobKey }
}

/**
 * Emit one structured, JSON-parseable log line for a reconcile decision —
 * mirrors `src/mail/ingest.ts`'s `logIngestEvent`: no custom logger
 * abstraction exists in this codebase yet (CHARTER.md §4: serverless,
 * platform-log-aggregated), so this is deliberately a plain `console.*` of
 * a JSON-serializable object. NEVER pass an access token or any raw
 * caught-error object into `record` — see the module doc's discipline
 * around the token-acquisition catch block, which passes no error content
 * at all.
 */
function logReconcileEvent(
  level: 'info' | 'warn' | 'error',
  record: Record<string, unknown>,
): void {
  const line = JSON.stringify({ event: 'gmail_reconcile', ...record })
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.info(line)
  }
}
