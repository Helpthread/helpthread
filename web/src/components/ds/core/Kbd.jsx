import React from 'react'

/** Keycap. Used in shortcut hints and menu affordances. */
export function Kbd({ children }) {
  return (
    <kbd
      style={{
        fontFamily: 'var(--ht-mono)',
        fontSize: 11,
        color: 'var(--ht-ink-muted)',
        background: 'var(--ht-surface)',
        border: '1px solid var(--ht-border)',
        borderBottomWidth: 2,
        borderRadius: 'var(--ht-radius-sm)',
        padding: '1px 6px',
        minWidth: 10,
        display: 'inline-block',
        textAlign: 'center',
      }}
    >
      {children}
    </kbd>
  )
}
