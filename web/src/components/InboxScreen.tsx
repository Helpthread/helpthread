'use client'

/**
 * The inbox list — the elevated work surface beside the shell's persistent
 * folder rail (`FolderNav`, rendered by the `(shell)` layout). Composed from
 * the design system's own components. The server page hands down whichever
 * flat conversation list the folder needs (see `app/(shell)/inbox/[folder]`);
 * Unassigned/Mine/Assigned/Starred/Drafts filter that list client-side
 * (assignee for the first three, localStorage for the last two) — Closed
 * and Spam show it as-is, with keyset pagination.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ConversationSummary } from '../lib/api-types'
import { useDrafts } from '../lib/drafts'
import { type AppFolder, EMPTY_COPY, FOLDER_LABELS } from '../lib/folders'
import { nameFromEmail, relativeTime } from '../lib/format'
import { useStarred } from '../lib/starred'
import { EmptyState } from './ds/core/EmptyState'
import { StatusPill } from './ds/core/StatusPill'
import { ConversationRow } from './ds/inbox/ConversationRow'
import { ToolbarBand } from './ds/inbox/ToolbarBand'

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
  const { isStarred, toggle } = useStarred()
  const drafts = useDrafts()

  const visible = conversations.filter((c) => {
    if (folder === 'unassigned') return c.assignee === null
    if (folder === 'mine') return c.assignee === 'me'
    if (folder === 'assigned') return c.assignee !== null
    if (folder === 'starred') return isStarred(c.id)
    if (folder === 'drafts') return c.id in drafts
    return true // closed | spam: shown as fetched
  })

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
        <span style={{ fontSize: 13, fontWeight: 700 }}>{FOLDER_LABELS[folder]}</span>
      </ToolbarBand>

      {visible.length === 0 ? (
        <EmptyState {...EMPTY_COPY[folder]} />
      ) : (
        <div>
          {visible.map((c) => (
            <div key={c.id} style={{ position: 'relative' }}>
              <ConversationRow
                customerName={nameFromEmail(c.customerEmail)}
                customerEmail={c.customerEmail}
                subject={c.subject}
                preview={c.preview}
                count={c.threadCount > 1 ? String(c.threadCount) : ''}
                number={String(c.number)}
                time={relativeTime(c.updatedAt)}
                showCheckbox={false}
                starred={isStarred(c.id)}
                onStar={() => toggle(c.id)}
                onClick={() => router.push(`/conversations/${c.id}`)}
              />
              {c.status === 'pending' && (
                <span style={{ position: 'absolute', right: 14, top: 6 }}>
                  <StatusPill status="pending" style={{ fontSize: 9.5, padding: '1px 7px' }} />
                </span>
              )}
            </div>
          ))}
          {nextCursor !== null && (
            <div style={{ padding: '14px 18px' }}>
              <Link
                href={`/inbox/${folder}?cursor=${encodeURIComponent(nextCursor)}`}
                style={{ fontSize: 13, color: 'var(--ht-accent)' }}
              >
                Older conversations →
              </Link>
            </div>
          )}
        </div>
      )}
    </main>
  )
}
