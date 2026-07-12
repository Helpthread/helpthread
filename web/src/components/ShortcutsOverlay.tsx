'use client'

/** The keyboard-shortcuts modal (fidelity checklist). Toggled/closed by `ShortcutsProvider`. */

import type { ReactNode } from 'react'
import { Kbd } from './ds/core/Kbd'

const ROWS: Array<{ keys: ReactNode; label: string }> = [
  {
    keys: (
      <>
        <Kbd>j</Kbd>
        <Kbd>k</Kbd>
      </>
    ),
    label: 'Move through the inbox',
  },
  { keys: <Kbd>↵</Kbd>, label: 'Open conversation' },
  { keys: <Kbd>x</Kbd>, label: 'Select conversation' },
  { keys: <Kbd>r</Kbd>, label: 'Reply' },
  { keys: <Kbd>n</Kbd>, label: 'Add a note' },
  {
    keys: (
      <>
        <Kbd>⌘</Kbd>
        <Kbd>↵</Kbd>
      </>
    ),
    label: 'Send',
  },
  { keys: <Kbd>Esc</Kbd>, label: 'Close / back' },
  { keys: <Kbd>?</Kbd>, label: 'Show these shortcuts' },
]

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    // Backdrop is non-interactive by design — Esc and the header's close
    // chip are the documented ways to dismiss (see ShortcutsProvider).
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'oklch(0 0 0 / 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 80,
      }}
    >
      <div
        style={{
          width: 360,
          maxWidth: 'calc(100vw - 32px)',
          background: 'var(--ht-surface)',
          border: '1px solid var(--ht-border)',
          borderRadius: 'var(--ht-radius-lg, 8px)',
          boxShadow: 'var(--ht-shadow-md)',
          padding: 18,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>Keyboard shortcuts</span>
          <button
            type="button"
            title="Close"
            onClick={onClose}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
          >
            <Kbd>Esc</Kbd>
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {ROWS.map((row) => (
            <div
              key={row.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--ht-ink-muted)' }}>{row.label}</span>
              <span style={{ display: 'flex', gap: 4 }}>{row.keys}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
