'use client'

/**
 * `/setup` — first-run bootstrap (HT-54; specs/auth/agents-and-auth.md §6,
 * §7): creates the deployment's first admin. Public, zero-Agents-guarded —
 * the page component redirects to `/login` once `needsSetup` is false. **NEW
 * designed surface — requires TJ fidelity sign-off** (same gate as the HT-51
 * login screen this borrows its register from; see `LoginScreen`'s module
 * doc for the two documented `ds/` workarounds this screen reuses verbatim
 * rather than inventing new ones).
 */

import { useRef, useState, useTransition } from 'react'
import { setupAction } from '../lib/auth-actions'
import { Button } from './ds/core/Button'
import { TextInput } from './ds/core/TextInput'

const MIN_PASSWORD_LENGTH = 8

export function SetupScreen() {
  const formRef = useRef<HTMLFormElement>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const mismatch = confirm.length > 0 && password !== confirm
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH
  const canSubmit =
    name.trim().length > 0 &&
    email.length > 0 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password === confirm

  function submit(): void {
    if (isPending || !canSubmit) return
    setError(null)
    startTransition(async () => {
      const result = await setupAction(name.trim(), email, password)
      // A successful setup redirects server-side and never returns here.
      if (!result.ok) {
        setError(result.message ?? 'Could not complete setup. Please try again.')
      }
    })
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        background: 'var(--ht-bg)',
        color: 'var(--ht-ink)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: 24,
        overflowY: 'auto',
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
        Set up your team
      </h1>

      <p
        style={{
          margin: '12px 0 0',
          maxWidth: 360,
          fontSize: 14.5,
          lineHeight: 1.65,
          color: 'var(--ht-ink-muted)',
        }}
      >
        Create the first Admin account. You can invite the rest of your team afterward.
      </p>

      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        style={{ marginTop: 24, width: '100%', maxWidth: 300, textAlign: 'left' }}
      >
        <label
          htmlFor="ht-setup-name"
          style={{
            display: 'block',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--ht-ink-dim)',
            marginBottom: 6,
          }}
        >
          Name
        </label>
        <TextInput
          id="ht-setup-name"
          value={name}
          onChange={(event: { target: { value: string } }) => setName(event.target.value)}
          style={{ padding: '8px 10px', fontSize: 12.5 }}
        />

        <label
          htmlFor="ht-setup-email"
          style={{
            display: 'block',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--ht-ink-dim)',
            margin: '14px 0 6px',
          }}
        >
          Email
        </label>
        <TextInput
          id="ht-setup-email"
          value={email}
          onChange={(event: { target: { value: string } }) => setEmail(event.target.value)}
          style={{ padding: '8px 10px', fontSize: 12.5 }}
        />

        <label
          htmlFor="ht-setup-password"
          style={{
            display: 'block',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--ht-ink-dim)',
            margin: '14px 0 6px',
          }}
        >
          Password
        </label>
        {/* Native input, not ds/core/TextInput — see LoginScreen's module doc. */}
        <input
          id="ht-setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
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
          htmlFor="ht-setup-confirm"
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
          id="ht-setup-confirm"
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
            style={{ marginTop: 8, fontSize: 12.5, fontWeight: 600, color: 'var(--ht-critical)' }}
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
            {isPending ? 'Setting up…' : 'Create admin account'}
          </Button>
        </div>
      </form>
    </div>
  )
}
