/**
 * The provider-agnostic inbound ingest pipeline (specs/mail/inbound-
 * ingestion.md §3) — turns one raw inbound message into a stored
 * conversation/thread, idempotently and never-dropped (spec §1's three
 * invariants: parse exactly once, thread only on our token, at-least-once
 * and never silently lost). This is the orchestration `threading.md` and
 * `store/conversations.ts` repeatedly deferred to as "the mail-ingestion
 * pipeline, not yet built" — it is built here.
 *
 * ## The five steps (spec §3), in order
 *
 * 1. **Claim, atomically** (`InboundDeliveryStore.claim`,
 *    `src/store/inbound-deliveries.ts`) — a fresh claim (or a reclaimed
 *    `failed` row, or a reclaimed lease-expired `received` row — HT-45, see
 *    that store's doc comment) means this call owns processing; any other
 *    outcome means a concurrent or prior delivery already does, so this
 *    function stops and returns THAT row's recorded outcome (never
 *    double-processes).
 * 2. **Parse** (`parseInboundEmail`, `src/mail/parse.ts`) — the pipeline's
 *    ONE parse (invariant #1). The raw bytes come either inline or via a
 *    `BlobStore.get` of a `blobRef` (`src/providers/inbound-email.ts`).
 * 3. **Loop guard** (spec §5) — see {@link isOwnMessageReflection}'s doc
 *    comment for exactly what this does and does not suppress.
 * 4. **Decide** (`decideThreading`, `src/mail/thread.ts`) — never
 *    re-implemented here.
 * 5. **Store and commit the outcome, atomically** — see
 *    {@link storeAndMarkDelivered}'s doc comment for how the store write and
 *    the ledger's `received → stored` transition become ONE transaction
 *    (spec §4 — the crux this ticket exists to get right).
 *
 * ## Attachments: deferred (HT-37 scope note)
 *
 * `ParsedEmail.attachments` carries bytes (`src/mail/parse.ts`), but the
 * `threads` store has no attachment column today, and writing attachment
 * bytes to the `BlobStore` under a mailbox-namespaced key (spec §3's closing
 * paragraph) is explicitly out of scope for this ticket. This pipeline
 * stores the text/html body only; attachment bytes are silently NOT
 * persisted anywhere yet. Flagged in the implementation report as a
 * follow-up, not invented here.
 */

import type { Db, Queryable } from '../db/client.js'
import type { BlobStore, RawInboundMessage, RawMessageContent } from '../providers/index.js'
import { appendThreadInTx, createConversationInTx, type NewThread } from '../store/conversations.js'
import {
  type InboundDeliveryStore,
  markStoredInTx,
  type StoredInboundDelivery,
} from '../store/inbound-deliveries.js'
import { type ParsedEmail, parseInboundEmail } from './parse.js'
import { type Keyring, verifyReplyMessageId } from './reply-token.js'
import { decideThreading, type ThreadingDecision } from './thread.js'

/**
 * How many FAILED processing attempts a delivery may accumulate before this
 * pipeline gives up and marks it `dead-letter` for manual review (spec §4:
 * "a message that exhausts its retry budget"). Migration 012's doc comment
 * (`src/db/migrate.ts`) deliberately leaves this policy to "the worker that
 * consumes this table" — this pipeline IS that consumer, so the number lives
 * here. Not tuned against any measured production failure rate; a small,
 * reasonable default.
 */
export const MAX_INGEST_ATTEMPTS = 5

/**
 * Default lease duration held on a delivery between {@link
 * InboundDeliveryStore.claim} committing `'received'` and this pipeline's
 * own step-5 store transaction (or its catch-block `markFailed`) — mirrors
 * `src/mail/send.ts`'s `DEFAULT_LEASE_MS`, the outbound precedent for this
 * exact claim/lease/reclaim shape (HT-45; `src/store/inbound-deliveries.ts`'s
 * module doc, "received rows are ALSO reclaimed"). Unlike `DEFAULT_LEASE_MS`,
 * this is not asserted against any external bounded call (`EmailSender.
 * maxSendMs` has no inbound-side equivalent) — it is simply a generous
 * ceiling on how long one `ingestInboundMessage` call should ever
 * legitimately take (parse + threading decision + one store transaction),
 * past which a claim is presumed abandoned (crashed) rather than merely
 * slow.
 */
export const DEFAULT_INBOUND_LEASE_MS = 120_000

/** Dependencies {@link ingestInboundMessage} needs, injected so it stays testable against fakes/in-memory stores. */
export interface IngestDeps {
  /**
   * The raw-SQL handle whose `.transaction()` this pipeline calls directly
   * for step 5's joint store-write + ledger-mark transaction (see
   * {@link storeAndMarkDelivered}) — one level below the `ConversationStore`/
   * `InboundDeliveryStore` abstractions, each of which opens its OWN
   * transaction and so cannot be composed into a single shared one from
   * outside.
   */
  db: Db
  inboundDeliveryStore: InboundDeliveryStore
  blobStore: BlobStore
  keyring: Keyring
  /** Lease duration passed to `InboundDeliveryStore.claim` (default {@link DEFAULT_INBOUND_LEASE_MS}). */
  leaseMs?: number
}

/** Fields every {@link IngestOutcome} variant carries. */
interface IngestOutcomeBase {
  deliveryId: string
  mailboxId: string
  providerMessageId: string
}

/**
 * The result of one {@link ingestInboundMessage} call. `'in-progress'` is
 * returned when a concurrent or prior call already owns this delivery and is
 * still working on it (the claim's `received`-conflict case) — nothing was
 * done by THIS call.
 */
export type IngestOutcome =
  | (IngestOutcomeBase & { kind: 'stored'; conversationId: string; threadId: string })
  | (IngestOutcomeBase & { kind: 'suppressed'; reason: string })
  | (IngestOutcomeBase & { kind: 'failed'; attempts: number; error: string })
  | (IngestOutcomeBase & { kind: 'dead-letter'; attempts: number; error: string })
  | (IngestOutcomeBase & { kind: 'in-progress' })

/**
 * Run the full inbound ingest pipeline on one raw message (spec §3). See the
 * module doc for the five steps. Never throws for an expected processing
 * failure (a malformed message, a transient blob-read error, a step-5
 * transaction failure) — those are caught and recorded as a `failed`/
 * `dead-letter` ledger outcome, per spec §4's at-least-once, honest-partial-
 * failure contract. Only a fault in the claim step itself propagates (e.g.
 * the database being unreachable) — there is no ledger row yet to record it
 * against.
 *
 * Idempotent by construction (spec §3: "idempotent by step 1, so a whole
 * re-run is safe") — calling this again with the SAME `raw.mailboxId`/
 * `raw.providerMessageId` is how a caller retries a `failed` delivery, and is
 * a no-op once the delivery is `stored`/`suppressed`/`dead-letter`.
 */
export async function ingestInboundMessage(
  raw: RawInboundMessage,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const claimResult = await deps.inboundDeliveryStore.claim(
    raw.mailboxId,
    raw.providerMessageId,
    deps.leaseMs ?? DEFAULT_INBOUND_LEASE_MS,
  )

  if (!claimResult.claimed) {
    return outcomeForExistingDelivery(claimResult.delivery, deps)
  }

  return processClaimedDelivery(claimResult.delivery, raw, deps)
}

/**
 * §5's loop-suppression check, narrowly scoped to the ONE unambiguous,
 * verifiable correlation this pipeline implements: `parsed`'s OWN
 * `Message-ID` header itself verifies as a reply token WE minted
 * (`verifyReplyMessageId`, `src/mail/reply-token.ts`) — i.e. this "inbound"
 * message IS (a copy of) a message we sent, reflected back to us (e.g. a
 * transparent mail-forwarding loop, or a relay/bounce that preserves the
 * original `Message-ID`). This is spec §5's "our exact outbound Message-ID
 * (which we minted and can recognise) appearing as this message's
 * Message-ID," verbatim.
 *
 * Deliberately does NOT examine `In-Reply-To`/`References`: a valid token
 * THERE is the ordinary, correct signal `decideThreading` (`src/mail/
 * thread.ts`) uses to APPEND a genuine reply — including a customer's own
 * out-of-office autoresponder replying to our token, which
 * fixtures/mail/observed/auto-submitted.json and spec §5 require to be
 * INGESTED, not suppressed ("an out-of-office reply from a customer is a
 * real thing an Agent may want to see"). Reusing that field here would
 * misfire on exactly that legitimate, fixture-proven case. `parsed.messageId`
 * is a field `decideThreading` never reads (its `buildCandidates` only
 * consults `inReplyTo`/`references`), so this check is strictly additive,
 * never overlapping with normal threading.
 *
 * NOT implemented here — see this ticket's report: spec §5's second phrasing,
 * "a valid... own reply token in a position indicating our mail was bounced
 * or auto-answered," read as possibly also covering a DSN/bounce that embeds
 * the original message as a nested `message/rfc822` part rather than
 * preserving its `Message-ID` as its own outer `Message-ID`. That would
 * require parsing nested MIME sub-messages this codebase has no support for
 * yet, and no fixture exercises it — flagged as an open question rather than
 * guessed at (spec §5 itself notes "this rule is additive; no fixture speaks
 * to it").
 */
export function isOwnMessageReflection(parsed: ParsedEmail, keyring: Keyring): boolean {
  return parsed.messageId !== null && verifyReplyMessageId(parsed.messageId, keyring) !== null
}

/**
 * Map an existing ledger row — the claim's not-claimed branch, i.e. a
 * completed replay or another worker's in-flight claim — to the outcome this
 * function reports, WITHOUT reprocessing (spec §3 step 1: "do not
 * double-process").
 */
async function outcomeForExistingDelivery(
  delivery: StoredInboundDelivery,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const base: IngestOutcomeBase = {
    deliveryId: delivery.id,
    mailboxId: delivery.mailboxId,
    providerMessageId: delivery.providerMessageId,
  }

  switch (delivery.status) {
    case 'stored': {
      if (delivery.threadId === null) {
        // Structurally unreachable: markStoredInTx always sets thread_id in
        // the SAME write that sets status = 'stored'. Thrown rather than
        // silently reporting a made-up outcome if it ever did happen.
        throw new Error(
          `ingestInboundMessage: delivery ${delivery.id} is 'stored' but has no thread_id`,
        )
      }
      const conversationId = await conversationIdForThread(deps.db, delivery.threadId)
      return { ...base, kind: 'stored', conversationId, threadId: delivery.threadId }
    }
    case 'suppressed':
      return { ...base, kind: 'suppressed', reason: delivery.lastError ?? '' }
    case 'dead-letter':
      return {
        ...base,
        kind: 'dead-letter',
        attempts: delivery.attempts,
        error: delivery.lastError ?? '',
      }
    case 'received':
      // claim() only returns claimed:false for a 'received' row when its
      // lease has NOT yet lapsed (src/store/inbound-deliveries.ts's "received
      // rows are ALSO reclaimed", HT-45) — i.e. another delivery's claim is
      // genuinely still in flight. Not our outcome to report; the caller
      // must not touch this row. A lease-expired row is reclaimed by claim()
      // instead and flows through processClaimedDelivery below, never here.
      return { ...base, kind: 'in-progress' }
    case 'failed':
      // claim() only returns claimed:false for a 'failed' row if its own
      // atomic reclaim raced and lost (InboundDeliveryStore's doc comment) —
      // the row it returned is the CURRENT post-race state, so report it as
      // failed; the next re-delivery gets another chance to reclaim it.
      return {
        ...base,
        kind: 'failed',
        attempts: delivery.attempts,
        error: delivery.lastError ?? '',
      }
  }
}

/** Look up the conversation a thread belongs to — needed only to report a `stored`-replay outcome (the ledger stores `thread_id`, not `conversation_id`; migration 012's doc comment). */
async function conversationIdForThread(db: Db, threadId: string): Promise<string> {
  const rows = await db.query<{ conversation_id: string }>(
    'SELECT conversation_id FROM threads WHERE id = $1',
    [threadId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new Error(
      `ingestInboundMessage: thread ${threadId} referenced by a 'stored' ledger row does not exist`,
    )
  }
  return row.conversation_id
}

/** Resolve `content` to raw bytes — inline as-is, or a `BlobStore.get` of a `blobRef` (`src/providers/inbound-email.ts`'s module doc). */
async function resolveRawBytes(
  content: RawMessageContent,
  blobStore: BlobStore,
): Promise<Uint8Array> {
  return content.kind === 'inline' ? content.bytes : blobStore.get(content.blobKey)
}

/** Fallback sender address for a message with no usable `From` header — pathological, but must not crash ingest (invariant #1: never lose or corrupt customer mail). */
const UNKNOWN_SENDER = 'unknown-sender@invalid'

function fromAddressOf(parsed: ParsedEmail): string {
  return parsed.from?.address ?? UNKNOWN_SENDER
}

/**
 * Run steps 2-5 of the pipeline for a delivery this call now owns (a fresh
 * claim, or a reclaimed `failed` row). Every failure path is caught and
 * recorded on the ledger rather than thrown — see {@link ingestInboundMessage}'s
 * doc comment.
 */
async function processClaimedDelivery(
  delivery: StoredInboundDelivery,
  raw: RawInboundMessage,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const base: IngestOutcomeBase = {
    deliveryId: delivery.id,
    mailboxId: delivery.mailboxId,
    providerMessageId: delivery.providerMessageId,
  }

  // --- Step 2: parse (invariant #1: the pipeline's ONE parse). -------------
  let parsed: ParsedEmail
  let parseSize: number
  try {
    const bytes = await resolveRawBytes(raw.content, deps.blobStore)
    parseSize = bytes.byteLength
    parsed = await parseInboundEmail(bytes)
  } catch (err) {
    return recordFailure(delivery, deps, 'parse', err, base)
  }

  // --- Step 3: loop guard (spec §5). ----------------------------------------
  if (isOwnMessageReflection(parsed, deps.keyring)) {
    const reason = 'own-message-loop'
    const updated = await deps.inboundDeliveryStore.markSuppressed(delivery.id, reason)
    logIngestEvent({
      ...base,
      outcome: 'suppressed',
      reason,
      parseSize,
      attachmentCount: parsed.attachments.length,
    })
    return { ...base, kind: 'suppressed', reason: updated.lastError ?? reason }
  }

  // --- Step 4: decide (never re-implemented here). --------------------------
  const decision = decideThreading(parsed, deps.keyring)

  // --- Step 5: store + mark stored, ONE transaction (the crux — see
  // storeAndMarkDelivered's doc comment). ------------------------------------
  try {
    const written = await storeAndMarkDelivered(deps.db, delivery.id, decision, parsed)
    logIngestEvent({
      ...base,
      outcome: 'stored',
      threading: decision.kind,
      forgedTokenCount: decision.forgedTokenCount,
      parseSize,
      attachmentCount: parsed.attachments.length,
      conversationId: written.conversationId,
      threadId: written.threadId,
    })
    return {
      ...base,
      kind: 'stored',
      conversationId: written.conversationId,
      threadId: written.threadId,
    }
  } catch (err) {
    return recordFailure(delivery, deps, 'store', err, base)
  }
}

/**
 * Record a caught processing failure on the ledger — `dead-letter` once
 * `MAX_INGEST_ATTEMPTS` would be reached, otherwise the retryable `failed`
 * (spec §4). Emits the same structured observability record as the success
 * paths (spec §6).
 */
async function recordFailure(
  delivery: StoredInboundDelivery,
  deps: IngestDeps,
  stage: 'parse' | 'store',
  err: unknown,
  base: IngestOutcomeBase,
): Promise<IngestOutcome> {
  const message = `${stage}: ${err instanceof Error ? err.message : String(err)}`
  const willDeadLetter = delivery.attempts + 1 >= MAX_INGEST_ATTEMPTS

  const updated = willDeadLetter
    ? await deps.inboundDeliveryStore.markDeadLetter(delivery.id, message)
    : await deps.inboundDeliveryStore.markFailed(delivery.id, message)

  logIngestEvent({
    ...base,
    outcome: updated.status,
    stage,
    attempts: updated.attempts,
    error: message,
  })

  return willDeadLetter
    ? { ...base, kind: 'dead-letter', attempts: updated.attempts, error: message }
    : { ...base, kind: 'failed', attempts: updated.attempts, error: message }
}

/**
 * Step 5's store write and the ledger's `received → stored` transition,
 * genuinely ONE transaction (spec §4 — this is the crux this ticket exists
 * to get right).
 *
 * `ConversationStore.createConversation`/`appendThread` (`src/store/
 * conversations.ts`) each open their OWN `db.transaction(...)` — correct for
 * every other caller, but unusable here: a transaction opened by one call
 * cannot be joined by a different call over the same connection, and this
 * step needs the store write and the ledger mark to commit or roll back
 * together. So this function opens exactly ONE transaction itself, via
 * `Db.transaction` directly, and inside it calls the TRANSACTION-SCOPED cores
 * those two methods are themselves thin wrappers around
 * (`createConversationInTx`/`appendThreadInTx`, exported from
 * `conversations.ts` for precisely this reason), followed by `markStoredInTx`
 * (`src/store/inbound-deliveries.ts`, likewise transaction-scoped) — all
 * three against the SAME `tx` handle.
 *
 * If anything in this function throws (a constraint violation, a dropped
 * connection), `Db.transaction` rolls back EVERYTHING: no conversation/thread
 * row survives, and the ledger row stays exactly at `received` — never a
 * stored conversation with no matching ledger mark, and never a ledger mark
 * with no matching conversation. A retry (the next `ingestInboundMessage`
 * call for the same key) redoes the whole unit cleanly from a clean slate,
 * per spec §4: "a crash before that commit leaves the row at received and no
 * conversation, and the retry redoes the whole unit cleanly."
 *
 * Implements spec §3 step 5's new/append/deleted/not-found policy: `new` →
 * `createConversationInTx`; `append` → `appendThreadInTx`, falling back to a
 * FRESH `createConversationInTx` on `{ ok: false, reason: 'deleted' |
 * 'not-found' }` — never resurrects a deleted conversation, never drops the
 * mail (threading.md §5, mirrored here for the ingest path).
 */
async function storeAndMarkDelivered(
  db: Db,
  deliveryId: string,
  decision: ThreadingDecision,
  parsed: ParsedEmail,
): Promise<{ conversationId: string; threadId: string }> {
  return db.transaction(async (tx) => {
    const written = await writeParsedEmail(tx, decision, parsed)
    await markStoredInTx(tx, deliveryId, written.threadId)
    return written
  })
}

/** The `new`/`append`(+deleted/not-found fallback) store write itself — see {@link storeAndMarkDelivered}'s doc comment for the transaction it runs inside. */
async function writeParsedEmail(
  tx: Queryable,
  decision: ThreadingDecision,
  parsed: ParsedEmail,
): Promise<{ conversationId: string; threadId: string }> {
  const firstMessage: NewThread = {
    direction: 'inbound',
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    fromAddress: fromAddressOf(parsed),
    bodyText: parsed.text,
    bodyHtml: parsed.html,
  }

  if (decision.kind === 'new') {
    return createConversationInTx(tx, {
      subject: parsed.subject,
      customerEmail: fromAddressOf(parsed),
      firstMessage,
    })
  }

  const appended = await appendThreadInTx(tx, decision.conversationId, firstMessage)
  if (appended.ok) {
    return { conversationId: decision.conversationId, threadId: appended.threadId }
  }

  // 'deleted' or 'not-found' (threading.md §5, spec §3 step 5): the token
  // verified but its target conversation is gone or never existed — never
  // resurrect it, never drop the mail. Fall back to a fresh conversation.
  return createConversationInTx(tx, {
    subject: parsed.subject,
    customerEmail: fromAddressOf(parsed),
    firstMessage,
  })
}

/**
 * Emit spec §6's "structured record" for one ingest outcome: `mailboxId`,
 * `providerMessageId`, the threading decision, `forgedTokenCount`,
 * suppression reason, parse size, attachment count, and the final ledger
 * outcome, wherever each applies. This is where `decideThreading`'s
 * `forgedTokenCount` is actually CONSUMED (spec §6: "nothing consumes it
 * today. This pipeline is where it is consumed") — surfaced in a structured
 * line, ready for a log aggregator or a future alerting rule to act on.
 *
 * No custom logger abstraction exists in this codebase yet (CHARTER.md §4:
 * serverless, platform-log-aggregated), so this is deliberately a plain
 * `console.log` of a JSON-serializable object rather than a new logging
 * dependency invented for this ticket. Only called for FRESH processing
 * outcomes (stored/suppressed/failed/dead-letter) — a replay of an existing
 * terminal row (`outcomeForExistingDelivery`) did no new work, so it emits
 * nothing.
 */
function logIngestEvent(record: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: 'inbound_ingest', ...record }))
}
