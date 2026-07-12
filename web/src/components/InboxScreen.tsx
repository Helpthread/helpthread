'use client'

/**
 * The inbox list — the elevated work surface beside the shell's persistent
 * folder rail (`FolderNav`, rendered by the `(shell)` layout). Composed from
 * the design system's own components; all DATA arrives as serializable props
 * from the server page, and navigation is the only side effect here.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ConversationFolder, ConversationSummary } from '../lib/api-types'
import { nameFromEmail, relativeTime } from '../lib/format'
import { EmptyState } from './ds/core/EmptyState'
import { StatusPill } from './ds/core/StatusPill'
import { ConversationRow } from './ds/inbox/ConversationRow'
import { ToolbarBand } from './ds/inbox/ToolbarBand'

const FOLDER_LABELS: Record<ConversationFolder, string> = {
  open: 'Open',
  closed: 'Closed',
  spam: 'Spam',
}

const EMPTY_COPY: Record<ConversationFolder, { title: string; body: string; celebrate: boolean }> =
  {
    open: { title: 'Inbox zero.', body: 'Every customer has an answer.', celebrate: true },
    closed: {
      title: 'Nothing closed yet',
      body: 'Resolved conversations land here.',
      celebrate: false,
    },
    spam: {
      title: 'No spam',
      body: 'Mark a conversation as spam from its page.',
      celebrate: false,
    },
  }

export function InboxScreen({
  folder,
  conversations,
  nextCursor,
}: {
  folder: ConversationFolder
  conversations: ConversationSummary[]
  nextCursor: string | null
}) {
  const router = useRouter()

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

      {conversations.length === 0 ? (
        <EmptyState {...EMPTY_COPY[folder]} />
      ) : (
        <div>
          {conversations.map((c) => (
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
                onClick={() => router.push(`/conversations/${c.id}`)}
              />
              {folder === 'open' && c.status === 'pending' && (
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
