'use client'

/**
 * /settings — four cards on the paper background, deliberately outside the
 * `(shell)` group (no folder rail). The Deployment card is plain read-only
 * data handed down from the server page; Appearance is wired to `useTheme`.
 *
 * Keyboard shortcuts (HT-54 fidelity correction, TJ's 2026-07-18 admin-IA
 * review): moved here from the top bar's Manage/avatar menus — a personal
 * preference, not a Manage-scoped or avatar-scoped affordance. The global
 * `?` shortcut (`ShortcutsProvider`) is unchanged; this card is just an
 * explicit way to reach the same `ShortcutsOverlay` without knowing the key.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Theme } from '../lib/theme'
import { Button } from './ds/core/Button'
import { Kbd } from './ds/core/Kbd'
import { useShortcutsOverlay } from './ShortcutsProvider'
import { useTheme } from './ThemeProvider'

export interface DeploymentInfo {
  productName: string
  supportAddress: string
  mailDomain: string
}

const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

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

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
      <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Link
          href="/inbox/open"
          style={{ fontSize: 13, color: 'var(--ht-ink-muted)', textDecoration: 'none' }}
        >
          ← Inbox
        </Link>

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
            <dd style={{ margin: 0, fontFamily: 'var(--ht-mono)' }}>{deployment.supportAddress}</dd>
            <dt style={{ color: 'var(--ht-ink-dim)' }}>Mail domain</dt>
            <dd style={{ margin: 0, fontFamily: 'var(--ht-mono)' }}>{deployment.mailDomain}</dd>
          </dl>
        </Card>

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

        <Card title="Branding lives in one file">
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.65, color: 'var(--ht-ink-muted)' }}>
            Rebranding Helpthread is one edit: the accent and neutrals in{' '}
            <code style={{ fontFamily: 'var(--ht-mono)' }}>theme/helpthread.css</code>. The product
            name, support address, and mail domain come from the deployment's identity
            configuration, set once at deploy time.
          </p>
        </Card>
      </div>
    </main>
  )
}
