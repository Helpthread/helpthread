'use client'

/**
 * /settings — the global Settings surface, now with the reference IA's left
 * section-sidebar (HT-54 fidelity correction, TJ's 2026-07-18 admin-IA
 * review; specs/ui/admin-ia.md): every Manage surface separates its content
 * into sections down a left rail, and Settings sections are the injection
 * points future increments (HT-56: Mail Settings, Alerts) and modules
 * extend. Sections today: **General** (deployment identity + the branding
 * note), **Appearance**, **Keyboard shortcuts**.
 *
 * Sections are client-side state within the one /settings route for now —
 * three shallow sections don't justify three routes; HT-56 graduates
 * sections to routes (the AgentDetailShell pattern) when they gain depth.
 *
 * Keyboard shortcuts moved here from the top bar's menus (a personal
 * preference is not a Manage- or avatar-scoped affordance); the global `?`
 * shortcut (`ShortcutsProvider`) is unchanged.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { Theme } from '../lib/theme'
import { Button } from './ds/core/Button'
import { Kbd } from './ds/core/Kbd'
import { FolderItem } from './ds/inbox/FolderItem'
import { useShortcutsOverlay } from './ShortcutsProvider'
import { useTheme } from './ThemeProvider'

export interface DeploymentInfo {
  productName: string
  supportAddress: string
  mailDomain: string
}

type SettingsSection = 'general' | 'appearance' | 'shortcuts'

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

function GeneralIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.7l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1L14.4 2.4a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4L9 5.1a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.7L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.7l2 3.4c.1.2.4.3.6.2l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.7c0 .2.3.4.5.4h4c.2 0 .5-.2.5-.4l.4-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.7L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
      />
    </svg>
  )
}

function AppearanceIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18V4a8 8 0 0 1 0 16z"
      />
    </svg>
  )
}

function ShortcutsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H4zm0 2h16v10H4V7zm2 2v2h2V9H6zm4 0v2h2V9h-2zm4 0v2h2V9h-2zm-8 4v2h8v-2H8z"
      />
    </svg>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--ht-surface)',
        border: '1px solid var(--ht-border)',
        borderRadius: 'var(--ht-radius-lg, 8px)',
        padding: 18,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>{title}</div>
      {children}
    </section>
  )
}

export function SettingsScreen({ deployment }: { deployment: DeploymentInfo }) {
  const { theme, setTheme } = useTheme()
  const { open: openShortcuts } = useShortcutsOverlay()
  const [section, setSection] = useState<SettingsSection>('general')

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 24, display: 'flex', gap: 28 }}>
      <div style={{ width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Link
          href="/inbox/open"
          style={{
            alignSelf: 'flex-start',
            paddingBottom: 4,
            fontSize: 13,
            color: 'var(--ht-ink-muted)',
            textDecoration: 'none',
          }}
        >
          ← Inbox
        </Link>
        <nav aria-label="Settings" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <FolderItem
            icon={<GeneralIcon />}
            label="General"
            active={section === 'general'}
            hasItems
            onClick={() => setSection('general')}
          />
          <FolderItem
            icon={<AppearanceIcon />}
            label="Appearance"
            active={section === 'appearance'}
            hasItems
            onClick={() => setSection('appearance')}
          />
          <FolderItem
            icon={<ShortcutsIcon />}
            label="Keyboard shortcuts"
            active={section === 'shortcuts'}
            hasItems
            onClick={() => setSection('shortcuts')}
          />
        </nav>
      </div>

      <div style={{ flex: 1, minWidth: 0, maxWidth: 640 }}>
        {section === 'general' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card title="Deployment">
              <dl
                style={{
                  margin: 0,
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  rowGap: 10,
                  columnGap: 16,
                  fontSize: 13,
                }}
              >
                <dt style={{ color: 'var(--ht-ink-dim)' }}>Product name</dt>
                <dd style={{ margin: 0 }}>{deployment.productName}</dd>
                <dt style={{ color: 'var(--ht-ink-dim)' }}>Support address</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--ht-mono)' }}>
                  {deployment.supportAddress}
                </dd>
                <dt style={{ color: 'var(--ht-ink-dim)' }}>Mail domain</dt>
                <dd style={{ margin: 0, fontFamily: 'var(--ht-mono)' }}>{deployment.mailDomain}</dd>
              </dl>
            </Card>

            <Card title="Branding lives in one file">
              <p
                style={{ margin: 0, fontSize: 13, lineHeight: 1.65, color: 'var(--ht-ink-muted)' }}
              >
                Rebranding Helpthread is one edit: the accent and neutrals in{' '}
                <code style={{ fontFamily: 'var(--ht-mono)' }}>theme/helpthread.css</code>. The
                product name, support address, and mail domain come from the deployment's identity
                configuration, set once at deploy time.
              </p>
            </Card>
          </div>
        )}

        {section === 'appearance' && (
          <Card title="Appearance">
            <div
              style={{
                display: 'inline-flex',
                border: '1px solid var(--ht-border)',
                borderRadius: 'var(--ht-radius-md)',
                overflow: 'hidden',
              }}
            >
              {THEME_OPTIONS.map((option) => {
                const selected = theme === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setTheme(option.value)}
                    style={{
                      border: 'none',
                      padding: '7px 16px',
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer',
                      color: selected ? 'var(--ht-on-accent)' : 'var(--ht-ink-muted)',
                      background: selected ? 'var(--ht-accent)' : 'transparent',
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          </Card>
        )}

        {section === 'shortcuts' && (
          <Card title="Keyboard shortcuts">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <p style={{ margin: 0, flex: 1, fontSize: 13, color: 'var(--ht-ink-muted)' }}>
                Press <Kbd>?</Kbd> anywhere in the app to bring up the full list.
              </p>
              <Button variant="outline" onClick={openShortcuts}>
                View shortcuts
              </Button>
            </div>
          </Card>
        )}
      </div>
    </main>
  )
}
