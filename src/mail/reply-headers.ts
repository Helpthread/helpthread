/**
 * Derive a reply's mail headers (`subject`, `In-Reply-To`, `References`)
 * from the conversation being replied to (specs/api/agent-inbox-v1.md
 * §4a). Extracted from `src/api/conversations.ts` (HT-70) so the Agent-
 * authored reply path (`handleReply`) and the draft-approval orchestration
 * (`src/mail/approve-draft.ts`, spec §6 step 2 — "derive the envelope
 * exactly per agent-inbox-v1 §4a") share the EXACT same derivation rather
 * than two independently-drifting copies. Pure, no I/O — the caller
 * supplies the conversation's already-loaded threads.
 */

import type { StoredThread } from '../store/conversations.js'

/**
 * - `subject`: the conversation's subject, `Re: `-prefixed unless it
 *   already starts with `re:` (case-insensitive) — never double-prefixed.
 * - `inReplyTo`: the `messageId` of the most-recent INBOUND thread that has
 *   one. Threads are stored oldest-first, so this walks from the end
 *   looking for the first (i.e. most recent) inbound thread with a
 *   non-null `messageId`. `undefined` if there is none (e.g. every inbound
 *   message arrived without a `Message-ID`).
 * - `references`: every thread's `messageId`, in chronological order, that
 *   is non-null. `undefined` (the key omitted entirely, per spec §4a) when
 *   NO thread has one — never an empty array in that case. A draft thread
 *   awaiting approval always has `messageId: null` (minted only at
 *   approval), so it contributes nothing here without needing to be
 *   filtered out specially.
 */
export function deriveReplyHeaders(conversation: { subject: string; threads: StoredThread[] }): {
  subject: string
  inReplyTo: string | undefined
  references: string[] | undefined
} {
  const subject = /^re:/i.test(conversation.subject)
    ? conversation.subject
    : `Re: ${conversation.subject}`

  let inReplyTo: string | undefined
  for (let i = conversation.threads.length - 1; i >= 0; i--) {
    const thread = conversation.threads[i]
    if (thread.direction === 'inbound' && thread.messageId !== null) {
      inReplyTo = thread.messageId
      break
    }
  }

  const referencesList = conversation.threads
    .map((t) => t.messageId)
    .filter((messageId): messageId is string => messageId !== null)
  const references = referencesList.length > 0 ? referencesList : undefined

  return { subject, inReplyTo, references }
}
