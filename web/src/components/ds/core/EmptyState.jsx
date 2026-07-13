import React from 'react'

/** Typographic empty state. celebrate=true is the italic "Inbox zero." treatment. */
export function EmptyState({ title, body, celebrate = false }) {
  return (
    <div style={{ padding: '100px 24px 90px', textAlign: 'center' }}>
      <div
        style={{
          fontFamily: 'var(--ht-display)',
          fontSize: celebrate ? 28 : 22,
          fontWeight: 600,
          fontStyle: celebrate ? 'italic' : 'normal',
          color: 'var(--ht-ink)',
        }}
      >
        {title}
      </div>
      {body && (
        <div
          style={{
            margin: '10px auto 0',
            maxWidth: 360,
            fontSize: 14.5,
            lineHeight: 1.65,
            color: 'var(--ht-ink-muted)',
          }}
        >
          {body}
        </div>
      )}
    </div>
  )
}
