/**
 * Wire types for the Agent Inbox API, 1:1 with `specs/api/agent-inbox-v1.md`
 * (v1.1) §2. Pure types with no imports, so BOTH sides can use them: the
 * server-only client (`api.ts`) and client components receiving fetched
 * data as props.
 */

export type ConversationStatus = 'active' | 'pending' | 'closed' | 'spam'
export type ConversationFolder = 'open' | 'closed' | 'spam'

export interface ConversationSummary {
  id: string
  number: number
  subject: string
  customerEmail: string
  status: ConversationStatus
  threadCount: number
  preview: string
  tags: string[]
  assignee: 'me' | null
  createdAt: string
  updatedAt: string
}

export interface ThreadView {
  id: string
  direction: 'inbound' | 'outbound' | 'note'
  from: string
  bodyText: string | null
  /** ⚠ UNTRUSTED, UNSANITIZED (spec §5) — render only through SanitizedHtml. */
  bodyHtml: string | null
  deliveryStatus: 'pending' | 'sent' | 'failed' | null
  customerViewedAt: string | null
  createdAt: string
}

export interface ConversationDetail extends ConversationSummary {
  threads: ThreadView[]
}

export interface ConversationListResponse {
  conversations: ConversationSummary[]
  nextCursor: string | null
}
