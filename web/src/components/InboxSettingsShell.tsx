'use client'

/**
 * The left sidebar for a mailbox's settings area
 * (`/mailbox/{id}/settings/{section}`) — Mailbox-scoped per
 * specs/ui/admin-ia.md §1 (the folder rail's gear, never `Manage ▾`).
 * Mirrors `AgentDetailShell`'s structure (168px persistent rail, `FolderItem`
 * nav entries) with two differences the mailbox-settings spec calls for:
 *
 * - A mailbox ▾ switcher in the header (an Agent's detail rail has no
 *   equivalent — there's exactly one you; a deployment can have several
 *   connected mailboxes), built from `ds/core/DropdownMenu` + `MenuItem`,
 *   same primitives `TopBar`'s `Manage ▾`/avatar menus already use.
 * - `planned` nav entries render visibly disabled ("Not yet available",
 *   no `onClick`) rather than omitted — admin-ia.md Rule 6: absent ≠
 *   nonexistent, and Rule 2 (module extensibility) means this menu is
 *   never assumed closed. The section list itself comes from
 *   `resolveInboxSettingsSections` (`../lib/inbox-settings-sections.ts`),
 *   never hardcoded here — that registry IS the module injection point.
 *
 * DECISION FLAGGED FOR TJ: a mailbox has no separate "name" field today
 * (`MailboxSummary` carries only `id`/`address`/`status`), so the bold
 * header line is the address itself; the muted-mono line beneath (matching
 * FolderNav's bold-label-then-mono-value header treatment) shows the
 * mailbox's connection status rather than repeating the address, which
 * would be redundant. Revisit if/when a per-mailbox display name ships.
 */

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { MailboxSummary } from '../lib/api-types'
import { resolveInboxSettingsSections } from '../lib/inbox-settings-sections'
import { DropdownMenu } from './ds/core/DropdownMenu'
import { MenuItem } from './ds/core/MenuItem'
import { FolderItem } from './ds/inbox/FolderItem'

function ChevronDownIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style={{ opacity: 0.7 }}>
      <polyline
        points="6 9 12 15 18 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** One shared glyph for every nav row — the registry carries no per-section icon (not part of `InboxSettingsSection`'s contract), so every entry reads consistently rather than inventing seven bespoke icons. */
function SectionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" fill="currentColor" />
    </svg>
  )
}

function statusLabel(status: MailboxSummary['status']): string {
  if (status === 'active') return 'Active'
  if (status === 'paused') return 'Paused'
  if (status === 'needs_reconnect') return 'Needs reconnect'
  return 'Disconnected'
}

export function InboxSettingsShell({
  mailbox,
  mailboxes,
  activeSection,
  children,
}: {
  mailbox: { id: string; address: string; status: MailboxSummary['status'] }
  /** Every connected mailbox — the switcher's roster. Always includes `mailbox` itself. */
  mailboxes: MailboxSummary[]
  activeSection: string
  children: ReactNode
}) {
  const router = useRouter()
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const sections = resolveInboxSettingsSections()

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 24, display: 'flex', gap: 28 }}>
      <div style={{ width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ position: 'relative', paddingBottom: 4 }}>
          <button
            type="button"
            onClick={() => setSwitcherOpen((current) => !current)}
            // Without these, assistive tech announces a plain button and gives
            // no way to know it opens a menu or whether that menu is currently
            // open (review, 2026-07-25).
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            aria-label={`Switch inbox — currently ${mailbox.address}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              width: '100%',
              border: 'none',
              background: 'none',
              padding: 0,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--ht-ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {mailbox.address}
            </span>
            <ChevronDownIcon />
          </button>
          <div
            style={{
              marginTop: 2,
              fontFamily: 'var(--ht-mono)',
              fontSize: 11,
              color: 'var(--ht-ink-dim)',
            }}
          >
            {statusLabel(mailbox.status)}
          </div>
          <DropdownMenu open={switcherOpen} onClose={() => setSwitcherOpen(false)} minWidth={200}>
            {mailboxes.map((entry) => (
              <MenuItem
                key={entry.id}
                selected={entry.id === mailbox.id}
                onClick={() => {
                  setSwitcherOpen(false)
                  router.push(`/mailbox/${entry.id}/settings/${activeSection}`)
                }}
              >
                {entry.address}
              </MenuItem>
            ))}
          </DropdownMenu>
        </div>

        <nav
          aria-label="Mailbox settings"
          style={{ display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          {sections.map((section) => (
            <FolderItem
              key={section.key}
              icon={<SectionIcon />}
              label={section.label}
              count={section.status === 'planned' ? 'Not yet available' : ''}
              active={section.key === activeSection}
              hasItems={section.status === 'available'}
              onClick={
                section.status === 'available'
                  ? () => router.push(section.href(mailbox.id))
                  : undefined
              }
            />
          ))}
        </nav>

        <button
          type="button"
          onClick={() => router.push('/inbox/open')}
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'none',
            padding: '4px 0 0',
            fontSize: 13,
            color: 'var(--ht-ink-muted)',
            cursor: 'pointer',
          }}
        >
          Inbox →
        </button>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </main>
  )
}
