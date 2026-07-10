/**
 * Inbound threading decision — decides which conversation (if any) an
 * inbound email belongs to (specs/mail/threading.md §3; charter §2
 * "threading authority lives on the outbound side", invariant #3 "threading
 * correctness outranks feature velocity").
 *
 * The engine never trusts inbound `In-Reply-To`/`References` values on their
 * own — every mail client on earth writes them inconsistently. The only
 * authority is a signed reply token this engine minted onto its own OUTBOUND
 * `Message-ID` (`src/mail/reply-token.ts`) and can re-verify offline. A
 * header that merely *looks* like a threading reference but carries no
 * verified token has zero weight — inert, not a weaker signal
 * (specs/mail/threading.md §4).
 *
 * This module wires the parser (`src/mail/parse.ts`, `ParsedEmail`) to the
 * reply-token verifier (`src/mail/reply-token.ts`) and implements the
 * ordered decision procedure from specs/mail/threading.md §3. Pure: no I/O,
 * no DB lookups, no throwing on any `ParsedEmail` input (a well-formed
 * `Keyring` is required — `verifyReplyMessageId` already asserts that).
 */

import type { ParsedEmail } from './parse.js'
import { isReplyTokenShaped, type Keyring, verifyReplyMessageId } from './reply-token.js'

/**
 * The outcome of running the inbound threading decision on one email.
 *
 * - `'append'` — a candidate header carried a valid reply token; the message
 *   belongs to that token's conversation/thread lineage (specs/mail/threading.md
 *   §3 rule 2).
 * - `'new'` — no candidate header carried a valid token; this is a fresh
 *   conversation, full stop, regardless of subject (specs/mail/threading.md
 *   §3 rule 4).
 *
 * `forgedTokenCount` is carried on both variants: how many candidate headers
 * were SHAPED like one of our tokens (per {@link isReplyTokenShaped}) but
 * failed signature verification — i.e. forged or tampered. This is a
 * security signal (specs/mail/threading.md §5, "forged-token rate-limiting");
 * it is `0` in the normal case where no forgery attempt is present.
 */
export type ThreadingDecision =
  | { kind: 'append'; conversationId: string; threadId: string; forgedTokenCount: number }
  | { kind: 'new'; forgedTokenCount: number }

/**
 * Decide which conversation (if any) `email` belongs to, per
 * specs/mail/threading.md §3.
 *
 * ## Candidate ordering
 *
 * The candidate list is `In-Reply-To` FIRST, then each `References` entry
 * MOST-RECENT-FIRST. `In-Reply-To` names the specific message being replied
 * to, so it is checked before anything else. `ParsedEmail.references` is
 * preserved in wire order (oldest-first, per RFC 5322 §3.6.4 — the header
 * accumulates as a conversation ages), so this function reverses it before
 * scanning: the most recently appended reference is what the customer is
 * most immediately replying to, and should be tried before older entries
 * (specs/mail/threading.md §3 rule 1, §5 "multiple valid tokens" open
 * question — most-recent-wins is the documented, if not yet
 * fixture-confirmed, intent).
 *
 * ## Subject is never consulted
 *
 * `email.subject` is deliberately never read here — not even as a
 * tiebreaker or fallback. Subject carries zero threading weight, matched or
 * not, `Re:`-prefixed or not (specs/mail/threading.md §3 rules 4–5, §4).
 *
 * ## Deduplication
 *
 * The same message-id can legally appear in both `In-Reply-To` and
 * `References` (or repeated within `References`). This function does NOT
 * deduplicate the candidate list — it scans candidates exactly as built and
 * verifies each one encountered. Verification is cheap, pure, and
 * idempotent, so re-checking the same string twice is harmless; a duplicate
 * only affects `forgedTokenCount` if the SAME shaped-but-invalid string is
 * literally repeated as a separate list entry, in which case it is counted
 * once per occurrence (each occurrence is a distinct candidate position, not
 * a distinct forgery — see the field doc on {@link ThreadingDecision}).
 *
 * ## `forgedTokenCount`
 *
 * Incremented for every candidate that is shaped like one of our tokens
 * ({@link isReplyTokenShaped}) but fails verification, in scan order, up to
 * and including the point where scanning stops (either the first valid
 * token found, or the end of the candidate list).
 */
export function decideThreading(email: ParsedEmail, keyring: Keyring): ThreadingDecision {
  const candidates = buildCandidates(email)

  let forgedTokenCount = 0
  for (const candidate of candidates) {
    const payload = verifyReplyMessageId(candidate, keyring)
    if (payload !== null) {
      return {
        kind: 'append',
        conversationId: payload.conversationId,
        threadId: payload.threadId,
        forgedTokenCount,
      }
    }
    if (isReplyTokenShaped(candidate)) {
      forgedTokenCount += 1
    }
    // Not shaped like ours at all (e.g. a real client's Message-ID) — not
    // ours to judge; ignore and keep scanning.
  }

  return { kind: 'new', forgedTokenCount }
}

/** Extract every angle-bracketed `<...>` message-id from a raw header value, in order. */
function extractMessageIds(headerValue: string): string[] {
  return headerValue.match(/<[^>]+>/g) ?? []
}

/**
 * Build the ordered candidate list per specs/mail/threading.md §3 rule 1:
 * `In-Reply-To` first, then `References` most-recent-first (wire order is
 * oldest-first, so it is reversed here).
 *
 * Both headers are TOKENIZED — we extract the angle-bracketed `<...>`
 * message-ids from each, rather than treating the raw header string as a
 * single candidate. RFC 5322 §3.6.4 permits CFWS/comments between (and
 * around) message-ids and more than one id in `In-Reply-To`, so a verbatim
 * header like `In-Reply-To: (client note) <ht-token@domain>` would never
 * match a token if compared whole — the valid reply would be mis-threaded to
 * a NEW conversation. `references` entries are already single tokens from the
 * parser, but tokenizing them here too is idempotent and keeps the two paths
 * symmetric. A header carrying no `<...>` id contributes no candidate.
 */
function buildCandidates(email: ParsedEmail): string[] {
  const fromInReplyTo = email.inReplyTo ? extractMessageIds(email.inReplyTo) : []
  const fromReferences = [...email.references].reverse().flatMap(extractMessageIds)
  return [...fromInReplyTo, ...fromReferences]
}
