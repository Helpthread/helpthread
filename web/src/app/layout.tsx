import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../theme/helpthread.css'

export const metadata: Metadata = {
  title: 'Helpthread',
  description: 'Helpthread Agent Inbox',
}

/**
 * The app shell: the accent-filled top bar — the design system's ONE colored
 * surface — carrying the wordmark (plain text, serif, muted dot; there is no
 * logo), over the warm-paper canvas everything else sits on.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: 'var(--ht-bg)',
          color: 'var(--ht-ink)',
          font: '14px/1.5 var(--ht-sans, system-ui, sans-serif)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: '100vh',
        }}
      >
        <header
          style={{
            background: 'var(--ht-header-bg)',
            color: 'var(--ht-header-fg)',
            padding: '10px 18px',
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
          }}
        >
          <span
            style={{
              fontFamily: "var(--ht-serif, 'Source Serif 4', serif)",
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: '0.01em',
            }}
          >
            helpthread<span style={{ opacity: 0.55 }}>.</span>
          </span>
        </header>
        {children}
      </body>
    </html>
  )
}
