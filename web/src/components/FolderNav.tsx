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
 *
 * The gear button (HT-101 admin-IA correction; specs/ui/admin-ia.md §1) is
 * THIS mailbox's Mailbox-scoped settings entry point, not a plain link to
 * the old app-level `/settings` — it opens a dropdown of
 * `resolveInboxSettingsSections()` (`../lib/inbox-settings-sections.ts`,
 * the SAME registry `InboxSettingsShell`'s nav renders from — the module
 * injection point, Rule 2), deep-linking into
 * `/mailbox/{id}/settings/{section}`. `planned` entries render disabled
 * (no `onClick`, a muted "Not yet available" hint) — an honest menu, never
 * a fake link (Rule 6). The app-level `Manage → Settings` link is
 * deliberately NOT here — that's Global-admin scope and lives in `Manage
 * ▾` (`TopBar`) instead. `mailbox` is `null` only when the layout found no
 * connected mailbox to resolve (`(shell)/layout.tsx`'s doc) — the gear is
 * inert in that case, since there's no mailbox id to link into.
 */

import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import { useDrafts } from '../lib/drafts'
import {
  FOLDER_ICON_PATHS,
  FOLDER_LABELS,
  FOLDER_ORDER,
  mergeFolderCounts,
  type ServerFolderCounts,
} from '../lib/folders'
import { resolveInboxSettingsSections } from '../lib/inbox-settings-sections'
import { useStarred } from '../lib/starred'
import { DropdownMenu } from './ds/core/DropdownMenu'
import { MenuItem } from './ds/core/MenuItem'
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

function ChevronDownIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" aria-hidden="true" style={{ opacity: 0.75 }}>
      <polyline
        points="6 9 12 15 18 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function FolderNav({
  supportAddress,
  counts,
  mailbox,
}: {
  supportAddress: string
  counts: ServerFolderCounts
  /** THIS mailbox's id/address, resolved server-side (`(shell)/layout.tsx`). `null` when no mailbox could be resolved — the gear menu is inert. */
  mailbox: { id: string; address: string } | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const showToast = useToast()
  const { starredIds } = useStarred()
  const drafts = useDrafts()
  const [gearOpen, setGearOpen] = useState(false)
  const sections = resolveInboxSettingsSections()

  const merged = mergeFolderCounts(counts, {
    starred: starredIds.length,
    drafts: Object.keys(drafts).length,
  })

  return (
    <nav
      aria-label="Folders"
      style={{
        width: 220,
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
        <div style={{ position: 'relative', flex: 1 }}>
          <button
            type="button"
            title="Mailbox settings"
            // Both child icons are decorative, so `title` alone is an
            // unreliable accessible name; and without the disclosure pair,
            // assistive tech cannot tell this opens a menu or whether it is
            // currently open (review, 2026-07-31).
            aria-label="Mailbox settings"
            aria-haspopup="menu"
            aria-expanded={gearOpen}
            disabled={mailbox === null}
            onClick={() => setGearOpen((current) => !current)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              border: 'none',
              borderRight: '1px solid var(--ht-border)',
              background: 'none',
              padding: '9px 0',
              color: 'var(--ht-ink-muted)',
              cursor: mailbox === null ? 'default' : 'pointer',
              opacity: mailbox === null ? 0.5 : 1,
            }}
            onMouseEnter={(e) => {
              if (mailbox !== null) e.currentTarget.style.background = 'var(--ht-surface-2)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'none'
            }}
          >
            <SettingsIcon />
            <ChevronDownIcon />
          </button>
          {mailbox !== null && (
            <DropdownMenu open={gearOpen} onClose={() => setGearOpen(false)} minWidth={210}>
              {sections.map((section) => (
                <MenuItem
                  key={section.key}
                  shortcut={
                    section.status === 'planned' ? (
                      <span style={{ fontSize: 11, color: 'var(--ht-ink-dim)' }}>
                        Not yet available
                      </span>
                    ) : undefined
                  }
                  onClick={
                    section.status === 'available'
                      ? () => {
                          setGearOpen(false)
                          router.push(section.href(mailbox.id))
                        }
                      : undefined
                  }
                >
                  {section.label}
                </MenuItem>
              ))}
            </DropdownMenu>
          )}
        </div>
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
