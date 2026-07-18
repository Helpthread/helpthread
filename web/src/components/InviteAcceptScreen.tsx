'use client'

/**
 * `/invite/{token}` — accept an invite (HT-54; specs/auth/agents-and-auth.md
 * §6, §7): set a password, activate, sign in. Public route. There is no
 * separate token-validation endpoint (the engine's `/auth/invite/accept`
 * validates and consumes the token in the SAME atomic call that sets the
 * password), so an invalid/expired token is only discoverable at submit
 * time — the calm error state renders inline after that failed submit, not
 * as a pre-check. **NEW designed surface — requires TJ fidelity sign-off**
 * (reuses `LoginScreen`'s documented `ds/` workarounds verbatim).
 */

import { useRef, useState, useTransition } from 'react'
import { acceptInviteAction } from '../lib/auth-actions'
import { Button } from './ds/core/Button'

const MIN_PASSWORD_LENGTH = 8

export function InviteAcceptScreen({ token }: { token: string }) {
  const formRef = useRef<HTMLFormElement>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  // `invalidInvite` (the token is dead — terminal) replaces the form with
  // the ask-your-admin panel; `error` (transient — network, server) renders
  // ABOVE the form, which stays interactive so the Agent can simply retry.
  const [invalidInvite, setInvalidInvite] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const mismatch = confirm.length > 0 && password !== confirm
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const canSubmit = password.length >= MIN_PASSWORD_LENGTH && password === confirm

  function submit(): void {
    if (isPending || !canSubmit) return
    setError(null)
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof acceptInviteAction>>
      try {
        result = await acceptInviteAction(token, password)
      } catch {
        setError('Could not reach the server. Please try again.')
        return
      }
      // A successful accept redirects server-side and never returns here.
      if (!result.ok) {
        if (result.invalidInvite) {
          setInvalidInvite(true)
        } else {
          setError(result.message ?? 'Could not reach the server. Please try again.')
        }
      }
    })
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        overflowY: 'auto',
        zIndex: 90,
        background: 'var(--ht-bg)',
        color: 'var(--ht-ink)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          fontFamily: "var(--ht-serif, 'Source Serif 4', serif)",
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: '0.01em',
        }}
      >
        helpthread<span style={{ color: 'var(--ht-accent)' }}>.</span>
      </div>

      <h1
        style={{
          fontFamily: 'var(--ht-display)',
          fontSize: 22,
          fontWeight: 600,
          margin: '18px 0 0',
        }}
      >
        Set your password
      </h1>

      <p
        style={{
          margin: '12px 0 0',
          maxWidth: 340,
          fontSize: 14.5,
          lineHeight: 1.65,
          color: 'var(--ht-ink-muted)',
        }}
      >
        Finish joining your team by choosing a password.
      </p>

      {invalidInvite ? (
        <div style={{ marginTop: 24, maxWidth: 320 }}>
          <div
            role="alert"
            aria-live="assertive"
            style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ht-critical)' }}
          >
            That invite link isn't valid or has expired.
          </div>
          <p style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ht-ink-dim)' }}>
            Ask your admin to send a new invite.
          </p>
        </div>
      ) : (
        <form
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          style={{ marginTop: 24, width: '100%', maxWidth: 280, textAlign: 'left' }}
        >
          <label
            htmlFor="ht-invite-password"
            style={{
              display: 'block',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--ht-ink-dim)',
              marginBottom: 6,
            }}
          >
            Password
          </label>
          {/* Native input, not ds/core/TextInput — see LoginScreen's module doc. */}
          <input
            id="ht-invite-password"
            name="password"
            type="password"
            autoComplete="new-password"
            // biome-ignore lint/a11y/noAutofocus: the one interactive element on a dedicated invite-accept screen.
            autoFocus
            required
            disabled={isPending}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'var(--ht-sans)',
              fontSize: 12.5,
              color: 'var(--ht-ink)',
              background: 'var(--ht-bg)',
              border: '1px solid var(--ht-divider)',
              borderRadius: 'var(--ht-radius-sm)',
              padding: '8px 10px',
              outline: 'none',
            }}
          />

          <label
            htmlFor="ht-invite-confirm"
            style={{
              display: 'block',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--ht-ink-dim)',
              margin: '14px 0 6px',
            }}
          >
            Confirm password
          </label>
          <input
            id="ht-invite-confirm"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            required
            disabled={isPending}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'var(--ht-sans)',
              fontSize: 12.5,
              color: 'var(--ht-ink)',
              background: 'var(--ht-bg)',
              border: '1px solid var(--ht-divider)',
              borderRadius: 'var(--ht-radius-sm)',
              padding: '8px 10px',
              outline: 'none',
            }}
          />

          {tooShort && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ht-ink-dim)' }}>
              Password must be at least {MIN_PASSWORD_LENGTH} characters.
            </div>
          )}
          {mismatch && (
            <div
              role="alert"
              aria-live="assertive"
              style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--ht-critical)' }}
            >
              Passwords don't match.
            </div>
          )}

          {error !== null && (
            <div
              role="alert"
              aria-live="assertive"
              style={{
                marginTop: 14,
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--ht-critical)',
              }}
            >
              {error}
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <Button
              variant="primary"
              disabled={isPending || !canSubmit}
              onClick={() => formRef.current?.requestSubmit()}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {isPending ? 'Setting password…' : 'Set password and sign in'}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
