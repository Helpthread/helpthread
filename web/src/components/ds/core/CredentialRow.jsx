import React from 'react'
import { Button } from './Button'
import { fmtDate, IconKey, IconPencil, IconPlus, IconTrash, RING, rel } from './primitives-support'

/** A registered passkey: key icon, name, added / last-used metadata, inline
 *  rename, and revoke behind a two-step arm.
 *  `demo` forces a visual state (hover | rename | armed) for specimen rendering. */
export function CredentialRow({ cred, demo, onRename, onRevoke, first }) {
  const [hover, setHover] = React.useState(demo === 'hover')
  const [renaming, setRenaming] = React.useState(demo === 'rename')
  const [name, setName] = React.useState(cred.name)
  const [armed, setArmed] = React.useState(demo === 'armed')
  const timer = React.useRef(null)
  React.useEffect(() => () => clearTimeout(timer.current), [])

  const arm = () => {
    if (armed) {
      setArmed(false)
      clearTimeout(timer.current)
      onRevoke?.(cred)
    } else {
      setArmed(true)
      timer.current = setTimeout(() => setArmed(false), 3500)
    }
  }

  return (
    <div
      onMouseEnter={() => !demo && setHover(true)}
      onMouseLeave={() => !demo && setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        padding: '13px 14px',
        borderTop: first ? 'none' : '1px solid var(--ht-divider)',
        background: hover ? 'var(--ht-surface-2)' : 'transparent',
        transition: 'background .1s',
      }}
    >
      <div
        style={{
          width: 38,
          height: 38,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--ht-radius-sm)',
          background: 'var(--ht-accent-soft)',
          color: 'var(--ht-accent)',
        }}
      >
        {IconKey(20)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {renaming ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              // The field only exists after the user clicks Rename, so focus simply
              // follows the action they just took.
              // biome-ignore lint/a11y/noAutofocus: deliberate in the design source
              autoFocus={!demo}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setRenaming(false)
                  onRename?.(cred, name)
                }
                if (e.key === 'Escape') {
                  setName(cred.name)
                  setRenaming(false)
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                fontFamily: 'var(--ht-sans)',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--ht-ink)',
                background: 'var(--ht-bg)',
                border: '1px solid var(--ht-border)',
                borderRadius: 'var(--ht-radius-sm)',
                padding: '5px 9px',
                outline: 'none',
                boxShadow: RING,
              }}
            />
            <button
              type="button"
              onClick={() => {
                setRenaming(false)
                onRename?.(cred, name)
              }}
              style={{
                font: 'inherit',
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--ht-on-accent)',
                background: 'var(--ht-accent)',
                border: 'none',
                borderRadius: 'var(--ht-radius-sm)',
                padding: '5px 12px',
                cursor: 'pointer',
              }}
            >
              Save
            </button>
          </div>
        ) : (
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
            {name}
          </div>
        )}
        {!renaming ? (
          <div
            style={{
              marginTop: 3,
              fontSize: 12,
              color: 'var(--ht-ink-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {`Added ${fmtDate(cred.added)}  ·  Last used ${cred.lastUsed ? rel(cred.lastUsed) : 'never'}`}
          </div>
        ) : null}
      </div>
      {!renaming ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
            opacity: hover || armed || demo ? 1 : 0,
            transition: 'opacity .12s',
          }}
        >
          {armed ? (
            <button
              type="button"
              onClick={arm}
              style={{
                font: 'inherit',
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--ht-surface)',
                background: 'var(--ht-critical)',
                border: '1px solid color-mix(in oklab, var(--ht-critical) 40%, transparent)',
                borderRadius: 'var(--ht-radius-sm)',
                padding: '5px 12px',
                cursor: 'pointer',
              }}
            >
              Confirm revoke
            </button>
          ) : (
            <>
              <button
                type="button"
                title="Rename"
                onClick={() => setRenaming(true)}
                style={{
                  width: 30,
                  height: 30,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--ht-ink-muted)',
                  background: 'none',
                  border: 'none',
                  borderRadius: 'var(--ht-radius-sm)',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--ht-surface)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'none'
                }}
              >
                {IconPencil(15)}
              </button>
              <button
                type="button"
                title="Revoke"
                onClick={arm}
                style={{
                  width: 30,
                  height: 30,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--ht-critical)',
                  background: 'none',
                  border: 'none',
                  borderRadius: 'var(--ht-radius-sm)',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--ht-critical-soft)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'none'
                }}
              >
                {IconTrash(15)}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** The passkey list: registered credentials plus the add affordance, or the
 *  empty state when nothing is registered yet. */
export function PasskeyList({ creds = [], empty, onAdd }) {
  const addBtn = (
    <Button variant="outline" onClick={() => onAdd?.()}>
      <span style={{ display: 'inline-flex', marginRight: -2 }}>{IconPlus(14)}</span>
      Add a passkey
    </Button>
  )
  return (
    <div
      style={{
        border: '1px solid var(--ht-divider)',
        borderRadius: 'var(--ht-radius-md)',
        background: 'var(--ht-surface)',
        overflow: 'hidden',
      }}
    >
      {empty || creds.length === 0 ? (
        <div style={{ padding: '40px 24px 34px', textAlign: 'center' }}>
          <div
            style={{
              width: 44,
              height: 44,
              margin: '0 auto 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--ht-radius-md)',
              background: 'var(--ht-surface-2)',
              color: 'var(--ht-ink-dim)',
            }}
          >
            {IconKey(24)}
          </div>
          <div
            style={{
              fontFamily: 'var(--ht-display)',
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--ht-ink)',
            }}
          >
            No passkeys yet
          </div>
          <div
            style={{
              margin: '7px auto 18px',
              maxWidth: 320,
              fontSize: 13.5,
              lineHeight: 1.6,
              color: 'var(--ht-ink-muted)',
            }}
          >
            Add a passkey to sign in with your fingerprint, face, or security key — no password to
            remember.
          </div>
          {addBtn}
        </div>
      ) : (
        <>
          {creds.map((c, i) => (
            <CredentialRow key={c.name} cred={c} first={i === 0} />
          ))}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              padding: '12px 14px',
              borderTop: '1px solid var(--ht-divider)',
              background: 'var(--ht-bg)',
            }}
          >
            {addBtn}
          </div>
        </>
      )}
    </div>
  )
}
