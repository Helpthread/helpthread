import React from 'react'
import { Avatar } from '../core/Avatar.jsx'
import { StatusPill } from '../core/StatusPill.jsx'

/** Full-bleed thread band. Fill carries who's-who: customer = surface,
 *  Agent reply = 6% accent tint, internal note = 9% warn tint + edge bar.
 *  Hairline top only within a same-speaker run. */
export function MessageBand({
  kind = 'inbound',
  fromLabel,
  fromAddr,
  time,
  delivery,
  viewedAt,
  failed = false,
  sameSpeakerAsPrev = false,
  email,
  children,
}) {
  const bg =
    kind === 'note'
      ? 'color-mix(in oklab, var(--ht-warn) 9%, var(--ht-surface))'
      : kind === 'outbound'
        ? 'color-mix(in oklab, var(--ht-accent) 6%, var(--ht-surface))'
        : 'var(--ht-surface)'
  const fromColor =
    kind === 'note' ? 'var(--ht-warn)' : kind === 'inbound' ? 'var(--ht-ink)' : 'var(--ht-accent)'
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '14px 18px',
        background: bg,
        borderTop: sameSpeakerAsPrev ? '1px solid var(--ht-divider)' : 'none',
        borderLeft: kind === 'note' ? '3px solid var(--ht-warn)' : 'none',
      }}
    >
      <Avatar email={email} agent={kind !== 'inbound'} size={32} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: fromColor }}>{fromLabel}</span>
          {kind === 'note' && (
            <StatusPill status="note" style={{ fontSize: 10.5, padding: '2px 8px' }} />
          )}
          <span
            style={{ fontFamily: 'var(--ht-mono)', fontSize: 11.5, color: 'var(--ht-ink-dim)' }}
          >
            {fromAddr}
          </span>
          <span style={{ flex: 1 }} />
          {kind === 'outbound' && !failed && delivery && (
            <span
              style={{
                fontSize: 11.5,
                color: delivery === 'pending' ? 'var(--ht-warn)' : 'var(--ht-ink-dim)',
                fontWeight: delivery === 'pending' ? 600 : 400,
              }}
            >
              {delivery === 'pending' ? 'Sending…' : 'Sent'}
            </span>
          )}
          <span
            style={{
              fontSize: 12,
              color: 'var(--ht-ink-dim)',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {time}
          </span>
        </div>
        <div
          style={{
            marginTop: 7,
            fontSize: 14,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            maxWidth: '72ch',
          }}
        >
          {children}
        </div>
        {viewedAt && (
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11.5,
              color: 'var(--ht-ink-dim)',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
              ></path>
            </svg>
            <span>Customer viewed {viewedAt}</span>
          </div>
        )}
        {failed && (
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              flexWrap: 'wrap',
              padding: '10px 14px',
              borderRadius: 'var(--ht-radius-md)',
              background: 'var(--ht-critical-soft)',
              border: '1px solid color-mix(in oklab, var(--ht-critical) 28%, transparent)',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ht-critical)' }}>
              This reply didn't reach the customer.
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--ht-ink-muted)' }}>
              Delivery failed — Helpthread will keep retrying.
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
