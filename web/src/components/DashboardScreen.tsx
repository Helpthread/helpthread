'use client'

/**
 * /dashboard — a centered mailbox card: the seven folders with their counts
 * (Unassigned's shown as a filled accent badge, the others plain), and
 * quick links into the inbox and settings. The wordmark and the top bar's
 * Mailbox tab both land here. Counts use the same server-fetched +
 * localStorage-merged mechanism as the folder rail (`lib/folder-counts.ts`,
 * `mergeFolderCounts`).
 */

import Link from 'next/link'
import { useDrafts } from '../lib/drafts'
import {
  FOLDER_ICON_PATHS,
  FOLDER_LABELS,
  FOLDER_ORDER,
  mergeFolderCounts,
  type ServerFolderCounts,
} from '../lib/folders'
import { useStarred } from '../lib/starred'

function FolderIcon({ path }: { path: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d={path} />
    </svg>
  )
}

export function DashboardScreen({
  supportAddress,
  counts,
}: {
  supportAddress: string
  counts: ServerFolderCounts
}) {
  const { starredIds } = useStarred()
  const drafts = useDrafts()

  const merged = mergeFolderCounts(counts, {
    starred: starredIds.length,
    drafts: Object.keys(drafts).length,
  })

  return (
    <main style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', padding: 40 }}>
      <div style={{ width: '100%', maxWidth: 420, alignSelf: 'flex-start', marginTop: 32 }}>
        <section
          style={{
            background: 'var(--ht-surface)',
            border: '1px solid var(--ht-border)',
            borderRadius: 'var(--ht-radius-lg, 8px)',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--ht-divider)' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Support</div>
            <div
              style={{
                marginTop: 2,
                fontFamily: 'var(--ht-mono)',
                fontSize: 12,
                color: 'var(--ht-ink-dim)',
              }}
            >
              {supportAddress}
            </div>
          </div>

          <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column' }}>
            {FOLDER_ORDER.map((folder) => {
              const count = merged[folder]
              return (
                <div
                  key={folder}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 10px',
                    fontSize: 13,
                  }}
                >
                  <span
                    style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--ht-ink-dim)' }}
                  >
                    <FolderIcon path={FOLDER_ICON_PATHS[folder]} />
                  </span>
                  <span style={{ flex: 1 }}>{FOLDER_LABELS[folder]}</span>
                  {count !== '' &&
                    (folder === 'unassigned' ? (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: 'var(--ht-on-accent)',
                          background: 'var(--ht-accent)',
                          borderRadius: 999,
                          padding: '1px 8px',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {count}
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 600,
                          color: 'var(--ht-ink-muted)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {count}
                      </span>
                    ))}
                </div>
              )
            })}
          </div>

          <div
            style={{
              display: 'flex',
              gap: 16,
              borderTop: '1px solid var(--ht-divider)',
              padding: '10px 20px',
            }}
          >
            <Link href="/inbox/unassigned" style={{ fontSize: 13, color: 'var(--ht-accent)' }}>
              Open inbox →
            </Link>
            <Link href="/settings" style={{ fontSize: 13, color: 'var(--ht-ink-muted)' }}>
              Settings
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
