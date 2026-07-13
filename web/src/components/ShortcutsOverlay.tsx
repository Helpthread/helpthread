'use client'

/** The keyboard-shortcuts modal (fidelity checklist). Toggled/closed by `ShortcutsProvider`. */

import { type ReactNode, useEffect, useRef } from 'react'
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
  { keys: <Kbd>↵</Kbd>, label: 'Open the selected conversation' },
  { keys: <Kbd>x</Kbd>, label: 'Select the focused conversation' },
  {
    keys: (
      <>
        <Kbd>j</Kbd>
        <Kbd>k</Kbd>
      </>
    ),
    label: 'Next / previous conversation (while reading)',
  },
  { keys: <Kbd>r</Kbd>, label: 'Open the reply composer' },
  { keys: <Kbd>n</Kbd>, label: 'Add an internal note' },
  {
    keys: (
      <>
        <Kbd>⌘/Ctrl</Kbd>
        <Kbd>↵</Kbd>
      </>
    ),
    label: 'Send the reply',
  },
  { keys: <Kbd>Esc</Kbd>, label: 'Back to the inbox / close dialogs' },
  { keys: <Kbd>?</Kbd>, label: 'Show this overlay' },
]

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)

  // Focus the close button on open and return focus to whatever was focused
  // before, on close — the baseline modal a11y contract. (Esc is handled by
  // ShortcutsProvider.) The close button is the dialog's only focusable
  // control, so the Tab handler below keeps focus on it — a minimal trap.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    return () => previous?.focus?.()
  }, [])

  return (
    // Backdrop is non-interactive by design — Esc and the header's close
    // chip are the documented ways to dismiss (see ShortcutsProvider).
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onKeyDown={(event) => {
        if (event.key === 'Tab') {
          // One focusable control — keep focus trapped on it.
          event.preventDefault()
          closeRef.current?.focus()
        }
      }}
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
            ref={closeRef}
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
