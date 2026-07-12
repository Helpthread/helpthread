'use client'

/**
 * The inbox list — the elevated work surface beside the shell's persistent
 * folder rail (`FolderNav`, rendered by the `(shell)` layout). Composed from
 * the design system's own components. The server page hands down whichever
 * flat conversation list the folder needs (see `app/(shell)/inbox/[folder]`);
 * Unassigned/Mine/Assigned/Starred/Drafts filter that list client-side
 * (assignee for the first three, localStorage for the last two) — Closed
 * and Spam show it as-is, with in-place keyset pagination (`loadOlderAction`
 * appends pages to client state; no route navigation).
 *
 * The header band doubles as a bulk-selection bar: with 0 rows checked it
 * shows the column labels and the sort toggle; with 1+ checked it swaps to
 * the selection count and the bulk actions (status, delete).
 */

import { useRouter } from 'next/navigation'
import type { CSSProperties } from 'react'
import { useEffect, useRef, useState } from 'react'
import { deleteConversationAction, loadOlderAction, setStatusAction } from '../lib/actions'
import type { ConversationStatus, ConversationSummary } from '../lib/api-types'
import { useDrafts } from '../lib/drafts'
import { type AppFolder, EMPTY_COPY } from '../lib/folders'
import { nameFromEmail, relativeTime } from '../lib/format'
import { useStarred } from '../lib/starred'
import { Button } from './ds/core/Button'
import { DropdownMenu } from './ds/core/DropdownMenu'
import { EmptyState } from './ds/core/EmptyState'
import { Kbd } from './ds/core/Kbd'
import { MenuItem } from './ds/core/MenuItem'
import { StatusPill } from './ds/core/StatusPill'
import { ConversationRow } from './ds/inbox/ConversationRow'
import { ToolbarBand } from './ds/inbox/ToolbarBand'
import { useShortcutsOverlay } from './ShortcutsProvider'
import { useToast } from './Toaster'

const DELETE_DISARM_MS = 3500

const HEADER_LABEL_STYLE: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ht-ink-dim)',
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
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

export function InboxScreen({
  folder,
  conversations,
  nextCursor,
}: {
  folder: AppFolder
  conversations: ConversationSummary[]
  nextCursor: string | null
}) {
  const router = useRouter()
  const showToast = useToast()
  const { isStarred, toggle } = useStarred()
  const drafts = useDrafts()
  const { isOpen: isShortcutsOverlayOpen } = useShortcutsOverlay()

  const [extraPages, setExtraPages] = useState<ConversationSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(nextCursor)
  const [loadingMore, setLoadingMore] = useState(false)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sortDesc, setSortDesc] = useState(true)
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // j/k (and ↑/↓) move this cursor; Enter opens it, x toggles its checkbox.
  const [focusedIndex, setFocusedIndex] = useState(0)
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // A folder switch is a fresh list — appended pages, selection, and the
  // armed-delete state from the previous folder don't carry over. `folder`
  // is the intended trigger (a route change); `nextCursor` always changes
  // alongside it (it's that folder's freshly server-fetched first page).
  // biome-ignore lint/correctness/useExhaustiveDependencies: folder is the trigger, not read in the body
  useEffect(() => {
    setExtraPages([])
    setCursor(nextCursor)
    setSelected(new Set())
    setDeleteArmed(false)
    setFocusedIndex(0)
    if (disarmTimer.current !== null) clearTimeout(disarmTimer.current)
  }, [folder, nextCursor])

  useEffect(() => {
    return () => {
      if (disarmTimer.current !== null) clearTimeout(disarmTimer.current)
    }
  }, [])

  const showCheckboxColumn = folder !== 'starred' && folder !== 'drafts'

  const visible = [...conversations, ...extraPages].filter((c) => {
    if (folder === 'unassigned') return c.assignee === null
    if (folder === 'mine') return c.assignee === 'me'
    if (folder === 'assigned') return c.assignee !== null
    if (folder === 'starred') return isStarred(c.id)
    if (folder === 'drafts') return c.id in drafts
    return true // closed | spam: shown as fetched
  })
  const displayed = sortDesc ? visible : [...visible].reverse()
  const allChecked = visible.length > 0 && visible.every((c) => selected.has(c.id))

  // The list can shrink (unstarring the focused row while on Starred, etc.)
  // without a folder switch — keep the cursor in bounds.
  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, Math.max(displayed.length - 1, 0)))
  }, [displayed.length])

  useEffect(() => {
    const row = displayed[focusedIndex]
    if (row === undefined) return
    rowRefs.current.get(row.id)?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex, displayed])

  // Kept in a ref (the "latest closure" pattern): `displayed` is a fresh
  // array every render, so listing it as a dependency would churn the DOM
  // listener on every render — only the closure it calls needs to be fresh.
  const onKeyDownRef = useRef<(event: KeyboardEvent) => void>(() => {})
  onKeyDownRef.current = (event: KeyboardEvent) => {
    // The shortcuts overlay owns Escape/'?' while open; don't also act.
    if (isShortcutsOverlayOpen) return

    const target = event.target as HTMLElement | null
    const typing =
      target !== null &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    if (typing) return

    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      setFocusedIndex((i) => Math.min(i + 1, Math.max(displayed.length - 1, 0)))
      return
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      setFocusedIndex((i) => Math.max(i - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      const row = displayed[focusedIndex]
      if (row !== undefined) router.push(`/conversations/${row.id}`)
      return
    }
    if (event.key === 'x' && showCheckboxColumn) {
      const row = displayed[focusedIndex]
      if (row !== undefined) toggleOne(row.id)
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      onKeyDownRef.current(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function toggleAll(): void {
    setSelected(allChecked ? new Set() : new Set(visible.map((c) => c.id)))
  }

  function toggleOne(id: string): void {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearSelection(): void {
    setSelected(new Set())
    if (disarmTimer.current !== null) clearTimeout(disarmTimer.current)
    setDeleteArmed(false)
  }

  async function applyStatus(status: ConversationStatus): Promise<void> {
    setStatusMenuOpen(false)
    const ids = Array.from(selected)
    let successCount = 0
    let hadFailure = false
    for (const id of ids) {
      const result = await setStatusAction(id, status)
      if (result.ok) successCount++
      else hadFailure = true
    }
    if (hadFailure) {
      showToast({ title: "Couldn't update the conversation", detail: 'Please try again.' })
    }
    if (successCount > 0) {
      showToast({ title: `${pluralize(successCount, 'conversation')} marked ${status}` })
    }
    setSelected(new Set())
    router.refresh()
  }

  function onDeleteClick(): void {
    if (!deleteArmed) {
      setDeleteArmed(true)
      disarmTimer.current = setTimeout(() => setDeleteArmed(false), DELETE_DISARM_MS)
      return
    }
    if (disarmTimer.current !== null) clearTimeout(disarmTimer.current)
    setDeleteArmed(false)
    void performDelete()
  }

  async function performDelete(): Promise<void> {
    const ids = Array.from(selected)
    let successCount = 0
    let hadFailure = false
    for (const id of ids) {
      const result = await deleteConversationAction(id)
      if (result.ok) successCount++
      else hadFailure = true
    }
    if (hadFailure) {
      showToast({ title: "Couldn't update the conversation", detail: 'Please try again.' })
    }
    if (successCount > 0) {
      showToast({ title: `${pluralize(successCount, 'conversation')} deleted` })
    }
    setSelected(new Set())
    router.refresh()
  }

  async function loadOlder(): Promise<void> {
    if (cursor === null || loadingMore) return
    setLoadingMore(true)
    try {
      // Only reachable for closed/spam (the only folders the server ever
      // hands a non-null cursor for — see `app/(shell)/inbox/[folder]`).
      const page = await loadOlderAction(folder as 'closed' | 'spam', cursor)
      setExtraPages((current) => [...current, ...page.conversations])
      setCursor(page.nextCursor)
    } catch {
      showToast({ title: "Couldn't load older conversations", detail: 'Please try again.' })
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--ht-surface)',
        boxShadow: 'var(--ht-seam-shadow, -1px 0 0 var(--ht-divider))',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ToolbarBand>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%' }}>
          {selected.size > 0 ? (
            <>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{selected.size} selected</span>
              <div style={{ position: 'relative' }}>
                <Button variant="outline" onClick={() => setStatusMenuOpen((open) => !open)}>
                  Set status
                  <ChevronDownIcon />
                </Button>
                <DropdownMenu open={statusMenuOpen} onClose={() => setStatusMenuOpen(false)}>
                  <MenuItem onClick={() => applyStatus('active')}>Active</MenuItem>
                  <MenuItem onClick={() => applyStatus('pending')}>Pending</MenuItem>
                  <MenuItem onClick={() => applyStatus('closed')}>Closed</MenuItem>
                  <MenuItem destructive onClick={() => applyStatus('spam')}>
                    Spam
                  </MenuItem>
                </DropdownMenu>
              </div>
              <Button variant="destructive" armed={deleteArmed} onClick={onDeleteClick}>
                {deleteArmed ? 'Confirm delete' : 'Delete'}
              </Button>
              <Button variant="ghost" onClick={clearSelection}>
                Clear
              </Button>
            </>
          ) : (
            <>
              {showCheckboxColumn && (
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  aria-label="Select all conversations"
                  style={{
                    width: 15,
                    height: 15,
                    accentColor: 'var(--ht-accent)',
                    cursor: 'pointer',
                    margin: 0,
                    flexShrink: 0,
                  }}
                />
              )}
              <span style={{ width: 200, flexShrink: 0, ...HEADER_LABEL_STYLE }}>Customer</span>
              <span style={{ width: 22, flexShrink: 0 }} aria-hidden="true" />
              <span style={{ flex: 1, ...HEADER_LABEL_STYLE }}>Conversation</span>
              <span style={{ minWidth: 36, flexShrink: 0 }} aria-hidden="true" />
              <span
                style={{ minWidth: 44, textAlign: 'right', flexShrink: 0, ...HEADER_LABEL_STYLE }}
              >
                Number
              </span>
              <button
                type="button"
                onClick={() => setSortDesc((desc) => !desc)}
                style={{
                  minWidth: 96,
                  textAlign: 'right',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--ht-accent)',
                  padding: 0,
                }}
              >
                Waiting since {sortDesc ? '↓' : '↑'}
              </button>
            </>
          )}
        </div>
      </ToolbarBand>

      {displayed.length === 0 ? (
        <EmptyState {...EMPTY_COPY[folder]} />
      ) : (
        <div>
          {displayed.map((c, index) => (
            <div
              key={c.id}
              ref={(el) => {
                if (el) rowRefs.current.set(c.id, el)
                else rowRefs.current.delete(c.id)
              }}
              style={{ position: 'relative' }}
            >
              <ConversationRow
                customerName={nameFromEmail(c.customerEmail)}
                customerEmail={c.customerEmail}
                subject={c.subject}
                preview={c.preview}
                count={c.threadCount > 1 ? String(c.threadCount) : ''}
                number={String(c.number)}
                time={relativeTime(c.updatedAt)}
                showCheckbox={showCheckboxColumn}
                checked={selected.has(c.id)}
                onCheck={() => toggleOne(c.id)}
                starred={isStarred(c.id)}
                onStar={() => toggle(c.id)}
                selected={index === focusedIndex}
                onClick={() => {
                  setFocusedIndex(index)
                  router.push(`/conversations/${c.id}`)
                }}
              />
              {c.status === 'pending' && (
                <span style={{ position: 'absolute', right: 14, top: 6 }}>
                  <StatusPill status="pending" style={{ fontSize: 9.5, padding: '1px 7px' }} />
                </span>
              )}
            </div>
          ))}
          {cursor !== null && (
            <div style={{ padding: '14px 18px' }}>
              <Button variant="outline" disabled={loadingMore} onClick={loadOlder}>
                {loadingMore ? 'Loading…' : 'Load older conversations'}
              </Button>
            </div>
          )}
        </div>
      )}

      <div
        style={{
          padding: '10px 14px',
          textAlign: 'center',
          fontSize: 12,
          color: 'var(--ht-ink-dim)',
        }}
      >
        <Kbd>j</Kbd> <Kbd>k</Kbd> navigate · <Kbd>↵</Kbd> open · <Kbd>?</Kbd> shortcuts
      </div>
    </main>
  )
}
