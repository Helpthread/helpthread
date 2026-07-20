import React from 'react'
import { MenuItem } from './MenuItem'
import { chevron, RING, useFocusRing } from './primitives-support'

/** A primary action with an attached caret. The caret opens a DropdownMenu of
 *  MenuItems — "Send and close" / "Send and snooze" and friends.
 *  `demo` forces a visual state (hover | focus | active) for specimen rendering. */
export function SplitButton({
  label = 'Send',
  options = [],
  variant = 'primary',
  loading = false,
  disabled = false,
  demo,
  onAction,
  inline,
}) {
  const [open, setOpen] = React.useState(false)
  const [hovMain, setHovMain] = React.useState(demo === 'hover')
  const [hovCaret, setHovCaret] = React.useState(false)
  const [fMain, focMain] = useFocusRing()
  const [fCaret, focCaret] = useFocusRing()
  const focusMain = demo === 'focus' || fMain
  const activeMain = demo === 'active'
  const primary = variant === 'primary'
  const isDisabled = disabled || loading

  const fills = primary
    ? {
        fg: 'var(--ht-on-accent)',
        bg: isDisabled
          ? 'color-mix(in oklab, var(--ht-accent) 42%, var(--ht-bg))'
          : 'var(--ht-accent)',
        seam: 'color-mix(in oklab, var(--ht-on-accent) 22%, transparent)',
      }
    : {
        fg: 'var(--ht-ink)',
        bg: 'var(--ht-surface)',
        border: '1px solid var(--ht-border)',
        seam: 'var(--ht-border)',
      }
  const seg = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    font: 'inherit',
    fontSize: '13.5px',
    fontWeight: 600,
    border: 'none',
    cursor: isDisabled ? 'default' : 'pointer',
    color: fills.fg,
    background: fills.bg,
    position: 'relative',
    transition: 'filter .12s',
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        ...(variant !== 'primary' ? { borderRadius: 'var(--ht-radius-md)' } : {}),
      }}
    >
      <button
        type="button"
        disabled={isDisabled}
        {...focMain}
        onMouseEnter={() => !isDisabled && setHovMain(true)}
        onMouseLeave={() => !demo && setHovMain(false)}
        onClick={() => onAction?.({ label, primary: true })}
        style={{
          ...seg,
          padding: primary ? '8px 16px' : '7px 15px',
          borderTop: fills.border,
          borderLeft: fills.border,
          borderBottom: fills.border,
          borderRadius: 'var(--ht-radius-md) 0 0 var(--ht-radius-md)',
          filter: (hovMain || activeMain) && !isDisabled ? 'brightness(0.94)' : 'none',
          boxShadow: focusMain ? RING : 'none',
          zIndex: focusMain ? 1 : 'auto',
        }}
      >
        {loading ? (
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: '2px solid color-mix(in oklab, var(--ht-on-accent) 40%, transparent)',
              borderTopColor: 'var(--ht-on-accent)',
              animation: 'ht-spin .7s linear infinite',
            }}
          />
        ) : null}
        <span>{loading ? 'Sending…' : label}</span>
      </button>
      <button
        type="button"
        disabled={isDisabled}
        {...focCaret}
        title={`${label} options`}
        onMouseEnter={() => !isDisabled && setHovCaret(true)}
        onMouseLeave={() => setHovCaret(false)}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...seg,
          width: 34,
          padding: 0,
          borderTop: fills.border,
          borderRight: fills.border,
          borderBottom: fills.border,
          borderLeft: `1px solid ${fills.seam}`,
          borderRadius: '0 var(--ht-radius-md) var(--ht-radius-md) 0',
          filter: (hovCaret || open) && !isDisabled ? 'brightness(0.94)' : 'none',
          boxShadow: fCaret ? RING : 'none',
          zIndex: fCaret || open ? 1 : 'auto',
        }}
      >
        {chevron(open ? 'up' : 'down', 15)}
      </button>
      {open && options.length ? (
        <>
          {inline ? null : (
            <div
              onClick={() => setOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 39 }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: 40,
              zIndex: 40,
              minWidth: 200,
              background: 'var(--ht-surface)',
              border: '1px solid var(--ht-border)',
              borderRadius: 'var(--ht-radius-md)',
              boxShadow: 'var(--ht-shadow-md)',
              padding: 5,
              animation: 'ht-rise .16s ease-out',
            }}
          >
            {options.map((o, i) => (
              <MenuItem
                key={o.label ?? i}
                icon={o.icon}
                onClick={() => {
                  setOpen(false)
                  onAction?.(o)
                }}
              >
                {o.label}
              </MenuItem>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
