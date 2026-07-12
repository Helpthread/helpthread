'use client'

/**
 * Full-screen auth-failure state (fidelity checklist). Rendered by
 * `AppError` when a thrown `ApiError`'s message carries the `unauthorized:`
 * prefix (see `lib/api.ts`). `position: fixed; inset: 0` so it covers the
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
      <h1 style={{ fontFamily: 'var(--ht-display)', fontSize: 22, fontWeight: 600, margin: 0 }}>
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
        The Agent Inbox API rejected the request. There&rsquo;s nothing to sign into — this is
        configuration, not a login.
      </p>
      <p style={{ margin: '18px 0 0', fontSize: 12, color: 'var(--ht-ink-dim)' }}>
        Check that this is set correctly on the server:
      </p>
      <code
        style={{
          marginTop: 6,
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
      <div style={{ marginTop: 20 }}>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  )
}
