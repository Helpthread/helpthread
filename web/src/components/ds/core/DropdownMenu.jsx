import React from 'react'

/** Anchored dropdown surface with backdrop dismissal. Wrap the trigger in a
 *  position:relative parent and render this when open. */
export function DropdownMenu({
  open,
  onClose,
  align = 'left',
  top = 36,
  minWidth = 160,
  children,
}) {
  if (!open) return null
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 39 }} />
      <div
        style={{
          position: 'absolute',
          [align]: 0,
          top,
          zIndex: 40,
          minWidth,
          background: 'var(--ht-surface)',
          border: '1px solid var(--ht-border)',
          borderRadius: 'var(--ht-radius-md)',
          boxShadow: 'var(--ht-shadow-md)',
          padding: 5,
        }}
      >
        {children}
      </div>
    </>
  )
}
