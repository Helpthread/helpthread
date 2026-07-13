import React from 'react'

/** Primary action button. variant: primary | outline | ghost | destructive.
 *  Destructive supports the two-step arm pattern via the `armed` prop. */
export function Button({
  variant = 'primary',
  armed = false,
  disabled = false,
  onClick,
  title,
  style,
  children,
}) {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    whiteSpace: 'nowrap',
    font: 'inherit',
    fontSize: '13.5px',
    fontWeight: 600,
    borderRadius: 'var(--ht-radius-md)',
    padding: '8px 18px',
    cursor: disabled ? 'default' : 'pointer',
    border: 'none',
  }
  const variants = {
    primary: {
      color: 'var(--ht-on-accent)',
      background: disabled
        ? 'color-mix(in oklab, var(--ht-accent) 42%, var(--ht-bg))'
        : 'var(--ht-accent)',
    },
    outline: {
      color: 'var(--ht-ink)',
      background: 'var(--ht-surface)',
      border: '1px solid var(--ht-border)',
      padding: '7px 17px',
    },
    ghost: { color: 'var(--ht-ink-muted)', background: 'none' },
    destructive: armed
      ? {
          color: 'var(--ht-surface)',
          background: 'var(--ht-critical)',
          border: '1px solid color-mix(in oklab, var(--ht-critical) 40%, transparent)',
          padding: '7px 17px',
        }
      : {
          color: 'var(--ht-critical)',
          background: 'transparent',
          border: '1px solid color-mix(in oklab, var(--ht-critical) 40%, transparent)',
          padding: '7px 17px',
        },
  }
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{ ...base, ...variants[variant], ...style }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.filter = 'brightness(0.95)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = ''
      }}
    >
      {children}
    </button>
  )
}
