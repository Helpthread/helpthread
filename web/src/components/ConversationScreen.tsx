'use client'

/**
 * One conversation: toolbar (back, reply/note/delete, tags, star, more,
 * assignee/status/position — subject/#number/status pill on a wrapped
 * second row), a SUMMONED composer (hidden by default; opens via the
 * toolbar Reply/Note buttons, the `r`/`n` keys, or automatically when a
 * saved draft exists), and the thread as full-bleed MessageBands
 * newest-first (design-system rule: bands, not chat bubbles).
 *
 * The composer implements spec §4a's client contract faithfully:
 * - ONE Idempotency-Key per logical send, minted when the draft starts and
 *   reused verbatim on every retry — a 409 `retry_in_progress` or a network
 *   failure never mints a new key (that would risk a duplicate send). A
 *   `400 validation_failed` DOES mint a new key — the original attempt never
 *   reached the send path, so there is nothing to safely replay.
 * - `send_failed` (502) keeps the draft and says exactly what is true:
 *   nothing reached the customer, with a "Retry send" action that reuses
 *   the same key.
 * - Only a SUCCESS clears the draft and rotates the key.
 *
 * This screen also owns its own keyboard shortcuts (j/k conversation nav,
 * r/n to open the composer, ⌘/Ctrl+↵ to send, and a cascading Escape) — see
 * the keydown effect below, coordinated with `ShortcutsProvider`'s overlay.
 */

import { useRouter } from 'next/navigation'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState, useTransition } from 'react'
import {
  deleteConversationAction,
  postNoteAction,
  putAssigneeAction,
  putTagsAction,
  sendReplyAction,
  setStatusAction,
} from '../lib/actions'
import type { Agent, ConversationDetail, ConversationStatus, ThreadView } from '../lib/api-types'
import { clearDraft, getDraft, writeDraft } from '../lib/drafts'
import { humanFileSize, messageTime, nameFromEmail, relativeTime, shortDate } from '../lib/format'
import { useStarred } from '../lib/starred'
import { Avatar } from './ds/core/Avatar'
import { Button } from './ds/core/Button'
import { DropdownMenu } from './ds/core/DropdownMenu'
import { IconButton } from './ds/core/IconButton'
import { MenuItem } from './ds/core/MenuItem'
import { StatusPill } from './ds/core/StatusPill'
import { TagChip } from './ds/core/TagChip'
import { TextInput } from './ds/core/TextInput'
import { MessageBand } from './ds/inbox/MessageBand'
import { ToolbarBand } from './ds/inbox/ToolbarBand'
import { SanitizedHtml } from './SanitizedHtml'
import { useShortcutsOverlay } from './ShortcutsProvider'
import { useToast } from './Toaster'

const MAX_REPLY_LENGTH = 5000
const MAX_TAG_LENGTH = 40
const DELETE_DISARM_MS = 3500
const DRAFT_SAVE_DEBOUNCE_MS = 300

/** Reply-mode formatting is honestly reported only when the Agent actually
 *  used the toolbar — checked by tag presence, not by diffing markup. */
function hasRichFormatting(el: HTMLElement): boolean {
  return el.querySelector('b, i, ul, a') !== null
}

/** contenteditable's `innerText` reports a trailing newline for the last
 *  (empty) line — trim only trailing whitespace, keep interior formatting. */
function normalizedInnerText(el: HTMLElement): string {
  return el.innerText.replace(/\s+$/, '')
}

function pillTabStyle(active: boolean): CSSProperties {
  return {
    border: 'none',
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: 12.5,
    fontWeight: 700,
    cursor: 'pointer',
    background: active ? 'var(--ht-accent)' : 'var(--ht-surface-2)',
    color: active ? 'var(--ht-on-accent)' : 'var(--ht-ink-muted)',
  }
}

function counterStyle(length: number): CSSProperties {
  const over = length > MAX_REPLY_LENGTH
  return {
    fontSize: 11.5,
    fontVariantNumeric: 'tabular-nums',
    fontWeight: over ? 700 : 400,
    color: over ? 'var(--ht-critical)' : 'var(--ht-ink-dim)',
  }
}

const WARN_BANNER_STYLE: CSSProperties = {
  marginBottom: 10,
  padding: '8px 12px',
  borderRadius: 'var(--ht-radius-md)',
  background: 'color-mix(in oklab, var(--ht-warn) 9%, var(--ht-surface))',
  border: '1px solid color-mix(in oklab, var(--ht-warn) 30%, transparent)',
  fontSize: 12.5,
  color: 'var(--ht-ink-muted)',
}

const CRITICAL_BANNER_STYLE: CSSProperties = {
  marginBottom: 10,
  padding: '10px 14px',
  borderRadius: 'var(--ht-radius-md)',
  background: 'var(--ht-critical-soft)',
  border: '1px solid color-mix(in oklab, var(--ht-critical) 28%, transparent)',
}

/** Plain borderless icon buttons on the format-toolbar row — the design has
 *  no grey pill/segmented group around them, just hover feedback. */
const FORMAT_BUTTON_STYLE: CSSProperties = {
  width: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12.5,
  fontWeight: 700,
  color: 'var(--ht-ink-muted)',
  background: 'none',
  border: 'none',
  borderRadius: 'var(--ht-radius-sm)',
  cursor: 'pointer',
}

function onFormatButtonHover(event: { currentTarget: HTMLElement }): void {
  event.currentTarget.style.background = 'var(--ht-surface-2)'
}

function onFormatButtonUnhover(event: { currentTarget: HTMLElement }): void {
  event.currentTarget.style.background = 'none'
}

const CONTENT_EDITABLE_STYLE: CSSProperties = {
  minHeight: 84,
  outline: 'none',
  fontSize: 14,
  lineHeight: 1.6,
  color: 'var(--ht-ink)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'break-word',
}

export interface ConversationNeighborPosition {
  index: number
  total: number
  prevId: string | null
  nextId: string | null
}

/** A prior conversation from the same customer — the context panel's
 *  "Previous conversations" section (design fix C5). */
export interface PreviousConversationSummary {
  id: string
  subject: string
  status: ConversationStatus
  updatedAt: string
}

const STATUS_META: Record<ConversationStatus, { label: string; fg: string; bg: string }> = {
  active: { label: 'Active', fg: 'var(--ht-accent)', bg: 'var(--ht-accent-soft)' },
  pending: {
    label: 'Pending',
    fg: 'var(--ht-warn)',
    bg: 'color-mix(in oklab, var(--ht-warn) 12%, transparent)',
  },
  closed: { label: 'Closed', fg: 'var(--ht-ink-dim)', bg: 'var(--ht-surface-2)' },
  spam: { label: 'Spam', fg: 'var(--ht-critical)', bg: 'var(--ht-critical-soft)' },
}

function ReplyIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="9 17 4 12 9 7" />
      <path d="M4 12h10a6 6 0 0 1 6 6v1" />
    </svg>
  )
}

function NoteIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

function TagIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82Z" />
      <circle cx="7" cy="7" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

/** HT-46 inbound-attachment marker — the same stroke weight/size family as
 *  the other inline message-band icons on this screen. */
function PaperclipIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.44 11.05 12.25 20.24a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48" />
    </svg>
  )
}

function PersonIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function FlagIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="12" r="2" fill="currentColor" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
      <circle cx="19" cy="12" r="2" fill="currentColor" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <polyline
        points="6 9 12 15 18 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <polyline
        points="15 18 9 12 15 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <polyline
        points="9 18 15 12 9 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function BulletListIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      <circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <line
        x1="18"
        y1="6"
        x2="6"
        y2="18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="6"
        y1="6"
        x2="18"
        y2="18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** ⌄ per-message menu — Copy text / Show original. Positioned by the caller's wrapper div. */
function MessageMenu({
  open,
  onToggle,
  onClose,
  onCopyText,
  onShowOriginal,
}: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  onCopyText: () => void
  onShowOriginal: () => void
}) {
  return (
    <div style={{ position: 'absolute', top: 8, right: 12 }}>
      <IconButton title="Message actions" size={24} active={open} onClick={onToggle}>
        <ChevronDownIcon />
      </IconButton>
      <DropdownMenu open={open} onClose={onClose} align="right" minWidth={160}>
        <MenuItem onClick={onCopyText}>Copy text</MenuItem>
        <MenuItem onClick={onShowOriginal}>Show original</MenuItem>
      </DropdownMenu>
    </div>
  )
}

/**
 * Fixed centered modal: the raw source, exactly as it arrived, never
 * rendered as HTML. Escape is handled by the parent's cascading Escape
 * handler (this modal has top priority in that cascade), not locally — a
 * single owner avoids two listeners racing to close the same state.
 */
function OriginalMessageModal({ thread, onClose }: { thread: ThreadView; onClose: () => void }) {
  const bodyKind =
    thread.bodyHtml !== null && thread.bodyText !== null && thread.bodyText !== ''
      ? 'HTML + text'
      : thread.bodyHtml !== null
        ? 'HTML only'
        : thread.bodyText !== null
          ? 'Text only'
          : 'Empty'

  const source = thread.bodyHtml ?? thread.bodyText ?? ''

  return (
    <>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 79,
          border: 'none',
          padding: 0,
          cursor: 'default',
          background: 'color-mix(in oklab, black 45%, transparent)',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Original message"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 80,
          width: 'min(640px, 90vw)',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--ht-surface)',
          border: '1px solid var(--ht-border)',
          borderRadius: 'var(--ht-radius-lg, 8px)',
          boxShadow: 'var(--ht-shadow-md)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '14px 18px',
            borderBottom: '1px solid var(--ht-divider)',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Original message</span>
          <span style={{ flex: 1 }} />
          <IconButton title="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div
          style={{
            padding: '14px 18px',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            rowGap: 6,
            columnGap: 12,
            fontSize: 12.5,
            flexShrink: 0,
          }}
        >
          <span style={{ color: 'var(--ht-ink-dim)' }}>From</span>
          <span style={{ fontFamily: 'var(--ht-mono)', overflowWrap: 'break-word' }}>
            {thread.from}
          </span>
          <span style={{ color: 'var(--ht-ink-dim)' }}>Date</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {new Date(thread.createdAt).toLocaleString()}
          </span>
          <span style={{ color: 'var(--ht-ink-dim)' }}>Body kind</span>
          <span>{bodyKind}</span>
        </div>
        <pre
          style={{
            margin: '0 18px 14px',
            padding: 12,
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            background: 'var(--ht-surface-2)',
            borderRadius: 'var(--ht-radius-md)',
            fontFamily: 'var(--ht-mono)',
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
          }}
        >
          {source}
        </pre>
        <div
          style={{
            padding: '0 18px 16px',
            fontSize: 11,
            color: 'var(--ht-ink-dim)',
            flexShrink: 0,
          }}
        >
          Shown as source, never rendered — this is the untrusted message exactly as it arrived.
        </div>
      </div>
    </>
  )
}

export function ConversationScreen({
  conversation,
  position,
  previousConversations,
  agents,
  selfId,
}: {
  conversation: ConversationDetail
  position: ConversationNeighborPosition | null
  previousConversations: PreviousConversationSummary[]
  /** The Agent roster (`listAgents()`, HT-54) — every ACTIVE Agent may appear in the assignee menu. */
  agents: Agent[]
  /** The viewing Agent's own id (`getMe()`) — resolves "Assign to me". */
  selfId: string
}) {
  const router = useRouter()
  const showToast = useToast()
  const { isStarred, toggle } = useStarred()
  const { isOpen: isShortcutsOverlayOpen } = useShortcutsOverlay()

  const [isPending, startTransition] = useTransition()

  // The summoned composer — hidden by default (spec: opens via the toolbar,
  // r/n, or automatically when a saved draft exists).
  const [composerOpen, setComposerOpen] = useState(false)
  const [composerMode, setComposerMode] = useState<'reply' | 'note'>('reply')
  const [composerError, setComposerError] = useState<string | null>(null)
  const [sendFailed, setSendFailed] = useState(false)
  const [replyTextLength, setReplyTextLength] = useState(0)
  const [noteDraft, setNoteDraft] = useState('')
  // Bumped by the per-conversation reset below so the DOM-population effect
  // re-runs even when `composerOpen` itself doesn't change value (both
  // conversations have a draft, so it's `true` on both sides of a j/k nav).
  const [composerGeneration, setComposerGeneration] = useState(0)

  const replyBodyRef = useRef<HTMLDivElement | null>(null)
  const noteTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Plain text loaded from localStorage for the CURRENT conversation, and
  // the live in-session HTML once the Agent has actually typed (so toggling
  // the composer closed/open again within the same visit keeps formatting —
  // only localStorage itself is plain-text-only, per the draft contract).
  const replyDraftTextRef = useRef<string>('')
  const replyBodyHtmlRef = useRef<string | null>(null)
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // One key per logical send (spec §4a) — rotated on success, and on a
  // validation failure (the original attempt never reached the send path).
  const idempotencyKey = useRef<string>(crypto.randomUUID())

  const [status, setLocalStatus] = useState<ConversationStatus>(conversation.status)
  const [tags, setTags] = useState<string[]>(conversation.tags)
  const [assigneeAgentId, setAssigneeAgentId] = useState<string | null>(
    conversation.assigneeAgentId,
  )

  const [tagInput, setTagInput] = useState('')
  const [tagsMenuOpen, setTagsMenuOpen] = useState(false)
  const [assigneeMenuOpen, setAssigneeMenuOpen] = useState(false)
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [following, setFollowing] = useState(false)
  const [previousConversationsOpen, setPreviousConversationsOpen] = useState(true)

  const [deleteArmed, setDeleteArmed] = useState(false)
  const deleteDisarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guards changeStatus against concurrent status changes: while one request
  // is in flight, a second click is a no-op rather than racing it — so
  // `previous` (captured per-call for rollback) is always a value the server
  // actually confirmed, never another in-flight call's unconfirmed optimism.
  const statusChangeInFlight = useRef(false)

  const [openMessageMenuId, setOpenMessageMenuId] = useState<string | null>(null)
  const [originalMessage, setOriginalMessage] = useState<ThreadView | null>(null)

  useEffect(() => {
    return () => {
      if (deleteDisarmTimer.current !== null) clearTimeout(deleteDisarmTimer.current)
      if (draftSaveTimer.current !== null) clearTimeout(draftSaveTimer.current)
    }
  }, [])

  // Per-conversation reset — this component instance is reused across
  // conversations (j/k, prev/next chevrons navigate without remounting), so
  // this can't be a one-time mount effect. Loads that conversation's saved
  // draft and auto-opens the composer when one exists.
  useEffect(() => {
    const existingDraft = getDraft(conversation.id) ?? ''
    replyDraftTextRef.current = existingDraft
    replyBodyHtmlRef.current = null
    setReplyTextLength(existingDraft.length)
    setNoteDraft('')
    setComposerError(null)
    setSendFailed(false)
    idempotencyKey.current = crypto.randomUUID()
    setComposerGeneration((generation) => generation + 1)
    if (existingDraft.length > 0) {
      setComposerMode('reply')
      setComposerOpen(true)
    } else {
      setComposerOpen(false)
    }
  }, [conversation.id])

  // Populate the (uncontrolled) contenteditable whenever the reply composer
  // becomes visible — never on every keystroke, so the caret stays put.
  // biome-ignore lint/correctness/useExhaustiveDependencies: composerGeneration is the trigger, not read in the body
  useEffect(() => {
    if (!composerOpen || composerMode !== 'reply') return
    const el = replyBodyRef.current
    if (el === null) return
    if (replyBodyHtmlRef.current !== null) {
      el.innerHTML = replyBodyHtmlRef.current
    } else {
      el.textContent = replyDraftTextRef.current
    }
    setReplyTextLength(normalizedInnerText(el).length)
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [composerOpen, composerMode, composerGeneration])

  useEffect(() => {
    if (composerOpen && composerMode === 'note') noteTextareaRef.current?.focus()
  }, [composerOpen, composerMode])

  function scheduleDraftSave(text: string): void {
    if (draftSaveTimer.current !== null) clearTimeout(draftSaveTimer.current)
    draftSaveTimer.current = setTimeout(() => {
      writeDraft(conversation.id, text)
      replyDraftTextRef.current = text
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }

  function onReplyBodyInput(): void {
    const el = replyBodyRef.current
    if (el === null) return
    replyBodyHtmlRef.current = el.innerHTML
    const text = normalizedInnerText(el)
    setReplyTextLength(text.length)
    setComposerError(null)
    scheduleDraftSave(text)
  }

  // document.execCommand is deprecated, but it remains the only
  // cross-browser way to drive a contenteditable's rich-text edits without
  // pulling in a full editor library — exactly what the prototype does.
  function applyFormat(command: 'bold' | 'italic' | 'insertUnorderedList'): void {
    replyBodyRef.current?.focus()
    document.execCommand(command)
    onReplyBodyInput()
  }

  function applyLink(): void {
    const url = window.prompt('Link URL')
    if (url === null || url.trim().length === 0) return
    replyBodyRef.current?.focus()
    document.execCommand('createLink', false, url.trim())
    onReplyBodyInput()
  }

  function openComposer(mode: 'reply' | 'note'): void {
    setComposerMode(mode)
    setComposerError(null)
    setSendFailed(false)
    setComposerOpen(true)
  }

  function closeComposer(): void {
    setComposerOpen(false)
  }

  function switchComposerMode(mode: 'reply' | 'note'): void {
    setComposerMode(mode)
    setComposerError(null)
    setSendFailed(false)
  }

  function sendReply(): void {
    const el = replyBodyRef.current
    const text = el !== null ? normalizedInnerText(el) : ''
    if (text.trim().length < 1) {
      setComposerError("Write a reply first — the message can't be empty.")
      return
    }
    if (text.length > MAX_REPLY_LENGTH) {
      setComposerError('Replies are limited to 5,000 characters.')
      return
    }
    setComposerError(null)
    setSendFailed(false)
    const html = el !== null && hasRichFormatting(el) ? el.innerHTML : undefined
    const wasClosedOrSpam = status === 'closed' || status === 'spam'
    startTransition(async () => {
      const result = await sendReplyAction(conversation.id, text, idempotencyKey.current, html)
      if (result.ok) {
        clearDraft(conversation.id)
        replyDraftTextRef.current = ''
        replyBodyHtmlRef.current = null
        if (el !== null) el.innerHTML = ''
        setReplyTextLength(0)
        idempotencyKey.current = crypto.randomUUID()
        setComposerOpen(false)
        if (wasClosedOrSpam) {
          setLocalStatus('active')
          showToast({
            title: 'Reply sent — conversation reopened',
            detail: 'Replying to a closed conversation reopens it.',
          })
        } else {
          showToast({ title: 'Reply sent' })
        }
        router.refresh()
        return
      }
      // Honest failure copy per the design system's content rules; the
      // draft is preserved in every outcome.
      if (result.code === 'send_failed') {
        setSendFailed(true)
        return
      }
      if (result.code === 'retry_in_progress') {
        setComposerError('This reply is already being sent. Give it a moment, then try again.')
        return
      }
      if (result.code === 'validation_failed') {
        // The original attempt never reached the send path — a replay key
        // has nothing to safely replay, so mint a fresh one.
        idempotencyKey.current = crypto.randomUUID()
      }
      setComposerError(result.message ?? 'Something went wrong. The draft is preserved.')
    })
  }

  function sendNote(): void {
    if (noteDraft.trim().length < 1) {
      setComposerError("Write a note first — the note can't be empty.")
      return
    }
    if (noteDraft.length > MAX_REPLY_LENGTH) {
      setComposerError('Notes are limited to 5,000 characters.')
      return
    }
    setComposerError(null)
    startTransition(async () => {
      const result = await postNoteAction(conversation.id, noteDraft)
      if (result.ok) {
        setNoteDraft('')
        setComposerOpen(false)
        showToast({ title: 'Note added', detail: 'Visible to Agents only — never emailed.' })
        router.refresh()
        return
      }
      setComposerError(result.message ?? 'Something went wrong.')
    })
  }

  function sendActive(): void {
    if (composerMode === 'reply') sendReply()
    else sendNote()
  }

  // The screen's own shortcuts: j/k conversation nav, r/n open the
  // composer, ⌘/Ctrl+↵ sends, Escape cascades (original-message modal → any
  // open menu → composer, draft kept → back to the inbox). The shortcuts
  // overlay's own Escape handler doesn't stop propagation, so this skips
  // entirely while it's open — otherwise one Escape press would both close
  // the overlay AND cascade through this screen's own close logic.
  //
  // Kept in a ref (the "latest closure" pattern) rather than the effect's
  // dependency array: nearly every piece of UI state on this screen affects
  // this handler, and the DOM listener itself doesn't need to churn on each
  // one — only the closure it calls does.
  const onKeyDownRef = useRef<(event: KeyboardEvent) => void>(() => {})
  onKeyDownRef.current = (event: KeyboardEvent) => {
    if (isShortcutsOverlayOpen) return

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && composerOpen) {
      event.preventDefault()
      sendActive()
      return
    }

    if (event.key === 'Escape') {
      if (originalMessage !== null) {
        setOriginalMessage(null)
        return
      }
      if (
        tagsMenuOpen ||
        assigneeMenuOpen ||
        statusMenuOpen ||
        moreMenuOpen ||
        openMessageMenuId !== null
      ) {
        setTagsMenuOpen(false)
        setAssigneeMenuOpen(false)
        setStatusMenuOpen(false)
        setMoreMenuOpen(false)
        setOpenMessageMenuId(null)
        return
      }
      if (composerOpen) {
        closeComposer()
        return
      }
      router.push('/inbox/open')
      return
    }

    const target = event.target as HTMLElement | null
    const typing =
      target !== null &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    if (typing) return

    if (event.key === 'j' || event.key === 'k') {
      const targetId = event.key === 'j' ? position?.nextId : position?.prevId
      if (targetId != null) {
        event.preventDefault()
        router.push(`/conversations/${targetId}`)
      }
      return
    }
    if (event.key === 'r') {
      event.preventDefault()
      openComposer('reply')
      return
    }
    if (event.key === 'n') {
      event.preventDefault()
      openComposer('note')
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      onKeyDownRef.current(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Optimistic like tags/assignee below: flip the pill immediately, close the
  // menu, and only crawl back to the previous value if the server rejects
  // it — never leave the Agent staring at a status that silently reverted
  // seconds later with no explanation.
  async function changeStatus(next: ConversationStatus): Promise<void> {
    if (statusChangeInFlight.current) return
    const previous = status
    statusChangeInFlight.current = true
    setStatusMenuOpen(false)
    setLocalStatus(next)
    try {
      const result = await setStatusAction(conversation.id, next)
      if (!result.ok) {
        setLocalStatus(previous)
        showToast({ title: "Couldn't update the conversation", detail: 'Please try again.' })
        return
      }
      showToast({ title: `Marked ${next}` })
    } catch {
      // The server-action POST itself never completed (offline, unreachable,
      // deploy blip) — the client-side promise rejects rather than
      // resolving {ok:false}. Treat exactly like a rejected update: roll
      // back the optimistic pill and tell the Agent, instead of stranding
      // the UI in a status the server never applied.
      setLocalStatus(previous)
      showToast({ title: "Couldn't update the conversation", detail: 'Please try again.' })
    } finally {
      statusChangeInFlight.current = false
    }
  }

  async function updateTags(nextTags: string[]): Promise<void> {
    const previous = tags
    setTags(nextTags)
    const result = await putTagsAction(conversation.id, nextTags)
    if (!result.ok) {
      setTags(previous)
      showToast({ title: "Couldn't update the tags", detail: 'Please try again.' })
    }
  }

  function addTagFromInput(): void {
    const value = tagInput.trim().toLowerCase()
    if (value.length === 0 || value.length > MAX_TAG_LENGTH || tags.includes(value)) return
    setTagInput('')
    void updateTags([...tags, value])
  }

  function onTagInputKeyDown(event: { key: string; preventDefault: () => void }): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    addTagFromInput()
  }

  async function updateAssignee(next: string | null): Promise<void> {
    const previous = assigneeAgentId
    setAssigneeMenuOpen(false)
    setAssigneeAgentId(next)
    const result = await putAssigneeAction(conversation.id, next)
    if (!result.ok) {
      setAssigneeAgentId(previous)
      showToast({ title: "Couldn't update the assignee", detail: 'Please try again.' })
    }
  }

  function onDeleteClick(): void {
    if (!deleteArmed) {
      setDeleteArmed(true)
      deleteDisarmTimer.current = setTimeout(() => setDeleteArmed(false), DELETE_DISARM_MS)
      return
    }
    if (deleteDisarmTimer.current !== null) clearTimeout(deleteDisarmTimer.current)
    setDeleteArmed(false)
    startTransition(async () => {
      const result = await deleteConversationAction(conversation.id)
      if (result.ok) {
        showToast({ title: 'Conversation deleted' })
        router.push('/inbox/unassigned')
      }
    })
  }

  function toggleFollowing(): void {
    setMoreMenuOpen(false)
    const next = !following
    setFollowing(next)
    showToast({ title: next ? 'Following conversation' : 'Unfollowed conversation' })
  }

  const customerName = nameFromEmail(conversation.customerEmail)
  const starred = isStarred(conversation.id)

  // Assignee display/menu (HT-54): "Me" wins the label when the assignee IS
  // the viewing Agent (parity with the old single-operator UX); otherwise
  // the roster supplies the name. `otherActiveAgents` backs the rest of the
  // menu — ACTIVE only (an invited/disabled Agent can't act, spec §8, and
  // offering them here would be a false choice), self excluded (the
  // "Assign to me" item above already covers self).
  const assigneeLabel =
    assigneeAgentId === null
      ? 'Anyone'
      : assigneeAgentId === selfId
        ? 'Me'
        : (agents.find((a) => a.id === assigneeAgentId)?.name ?? 'Someone')
  const otherActiveAgents = agents.filter((a) => a.id !== selfId && a.status === 'active')

  // sameSpeakerAsPrev compares CHRONOLOGICALLY adjacent messages — computed
  // here, before the list is reversed for newest-first presentation. The
  // API itself stays oldest-first (this is a presentation-layer reorder).
  const threadsWithMeta = conversation.threads.map((thread, index) => {
    const prev = conversation.threads[index - 1]
    return {
      thread,
      sameSpeakerAsPrev: prev !== undefined && prev.direction === thread.direction,
    }
  })
  const threadsNewestFirst = [...threadsWithMeta].reverse()

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', minHeight: 0 }}>
      <main
        style={{
          flex: 1,
          minWidth: 0,
          background: 'var(--ht-surface)',
          boxShadow: 'var(--ht-seam-shadow, -1px 0 0 var(--ht-divider))',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <ToolbarBand>
          <IconButton title="Reply (r)" onClick={() => openComposer('reply')}>
            <ReplyIcon />
          </IconButton>
          <IconButton title="Add a note (n)" onClick={() => openComposer('note')}>
            <NoteIcon />
          </IconButton>

          {deleteArmed ? (
            <Button
              variant="destructive"
              armed
              title="Click again to permanently delete"
              onClick={onDeleteClick}
              style={{ padding: '6px 14px' }}
            >
              <TrashIcon />
              Confirm
            </Button>
          ) : (
            <IconButton
              title="Delete conversation"
              onClick={onDeleteClick}
              style={{ color: 'var(--ht-critical)' }}
            >
              <TrashIcon />
            </IconButton>
          )}

          <div style={{ position: 'relative' }}>
            <IconButton
              title="Tags"
              active={tagsMenuOpen}
              onClick={() => setTagsMenuOpen((open) => !open)}
            >
              <TagIcon />
            </IconButton>
            {tags.length > 0 && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: -2,
                  right: -2,
                  minWidth: 14,
                  height: 14,
                  padding: '0 3px',
                  borderRadius: 999,
                  background: 'var(--ht-accent)',
                  color: 'var(--ht-on-accent)',
                  fontSize: 9.5,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  lineHeight: 1,
                  pointerEvents: 'none',
                }}
              >
                {tags.length}
              </span>
            )}
            <DropdownMenu open={tagsMenuOpen} onClose={() => setTagsMenuOpen(false)} minWidth={220}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 4 }}>
                {tags.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {tags.map((tag) => (
                      <TagChip
                        key={tag}
                        label={tag}
                        onRemove={() => void updateTags(tags.filter((t) => t !== tag))}
                      />
                    ))}
                  </div>
                )}
                <TextInput
                  value={tagInput}
                  onChange={(event: { target: { value: string } }) =>
                    setTagInput(event.target.value)
                  }
                  onKeyDown={onTagInputKeyDown}
                  placeholder="Add a tag…"
                />
              </div>
            </DropdownMenu>
          </div>

          <IconButton
            title={starred ? 'Unstar conversation' : 'Star conversation'}
            onClick={() => toggle(conversation.id)}
            style={{ color: starred ? 'var(--ht-accent)' : 'var(--ht-ink-dim)' }}
          >
            <StarIcon filled={starred} />
          </IconButton>

          <div style={{ position: 'relative' }}>
            <IconButton
              title="More"
              active={moreMenuOpen}
              onClick={() => setMoreMenuOpen((open) => !open)}
            >
              <MoreIcon />
            </IconButton>
            <DropdownMenu open={moreMenuOpen} onClose={() => setMoreMenuOpen(false)} minWidth={190}>
              <MenuItem selected={following} onClick={toggleFollowing}>
                {following ? 'Following ✓' : 'Follow'}
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMoreMenuOpen(false)
                  showToast({
                    title: "Forward isn't wired yet",
                    detail: 'Designed for v1 — arriving in a later increment.',
                  })
                }}
              >
                Forward
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMoreMenuOpen(false)
                  showToast({
                    title: "Merge isn't wired yet",
                    detail: 'Designed for v1 — arriving in a later increment.',
                  })
                }}
              >
                Merge
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setMoreMenuOpen(false)
                  window.print()
                }}
              >
                Print
              </MenuItem>
            </DropdownMenu>
          </div>

          <span style={{ flex: 1 }} />

          <div style={{ position: 'relative' }}>
            <Button variant="outline" onClick={() => setAssigneeMenuOpen((open) => !open)}>
              <PersonIcon />
              {assigneeLabel}
              <ChevronDownIcon />
            </Button>
            <DropdownMenu
              open={assigneeMenuOpen}
              onClose={() => setAssigneeMenuOpen(false)}
              align="right"
            >
              <MenuItem
                selected={assigneeAgentId === null}
                onClick={() => void updateAssignee(null)}
              >
                Anyone
              </MenuItem>
              <MenuItem
                selected={assigneeAgentId === selfId}
                onClick={() => void updateAssignee(selfId)}
              >
                Assign to me
              </MenuItem>
              {otherActiveAgents.length > 0 && (
                <div style={{ height: 1, background: 'var(--ht-divider)', margin: '4px 2px' }} />
              )}
              {otherActiveAgents.map((agent) => (
                <MenuItem
                  key={agent.id}
                  selected={assigneeAgentId === agent.id}
                  onClick={() => void updateAssignee(agent.id)}
                >
                  {agent.name}
                </MenuItem>
              ))}
            </DropdownMenu>
          </div>

          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setStatusMenuOpen((open) => !open)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                border: 'none',
                background: STATUS_META[status].bg,
                borderRadius: 999,
                padding: '6px 12px',
                fontSize: 12.5,
                fontWeight: 700,
                color: STATUS_META[status].fg,
                cursor: 'pointer',
              }}
            >
              <FlagIcon />
              {STATUS_META[status].label}
              <ChevronDownIcon />
            </button>
            <DropdownMenu
              open={statusMenuOpen}
              onClose={() => setStatusMenuOpen(false)}
              align="right"
            >
              <MenuItem selected={status === 'active'} onClick={() => void changeStatus('active')}>
                Active
              </MenuItem>
              <MenuItem
                selected={status === 'pending'}
                onClick={() => void changeStatus('pending')}
              >
                Pending
              </MenuItem>
              <MenuItem selected={status === 'closed'} onClick={() => void changeStatus('closed')}>
                Closed
              </MenuItem>
              <MenuItem
                selected={status === 'spam'}
                destructive
                onClick={() => void changeStatus('spam')}
              >
                Spam
              </MenuItem>
            </DropdownMenu>
          </div>

          {position !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--ht-ink-dim)',
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: 56,
                  textAlign: 'center',
                }}
              >
                {position.index} of {position.total}
              </span>
              <IconButton
                title="Previous conversation"
                onClick={() => {
                  if (position.prevId !== null) router.push(`/conversations/${position.prevId}`)
                }}
                style={{
                  opacity: position.prevId !== null ? 1 : 0.35,
                  pointerEvents: position.prevId !== null ? 'auto' : 'none',
                }}
              >
                <ChevronLeftIcon />
              </IconButton>
              <IconButton
                title="Next conversation"
                onClick={() => {
                  if (position.nextId !== null) router.push(`/conversations/${position.nextId}`)
                }}
                style={{
                  opacity: position.nextId !== null ? 1 : 0.35,
                  pointerEvents: position.nextId !== null ? 'auto' : 'none',
                }}
              >
                <ChevronRightIcon />
              </IconButton>
            </div>
          )}
        </ToolbarBand>

        <div
          style={{
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 19, fontWeight: 700 }}>{conversation.subject}</span>
          <StatusPill status={status} />
        </div>

        {composerOpen && (
          <div
            style={{
              margin: 14,
              borderRadius: 'var(--ht-radius-lg, 8px)',
              border: '1px solid var(--ht-border)',
              background: 'var(--ht-surface)',
              boxShadow: 'var(--ht-shadow-md, 0 2px 10px rgba(0,0,0,0.06))',
              padding: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => switchComposerMode('reply')}
                  style={pillTabStyle(composerMode === 'reply')}
                >
                  Reply
                </button>
                <button
                  type="button"
                  onClick={() => switchComposerMode('note')}
                  style={pillTabStyle(composerMode === 'note')}
                >
                  Note
                </button>
              </div>
              <span style={{ flex: 1 }} />
              {/* Reply mode hosts the close button on the format-toolbar row
                  below (design: icons ... caption ... ×); Note mode has no
                  format row, so its close button stays up here. */}
              {composerMode === 'note' && (
                <IconButton title="Close composer — your draft is kept" onClick={closeComposer}>
                  <CloseIcon />
                </IconButton>
              )}
            </div>

            {composerMode === 'note' && (
              <div style={WARN_BANNER_STYLE}>
                Internal note — visible to Agents only, never emailed to the customer.
              </div>
            )}
            {composerMode === 'reply' && (status === 'closed' || status === 'spam') && (
              <div style={WARN_BANNER_STYLE}>
                This conversation is closed — sending a reply will reopen it.
              </div>
            )}
            {composerMode === 'reply' && sendFailed && (
              <div style={CRITICAL_BANNER_STYLE}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ht-critical)' }}>
                  Your reply couldn't be delivered.
                </div>
                <div style={{ marginTop: 2, fontSize: 12.5, color: 'var(--ht-ink-muted)' }}>
                  Nothing reached the customer. The draft is preserved.
                </div>
                <div style={{ marginTop: 8 }}>
                  <Button variant="outline" disabled={isPending} onClick={sendReply}>
                    {isPending ? 'Sending…' : 'Retry send'}
                  </Button>
                </div>
              </div>
            )}

            {composerMode === 'reply' ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                  <button
                    type="button"
                    title="Bold"
                    onClick={() => applyFormat('bold')}
                    style={FORMAT_BUTTON_STYLE}
                    onMouseEnter={onFormatButtonHover}
                    onMouseLeave={onFormatButtonUnhover}
                  >
                    <b>B</b>
                  </button>
                  <button
                    type="button"
                    title="Italic"
                    onClick={() => applyFormat('italic')}
                    style={FORMAT_BUTTON_STYLE}
                    onMouseEnter={onFormatButtonHover}
                    onMouseLeave={onFormatButtonUnhover}
                  >
                    <i>I</i>
                  </button>
                  <button
                    type="button"
                    title="Bulleted list"
                    onClick={() => applyFormat('insertUnorderedList')}
                    style={FORMAT_BUTTON_STYLE}
                    onMouseEnter={onFormatButtonHover}
                    onMouseLeave={onFormatButtonUnhover}
                  >
                    <BulletListIcon />
                  </button>
                  <button
                    type="button"
                    title="Link"
                    onClick={applyLink}
                    style={FORMAT_BUTTON_STYLE}
                    onMouseEnter={onFormatButtonHover}
                    onMouseLeave={onFormatButtonUnhover}
                  >
                    <LinkIcon />
                  </button>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: 'var(--ht-ink-dim)' }}>
                    Formatting is sent as HTML alongside plain text
                  </span>
                  <IconButton title="Close composer — your draft is kept" onClick={closeComposer}>
                    <CloseIcon />
                  </IconButton>
                </div>
                <div style={{ position: 'relative' }}>
                  {replyTextLength === 0 && (
                    <div
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        pointerEvents: 'none',
                        fontSize: 14,
                        lineHeight: 1.6,
                        color: 'var(--ht-ink-dim)',
                      }}
                    >
                      Reply to {customerName}…
                    </div>
                  )}
                  {/* biome-ignore lint/a11y/useSemanticElements: rich-text
                      formatting (bold/italic/list/link via execCommand)
                      requires a contenteditable element — a <textarea>
                      cannot host it. */}
                  <div
                    ref={replyBodyRef}
                    contentEditable
                    onInput={onReplyBodyInput}
                    role="textbox"
                    tabIndex={0}
                    aria-multiline="true"
                    aria-label={`Reply to ${customerName}`}
                    suppressContentEditableWarning
                    style={CONTENT_EDITABLE_STYLE}
                  />
                </div>
              </>
            ) : (
              <textarea
                ref={noteTextareaRef}
                value={noteDraft}
                onChange={(event) => {
                  setNoteDraft(event.target.value)
                  setComposerError(null)
                }}
                placeholder="Add an internal note…"
                rows={4}
                maxLength={MAX_REPLY_LENGTH}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: 'none',
                  outline: 'none',
                  resize: 'vertical',
                  font: 'inherit',
                  fontSize: 14,
                  lineHeight: 1.6,
                  background: 'transparent',
                  color: 'var(--ht-ink)',
                }}
              />
            )}

            {composerError !== null && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: 'var(--ht-critical)',
                }}
              >
                {composerError}
              </div>
            )}

            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={counterStyle(composerMode === 'reply' ? replyTextLength : noteDraft.length)}
              >
                {(composerMode === 'reply' ? replyTextLength : noteDraft.length).toLocaleString()} /
                5,000
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--ht-ink-dim)' }}>⌘/Ctrl + ↵ to send</span>
              <Button
                variant="primary"
                disabled={
                  isPending ||
                  (composerMode === 'reply' ? replyTextLength : noteDraft.length) === 0 ||
                  (composerMode === 'reply' ? replyTextLength : noteDraft.length) > MAX_REPLY_LENGTH
                }
                onClick={sendActive}
              >
                {composerMode === 'reply'
                  ? isPending
                    ? 'Sending…'
                    : 'Send reply'
                  : isPending
                    ? 'Adding…'
                    : 'Add note'}
              </Button>
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {threadsNewestFirst.map(({ thread, sameSpeakerAsPrev }) => {
            const kind = thread.direction
            return (
              <div key={thread.id} style={{ position: 'relative' }}>
                <MessageBand
                  kind={kind}
                  fromLabel={
                    kind === 'inbound' ? customerName : kind === 'note' ? 'Internal note' : 'You'
                  }
                  fromAddr={thread.from}
                  time={messageTime(thread.createdAt)}
                  delivery={thread.deliveryStatus ?? undefined}
                  failed={thread.deliveryStatus === 'failed'}
                  viewedAt={
                    thread.customerViewedAt !== null
                      ? relativeTime(thread.customerViewedAt)
                      : undefined
                  }
                  sameSpeakerAsPrev={sameSpeakerAsPrev}
                  email={kind === 'inbound' ? conversation.customerEmail : thread.from}
                >
                  {thread.bodyHtml !== null ? (
                    <>
                      <SanitizedHtml html={thread.bodyHtml} />
                      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--ht-ink-dim)' }}>
                        HTML email · sanitized · external images blocked
                      </div>
                    </>
                  ) : (
                    (thread.bodyText ?? '')
                  )}
                  {/* HT-46 read path, TJ-approved addition beyond the design
                      prototype (flagged for his sign-off). An empty list
                      renders nothing — zero layout shift either way. Signed
                      URLs expire, so this is always the URL exactly as the
                      API gave it, opened fresh in a new tab rather than
                      cached or re-derived. */}
                  {kind === 'inbound' && thread.attachments.length > 0 && (
                    <div
                      style={{
                        marginTop: 8,
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                      }}
                    >
                      {thread.attachments.map((attachment) => (
                        <a
                          key={attachment.id}
                          href={attachment.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Download ${attachment.filename ?? 'attachment'}`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 12.5,
                            color: 'var(--ht-ink-muted)',
                            textDecoration: 'none',
                            background: 'var(--ht-surface-2)',
                            borderRadius: 999,
                            padding: '4px 10px 4px 8px',
                          }}
                        >
                          <PaperclipIcon />
                          <span style={{ fontWeight: 600, color: 'var(--ht-ink)' }}>
                            {attachment.filename ?? 'Attachment'}
                          </span>
                          <span style={{ color: 'var(--ht-ink-dim)' }}>
                            {humanFileSize(attachment.size)}
                          </span>
                        </a>
                      ))}
                    </div>
                  )}
                </MessageBand>
                <MessageMenu
                  open={openMessageMenuId === thread.id}
                  onToggle={() =>
                    setOpenMessageMenuId((current) => (current === thread.id ? null : thread.id))
                  }
                  onClose={() => setOpenMessageMenuId(null)}
                  onCopyText={() => {
                    setOpenMessageMenuId(null)
                    void navigator.clipboard.writeText(thread.bodyText ?? '')
                    showToast({ title: 'Message text copied' })
                  }}
                  onShowOriginal={() => {
                    setOpenMessageMenuId(null)
                    setOriginalMessage(thread)
                  }}
                />
              </div>
            )
          })}
        </div>
      </main>

      <aside
        aria-label="Conversation details"
        style={{
          width: 240,
          flexShrink: 0,
          borderLeft: '1px solid var(--ht-divider)',
          background: 'var(--ht-surface)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ToolbarBand tone="panel">
          <span style={{ flex: 1 }} />
          <IconButton
            title="Customer settings"
            onClick={() =>
              showToast({
                title: "Customer settings isn't wired yet",
                detail: "Designed for v1 — the endpoint is spec'd, not in the mock.",
              })
            }
          >
            <GearIcon />
          </IconButton>
        </ToolbarBand>
        <div style={{ padding: '0 14px 16px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ marginTop: -36 }}>
            <Avatar email={conversation.customerEmail} size={72} ring />
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 19, fontWeight: 700 }}>{customerName}</div>
            <div
              style={{
                fontFamily: 'var(--ht-mono)',
                fontSize: 11,
                color: 'var(--ht-ink-dim)',
                overflowWrap: 'break-word',
              }}
            >
              {conversation.customerEmail}
            </div>
          </div>

          <div
            style={{ height: 1, background: 'var(--ht-divider)', margin: '14px 0' }}
            aria-hidden="true"
          />

          {previousConversations.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setPreviousConversationsOpen((open) => !open)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  width: '100%',
                  border: 'none',
                  background: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: 'var(--ht-ink-muted)',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  Previous conversations
                </span>
                <span style={{ fontSize: 11, color: 'var(--ht-ink-dim)' }}>
                  {previousConversations.length}
                </span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    display: 'inline-flex',
                    transform: previousConversationsOpen ? 'none' : 'rotate(-90deg)',
                  }}
                >
                  <ChevronDownIcon />
                </span>
              </button>
              {previousConversationsOpen && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column' }}>
                  {previousConversations.slice(0, 5).map((prior) => (
                    <button
                      key={prior.id}
                      type="button"
                      onClick={() => router.push(`/conversations/${prior.id}`)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        border: 'none',
                        background: 'none',
                        padding: '6px 0',
                        cursor: 'pointer',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 700,
                          color: 'var(--ht-ink)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {prior.subject}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--ht-ink-dim)' }}>
                        {STATUS_META[prior.status].label} · {shortDate(prior.updatedAt)}
                      </div>
                    </button>
                  ))}
                  {previousConversations.length > 5 && (
                    <div style={{ fontSize: 11.5, color: 'var(--ht-ink-dim)', padding: '4px 0' }}>
                      and {previousConversations.length - 5} more
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {originalMessage !== null && (
        <OriginalMessageModal thread={originalMessage} onClose={() => setOriginalMessage(null)} />
      )}
    </div>
  )
}
