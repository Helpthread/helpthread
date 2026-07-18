'use client'

/**
 * The per-Agent login screen (HT-51, extended HT-54). The frozen Claude
 * Design prototype has no login screen at all — this is a NEW designed
 * surface with no prototype to match pixel-for-pixel; it borrows
 * `AuthFailure`'s fixed-full-screen, calm, no-blame register as the closest
 * sibling, but it has NOT been through TJ's design sign-off. **Flagging
 * prominently per CLAUDE.md's UI-fidelity mandate — treat these pixels as a
 * placeholder until reviewed.**
 *
 * Renders whatever `GET /auth/providers` reports (spec §6/§7): one
 * email+password form per `kind: 'credentials'` descriptor. v1 has exactly
 * one (`password`) — a marketplace module would add a `kind` this seam
 * doesn't render yet ("Sign in with …"), not built here (spec §11).
 *
 * Two deliberate departures from "compose only from `ds/**`", both because
 * the frozen design system genuinely lacks the piece needed, not because it
 * was inconvenient to use. Tracked upstream as HT-52 (add a `type` prop to
 * `TextInput`, a `type="submit"` option to `Button`) so these two workarounds
 * have an expiry path instead of becoming a permanent fork:
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
 *   Pressing Enter in either field still submits the form natively, no JS
 *   trick needed for that path.
 *
 * A third, milder instance of the same HT-52 gap: the EMAIL field does use
 * `ds/core/TextInput`, which means it cannot carry `type="email"`,
 * `name="email"`, or `autoComplete="username"` — weakening password managers'
 * username↔password pairing on this form. Same expiry path (HT-52's `type`
 * prop, plus pass-through `name`/`autoComplete`), noted so the limitation is
 * a tracked trade-off, not an oversight.
 */

import { useRef, useState, useTransition } from 'react'
import type { AuthProviderDescriptor } from '../lib/api-types'
import { loginAction } from '../lib/auth-actions'
import { Button } from './ds/core/Button'
import { TextInput } from './ds/core/TextInput'

function CredentialsForm({ provider, next }: { provider: AuthProviderDescriptor; next: string }) {
  const formRef = useRef<HTMLFormElement>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function submit(): void {
    if (isPending) return
    setError(null)
    startTransition(async () => {
      const result = await loginAction(provider.key, email, password, next)
      // A successful login redirects server-side and never returns here —
      // reaching this line means the email/password didn't match.
      if (!result.ok) {
        setError(result.message ?? "That email and password didn't match.")
      }
    })
  }

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      style={{ marginTop: 24, width: '100%', maxWidth: 280, textAlign: 'left' }}
    >
      <label
        htmlFor="ht-login-email"
        style={{
          display: 'block',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--ht-ink-dim)',
          marginBottom: 6,
        }}
      >
        Email
      </label>
      <TextInput
        id="ht-login-email"
        value={email}
        onChange={(event: { target: { value: string } }) => {
          setEmail(event.target.value)
          if (error !== null) setError(null)
        }}
        style={{ padding: '8px 10px', fontSize: 12.5 }}
      />

      <label
        htmlFor="ht-login-password"
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
      {/* Native input, not ds/core/TextInput — see the module comment above. */}
      <input
        id="ht-login-password"
        name="password"
        type="password"
        autoComplete="current-password"
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
          role="alert"
          aria-live="assertive"
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
          disabled={isPending || email.length === 0 || password.length === 0}
          onClick={() => formRef.current?.requestSubmit()}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </form>
  )
}

export function LoginScreen({
  next,
  providers,
}: {
  next: string
  providers: AuthProviderDescriptor[]
}) {
  const credentialsProviders = providers.filter((provider) => provider.kind === 'credentials')

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
        Sign in with your Agent email and password.
      </p>

      {credentialsProviders.map((provider) => (
        <CredentialsForm key={provider.key} provider={provider} next={next} />
      ))}
    </div>
  )
}
