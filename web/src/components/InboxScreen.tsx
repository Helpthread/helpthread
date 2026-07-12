'use client'

/**
 * The inbox — sidebar folders + conversation list, composed from the design
 * system's own components (`components/ds/**`, ported verbatim from the
 * Claude Design hand-back). A client component because the DS components
 * are interaction-driven; all DATA arrives as serializable props from the
 * server page, and navigation is the only side effect here.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ConversationFolder, ConversationSummary } from '../lib/api-types'
import { nameFromEmail, relativeTime } from '../lib/format'
import { EmptyState } from './ds/core/EmptyState'
import { StatusPill } from './ds/core/StatusPill'
import { ConversationRow } from './ds/inbox/ConversationRow'
import { FolderItem } from './ds/inbox/FolderItem'
import { ToolbarBand } from './ds/inbox/ToolbarBand'

const FOLDERS: Array<{ key: ConversationFolder; label: string; icon: string }> = [
  {
    key: 'open',
    label: 'Open',
    icon: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z',
  },
  {
    key: 'closed',
    label: 'Closed',
    icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  },
  { key: 'spam', label: 'Spam', icon: 'M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z' },
]

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

function FolderIcon({ path }: { path: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d={path} />
    </svg>
  )
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
    <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
      <nav
        aria-label="Folders"
        style={{
          width: 190,
          flexShrink: 0,
          padding: '14px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {FOLDERS.map((f) => (
          <FolderItem
            key={f.key}
            icon={<FolderIcon path={f.icon} />}
            label={f.label}
            count={f.key === folder && conversations.length > 0 ? String(conversations.length) : ''}
            active={f.key === folder}
            hasItems={f.key === folder && conversations.length > 0}
            onClick={() => router.push(`/inbox/${f.key}`)}
          />
        ))}
      </nav>

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
          <span style={{ fontSize: 13, fontWeight: 700 }}>
            {FOLDERS.find((f) => f.key === folder)?.label}
          </span>
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
    </div>
  )
}
