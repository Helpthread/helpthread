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
  /** HT-54 breaking change (spec §3.3, §10): a real Agent id, or `null` (unassigned) — was `'me' | null`. */
  assigneeAgentId: string | null
  createdAt: string
  updatedAt: string
}

// --- Agents & Authentication (HT-54; specs/auth/agents-and-auth.md §6) -----
// Typed 1:1 against the engine branch's `src/api/agents.ts` handlers.

export type AgentRole = 'admin' | 'agent'
export type AgentStatus = 'invited' | 'active' | 'disabled'

/** The wire shape of one Agent (`toAgentJson`, `src/api/agents.ts`) — never carries a secret. */
export interface Agent {
  id: string
  email: string
  name: string
  role: AgentRole
  status: AgentStatus
  timezone: string
  createdAt: string
  updatedAt: string
}

/**
 * `GET /api/v1/auth/me`'s response shape (`handleAuthMe`) — deliberately
 * NARROWER than {@link Agent}: no `status` (an inactive Agent 401s instead of
 * being reported here) and no timestamps. Kept as its own type rather than
 * `Pick<Agent, ...>` aliasing so a future `/auth/me` field addition doesn't
 * silently widen this one.
 */
export interface SelfAgent {
  id: string
  email: string
  name: string
  role: AgentRole
  timezone: string
}

/** What the login UI needs to render one login method (`GET /auth/providers`, spec §6). */
export interface AuthProviderDescriptor {
  key: string
  label: string
  kind: 'credentials'
}

/**
 * Mirrors the engine's `MailboxStatus` (`src/store/mailboxes.ts`) — kept in
 * sync by hand, same posture as `api.ts`'s `ACTING_AGENT_HEADER` constant
 * (web and engine are separate packages, API-first only).
 */
export type MailboxStatus = 'active' | 'paused' | 'needs_reconnect' | 'disconnected'

/**
 * `GET /api/v1/mailboxes`'s roster entry (HT-54; specs/auth/agents-and-
 * auth.md §6 "Mailbox access") — the Permissions screen's checkbox roster,
 * the address is its label.
 */
export interface MailboxSummary {
  id: string
  address: string
  status: MailboxStatus
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
  /** v1.1 (HT-46) — inbound attachments this thread carries; per spec §2 the
   *  server ALWAYS emits this field, `[]` when there are none, or when the
   *  deployment hasn't wired the attachment read-path (config-gated, same
   *  posture as open tracking) — never absent. Required (not optional), like
   *  the sibling config-gated field `customerViewedAt` is required-nullable,
   *  so a server regression that drops the field fails the type at the
   *  boundary instead of silently rendering as "no attachments". */
  attachments: AttachmentView[]
  createdAt: string
}

export interface ConversationDetail extends ConversationSummary {
  threads: ThreadView[]
}

export interface ConversationListResponse {
  conversations: ConversationSummary[]
  nextCursor: string | null
}
