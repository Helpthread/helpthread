import React from 'react'
import { Avatar } from '../core/Avatar.jsx'

/** Full-bleed inbox table row: checkbox · customer · star · subject/preview ·
 *  count slot · #number · waiting time. Hairline bottom border. */
export function ConversationRow({
  customerName,
  customerEmail,
  subject,
  preview,
  count = '',
  number = '',
  time = '',
  starred = false,
  onStar,
  checked = false,
  onCheck,
  showCheckbox = true,
  selected = false,
  onClick,
}) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '9px 14px',
        borderBottom: '1px solid var(--ht-divider)',
        cursor: 'pointer',
        background: selected ? 'var(--ht-surface-2)' : 'transparent',
        boxShadow: selected ? 'inset 2.5px 0 0 var(--ht-accent)' : 'none',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--ht-surface-2)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = selected ? 'var(--ht-surface-2)' : 'transparent'
      }}
    >
      {showCheckbox && (
        <input
          type="checkbox"
          checked={checked}
          onChange={onCheck}
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 15,
            height: 15,
            accentColor: 'var(--ht-accent)',
            cursor: 'pointer',
            margin: 0,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ width: 200, flexShrink: 0, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {customerName}
        </div>
        <div
          style={{
            marginTop: 1,
            fontSize: 11.5,
            color: 'var(--ht-ink-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {customerEmail}
        </div>
      </div>
      <button
        type="button"
        title="Star conversation"
        onClick={(e) => {
          e.stopPropagation()
          onStar && onStar()
        }}
        style={{
          width: 22,
          height: 22,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: starred ? 'var(--ht-accent)' : 'var(--ht-ink-dim)',
          background: 'none',
          border: 'none',
          borderRadius: 'var(--ht-radius-sm)',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill={starred ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
        </svg>
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: 'var(--ht-ink)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {subject}
        </div>
        <div
          style={{
            marginTop: 1,
            fontSize: 12,
            color: 'var(--ht-ink-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {preview}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
        <span style={{ minWidth: 36, display: 'flex', justifyContent: 'flex-end' }}>
          {count && (
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--ht-ink-dim)',
                background: 'var(--ht-surface-2)',
                borderRadius: 999,
                padding: '2px 8px',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {count}
            </span>
          )}
        </span>
        <span
          style={{
            minWidth: 44,
            textAlign: 'right',
            fontSize: 12.5,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span style={{ color: 'var(--ht-ink-dim)', fontSize: 11 }}>#</span>
          <span style={{ fontWeight: 600, color: 'var(--ht-ink-muted)' }}>{number}</span>
        </span>
        <span
          style={{
            fontSize: 12.5,
            color: 'var(--ht-ink-dim)',
            fontVariantNumeric: 'tabular-nums',
            minWidth: 96,
            textAlign: 'right',
          }}
        >
          {time}
        </span>
      </div>
    </div>
  )
}
