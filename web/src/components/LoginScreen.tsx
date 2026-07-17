'use client'

/**
 * The operator login screen (HT-51). The frozen Claude Design prototype has
 * no login screen at all — the pre-HT-51 API posture was "no login, just a
 * deployment-held Bearer token" (see the `agent-inbox-v1.md` §3/§5 amendment
 * landing in the same commit as this file). This is therefore a NEW designed
 * surface with no prototype to match pixel-for-pixel; it borrows `AuthFailure`'s
 * fixed-full-screen, calm, no-blame register as the closest sibling, but it
 * has NOT been through TJ's design sign-off. **Flagging prominently per
 * CLAUDE.md's UI-fidelity mandate — treat these pixels as a placeholder until
 * reviewed.**
 *
 * Two deliberate departures from "compose only from `ds/**`", both because
 * the frozen design system genuinely lacks the piece needed, not because it
 * was inconvenient to use:
 *
 * - The password field is a native `<input type="password">`, not
 *   `ds/core/TextInput` — that component hardcodes `type="text"` (see its
 *   `.jsx`) with no prop to ask for anything else. Styled inline with the
 *   same tokens `TextInput` uses, so it reads as the same input, just able to
 *   mask what's typed and offer `autoComplete="current-password"`.
 * - The submit control IS `ds/core/Button`, but `Button` hardcodes
 *   `type="button"` — there's no `type="submit"` escape hatch — so clicking
 *   it calls `formRef.current?.requestSubmit()` to submit the surrounding
 *   `<form>` via JS instead of relying on native submit-button semantics.
 *   Pressing Enter in the password field still submits the form natively,
 *   no JS trick needed for that path.
 */

import { useRef, useState, useTransition } from 'react'
import { loginAction } from '../lib/auth-actions'
import { Button } from './ds/core/Button'

export function LoginScreen({ next }: { next: string }) {
  const formRef = useRef<HTMLFormElement>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function submit(): void {
    if (isPending) return
    setError(null)
    startTransition(async () => {
      const result = await loginAction(password, next)
      // A successful login redirects server-side and never returns here —
      // reaching this line means the password didn't match.
      if (!result.ok) {
        setError(result.message ?? "That password didn't match.")
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
        Sign in to your inbox
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
        This deployment has one operator password — there's no separate account to create.
      </p>

      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        style={{ marginTop: 24, width: '100%', maxWidth: 280, textAlign: 'left' }}
      >
        <label
          htmlFor="ht-login-password"
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
        {/* Native input, not ds/core/TextInput — see the module comment above. */}
        <input
          id="ht-login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          // biome-ignore lint/a11y/noAutofocus: the one interactive element on a dedicated login screen.
          autoFocus
          required
          disabled={isPending}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
            if (error !== null) setError(null)
          }}
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

        {error !== null && (
          <div
            style={{
              marginTop: 8,
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
            disabled={isPending || password.length === 0}
            onClick={() => formRef.current?.requestSubmit()}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>
      </form>
    </div>
  )
}
