/**
 * Draft-approval orchestration (HT-70; specs/plugins/substrate-v1.md §6
 * "What approval actually does") — the write path behind
 * `POST /api/v1/drafts/{threadId}/approve` (`src/api/drafts.ts`).
 *
 * `sendReply` (`./send.ts`) CANNOT be reused here — it mints and INSERTs a
 * *new* thread row and has no entry point for resolving an EXISTING one
 * (spec §6's own framing). This module instead performs, in one
 * transaction via `ConversationStore.resolveDraft`, the same derivations
 * `sendReply` performs pre-insert, then hands off to the EXISTING,
 * UNCHANGED delivery machinery (`attemptDeliveryOfClaimedThread` — the
 * exact function `sendReply`'s own keyed-retry path and the delivery
 * worker both call), so a draft approval and an ordinary keyed reply share
 * identical send/lease/retry/self-echo semantics from that point on.
 *
 * Steps (spec §6, verbatim order):
 *
 * 1. Mint the reply token + `Message-ID` for the draft's EXISTING thread id
 *    (`mintReplyMessageId`, `specs/mail/threading.md` §2a — same mint, same
 *    key rotation `sendReply` uses).
 * 2. Derive the envelope exactly per agent-inbox-v1 §4a — recipient/subject
 *    from the conversation, `In-Reply-To`/`References` from the latest
 *    inbound thread, with the minted id as the FINAL `References` entry
 *    (the HT-49 rule) — via `deriveReplyHeaders` (`./reply-headers.ts`),
 *    the SAME function `handleReply` uses, so the two paths can never
 *    drift.
 * 3. HT-32 pixel injection iff configured — byte-identical mail when
 *    absent, exactly like `sendReply`. See the "persisted body" note below
 *    for why this can change what gets written even on an UNEDITED
 *    approval.
 * 4. `ConversationStore.resolveDraft` — one atomic write: message id +
 *    envelope snapshot, `draft_status → 'approved'`,
 *    `delivery_status → 'pending'`, approving-Agent audit fields.
 * 5. Hand off to the EXISTING delivery path: claim the row
 *    (`ConversationStore.claimThreadForDelivery`) then
 *    `attemptDeliveryOfClaimedThread` — unchanged, not modified by this
 *    ticket.
 *
 * ## The persisted body vs. the `draft_edited` audit flag
 *
 * These are deliberately DECOUPLED (see `ResolveDraftInput`'s doc comment,
 * `src/store/conversations.ts`). The persisted `body_html` this function
 * asks `resolveDraft` to write is the pixel-injected version whenever
 * HT-32 is configured — matching `sendReply`'s own "injection happens
 * BEFORE persist, so every retry (which rebuilds from the stored row)
 * carries the same pixel" invariant, since `attemptDeliveryOfClaimedThread`
 * always sends whatever is currently persisted, never a value this
 * function could pass around it. But `draft_edited` (spec §2: "did the
 * approving AGENT change the body before sending") reflects ONLY whether
 * the caller's `input.edit` was actually submitted — pixel injection with
 * no Agent edit at all still records `edited: false`, an honest audit
 * trail rather than a false positive.
 */

import type { EmailSender } from '../providers/index.js'
import type {
  ConversationStore,
  SendEnvelope,
  StoredConversation,
  StoredThread,
} from '../store/conversations.js'
import { injectTrackingPixel, mintViewToken, pixelUrlFor } from './open-tracking.js'
import { deriveReplyHeaders } from './reply-headers.js'
import { type Keyring, mintReplyMessageId } from './reply-token.js'
import {
  assertLeaseExceedsSenderBound,
  attemptDeliveryOfClaimedThread,
  DEFAULT_LEASE_MS,
  type SelfEchoGuardDeps,
} from './send.js'

/** Dependencies {@link approveDraft} needs — the same shape `SendReplyDeps` uses, minus `mailDomain`'s sibling fields this function doesn't need (no `from` derivation — the draft's own `from_address`, set at draft-creation time to the deployment's support address, is already correct and untouched by approval). */
export interface ApproveDraftDeps {
  store: ConversationStore
  sender: EmailSender
  keyring: Keyring
  mailDomain: string
  /** HT-32 open tracking — ABSENT BY DEFAULT, same posture as `SendReplyDeps.openTracking`. */
  openTracking?: { publicBaseUrl: string }
  /** See `SendReplyDeps.selfEchoGuard`. ABSENT BY DEFAULT. */
  selfEchoGuard?: SelfEchoGuardDeps
}

/** Input to {@link approveDraft}. */
export interface ApproveDraftInput {
  /**
   * The draft's conversation, WITH every current thread. The API layer
   * (`src/api/drafts.ts`) already loaded this via
   * `ConversationStore.getConversationByThreadId` to check soft-delete/spam
   * (spec §6) before calling here — re-fetching it would be redundant I/O
   * for a value this function needs anyway (envelope derivation, and
   * finding the draft's own row).
   */
  conversation: StoredConversation & { threads: StoredThread[] }
  draftThreadId: string
  resolvedByAgentId: string
  /**
   * The approving Agent's optional body override ("approve with edits",
   * spec §6) — RAW, exactly as the API layer parsed it from the request.
   * `undefined` means no override was submitted; this is what drives the
   * `draft_edited` audit flag (see the module doc), independent of
   * whether HT-32 pixel injection still changes the persisted `bodyHtml`.
   */
  edit?: { bodyText?: string; bodyHtml?: string }
}

/**
 * The outcome of {@link approveDraft} — mirrors `SendReplyResult`'s shape
 * (`./send.ts`) for the outcomes this function shares with it (a claimed
 * row's delivery attempt can fail or race exactly the same way a keyed
 * reply retry's can), plus `not-a-draft` for a resolution that resolved no
 * row (unknown id, already resolved, or a genuine race between the API
 * layer's snapshot and this call).
 */
export type ApproveDraftResult =
  | { ok: true; threadId: string; messageId: string; delivery: 'sent' }
  | { ok: false; reason: 'not-a-draft' }
  | { ok: false; reason: 'retry-in-progress' }
  | {
      ok: false
      reason: 'send-failed'
      threadId: string
      messageId: string
      persistedStatus: 'failed' | 'pending'
    }

export async function approveDraft(
  input: ApproveDraftInput,
  deps: ApproveDraftDeps,
): Promise<ApproveDraftResult> {
  const { store, sender, keyring, mailDomain } = deps

  const draftThread = input.conversation.threads.find((t) => t.id === input.draftThreadId)
  if (draftThread === undefined || draftThread.draftStatus !== 'awaiting_review') {
    return { ok: false, reason: 'not-a-draft' }
  }

  // Step 1: mint for the draft's EXISTING thread id — never a fresh one.
  const messageId = mintReplyMessageId(
    { conversationId: input.conversation.id, threadId: input.draftThreadId, mailDomain },
    keyring,
  )

  // Step 2: same derivation handleReply uses (src/api/conversations.ts).
  // The draft's own row contributes nothing to this scan (its messageId is
  // still null pre-approval), so no special-casing is needed to exclude it.
  const {
    subject,
    inReplyTo,
    references: ancestorReferences,
  } = deriveReplyHeaders(input.conversation)
  // HT-49: append this reply's own minted messageId as the FINAL References
  // entry — identical rule to send.ts's sendReply.
  const references = [...(ancestorReferences ?? []), messageId]

  // Step 3: HT-32 pixel injection, iff configured — only the HTML body is
  // ever touched; a text-only draft gets no fabricated HTML part, matching
  // sendReply's own behavior.
  const overrideHtml = input.edit?.bodyHtml
  const bodyHtmlBeforePixel = overrideHtml ?? draftThread.bodyHtml ?? undefined
  const finalBodyHtml =
    deps.openTracking !== undefined && bodyHtmlBeforePixel !== undefined
      ? injectTrackingPixel(
          bodyHtmlBeforePixel,
          pixelUrlFor(deps.openTracking.publicBaseUrl, mintViewToken(input.draftThreadId, keyring)),
        )
      : bodyHtmlBeforePixel

  // Only ask resolveDraft to WRITE a new body_html when it actually differs
  // from what is already stored (an Agent override, or pixel injection) —
  // an unedited, un-pixel'd approval leaves body_html completely untouched
  // (COALESCE keeps the existing value either way; this is a value
  // decision to avoid a no-op write, not a correctness requirement).
  const bodyHtmlChanged = finalBodyHtml !== (draftThread.bodyHtml ?? undefined)

  const sendEnvelope: SendEnvelope = {
    to: [input.conversation.customerEmail],
    subject,
    references,
  }

  const editForResolve: { bodyText?: string; bodyHtml?: string } = {}
  if (input.edit?.bodyText !== undefined) {
    editForResolve.bodyText = input.edit.bodyText
  }
  if (bodyHtmlChanged && finalBodyHtml !== undefined) {
    editForResolve.bodyHtml = finalBodyHtml
  }

  // Step 4: one atomic write (message id + envelope + draft_status +
  // delivery_status + audit fields) — also fires draft.resolved (spec §4)
  // in the SAME transaction, inside the store.
  const resolved = await store.resolveDraft({
    action: 'approve',
    threadId: input.draftThreadId,
    resolvedByAgentId: input.resolvedByAgentId,
    messageId,
    sendEnvelope,
    inReplyTo: inReplyTo ?? null,
    edit: editForResolve,
    edited: input.edit !== undefined,
  })
  if (resolved === null) {
    // A race: resolved by someone else (or was never a draft) between the
    // API layer's snapshot and this write. Nothing was persisted that needs
    // undoing — resolveDraft's UPDATE simply matched zero rows.
    return { ok: false, reason: 'not-a-draft' }
  }

  // Step 5: hand off to the EXISTING, UNCHANGED delivery path — the same
  // claim + attemptDeliveryOfClaimedThread pair sendReply's own keyed-retry
  // branch uses.
  assertLeaseExceedsSenderBound(sender, DEFAULT_LEASE_MS)
  const claimed = await store.claimThreadForDelivery(resolved.id, DEFAULT_LEASE_MS)
  if (claimed === null) {
    // Same two-reasons disambiguation as sendReply's own claim-failure
    // handling (./send.ts) — re-read to tell "someone else is already
    // sending it" from "it already sent."
    const current = await store.getConversation(resolved.conversationId, {
      includeDeleted: false,
    })
    const currentThread = current?.threads.find((t) => t.id === resolved.id)
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
