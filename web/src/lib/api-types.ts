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

/** v1.1 (HT-46) — one inbound attachment's metadata plus a time-limited
 *  signed `BlobStore` URL (never a stable/public path; it expires). */
export interface AttachmentView {
  id: string
  /** null when the attachment arrived with no filename. */
  filename: string | null
  contentType: string
  /** bytes */
  size: number
  url: string
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
  /** v1.1 (HT-46) — inbound attachments this thread carries; `[]` when there
   *  are none, or when the deployment hasn't wired the attachment read-path
   *  (config-gated, same posture as open tracking). Optional rather than
   *  required so a pre-HT-46 API a deployment hasn't yet rolled forward to
   *  doesn't fail this type at the boundary — the UI treats a missing field
   *  exactly like an empty list (render nothing). */
  attachments?: AttachmentView[]
  createdAt: string
}

export interface ConversationDetail extends ConversationSummary {
  threads: ThreadView[]
}

export interface ConversationListResponse {
  conversations: ConversationSummary[]
  nextCursor: string | null
}
