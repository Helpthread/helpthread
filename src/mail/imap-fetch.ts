/**
 * `runImapFetch` — the scheduled-fetch cron for per-inbox IMAP mailboxes
 * (HT-101 Stage 2a-ii; specs/mail/mailbox-connection.md §5's "Inbound —
 * bounded scheduled fetch" section). The IMAP analogue of
 * `./gmail-reconcile.ts`'s `reconcileOneMailbox`, replayed here per active
 * IMAP mailbox: claim the lease, fetch bounded, ingest each message, and
 * advance the cursor ONLY once every message is terminal. This file is the
 * Stage 2 wiring `../providers/adapters/imap/fetch.ts`'s module doc
 * anticipated: "Stage 2 wires those in exactly the way gmail-reconcile.ts
 * wires Gmail's."
 *
 * ## Per-mailbox failure isolation (mirrors `./gmail-watch-maintenance.ts`)
 *
 * `runImapFetch` lists every ACTIVE mailbox with `provider === 'imap'`, then
 * runs {@link fetchOneMailbox} for each inside its OWN try/catch — one
 * mailbox's unexpected throw (a store blip, a thrown-not-caught client
 * error) never aborts the batch, exactly like
 * `runGmailWatchMaintenance`/`maintainOneMailbox`'s split.
 *
 * ## The fetch lease — never-double-fetch, not correctness
 *
 * `ImapWatchStateStore.claimFetchLease`/`releaseFetchLease`
 * (`../store/imap-watch-state.ts`) prevent an overlapping cron invocation
 * from fetching the same UID range twice — released in a `finally` around
 * every step past the claim, so a mailbox that throws mid-fetch is never
 * locked out until the lease naturally expires (mirrors
 * `./gmail-reconcile.ts`'s reconciliation lease "release on every exit path"
 * discipline). A `null` claim (another invocation holds it, OR this mailbox
 * has no `imap_watch_state` row yet — `ImapWatchStateStore.claimFetchLease`'s
 * own doc) is a silent skip: nothing to do this tick either way.
 *
 * ## SACRED — UIDVALIDITY reset: pause, never re-ingest, never advance
 *
 * `fetchImapInboundMessages`'s `uidValidityReset: true` means the server
 * renumbered this mailbox's UIDs since the stored cursor was recorded (RFC
 * 3501 §2.3.1.1) — every stored UID is now meaningless. This is the IMAP
 * analogue of Gmail's expired-cursor 404 (`./gmail-reconcile.ts` step 4:
 * "pause the mailbox, do NOT advance the cursor... a human must rebaseline"),
 * but the failure mode on the WRONG choice is worse here: `fetchImap
 * InboundMessages` itself already documents that a reset makes it rebuild
 * from UID 1 under the new epoch (its own module doc's "UIDVALIDITY
 * handling" section) — if this cron blindly ingested that rebuilt batch, it
 * would RE-INGEST the mailbox's entire visible history under the new epoch's
 * UIDs. Unlike Gmail (where the ingest ledger key is the STABLE
 * `providerMessageId` `messages.get` always returns for the same physical
 * message, so a redundant reconcile is deduped for free), IMAP's
 * `providerMessageId` is `imap:<uidValidity>:<uid>`
 * (`../providers/adapters/imap/fetch.ts`'s `providerMessageIdFor` — flagged
 * there as specs/mail/mailbox-connection.md's still-open unresolved question
 * #2) — the SAME physical message re-fetched under a NEW `uidValidity`
 * mints a DIFFERENT id, so `InboundDeliveryStore`'s `(mailboxId,
 * providerMessageId)` dedup (inbound-ingestion.md §4) would NOT catch it:
 * every message would be stored again as if new. So this cron never ingests
 * on a reset at all — it marks the mailbox `paused` (the same operator-
 * visible, resolvable state `MailboxStore.markPaused` already means for
 * Gmail's cursor-expiry case) and returns without touching the cursor,
 * surfacing the reset for manual rebaseline rather than silently reseeding
 * (or silently duplicating) anything.
 *
 * ## SACRED — the cursor advances on COMMIT, not on fetch
 *
 * Mirrors `./gmail-reconcile.ts` step 6 EXACTLY: every fetched message is
 * handed to `ingest` in order, and the cursor advances to
 * `fetchImapInboundMessages`'s `newCursor` ONLY if every resulting
 * `IngestOutcome` is TERMINAL — `stored`, `suppressed`, or `dead-letter` all
 * count (a `dead-letter`ed message is still durably, recoverably recorded —
 * see `./gmail-reconcile.ts`'s module doc, "`dead-letter` advances the
 * cursor," for why blocking on it would wedge every healthy message behind
 * it in UID order forever). Any `failed`/`in-progress` outcome blocks the
 * advance entirely and the WHOLE batch is retried next tick — the ingest
 * pipeline's own dedup on `(mailboxId, providerMessageId)` (inbound-
 * ingestion.md §4) makes re-fetching the already-terminal messages in that
 * retried batch free, so biasing toward "retry the batch" over "skip past
 * the stuck message" never drops anything (charter invariant #1).
 */

import {
  DEFAULT_MAX_PER_INVOCATION,
  fetchImapInboundMessages,
  type ImapClient,
  type ImapClientOptions,
} from '../providers/adapters/imap/index.js'
import type { RawInboundMessage } from '../providers/index.js'
import type { ImapConfigStore } from '../store/imap-config.js'
import type { ImapCredentialStore } from '../store/imap-credentials.js'
import type { ImapWatchStateStore } from '../store/imap-watch-state.js'
import type { MailboxStore } from '../store/mailboxes.js'
import type { IngestOutcome } from './ingest.js'

/**
 * Default fetch lease duration — mirrors `./gmail-reconcile.ts`'s
 * `DEFAULT_RECONCILE_LEASE_MS` (5 minutes): long enough to cover a realistic
 * IMAP connect + bounded fetch + a batch of `ingest` calls, short enough
 * that a crashed holder (the one case the `finally`-release cannot reach)
 * does not lock a mailbox out of fetching for long. A pure efficiency guard
 * (module doc), so the exact value only trades a little redundant IMAP work
 * against lock-out latency, never data safety.
 */
export const DEFAULT_IMAP_FETCH_LEASE_MS = 5 * 60_000

/** Dependencies {@link runImapFetch} needs. */
export interface ImapFetchDeps {
  mailboxStore: MailboxStore
  configStore: ImapConfigStore
  credentialStore: ImapCredentialStore
  watchStateStore: ImapWatchStateStore
  /**
   * Builds an {@link ImapClient} bound to one mailbox's connection options —
   * REQUIRED and injected, never defaulted to the concrete `createImapClient`
   * here, per `src/providers/README.md`'s "engine modules only ever see
   * adapter interfaces" rule (mirrors `./gmail-reconcile.ts`'s
   * `createHistoryClient`). The composition root wires in the real
   * `createImapClient`; tests pass a fake.
   */
  createImapClient: (options: ImapClientOptions) => ImapClient
  /**
   * Runs the ingest pipeline for one raw message. A production composition
   * root passes `(raw) => ingestInboundMessage(raw, ingestDeps)` — the SAME
   * `ingestDeps` `./gmail-reconcile.ts`'s handler is built with (`src/
   * composition/root.ts`); tests pass a fake returning canned outcomes.
   */
  ingest: (raw: RawInboundMessage) => Promise<IngestOutcome>
  /** See {@link DEFAULT_IMAP_FETCH_LEASE_MS}. */
  leaseMs?: number
  /** See `../providers/adapters/imap/fetch.ts`'s `DEFAULT_MAX_PER_INVOCATION`. */
  maxPerInvocation?: number
}

/** What one {@link runImapFetch} call did, for logging/observability by whatever schedules it. */
export interface ImapFetchReport {
  /** Active `provider === 'imap'` mailboxes processed this run. */
  total: number
  /** Mailboxes successfully fetched and whose cursor advanced this run. */
  fetched: number
  /** Total messages ingested across every fetched mailbox this run. */
  messagesIngested: number
  /** Mailboxes paused this run due to a UIDVALIDITY reset (module doc's SACRED section). */
  paused: number
  /** Mailboxes skipped this run: lease held elsewhere, or missing config/credential/cursor. */
  skipped: number
  /** Mailboxes with a non-terminal ingest outcome (cursor NOT advanced — retried next tick) or an unexpected error. */
  failed: number
}

/** Emit one structured, JSON-parseable log line — mirrors `./gmail-reconcile.ts`'s `logReconcileEvent`. NEVER pass a password or raw caught-error object into `record`. */
function logFetchEvent(level: 'info' | 'warn' | 'error', record: Record<string, unknown>): void {
  const line = JSON.stringify({ event: 'imap_fetch', ...record })
  if (level === 'error') {
    console.error(line)
  } else if (level === 'warn') {
    console.warn(line)
  } else {
    console.info(line)
  }
}

/** Dependencies {@link fetchOneMailbox} needs — the same set as {@link ImapFetchDeps}, with defaults already resolved. */
interface FetchOneDeps {
  mailboxStore: MailboxStore
  configStore: ImapConfigStore
  credentialStore: ImapCredentialStore
  watchStateStore: ImapWatchStateStore
  createImapClient: (options: ImapClientOptions) => ImapClient
  ingest: (raw: RawInboundMessage) => Promise<IngestOutcome>
  leaseMs: number
  maxPerInvocation: number
}

/** Mutable per-run counters {@link fetchOneMailbox} increments directly — see {@link ImapFetchReport}. */
type Counts = Omit<ImapFetchReport, 'total'>

/**
 * Run one fetch tick for ONE mailbox. See the module doc for the full
 * SACRED cursor-advance and UIDVALIDITY-reset contracts. Never throws for
 * an expected outcome (skip/pause/blocked) — only a genuinely unexpected
 * error propagates, for {@link runImapFetch}'s own per-mailbox catch to
 * count as `failed`.
 */
async function fetchOneMailbox(
  mailboxId: string,
  deps: FetchOneDeps,
  counts: Counts,
): Promise<void> {
  const {
    mailboxStore,
    configStore,
    credentialStore,
    watchStateStore,
    createImapClient,
    ingest,
    leaseMs,
    maxPerInvocation,
  } = deps

  // --- Claim the never-double-fetch lease. A null claim (another
  // invocation holds it, or no imap_watch_state row exists yet) is a silent
  // skip — module doc. ---
  const leaseToken = await watchStateStore.claimFetchLease(mailboxId, leaseMs)
  if (leaseToken === null) {
    counts.skipped++
    logFetchEvent('info', {
      mailboxId,
      outcome: 'skipped',
      reason: 'lease-held-or-no-baseline',
    })
    return
  }

  try {
    const config = await configStore.getConfig(mailboxId)
    const password = await credentialStore.getPassword(mailboxId)
    const cursor = await watchStateStore.getCursor(mailboxId)
    if (config === null || password === null || cursor === null) {
      counts.skipped++
      logFetchEvent('warn', {
        mailboxId,
        outcome: 'skipped',
        reason: 'missing-config-credential-or-cursor',
        hasConfig: config !== null,
        hasPassword: password !== null,
        hasCursor: cursor !== null,
      })
      return
    }

    const result = await fetchImapInboundMessages(
      mailboxId,
      cursor,
      () =>
        createImapClient({
          host: config.imapHost,
          port: config.imapPort,
          secure: config.secure,
          auth: { user: config.username, pass: password },
        }),
      maxPerInvocation,
    )

    // --- SACRED: UIDVALIDITY reset — pause, do NOT ingest, do NOT advance
    // (module doc). Re-ingesting a rebuilt-from-UID-1 batch under the NEW
    // epoch would duplicate every message already ingested under the OLD
    // one, since `imap:<uidValidity>:<uid>` changes with the epoch and the
    // ingest dedup would not catch it. ---
    if (result.uidValidityReset) {
      await mailboxStore.markPaused(mailboxId)
      counts.paused++
      logFetchEvent('warn', {
        mailboxId,
        outcome: 'paused',
        reason: 'uidvalidity-reset',
        previousCursor: cursor,
        note: 'mailbox paused for manual rebaseline — stored UIDs no longer valid under the new UIDVALIDITY epoch',
      })
      return
    }

    // --- Fetch + ingest each message, in order. ---
    const outcomes: IngestOutcome[] = []
    for (const raw of result.messages) {
      outcomes.push(await ingest(raw))
    }

    // --- SACRED: advance the cursor iff every outcome is terminal &
    // ledgered (module doc). Mirrors ./gmail-reconcile.ts step 6 exactly,
    // including dead-letter counting as terminal. ---
    const blocking = outcomes.find((o) => o.kind === 'failed' || o.kind === 'in-progress')
    if (blocking !== undefined) {
      counts.failed++
      logFetchEvent('warn', {
        mailboxId,
        outcome: 'blocked',
        reason: 'non-terminal-ingest-outcome',
        blockingOutcomeKind: blocking.kind,
        blockingProviderMessageId: blocking.providerMessageId,
        batchSize: result.messages.length,
      })
      return
    }

    await watchStateStore.setCursor(mailboxId, result.newCursor)
    counts.fetched++
    counts.messagesIngested += outcomes.length
    logFetchEvent('info', {
      mailboxId,
      outcome: 'fetched',
      messageCount: outcomes.length,
      previousCursor: cursor,
      newCursor: result.newCursor,
    })
  } finally {
    // Release on EVERY exit from the try above — success, the
    // uidValidityReset pause, the blocked-retry, AND an unexpected throw
    // (which this `finally` runs BEFORE the exception propagates to
    // runImapFetch's own per-mailbox catch). The lease is a pure efficiency
    // guard (module doc), so a mailbox that just threw must not be locked
    // out until leaseMs elapses.
    try {
      await watchStateStore.releaseFetchLease(mailboxId, leaseToken)
    } catch (releaseErr) {
      logFetchEvent('error', {
        mailboxId,
        outcome: 'lease-release-failed',
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      })
    }
  }
}

/**
 * Run one scheduled-fetch tick across every active `provider === 'imap'`
 * mailbox. See the module doc for the full contract. Never throws for one
 * mailbox's failure (failure-isolated, mirrors
 * `runGmailWatchMaintenance`) — a genuinely unexpected fault outside the
 * per-mailbox loop (e.g. `listActiveMailboxes` itself failing) propagates to
 * the caller, same as any other unexpected store error in this codebase.
 */
export async function runImapFetch(deps: ImapFetchDeps): Promise<ImapFetchReport> {
  const {
    mailboxStore,
    configStore,
    credentialStore,
    watchStateStore,
    createImapClient,
    ingest,
    leaseMs = DEFAULT_IMAP_FETCH_LEASE_MS,
    maxPerInvocation = DEFAULT_MAX_PER_INVOCATION,
  } = deps

  const mailboxes = (await mailboxStore.listActiveMailboxes()).filter(
    (mailbox) => mailbox.provider === 'imap',
  )

  const counts: Counts = { fetched: 0, messagesIngested: 0, paused: 0, skipped: 0, failed: 0 }

  const fetchOneDeps: FetchOneDeps = {
    mailboxStore,
    configStore,
    credentialStore,
    watchStateStore,
    createImapClient,
    ingest,
    leaseMs,
    maxPerInvocation,
  }

  for (const mailbox of mailboxes) {
    try {
      await fetchOneMailbox(mailbox.id, fetchOneDeps, counts)
    } catch (err) {
      // An UNEXPECTED throw — never let one mailbox stop the batch (module
      // doc's "Per-mailbox failure isolation" section).
      counts.failed++
      logFetchEvent('error', {
        mailboxId: mailbox.id,
        outcome: 'failed',
        reason: 'unexpected-error',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { total: mailboxes.length, ...counts }
}
