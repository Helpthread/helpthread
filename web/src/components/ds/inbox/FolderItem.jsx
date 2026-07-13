import React from 'react'

/** Sidebar folder row. Folders with items read stronger than empty ones;
 *  the active folder is accent-highlighted. */
export function FolderItem({ icon, label, count = '', active = false, hasItems = false, onClick }) {
  const fg = active
    ? 'var(--ht-accent)'
    : hasItems
      ? 'var(--ht-ink)'
      : 'color-mix(in oklab, var(--ht-ink-dim) 60%, transparent)'
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
        fontSize: 12,
        fontWeight: active ? 700 : 400,
        color: fg,
        background: active ? 'var(--ht-accent-soft)' : 'transparent',
        border: 'none',
        borderRadius: 'var(--ht-radius-sm)',
        padding: '8px 10px',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--ht-surface-2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? 'var(--ht-accent-soft)' : 'transparent'
      }}
    >
      <span style={{ display: 'inline-flex', flexShrink: 0, opacity: 0.85 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: active ? 'var(--ht-accent)' : 'var(--ht-ink-muted)',
        }}
      >
        {count}
      </span>
    </button>
  )
}
