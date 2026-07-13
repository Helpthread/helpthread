'use client'

/**
 * The persistent folder sidebar — part of the app SHELL (the `(shell)`
 * layout), so it stays put whether you're reading the list or inside a
 * conversation, per the design's anatomy. The active folder is derived from
 * the URL; inside a conversation no folder is active, but the rail remains.
 *
 * Counts: the five API-backed folders arrive as server-fetched props
 * (`(shell)/layout.tsx`, via `lib/folder-counts.ts`); Starred and Drafts are
 * localStorage-only and merged in here client-side (`mergeFolderCounts`).
 */

import { usePathname, useRouter } from 'next/navigation'
import { useDrafts } from '../lib/drafts'
import {
  FOLDER_ICON_PATHS,
  FOLDER_LABELS,
  FOLDER_ORDER,
  mergeFolderCounts,
  type ServerFolderCounts,
} from '../lib/folders'
import { useStarred } from '../lib/starred'
import { FolderItem } from './ds/inbox/FolderItem'
import { useToast } from './Toaster'

function FolderIcon({ path }: { path: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d={path} />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
      />
    </svg>
  )
}

function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z"
      />
    </svg>
  )
}

export function FolderNav({
  supportAddress,
  counts,
}: {
  supportAddress: string
  counts: ServerFolderCounts
}) {
  const router = useRouter()
  const pathname = usePathname()
  const showToast = useToast()
  const { starredIds } = useStarred()
  const drafts = useDrafts()

  const merged = mergeFolderCounts(counts, {
    starred: starredIds.length,
    drafts: Object.keys(drafts).length,
  })

  return (
    <nav
      aria-label="Folders"
      style={{
        width: 190,
        flexShrink: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: '14px 14px 10px' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Support</div>
        <div
          style={{
            marginTop: 2,
            fontFamily: 'var(--ht-mono)',
            fontSize: 11,
            color: 'var(--ht-ink-dim)',
          }}
        >
          {supportAddress}
        </div>
      </div>

      <div
        style={{
          minHeight: 0,
          padding: '4px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {FOLDER_ORDER.map((folder) => (
          <FolderItem
            key={folder}
            icon={<FolderIcon path={FOLDER_ICON_PATHS[folder]} />}
            label={FOLDER_LABELS[folder]}
            count={merged[folder]}
            active={pathname === `/inbox/${folder}`}
            hasItems={merged[folder] !== ''}
            onClick={() => router.push(`/inbox/${folder}`)}
          />
        ))}
      </div>

      <div
        style={{
          margin: '10px 10px 0',
          flexShrink: 0,
          display: 'flex',
          border: '1px solid var(--ht-border)',
          borderRadius: 'var(--ht-radius-md)',
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          title="Settings"
          onClick={() => router.push('/settings')}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            borderRight: '1px solid var(--ht-border)',
            background: 'none',
            padding: '9px 0',
            color: 'var(--ht-ink-muted)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--ht-surface-2)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none'
          }}
        >
          <SettingsIcon />
        </button>
        <button
          type="button"
          title="New message"
          onClick={() =>
            showToast({
              title: "New message isn't wired yet",
              detail: "Designed for v1 — the outbound-new endpoint is spec'd, not in the mock.",
            })
          }
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'none',
            padding: '9px 0',
            color: 'var(--ht-ink-muted)',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--ht-surface-2)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none'
          }}
        >
          <MailIcon />
        </button>
      </div>
    </nav>
  )
}
