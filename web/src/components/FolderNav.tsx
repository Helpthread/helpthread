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
        d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"
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
