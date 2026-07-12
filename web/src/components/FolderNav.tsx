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
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
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
          margin: 10,
          flexShrink: 0,
          display: 'flex',
          border: '1px solid var(--ht-border)',
          borderRadius: 999,
          overflow: 'hidden',
        }}
      >
        <button
          type="button"
          onClick={() => router.push('/settings')}
          style={{
            flex: 1,
            border: 'none',
            borderRight: '1px solid var(--ht-border)',
            background: 'none',
            padding: '7px 0',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--ht-ink-muted)',
            cursor: 'pointer',
          }}
        >
          Settings
        </button>
        <button
          type="button"
          onClick={() =>
            showToast({
              title: "New message isn't wired yet",
              detail: "Designed for v1 — the outbound-new endpoint is spec'd, not in the mock.",
            })
          }
          style={{
            flex: 1,
            border: 'none',
            background: 'none',
            padding: '7px 0',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--ht-ink-muted)',
            cursor: 'pointer',
          }}
        >
          New message
        </button>
      </div>
    </nav>
  )
}
