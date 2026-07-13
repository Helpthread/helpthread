'use client'

/**
 * Full-screen auth-failure state (fidelity checklist). Rendered by
 * `AppError` when a thrown `ApiError` carries the auth-failure `error.digest`
 * (see `lib/api.ts` and `lib/auth-error.ts`). `position: fixed; inset: 0` so it covers the
 * whole viewport regardless of where in the tree it's rendered — a broken
 * service token means nothing else on the page (folder rail included) is
 * usable anyway.
 */

import { Button } from './ds/core/Button'

export function AuthFailure() {
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
        Helpthread can&rsquo;t reach your inbox
      </h1>
      <p
        style={{
          margin: '12px 0 0',
          maxWidth: 420,
          fontSize: 14.5,
          lineHeight: 1.65,
          color: 'var(--ht-ink-muted)',
        }}
      >
        Every request is signed with this deployment&rsquo;s service token, and the API just
        rejected it. There&rsquo;s nothing to sign into — this is configuration, not a login.
      </p>
      <code
        style={{
          marginTop: 18,
          fontFamily: 'var(--ht-mono)',
          fontSize: 12.5,
          color: 'var(--ht-ink)',
          background: 'var(--ht-surface-2)',
          border: '1px solid var(--ht-border)',
          borderRadius: 'var(--ht-radius-sm)',
          padding: '4px 10px',
        }}
      >
        HELPTHREAD_API_TOKEN
      </code>
      <p
        style={{
          margin: '10px 0 0',
          maxWidth: 380,
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--ht-ink-dim)',
        }}
      >
        Update the token in your deployment settings, redeploy, and reload this page.
      </p>
      <div style={{ marginTop: 20 }}>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  )
}
