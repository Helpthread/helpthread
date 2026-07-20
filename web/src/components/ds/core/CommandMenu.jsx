import React from 'react'
import { IconReply, IconSearch } from './primitives-support'

/** Searchable inserter for saved replies. Filters as you type;
 *  ↑↓ moves, ↵ inserts, esc clears. */
export function CommandMenu({
  items = [],
  placeholder = 'Search saved replies…',
  onPick,
  inline,
  width = 320,
  initialQuery = '',
}) {
  const [q, setQ] = React.useState(initialQuery)
  const [hi, setHi] = React.useState(0)
  const inputRef = React.useRef(null)
  const listRef = React.useRef(null)

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return items
    return items.filter((it) =>
      `${it.label} ${it.snippet || ''} ${it.keywords || ''}`.toLowerCase().includes(s),
    )
  }, [q, items])

  // `q` is the trigger here, not a read: the highlight resets to the top of the
  // list whenever the query changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: q is a trigger, not a read
  React.useEffect(() => {
    setHi(0)
  }, [q])

  React.useEffect(() => {
    const el = listRef.current?.children[hi]
    if (el?.scrollIntoViewIfNeeded) {
      el.scrollIntoViewIfNeeded()
    } else if (el) {
      const p = listRef.current
      if (el.offsetTop < p.scrollTop) p.scrollTop = el.offsetTop
      else if (el.offsetTop + el.offsetHeight > p.scrollTop + p.clientHeight)
        p.scrollTop = el.offsetTop + el.offsetHeight - p.clientHeight
    }
  }, [hi])

  const key = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = filtered[hi]
      if (it) onPick?.(it)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setQ('')
      e.target.blur()
    }
  }

  return (
    <div
      style={{
        width,
        background: 'var(--ht-surface)',
        border: '1px solid var(--ht-border)',
        borderRadius: 'var(--ht-radius-md)',
        boxShadow: 'var(--ht-shadow-md)',
        overflow: 'hidden',
        animation: inline ? 'none' : 'ht-rise .16s ease-out',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          borderBottom: '1px solid var(--ht-divider)',
        }}
      >
        <span style={{ display: 'inline-flex', color: 'var(--ht-ink-dim)' }}>{IconSearch(15)}</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={key}
          placeholder={placeholder}
          // The menu opens in response to an explicit user action and the search
          // field is its entire purpose; not focusing it would strand keyboard users.
          // biome-ignore lint/a11y/noAutofocus: deliberate in the design source
          autoFocus={!inline}
          style={{
            flex: 1,
            font: 'inherit',
            fontFamily: 'var(--ht-sans)',
            fontSize: 13.5,
            color: 'var(--ht-ink)',
            background: 'none',
            border: 'none',
            outline: 'none',
            padding: 0,
          }}
        />
        <span
          style={{
            fontFamily: 'var(--ht-mono)',
            fontSize: 11,
            color: 'var(--ht-ink-dim)',
            border: '1px solid var(--ht-border)',
            borderBottomWidth: 2,
            borderRadius: 'var(--ht-radius-sm)',
            padding: '1px 6px',
          }}
        >
          esc
        </span>
      </div>
      {filtered.length === 0 ? (
        <div style={{ padding: '34px 20px 30px', textAlign: 'center' }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ht-ink)' }}>
            No matching replies
          </div>
          <div
            style={{
              margin: '6px auto 0',
              maxWidth: 220,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: 'var(--ht-ink-muted)',
            }}
          >
            {`Nothing matches “${q}”. Try a shorter term.`}
          </div>
        </div>
      ) : (
        <div ref={listRef} style={{ maxHeight: 244, overflowY: 'auto', padding: 5 }}>
          {filtered.map((it, i) => (
            <button
              key={it.label}
              type="button"
              onClick={() => onPick?.(it)}
              onMouseMove={() => setHi(i)}
              style={{
                display: 'block',
                width: '100%',
                boxSizing: 'border-box',
                textAlign: 'left',
                border: 'none',
                cursor: 'pointer',
                borderRadius: 'var(--ht-radius-sm)',
                padding: '7px 10px',
                background: i === hi ? 'var(--ht-accent-soft)' : 'transparent',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    display: 'inline-flex',
                    color: i === hi ? 'var(--ht-accent)' : 'var(--ht-ink-dim)',
                  }}
                >
                  {IconReply(14)}
                </span>
                <span
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontWeight: 600,
                    color: i === hi ? 'var(--ht-accent)' : 'var(--ht-ink)',
                  }}
                >
                  {it.label}
                </span>
                {it.shortcut ? (
                  <span
                    style={{
                      fontFamily: 'var(--ht-mono)',
                      fontSize: 11,
                      color: 'var(--ht-ink-dim)',
                    }}
                  >
                    {it.shortcut}
                  </span>
                ) : null}
              </div>
              {it.snippet ? (
                <div
                  style={{
                    margin: '2px 0 0 24px',
                    fontSize: 12,
                    lineHeight: 1.4,
                    color: 'var(--ht-ink-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {it.snippet}
                </div>
              ) : null}
            </button>
          ))}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '7px 12px',
          borderTop: '1px solid var(--ht-divider)',
          fontSize: 11,
          color: 'var(--ht-ink-dim)',
        }}
      >
        <span>{`${filtered.length} ${filtered.length === 1 ? 'reply' : 'replies'}`}</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--ht-mono)' }}>↑↓ move · ↵ insert</span>
      </div>
    </div>
  )
}
