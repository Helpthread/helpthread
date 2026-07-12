'use client'

/**
 * The persistent folder sidebar — part of the app SHELL (the `(shell)`
 * layout), so it stays put whether you're reading the list or inside a
 * conversation, per the design's anatomy. The active folder is derived from
 * the URL; inside a conversation no folder is active, but the rail remains.
 *
 * No counts yet: the list API deliberately has no totals (keyset pagination,
 * spec §3a), so an honest count needs its own API affordance — a later
 * increment, not a fake number here.
 */

import { usePathname, useRouter } from 'next/navigation'
import type { ConversationFolder } from '../lib/api-types'
import { FolderItem } from './ds/inbox/FolderItem'

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

function FolderIcon({ path }: { path: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d={path} />
    </svg>
  )
}

export function FolderNav() {
  const router = useRouter()
  const pathname = usePathname()

  return (
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
      {FOLDERS.map((folder) => (
        <FolderItem
          key={folder.key}
          icon={<FolderIcon path={folder.icon} />}
          label={folder.label}
          active={pathname === `/inbox/${folder.key}`}
          hasItems={true}
          onClick={() => router.push(`/inbox/${folder.key}`)}
        />
      ))}
    </nav>
  )
}
