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
 * ## Attachments (HT-46)
 *
 * `ParsedEmail.attachments` carries bytes (`src/mail/parse.ts`). Between
 * step 4 (decide) and step 5 (store), this pipeline writes each attachment's
 * bytes to the `BlobStore` under a mailbox-namespaced key
 * (`<mailboxId>/<attachmentId>/<filename>`, spec §3's closing paragraph —
 * see {@link writeAttachmentBlobs}) BEFORE the step-5 transaction opens, then
 * persists only the resulting blob-key REFERENCES inside that transaction
 * (`thread_attachments`, migration 015, `src/store/attachments.ts`) — never
 * the bytes themselves, and never inside the transaction. This ordering is
 * the ticket's design, not incidental: `BlobStore.put` is a non-transactional
 * external side effect (it cannot be rolled back if the transaction that
 * follows aborts), so spec §4's already-blessed failure mode — "a blob write
 * that succeeds then a transaction that aborts" — is exactly what happens on
 * a step-5 failure here, and it is HONEST about it: the blob is orphaned
 * (unreferenced by any `thread_attachments` row, since that insert never
 * committed), not corrupted or double-referenced. A retry (this pipeline's
 * ordinary retry-the-whole-unit contract, spec §4) re-parses, re-decides, and
 * re-writes FRESH blobs under fresh attachment ids — it never reuses or
 * cleans up the orphaned ones from the failed attempt. Orphaned blobs are
 * tolerable and GC-able (a future sweep keyed off `thread_attachments`
 * cross-referenced against the bucket — not built here, flagged as a
 * follow-up in the implementation report) but never a correctness problem:
 * an orphan is simply never referenced by anything, so it is never served.
 */

import { randomUUID } from 'node:crypto'
import type { Db, Queryable } from '../db/client.js'
import type { BlobStore, RawInboundMessage, RawMessageContent } from '../providers/index.js'
import { insertThreadAttachmentsInTx, type NewThreadAttachment } from '../store/attachments.js'
import { appendThreadInTx, createConversationInTx, type NewThread } from '../store/conversations.js'
import { appendOutboxEventInTx } from '../store/event-outbox.js'
import {
  type InboundDeliveryStore,
  LeaseLostError,
  markStoredInTx,
  type StoredInboundDelivery,
} from '../store/inbound-deliveries.js'
import { type ParsedAttachment, type ParsedEmail, parseInboundEmail } from './parse.js'
import { type Keyring, verifyReplyMessageId } from './reply-token.js'
import { decideThreading, type ThreadingDecision } from './thread.js'

/**
 * How many failed-or-abandoned processing attempts (`InboundDeliveryStore`'s
 * `attempts` — every `markFailed`/`markDeadLetter`, AND every `received`-row
 * lease reclaim, HT-45 review fix) a delivery may accumulate before this
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
}

/** Fields every {@link IngestOutcome} variant carries. */
interface IngestOutcomeBase {
  deliveryId: string
  mailboxId: string
  providerMessageId: string
}

/**
 * Why an `append` threading decision was stored as a FRESH conversation
 * instead (spec §3 step 5, threading.md §5): the token verified but its
 * target conversation was `deleted` (never resurrected) or `not-found`
 * (token valid, no such row). Absent on the ordinary paths — a `new`
 * decision, or an `append` that landed on its target.
 */
export type AppendFallbackReason = 'deleted' | 'not-found'

/**
 * The result of one {@link ingestInboundMessage} call. `'in-progress'` is
 * returned when a concurrent or prior call already owns this delivery and is
 * still working on it (the claim's `received`-conflict case) — nothing was
 * done by THIS call.
 *
 * `appendFallback` (HT-44, spec §6) is only ever set on a FRESH `stored`
 * outcome — a replay of an existing `stored` row reports without it (the
 * ledger records the resulting `thread_id`, not the decision path that
 * produced it).
 */
export type IngestOutcome =
  | (IngestOutcomeBase & {
      kind: 'stored'
      conversationId: string
      threadId: string
      appendFallback?: AppendFallbackReason
    })
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
 * A {@link LeaseLostError} bubbling up from ANY mark* write below (a stale
 * caller's lease was reclaimed by another worker mid-processing — see
 * `src/store/inbound-deliveries.ts`'s "The fence" section) is caught here and
 * reported as `in-progress`: this call's own claim generation is no longer
 * current, so it must not force a `failed`/`dead-letter` write (that would
 * itself just be fenced out, or — worse — land on whatever generation now
 * legitimately owns the row). The row's actual outcome belongs to whichever
 * worker holds the current generation; this call did nothing to it.
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
    DEFAULT_INBOUND_LEASE_MS,
  )

  if (!claimResult.claimed) {
    return outcomeForExistingDelivery(claimResult.delivery, deps)
  }

  try {
    return await processClaimedDelivery(claimResult.delivery, raw, deps)
  } catch (err) {
    if (err instanceof LeaseLostError) {
      return {
        deliveryId: claimResult.delivery.id,
        mailboxId: claimResult.delivery.mailboxId,
        providerMessageId: claimResult.delivery.providerMessageId,
        kind: 'in-progress',
      }
    }
    throw err
  }
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
 * claim, or a reclaimed `failed`/`received` row). Every failure path is
 * caught and recorded on the ledger rather than thrown — see {@link
 * ingestInboundMessage}'s doc comment. A {@link LeaseLostError} from any mark*
 * write is the one exception: it is deliberately NOT caught here (propagates
 * to {@link ingestInboundMessage}'s own catch) because it means this call's
 * claim generation is no longer current — forcing a `failed`/`dead-letter`
 * write in that state would itself just be fenced out.
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

  // --- Lease-reclaim retry budget (HT-45 review fix). A `received`-row
  // lease reclaim bumps `attempts` (src/store/inbound-deliveries.ts's "The
  // fence" section) precisely so a message that hard-crashes the process on
  // every attempt — never reaching a recorded `failed`/`dead-letter` outcome
  // via the catch blocks below — still converges to dead-letter, the same as
  // one that always throws. Checked BEFORE parsing so a message proven to
  // keep crashing doesn't burn another parse/store cycle first. -------------
  if (delivery.attempts >= MAX_INGEST_ATTEMPTS) {
    const message =
      `lease reclaimed ${delivery.attempts} times without completing ` +
      `(exceeded MAX_INGEST_ATTEMPTS = ${MAX_INGEST_ATTEMPTS})`
    const updated = await deps.inboundDeliveryStore.markDeadLetter(
      delivery.id,
      message,
      delivery.attempts,
    )
    logIngestEvent({
      ...base,
      outcome: 'dead-letter',
      stage: 'lease-reclaim-budget',
      attempts: updated.attempts,
      error: message,
    })
    return { ...base, kind: 'dead-letter', attempts: updated.attempts, error: message }
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
    const updated = await deps.inboundDeliveryStore.markSuppressed(
      delivery.id,
      reason,
      delivery.attempts,
    )
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

  // --- Attachments: write bytes to the BlobStore BEFORE step 5's transaction
  // (module doc's "Attachments (HT-46)" section) — a blob write is a
  // non-transactional external side effect, so it must happen outside (and
  // before) the transaction that references it. -----------------------------
  let attachmentRefs: Omit<NewThreadAttachment, 'threadId'>[]
  try {
    attachmentRefs = await writeAttachmentBlobs(
      delivery.mailboxId,
      parsed.attachments,
      deps.blobStore,
    )
  } catch (err) {
    return recordFailure(delivery, deps, 'blob', err, base)
  }

  // --- Step 5: store + mark stored, ONE transaction (the crux — see
  // storeAndMarkDelivered's doc comment). ------------------------------------
  try {
    const written = await storeAndMarkDelivered(
      deps.db,
      delivery.id,
      decision,
      parsed,
      attachmentRefs,
      delivery.attempts,
    )
    logIngestEvent({
      ...base,
      outcome: 'stored',
      threading: decision.kind,
      // Present only when an `append` decision's target was gone (spec §3
      // step 5) — without it, a fallback's log line would read
      // `threading: 'append'` while its conversationId names a conversation
      // this very write CREATED, silently contradicting itself (HT-44).
      ...(written.appendFallback !== undefined ? { appendFallback: written.appendFallback } : {}),
      forgedTokenCount: decision.forgedTokenCount,
      parseSize,
      attachmentCount: parsed.attachments.length,
      conversationId: written.conversationId,
      threadId: written.threadId,
    })
    if (decision.forgedTokenCount > 0) {
      logForgedTokenEvent(base, decision.forgedTokenCount, fromAddressOf(parsed), written)
    }
    return {
      ...base,
      kind: 'stored',
      conversationId: written.conversationId,
      threadId: written.threadId,
      ...(written.appendFallback !== undefined ? { appendFallback: written.appendFallback } : {}),
    }
  } catch (err) {
    // A LeaseLostError here means markStoredInTx's fenced write lost the
    // race (module doc reference above) — propagate it as-is rather than
    // routing it through recordFailure, which would attempt an ALSO-fenced
    // markFailed/markDeadLetter write against a generation this call no
    // longer owns.
    if (err instanceof LeaseLostError) throw err
    return recordFailure(delivery, deps, 'store', err, base)
  }
}

/**
 * Write every attachment's bytes to `blobStore` under a fresh, mailbox-
 * namespaced key (spec §3's closing paragraph): `<mailboxId>/<attachmentId>/
 * <filename>`, where `attachmentId` is a freshly minted UUID — formable
 * before any row id exists, exactly the ticket's design (the row this
 * attachment will reference, `thread_attachments.thread_id`, doesn't exist
 * until step 5's INSERT). Returns the reference each attachment resolved to
 * (everything {@link insertThreadAttachmentsInTx} needs except `threadId`,
 * which step 5 fills in once the thread row exists). `[]` for a message with
 * no attachments — the common case, and the fast path (no blob writes at
 * all).
 *
 * Called AFTER the loop guard (step 3) so a suppressed own-message-loop
 * reflection never writes attachment blobs that would then have nothing to
 * reference — see the module doc's "Attachments (HT-46)" section for why a
 * write here can still end up orphaned by a LATER step-5 failure, and why
 * that is tolerable.
 */
async function writeAttachmentBlobs(
  mailboxId: string,
  attachments: ParsedAttachment[],
  blobStore: BlobStore,
): Promise<Omit<NewThreadAttachment, 'threadId'>[]> {
  const refs: Omit<NewThreadAttachment, 'threadId'>[] = []
  for (const attachment of attachments) {
    const blobKey = `${mailboxId}/${randomUUID()}/${sanitizeAttachmentFilename(attachment.filename)}`
    await blobStore.put(blobKey, attachment.content, {
      contentType: attachment.contentType,
      contentLength: attachment.size,
    })
    refs.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      blobKey,
    })
  }
  return refs
}

/**
 * The filename segment of an attachment's blob key — NOT the `filename`
 * column value (that stays the original, verbatim `ParsedAttachment.filename`,
 * `null` included). `BlobStore` implementations (e.g. Supabase Storage,
 * `src/providers/adapters/supabase-storage/`) reject object keys containing
 * anything outside a restricted ASCII allowlist (letters, digits, `_`, `.`,
 * `-`) — no unicode, no `/` (a path separator, which would otherwise let an
 * attacker- or client-supplied filename nest the object under an unintended
 * "folder" inside this attachment's own namespace slot), no `%`/`#`/quotes/
 * control characters. Every other character is replaced with `_` so the key
 * stays exactly three segments deep and adapter-valid, whatever the filename
 * contains. A missing OR empty filename (`null`, `undefined`, or `''` — a
 * blank `''` is not caught by `??`) falls back to a fixed placeholder — the
 * key still needs SOME non-empty final segment. Truncated to
 * {@link MAX_SANITIZED_FILENAME_LENGTH} characters: `ParsedAttachment.filename`
 * comes verbatim from an attacker-controlled `Content-Disposition` header
 * with no length limit of its own, and an oversized key segment would
 * otherwise make every retry of an ordinary message fail the SAME way at
 * the `BlobStore` (most object-storage backends cap total key length).
 */
const MAX_SANITIZED_FILENAME_LENGTH = 200

export function sanitizeAttachmentFilename(filename: string | null): string {
  const sanitized = (filename ?? '').replaceAll(/[^A-Za-z0-9._-]/g, '_')
  if (sanitized === '') return 'attachment'
  return sanitized.slice(0, MAX_SANITIZED_FILENAME_LENGTH)
}

/**
 * Record a caught processing failure on the ledger — `dead-letter` once
 * `MAX_INGEST_ATTEMPTS` would be reached, otherwise the retryable `failed`
 * (spec §4). Emits the same structured observability record as the success
 * paths (spec §6). `delivery.attempts` is passed as the fence
 * (`src/store/inbound-deliveries.ts`'s "The fence" section) — if it no longer
 * matches (this call's lease was reclaimed while parse/store was running),
 * the mark* write throws {@link LeaseLostError}, which is deliberately left
 * uncaught here and propagates to {@link ingestInboundMessage}'s own catch.
 */
async function recordFailure(
  delivery: StoredInboundDelivery,
  deps: IngestDeps,
  stage: 'parse' | 'blob' | 'store',
  err: unknown,
  base: IngestOutcomeBase,
): Promise<IngestOutcome> {
  const message = `${stage}: ${err instanceof Error ? err.message : String(err)}`
  const willDeadLetter = delivery.attempts + 1 >= MAX_INGEST_ATTEMPTS

  const updated = willDeadLetter
    ? await deps.inboundDeliveryStore.markDeadLetter(delivery.id, message, delivery.attempts)
    : await deps.inboundDeliveryStore.markFailed(delivery.id, message, delivery.attempts)

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
 *
 * `attachmentRefs` (HT-46) — the blob-key references {@link
 * writeAttachmentBlobs} already resolved, BEFORE this transaction opened —
 * are persisted here via `insertThreadAttachmentsInTx`, stamped with the
 * thread id this same transaction just minted. This is the only place a
 * `thread_attachments` row is created, and it happens in the SAME commit as
 * the thread it references: no reference can survive without its thread, and
 * no thread can be missing a reference for bytes this call already wrote (a
 * throw anywhere in this transaction rolls back the thread AND the
 * references together, per this doc's rollback paragraph above — only the
 * already-written blob bytes are left behind, orphaned, per the module doc).
 *
 * `claimedAttempts` (HT-45) is threaded straight through to `markStoredInTx`
 * as its fence (`src/store/inbound-deliveries.ts`'s "The fence" section): if
 * it no longer matches, `markStoredInTx` throws `LeaseLostError` and
 * `Db.transaction` rolls back the conversation/thread write — and the
 * attachment-reference rows — this call just made along with it. A stale,
 * lease-lost caller can never leave behind a conversation with no matching
 * ledger mark, or a `thread_attachments` row pointing at a thread that was
 * never committed; the only trace it leaves is the orphaned blob bytes the
 * paragraph above already accounts for.
 */
async function storeAndMarkDelivered(
  db: Db,
  deliveryId: string,
  decision: ThreadingDecision,
  parsed: ParsedEmail,
  attachmentRefs: Omit<NewThreadAttachment, 'threadId'>[],
  claimedAttempts: number,
): Promise<{ conversationId: string; threadId: string; appendFallback?: AppendFallbackReason }> {
  return db.transaction(async (tx) => {
    const written = await writeParsedEmail(tx, decision, parsed)
    await insertThreadAttachmentsInTx(
      tx,
      attachmentRefs.map((ref) => ({ ...ref, threadId: written.threadId })),
    )
    await markStoredInTx(
      tx,
      deliveryId,
      written.threadId,
      claimedAttempts,
      decision.forgedTokenCount,
    )
    return written
  })
}

/**
 * The `new`/`append`(+deleted/not-found fallback) store write itself — see
 * {@link storeAndMarkDelivered}'s doc comment for the transaction it runs
 * inside. When an `append` decision's target is gone, the returned
 * `appendFallback` names why (spec §6's append-fallback reason, HT-44) —
 * the decision itself is left untouched, so the caller can log both what
 * `decideThreading` decided AND what the store made of it.
 *
 * ## Event emission (HT-69; specs/modules/substrate-v1.md §4)
 *
 * This is "the ingestion append path" spec §4's vocabulary table means by
 * `conversation.created`/`conversation.message_received`: both are fired
 * HERE, inside the SAME `tx` this function already writes the conversation/
 * thread rows in (spec §4's transactional-outbox rule) — never inside
 * `appendThreadInTx`/`createConversationInTx` themselves, which are shared
 * by callers that must NOT fire these events (`src/mail/send.ts`'s outbound
 * `sendReply`, and the notes handler in `src/api/conversations.ts`, both go
 * through `appendThread` too, but neither is "an inbound thread stored").
 *
 * A brand-new conversation's first message fires BOTH events
 * (`conversation.created` with no data, then `conversation.message_
 * received` with `reopened: false` — a fresh conversation is never a
 * reopen) — this covers a genuinely fresh `decision.kind === 'new'` AND the
 * deleted/not-found fallback below, which also creates a fresh
 * conversation. A successful `append` fires only `conversation.message_
 * received`, with `reopened` taken verbatim from `AppendResult.reopened`
 * (`src/store/conversations.ts`) rather than re-derived here.
 *
 * **The `append` branch's event is gated on `appended.created` (review
 * fix)** — `AppendResult.ok: true` alone does not mean a row was actually
 * INSERTED; `created: false` is a replay (the get-or-insert found a
 * pre-existing row instead, `appendThreadInTx`'s own doc comment). Nothing
 * about `firstMessage` here sets `idempotencyKey` today (inbound threads
 * never carry one — migration 003's CHECK forbids it, and a genuine
 * redelivery of the SAME raw message is already intercepted one layer up by
 * `InboundDeliveryStore`'s own ledger dedup, which never calls this
 * function twice for one delivery — see `ingestInboundMessage`'s "idempotent
 * by step 1" doc), so `created` is always `true` at this call site as
 * things stand. The gate is defensive, not a fix for an exploitable path
 * today: `AppendResult`'s type does not promise `created` is always `true`
 * here, and firing `conversation.message_received` with a FRESH `eventId`
 * on a replay would defeat every consumer's `eventId` dedupe (spec §4) —
 * this is exactly the same "a genuinely NEW row is the only thing that
 * counts" discipline `appendThreadInTx` already applies to its own reopen/
 * `updated_at`-bump decision, applied here to event emission too.
 */
async function writeParsedEmail(
  tx: Queryable,
  decision: ThreadingDecision,
  parsed: ParsedEmail,
): Promise<{ conversationId: string; threadId: string; appendFallback?: AppendFallbackReason }> {
  const firstMessage: NewThread = {
    direction: 'inbound',
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    fromAddress: fromAddressOf(parsed),
    bodyText: parsed.text,
    bodyHtml: parsed.html,
  }

  if (decision.kind === 'new') {
    const created = await createConversationInTx(tx, {
      subject: parsed.subject,
      customerEmail: fromAddressOf(parsed),
      firstMessage,
    })
    await emitNewConversationEvents(tx, created.conversationId, created.threadId)
    return created
  }

  const appended = await appendThreadInTx(tx, decision.conversationId, firstMessage)
  if (appended.ok) {
    // Gated on `created` (review fix, module doc above): a replay
    // (`created: false`) must never re-fire the event with a fresh eventId.
    if (appended.created) {
      await appendOutboxEventInTx(tx, {
        type: 'conversation.message_received',
        conversationId: decision.conversationId,
        data: { threadId: appended.threadId, reopened: appended.reopened },
      })
    }
    return { conversationId: decision.conversationId, threadId: appended.threadId }
  }

  // 'deleted' or 'not-found' (threading.md §5, spec §3 step 5): the token
  // verified but its target conversation is gone or never existed — never
  // resurrect it, never drop the mail. Fall back to a fresh conversation.
  const created = await createConversationInTx(tx, {
    subject: parsed.subject,
    customerEmail: fromAddressOf(parsed),
    firstMessage,
  })
  await emitNewConversationEvents(tx, created.conversationId, created.threadId)
  return { ...created, appendFallback: appended.reason }
}

/** Fire `conversation.created` + `conversation.message_received` (`reopened: false`) for a freshly-created conversation's first thread — the one pair {@link writeParsedEmail} emits from two call sites (a genuine `new` decision, and the deleted/not-found fallback), factored out so both stay byte-identical. */
async function emitNewConversationEvents(
  tx: Queryable,
  conversationId: string,
  threadId: string,
): Promise<void> {
  await appendOutboxEventInTx(tx, {
    type: 'conversation.created',
    conversationId,
    data: {},
  })
  await appendOutboxEventInTx(tx, {
    type: 'conversation.message_received',
    conversationId,
    data: { threadId, reopened: false },
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

/**
 * The forged-token security event (threading.md §5, spec §6; HT-44) — one
 * WARN-level line per stored delivery whose threading decision counted at
 * least one candidate that matched our Message-ID pattern but FAILED
 * signature verification. Deliberately a SEPARATE line from the ordinary
 * `inbound_ingest` record (which also carries `forgedTokenCount`): a log
 * viewer can only text-match, not compare fields, so a burst is findable by
 * searching the event name alone, and `console.warn` gives it a severity
 * filter (`level:warning`) the info-level ingest line doesn't have. Carries
 * what an operator triaging a burst needs: who sent it (`senderAddress` —
 * threading.md §5's "burst against one conversation or sender") and where
 * the message landed. Emitted only on the `stored` path — the same
 * narrowing migration 019's doc comment records for the persisted count.
 */
function logForgedTokenEvent(
  base: IngestOutcomeBase,
  forgedTokenCount: number,
  senderAddress: string,
  written: { conversationId: string; threadId: string; appendFallback?: AppendFallbackReason },
): void {
  console.warn(
    JSON.stringify({
      event: 'forged_token_detected',
      ...base,
      forgedTokenCount,
      senderAddress,
      conversationId: written.conversationId,
      threadId: written.threadId,
    }),
  )
}
