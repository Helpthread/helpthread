import React from 'react'

/** Inverse-fill toast, bottom-right. One msg line + optional detail. Auto-dismiss ~4.2s in-app. */
export function Toast({ message, detail, fixed = false, style }) {
  return (
    <div
      style={{
        ...(fixed ? { position: 'fixed', right: 20, bottom: 20, zIndex: 70 } : {}),
        maxWidth: 340,
        background: 'var(--ht-inverse-bg)',
        color: 'var(--ht-inverse-fg)',
        borderRadius: 'var(--ht-radius-md)',
        padding: '12px 16px',
        boxShadow: 'var(--ht-shadow-md)',
        ...style,
      }}
    >
      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{message}</div>
      {detail && <div style={{ marginTop: 3, fontSize: 12.5, opacity: 0.75 }}>{detail}</div>}
    </div>
  )
}
