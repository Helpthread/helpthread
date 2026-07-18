'use client'

/**
 * The app shell's top bar — the accent-filled surface, the design system's
 * ONE colored surface. The wordmark and folder rail are the persistent
 * anchors; everything on the right (Manage, Notifications, the Agent
 * avatar) is a dropdown menu, and only one is open at a time.
 *
 * Notifications are read-only display: the 6 most recent OPEN conversations,
 * fetched server-side in `app/layout.tsx` and handed down as props (no
 * client-side polling, no unread state — that's not in the API yet).
 */

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import type { ConversationSummary, SelfAgent } from '../lib/api-types'
import { logoutAction } from '../lib/auth-actions'
import { initialsFromName, nameFromEmail, relativeTime } from '../lib/format'
import { Avatar } from './ds/core/Avatar'
import { DropdownMenu } from './ds/core/DropdownMenu'
import { EmptyState } from './ds/core/EmptyState'
import { IconButton } from './ds/core/IconButton'
import { Kbd } from './ds/core/Kbd'
import { MenuItem } from './ds/core/MenuItem'
import { useShortcutsOverlay } from './ShortcutsProvider'
import { useToast } from './Toaster'

type MenuKey = 'manage' | 'notifications' | 'avatar'

function ChevronDownIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" style={{ opacity: 0.85 }}>
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

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"
      />
    </svg>
  )
}

function NotificationRow({
  conversation,
  onNavigate,
}: {
  conversation: ConversationSummary
  onNavigate: () => void
}) {
  return (
    <button
      type="button"
      onClick={onNavigate}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: '100%',
        boxSizing: 'border-box',
        textAlign: 'left',
        border: 'none',
        background: 'none',
        padding: '8px 8px',
        borderRadius: 'var(--ht-radius-sm)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--ht-surface-2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <Avatar email={conversation.customerEmail} size={28} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ht-ink)' }}>
          {nameFromEmail(conversation.customerEmail)} — conversation #{conversation.number}
        </div>
        <div
          style={{
            marginTop: 1,
            fontSize: 11.5,
            color: 'var(--ht-ink-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {conversation.preview}
        </div>
      </div>
      <span style={{ fontSize: 11, color: 'var(--ht-ink-dim)', flexShrink: 0, marginTop: 1 }}>
        {relativeTime(conversation.updatedAt)}
      </span>
    </button>
  )
}

export function TopBar({
  recentOpen,
  me,
}: {
  recentOpen: ConversationSummary[]
  /** The signed-in Agent (`getMe()`, HT-54), or `null` on public routes / a momentary session hiccup — see `app/layout.tsx`. */
  me: SelfAgent | null
}) {
  const pathname = usePathname()
  const router = useRouter()
  const showToast = useToast()
  const { open: openShortcuts } = useShortcutsOverlay()
  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null)
  const [, startLogoutTransition] = useTransition()

  useEffect(() => {
    if (openMenu === null) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openMenu])

  function toggle(key: MenuKey): void {
    setOpenMenu((current) => (current === key ? null : key))
  }

  function stubToast(feature: string): void {
    showToast({
      title: `${feature} isn't wired yet`,
      detail: "Designed for v1 — the endpoint is spec'd, not wired.",
    })
  }

  const mailboxActive = pathname.startsWith('/inbox') || pathname.startsWith('/conversations')

  return (
    <header
      style={{
        background: 'var(--ht-header-bg)',
        color: 'var(--ht-header-fg)',
        padding: '10px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <Link
        href="/dashboard"
        style={{
          fontFamily: "var(--ht-serif, 'Source Serif 4', serif)",
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: '0.01em',
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        helpthread<span style={{ opacity: 0.55 }}>.</span>
      </Link>

      <span
        aria-hidden="true"
        style={{
          width: 1,
          height: 18,
          background: 'var(--ht-header-fg)',
          opacity: 0.25,
        }}
      />

      <button
        type="button"
        onClick={() => router.push('/inbox/open')}
        style={{
          border: 'none',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          color: 'inherit',
          padding: '6px 12px',
          borderRadius: 'var(--ht-radius-md)',
          background: mailboxActive
            ? 'color-mix(in oklab, var(--ht-header-fg) 16%, transparent)'
            : 'none',
        }}
      >
        Mailbox
      </button>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => toggle('manage')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            border: 'none',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            color: 'inherit',
            padding: '6px 10px',
            borderRadius: 'var(--ht-radius-md)',
            background:
              openMenu === 'manage'
                ? 'color-mix(in oklab, var(--ht-header-fg) 16%, transparent)'
                : 'none',
          }}
        >
          Manage
          <ChevronDownIcon />
        </button>
        <DropdownMenu open={openMenu === 'manage'} onClose={() => setOpenMenu(null)}>
          <MenuItem
            onClick={() => {
              setOpenMenu(null)
              router.push('/settings')
            }}
          >
            Settings
          </MenuItem>
          <MenuItem
            shortcut={<Kbd>?</Kbd>}
            onClick={() => {
              setOpenMenu(null)
              openShortcuts()
            }}
          >
            Keyboard shortcuts
          </MenuItem>
        </DropdownMenu>
      </div>

      <span style={{ flex: 1 }} />

      <div style={{ position: 'relative' }}>
        <IconButton
          title="Notifications"
          tone="header"
          active={openMenu === 'notifications'}
          onClick={() => toggle('notifications')}
        >
          <BellIcon />
        </IconButton>
        <DropdownMenu
          open={openMenu === 'notifications'}
          onClose={() => setOpenMenu(null)}
          align="right"
          minWidth={360}
        >
          <div
            style={{
              padding: '6px 8px 8px',
              fontSize: 12.5,
              fontWeight: 700,
              color: 'var(--ht-ink)',
            }}
          >
            Notifications
          </div>
          {recentOpen.length === 0 ? (
            <div style={{ padding: '6px 4px 10px' }}>
              <EmptyState title="Nothing new right now." />
            </div>
          ) : (
            recentOpen.map((conversation) => (
              <NotificationRow
                key={conversation.id}
                conversation={conversation}
                onNavigate={() => {
                  setOpenMenu(null)
                  router.push(`/conversations/${conversation.id}`)
                }}
              />
            ))
          )}
        </DropdownMenu>
      </div>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => toggle('avatar')}
          style={{
            border: 'none',
            background: 'none',
            padding: 0,
            display: 'flex',
            cursor: 'pointer',
          }}
        >
          {me !== null ? (
            <Avatar email={me.email} initials={initialsFromName(me.name)} size={28} />
          ) : (
            <Avatar agent size={28} />
          )}
        </button>
        <DropdownMenu open={openMenu === 'avatar'} onClose={() => setOpenMenu(null)} align="right">
          {me !== null && (
            <div style={{ padding: '4px 8px 8px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ht-ink)' }}>
                {me.name}
              </div>
              <div
                style={{
                  marginTop: 1,
                  fontSize: 11.5,
                  color: 'var(--ht-ink-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {me.email}
              </div>
            </div>
          )}
          <MenuItem
            onClick={() => {
              setOpenMenu(null)
              if (me !== null) {
                router.push(`/settings/team/${me.id}`)
              } else {
                stubToast('Your profile')
              }
            }}
          >
            Your profile
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpenMenu(null)
              router.push('/settings')
            }}
          >
            Settings
          </MenuItem>
          <MenuItem
            shortcut={<Kbd>?</Kbd>}
            onClick={() => {
              setOpenMenu(null)
              openShortcuts()
            }}
          >
            Keyboard shortcuts
          </MenuItem>
          <div style={{ height: 1, background: 'var(--ht-divider)', margin: '4px 2px' }} />
          <MenuItem
            destructive
            onClick={() => {
              setOpenMenu(null)
              // logoutAction clears the session cookie and redirects to
              // /login server-side (HT-51) — nothing left to do here.
              startLogoutTransition(async () => {
                await logoutAction()
              })
            }}
          >
            Log out
          </MenuItem>
        </DropdownMenu>
      </div>
    </header>
  )
}
