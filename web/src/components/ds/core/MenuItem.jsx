import React from 'react'

/** One dropdown row. Optional leading glyph and trailing shortcut/hint. */
export function MenuItem({
  onClick,
  icon,
  shortcut,
  selected = false,
  destructive = false,
  children,
}) {
  const fg = destructive ? 'var(--ht-critical)' : selected ? 'var(--ht-accent)' : 'var(--ht-ink)'
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        boxSizing: 'border-box',
        textAlign: 'left',
        fontSize: 13,
        fontWeight: 600,
        color: fg,
        background: selected ? 'var(--ht-accent-soft)' : 'none',
        border: 'none',
        borderRadius: 'var(--ht-radius-sm)',
        padding: '7px 10px',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = destructive
          ? 'var(--ht-critical-soft)'
          : 'var(--ht-surface-2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = selected ? 'var(--ht-accent-soft)' : 'transparent'
      }}
    >
      {icon && <span style={{ display: 'inline-flex', color: 'var(--ht-ink-dim)' }}>{icon}</span>}
      <span style={{ flex: 1 }}>{children}</span>
      {shortcut}
    </button>
  )
}
