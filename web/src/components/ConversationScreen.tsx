'use client'

/**
 * One conversation: toolbar (back, reply/note/delete, tags, star, more,
 * assignee/status/position — subject/#number/status pill on a wrapped
 * second row), the reply composer (resident card, ABOVE the thread — it
 * becomes summoned in a later increment), and the thread as full-bleed
 * MessageBands newest-first (design-system rule: bands, not chat bubbles).
 *
 * The composer implements spec §4a's client contract faithfully:
 * - ONE Idempotency-Key per logical send, minted when the draft starts and
 *   reused verbatim on every retry — a 409 `retry_in_progress` or a network
 *   failure never mints a new key (that would risk a duplicate send).
 * - `send_failed` (502) keeps the draft and says exactly what is true:
 *   nothing reached the customer.
 * - Only a SUCCESS clears the draft and rotates the key.
 */

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import {
  deleteConversationAction,
  putAssigneeAction,
  putTagsAction,
  sendReplyAction,
  setStatusAction,
} from '../lib/actions'
import type { ConversationDetail, ConversationStatus, ThreadView } from '../lib/api-types'
import { nameFromEmail, relativeTime } from '../lib/format'
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
import { useToast } from './Toaster'

const MAX_REPLY_LENGTH = 5000
const MAX_TAG_LENGTH = 40
const DELETE_DISARM_MS = 3500

export interface ConversationNeighborPosition {
  index: number
  total: number
  prevId: string | null
  nextId: string | null
}

const STATUS_META: Record<ConversationStatus, { label: string; fg: string }> = {
  active: { label: 'Active', fg: 'var(--ht-accent)' },
  pending: { label: 'Pending', fg: 'var(--ht-warn)' },
  closed: { label: 'Closed', fg: 'var(--ht-ink-dim)' },
  spam: { label: 'Spam', fg: 'var(--ht-critical)' },
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

/** Fixed centered modal: the raw source, exactly as it arrived, never rendered as HTML. */
function OriginalMessageModal({ thread, onClose }: { thread: ThreadView; onClose: () => void }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

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
}: {
  conversation: ConversationDetail
  position: ConversationNeighborPosition | null
}) {
  const router = useRouter()
  const showToast = useToast()
  const { isStarred, toggle } = useStarred()

  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  // One key per logical send (spec §4a) — rotated only on success.
  const idempotencyKey = useRef<string>(crypto.randomUUID())
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  const [status, setLocalStatus] = useState<ConversationStatus>(conversation.status)
  const [tags, setTags] = useState<string[]>(conversation.tags)
  const [assignee, setAssignee] = useState<'me' | null>(conversation.assignee)

  const [tagInput, setTagInput] = useState('')
  const [tagsMenuOpen, setTagsMenuOpen] = useState(false)
  const [assigneeMenuOpen, setAssigneeMenuOpen] = useState(false)
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const [following, setFollowing] = useState(false)

  const [deleteArmed, setDeleteArmed] = useState(false)
  const deleteDisarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [openMessageMenuId, setOpenMessageMenuId] = useState<string | null>(null)
  const [originalMessage, setOriginalMessage] = useState<ThreadView | null>(null)

  useEffect(() => {
    return () => {
      if (deleteDisarmTimer.current !== null) clearTimeout(deleteDisarmTimer.current)
    }
  }, [])

  function send() {
    const text = draft
    if (text.length < 1 || text.length > MAX_REPLY_LENGTH) return
    setError(null)
    startTransition(async () => {
      const result = await sendReplyAction(conversation.id, text, idempotencyKey.current)
      if (result.ok) {
        setDraft('')
        idempotencyKey.current = crypto.randomUUID()
        router.refresh()
        return
      }
      // Honest failure copy per the design system's content rules; the
      // draft is preserved in all three cases, and the SAME key retries.
      if (result.code === 'send_failed') {
        setError('Nothing reached the customer. The draft is preserved — try again.')
      } else if (result.code === 'retry_in_progress') {
        setError('This reply is already being sent. Give it a moment, then try again.')
      } else {
        setError(result.message ?? 'Something went wrong. The draft is preserved.')
      }
    })
  }

  function focusComposer(): void {
    const el = textareaRef.current
    if (el === null) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.focus()
  }

  function changeStatus(next: ConversationStatus): void {
    setStatusMenuOpen(false)
    startTransition(async () => {
      const result = await setStatusAction(conversation.id, next)
      if (result.ok) {
        setLocalStatus(next)
        showToast({ title: `Marked ${next}` })
        router.refresh()
      }
    })
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

  async function updateAssignee(next: 'me' | null): Promise<void> {
    const previous = assignee
    setAssigneeMenuOpen(false)
    setAssignee(next)
    const result = await putAssigneeAction(conversation.id, next)
    if (!result.ok) {
      setAssignee(previous)
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
          <button
            type="button"
            onClick={() => router.push('/inbox/open')}
            style={{
              border: 'none',
              background: 'none',
              color: 'var(--ht-ink-muted)',
              fontSize: 13,
              cursor: 'pointer',
              padding: '4px 6px',
            }}
          >
            ← Inbox
          </button>

          <IconButton title="Reply (r)" onClick={focusComposer}>
            <ReplyIcon />
          </IconButton>
          <IconButton
            title="Add a note (n)"
            onClick={() =>
              showToast({
                title: "Notes composer isn't wired yet",
                detail: 'Designed for v1 — arriving with the composer increment.',
              })
            }
          >
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
            <IconButton title="Delete conversation" onClick={onDeleteClick}>
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
              {assignee === 'me' ? 'Me' : 'Anyone'}
              <ChevronDownIcon />
            </Button>
            <DropdownMenu
              open={assigneeMenuOpen}
              onClose={() => setAssigneeMenuOpen(false)}
              align="right"
            >
              <MenuItem selected={assignee === null} onClick={() => void updateAssignee(null)}>
                Anyone
              </MenuItem>
              <MenuItem selected={assignee === 'me'} onClick={() => void updateAssignee('me')}>
                Me
              </MenuItem>
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
                border: '1px solid var(--ht-border)',
                background: 'var(--ht-surface)',
                borderRadius: 'var(--ht-radius-md)',
                padding: '6px 12px',
                fontSize: 12.5,
                fontWeight: 700,
                color: STATUS_META[status].fg,
                cursor: 'pointer',
              }}
            >
              {STATUS_META[status].label}
              <ChevronDownIcon />
            </button>
            <DropdownMenu
              open={statusMenuOpen}
              onClose={() => setStatusMenuOpen(false)}
              align="right"
            >
              <MenuItem selected={status === 'active'} onClick={() => changeStatus('active')}>
                Active
              </MenuItem>
              <MenuItem selected={status === 'pending'} onClick={() => changeStatus('pending')}>
                Pending
              </MenuItem>
              <MenuItem selected={status === 'closed'} onClick={() => changeStatus('closed')}>
                Closed
              </MenuItem>
              <MenuItem
                selected={status === 'spam'}
                destructive
                onClick={() => changeStatus('spam')}
              >
                Spam
              </MenuItem>
            </DropdownMenu>
          </div>

          {position !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
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

          {/* Force the informational display onto its own row within the wrapping band. */}
          <div style={{ flexBasis: '100%', height: 0 }} aria-hidden="true" />

          <span style={{ fontSize: 14, fontWeight: 700, marginLeft: 4 }}>
            {conversation.subject}
          </span>
          <span
            style={{
              fontFamily: 'var(--ht-mono)',
              fontSize: 11.5,
              color: 'var(--ht-ink-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            #{conversation.number}
          </span>
          <StatusPill status={status} />
        </ToolbarBand>

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
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Reply to ${customerName}…`}
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
          {error !== null && (
            <div
              style={{ marginTop: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--ht-critical)' }}
            >
              {error}
            </div>
          )}
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                fontSize: 11.5,
                color: 'var(--ht-ink-dim)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {draft.length}/{MAX_REPLY_LENGTH}
            </span>
            <span style={{ flex: 1 }} />
            <Button variant="primary" disabled={isPending || draft.length === 0} onClick={send}>
              {isPending ? 'Sending…' : 'Send reply'}
            </Button>
          </div>
        </div>

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
                  time={relativeTime(thread.createdAt)}
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
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--ht-ink-muted)',
            }}
          >
            Customer
          </span>
        </ToolbarBand>
        <div style={{ padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Avatar email={conversation.customerEmail} size={36} ring />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{customerName}</div>
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
          </div>

          <dl
            style={{
              margin: 0,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              rowGap: 8,
              columnGap: 12,
              fontSize: 12,
            }}
          >
            <dt style={{ color: 'var(--ht-ink-dim)' }}>Status</dt>
            <dd style={{ margin: 0 }}>
              <StatusPill status={status} style={{ fontSize: 9.5, padding: '1px 7px' }} />
            </dd>
            <dt style={{ color: 'var(--ht-ink-dim)' }}>Started</dt>
            <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
              {relativeTime(conversation.createdAt)}
            </dd>
            <dt style={{ color: 'var(--ht-ink-dim)' }}>Last activity</dt>
            <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
              {relativeTime(conversation.updatedAt)}
            </dd>
            <dt style={{ color: 'var(--ht-ink-dim)' }}>Messages</dt>
            <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
              {conversation.threadCount}
            </dd>
          </dl>

          {tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {tags.map((tag) => (
                <TagChip key={tag} label={tag} />
              ))}
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
