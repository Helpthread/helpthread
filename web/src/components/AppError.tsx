'use client'

/**
 * Shared body for the route error boundaries (`app/error.tsx`,
 * `app/(shell)/error.tsx`, `app/settings/error.tsx`). A 401 from `lib/api.ts`
 * is tagged with one of two digests (HT-54; `lib/auth-error.ts`'s module
 * doc) — the channel that survives Next.js's production sanitization of
 * Server Component errors (which strips `message`):
 *
 * - {@link AUTH_ERROR_DIGEST} (or the dev-only `unauthorized:` message
 *   prefix fallback) — the deployment's own service token is bad. Renders
 *   `AuthFailure`.
 * - {@link SESSION_ERROR_DIGEST} — the Agent's session is stale (disabled/
 *   deleted, or otherwise invalid). Renders `SessionExpired`, which signs
 *   out (clearing the cookie via the existing `logoutAction`) and lands back
 *   on `/login` — this is "sign in again," not a deployment problem.
 */

import { useEffect } from 'react'
import { logoutAction } from '../lib/auth-actions'
import { AUTH_ERROR_DIGEST, SESSION_ERROR_DIGEST } from '../lib/auth-error'
import { AuthFailure } from './AuthFailure'
import { Button } from './ds/core/Button'

/** Calm full-screen "signing you out" state — fires `logoutAction` once on mount, which clears the cookie and redirects to `/login` server-side. */
function SessionExpired() {
  useEffect(() => {
    void logoutAction()
  }, [])

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
      <p
        style={{
          margin: '18px 0 0',
          fontSize: 14.5,
          color: 'var(--ht-ink-muted)',
        }}
      >
        Your session has expired. Signing you out…
      </p>
    </div>
  )
}

export function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  if (error.digest === SESSION_ERROR_DIGEST) {
    return <SessionExpired />
  }

  if (error.digest === AUTH_ERROR_DIGEST || error.message.startsWith('unauthorized:')) {
    return <AuthFailure />
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: '50vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          textAlign: 'center',
          background: 'var(--ht-surface)',
          border: '1px solid var(--ht-border)',
          borderRadius: 'var(--ht-radius-lg, 8px)',
          padding: 24,
          maxWidth: 360,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700 }}>The inbox couldn't load.</div>
        <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--ht-ink-dim)' }}>
          {error.message}
        </div>
        <div style={{ marginTop: 16 }}>
          <Button variant="outline" onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  )
}
