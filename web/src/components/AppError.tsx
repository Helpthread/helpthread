'use client'

/**
 * Shared body for the route error boundaries (`app/(shell)/error.tsx`,
 * `app/settings/error.tsx`). A 401 from `lib/api.ts` carries the
 * `unauthorized:` prefix on `error.message` — the one detail that survives
 * from a server-thrown error to a client error boundary — which is what
 * selects the AuthFailure screen instead of the generic fallback below.
 */

import { AuthFailure } from './AuthFailure'
import { Button } from './ds/core/Button'

export function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  if (error.message.startsWith('unauthorized:')) {
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
