/**
 * `fetchImapInboundMessages` — the pure, cron-invocation-shaped fetch logic
 * for one mailbox: given a stored cursor (or none) and an {@link ImapClient}
 * factory, connect, `SELECT INBOX`, fetch everything new (bounded), and
 * return the raw messages plus the cursor's next value. Implements
 * specs/mail/mailbox-connection.md §5, "Inbound — bounded scheduled fetch".
 *
 * ## Deliberately NOT the `InboundEmailProvider` seam
 *
 * `InboundEmailProvider` is webhook-shaped (`verifySignature(request)` /
 * `receiveDelivery(request)`) and a cron-driven fetch has no `Request` to
 * hand it — mailbox-connection.md's unresolved question #3. This function is
 * the *data* contract that spec calls satisfiable on its own: raw bytes, a
 * `RawInboundMessage`, a single later `parseInboundEmail`, with no `Request`
 * shape invented for a transport that has none.
 *
 * It is the IMAP analogue of `src/mail/gmail-reconcile.ts`'s
 * `reconcileOneMailbox`, scoped down: no mailbox-status check, no store
 * reads or writes, no `ingest` call, no lease. This function takes the cursor
 * as a plain argument and returns the next one; persisting it — only after
 * the pipeline durably commits every message, per §5's "cursor advances on
 * COMMIT, not on fetch" — is `src/mail/imap-fetch.ts`'s job.
 *
 * ## UIDVALIDITY handling (§5)
 *
 * If `cursor` is non-null and the server's current `uidValidity` no longer
 * matches it, every stored UID is meaningless — UIDs are unique only within
 * one `(mailbox, UIDVALIDITY)` epoch (RFC 3501 §2.3.1.1). This function
 * discards `lastUid` and refetches from UID 1 under the NEW `uidValidity`,
 * bounded by `maxPerInvocation` like any other tick.
 *
 * That trades possible RE-fetching of already-seen mail — safe, since
 * `parseInboundEmail` is pure and re-running it is harmless — against
 * silently skipping mail that arrived under the new epoch, which CHARTER.md
 * §2's never-drop invariant forbids.
 *
 * `uidValidityReset` on the result is `true` only for a genuine reset (a
 * PRE-EXISTING cursor whose `uidValidity` no longer matches), so a caller can
 * alert on it specifically. A brand-new mailbox (`cursor === null`) also
 * rebuilds from UID 1, but that is the ordinary first run, so it reports
 * `false`.
 *
 * Rebuilding "safely" in the fuller sense — mailbox-connection.md's
 * unresolved question #2, that `providerMessageId` has no transport-stable
 * identity for IMAP, so a UID-keyed idempotency ledger cannot survive the
 * very reset it exists to recover from — is out of scope here: this function
 * has no ledger and no store, nothing to survive. `src/mail/imap-fetch.ts`
 * is where that consequence bites, and it pauses the mailbox rather than
 * ingesting a rebuilt batch. See `providerMessageIdFor` for the placeholder
 * id minted in the meantime.
 *
 * ## Bounding (§5, "Bound the batch, and bound the clock")
 *
 * `maxPerInvocation` caps how many messages one call fetches, passed straight
 * to {@link ImapClient.uidFetchRawSince}, which bounds by message COUNT: it
 * asks the server which UIDs above `sinceUid` actually exist (`SEARCH`),
 * takes the lowest `max`, and fetches exactly those.
 *
 * **Not by UID arithmetic.** A `sinceUid+1 : sinceUid+max` range can span
 * zero real messages while mail waits just above it, because UIDs are not
 * dense (RFC 3501 §2.3.1.1) — the stall `./client.ts` records.
 *
 * The full remaining-invocation-budget scheme (§5: "every network
 * operation... carries its own timeout derived from the remaining invocation
 * budget") belongs to the cron wiring, not here — see
 * `ImapClientOptions.timeoutMs` for the one safety-net bound this client
 * provides.
 */

import type { RawInboundMessage } from '../../inbound-email.js'
import type { ImapClient } from './client.js'

/** Cap on messages fetched per invocation, absent an explicit override. Conservative per specs/mail/mailbox-connection.md §5 ("default it conservatively"); matches this ticket's brief. */
export const DEFAULT_MAX_PER_INVOCATION = 50

/** One mailbox's IMAP cursor: the UIDVALIDITY epoch it was recorded under, plus the last UID fetched within that epoch. */
export interface ImapCursor {
  uidValidity: number
  lastUid: number
}

/** The result of one {@link fetchImapInboundMessages} call. */
export interface ImapFetchResult {
  /** Raw messages fetched this invocation, oldest-UID-first, ready to hand to `parseInboundEmail` (never pre-parsed — see `../../inbound-email.ts`'s module doc). */
  messages: RawInboundMessage[]
  /** The cursor to persist ONCE every message above has been durably committed by the ingest pipeline (§5's "cursor advances on COMMIT, not on fetch") — persisting this eagerly is a Stage 2 concern this function does not perform itself. */
  newCursor: ImapCursor
  /** True only when a PRE-EXISTING stored cursor's `uidValidity` no longer matched the server's (module doc). False for a brand-new mailbox (`cursor === null`), which rebuilds from UID 1 as the expected first-run case, not an anomaly. */
  uidValidityReset: boolean
}

/**
 * Mint the `providerMessageId` `RawInboundMessage` requires
 * (`../../inbound-email.ts`: "the idempotency authority... NOT the RFC
 * `Message-ID`"). IMAP has no transport-stable id in the sense Gmail's
 * message id is — a UID is only unique within one `(mailbox, uidValidity)`
 * epoch (module doc). This composite is stable WITHIN that epoch (good
 * enough to satisfy the type and to let a fixture/equivalence test assert
 * something concrete) but explicitly does NOT resolve specs/mail/mailbox-
 * connection.md's unresolved question #2: after a UIDVALIDITY reset, the
 * same physical message re-fetched under the new epoch gets a DIFFERENT
 * `providerMessageId` here, which is precisely the ledger-survives-its-own-
 * reset problem that spec flags as unresolved. Stage 2 (migrations + the
 * idempotency ledger) must revisit this — flagged in this ticket's report,
 * not solved here.
 */
function providerMessageIdFor(uidValidity: number, uid: number): string {
  return `imap:${uidValidity}:${uid}`
}

/**
 * Fetch every new message for one mailbox since `cursor`, bounded to at most
 * `maxPerInvocation` messages. Connects, selects INBOX, fetches, and closes
 * the connection in a `finally` — regardless of success, an empty result, or
 * a thrown error (specs/mail/mailbox-connection.md §5: "no held
 * connections"). See the module doc for the UIDVALIDITY-reset and bounding
 * contracts.
 *
 * @param mailboxId Which connected mailbox this is — stamped onto every
 *   returned message (`RawInboundMessage.mailboxId`).
 * @param cursor The mailbox's stored cursor, or `null` if this mailbox has
 *   never been fetched before (module doc's "brand-new mailbox" case).
 * @param createClient Builds the {@link ImapClient} to use for this one
 *   call — REQUIRED and injected, never defaulted to `createImapClient`
 *   here, matching `src/mail/gmail-reconcile.ts`'s `createHistoryClient`
 *   convention (`src/providers/README.md`'s "engine modules never import an
 *   adapter" rule). Tests pass a factory returning a fake.
 */
export async function fetchImapInboundMessages(
  mailboxId: string,
  cursor: ImapCursor | null,
  createClient: () => ImapClient,
  maxPerInvocation: number = DEFAULT_MAX_PER_INVOCATION,
): Promise<ImapFetchResult> {
  const client = createClient()
  // `connect()` is INSIDE the try, so a failure part-way through the handshake
  // (TLS up, AUTH rejected) still reaches the `finally` and releases whatever
  // socket was allocated. Outside it, a rejected login leaks the connection —
  // and the cron retries every 2 minutes forever.
  try {
    await client.connect()
    const mailbox = await client.selectInbox()

    const uidValidityReset = cursor !== null && cursor.uidValidity !== mailbox.uidValidity
    // Rebuild from UID 1 both when there is no prior cursor at all AND when
    // the epoch changed under us (module doc) — the only difference is
    // whether that is reported as an anomaly.
    const sinceUid = cursor === null || uidValidityReset ? 0 : cursor.lastUid

    const fetched = await client.uidFetchRawSince(sinceUid, maxPerInvocation)

    // Ingestion order is oldest-UID-first (`ImapFetchResult.messages`' doc).
    // The client is expected to return sorted results, but a UID FETCH stream
    // does not guarantee order, so enforce it here too rather than trust any
    // one `ImapClient` implementation — reordering mailbox ingestion is a
    // mail-semantics defect, not a cosmetic one.
    const ordered = [...fetched].sort((a, b) => a.uid - b.uid)

    const messages: RawInboundMessage[] = ordered.map((message) => ({
      content: { kind: 'inline', bytes: message.raw },
      mailboxId,
      providerMessageId: providerMessageIdFor(mailbox.uidValidity, message.uid),
      receivedAt: message.internalDate,
    }))

    // Advances only as far as the highest UID actually fetched this batch —
    // if nothing new came back, this equals `sinceUid` and the cursor does
    // not move (no spurious advance on an empty tick).
    const lastUid = ordered.reduce((max, message) => Math.max(max, message.uid), sinceUid)

    return {
      messages,
      newCursor: { uidValidity: mailbox.uidValidity, lastUid },
      uidValidityReset,
    }
  } finally {
    // Never let cleanup replace the outcome. The bundled `ImapClient`
    // (`./client.ts`) is already written to swallow its own close failures,
    // but `createClient` is an injected seam — any other implementation could
    // throw, and a throw HERE would overwrite an in-flight AUTH rejection with
    // a meaningless close error, or reject a fetch whose messages were already
    // retrieved. The guarantee belongs at the call site, not in one
    // implementation's good behaviour (2026-07-31).
    try {
      await client.close()
    } catch {
      // Nothing to release and nothing a caller could act on.
    }
  }
}
