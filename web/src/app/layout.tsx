import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../theme/helpthread.css'
import { ShortcutsProvider } from '../components/ShortcutsProvider'
import { ThemeProvider } from '../components/ThemeProvider'
import { ToasterProvider } from '../components/Toaster'
import { THEME_INIT_SCRIPT } from '../lib/theme'

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
    // suppressHydrationWarning: the inline script below sets `data-theme` on
    // this element BEFORE React hydrates (that's the whole point — it avoids
    // a flash of the wrong theme), so the attribute React sees during
    // hydration legitimately differs from what it server-rendered. This is
    // the standard fix for this exact pattern (see e.g. next-themes); it
    // only suppresses the warning for this one element's own attributes; it
    // has no effect on children.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: pre-hydration
            theme apply, must run standalone before any bundle loads — see
            lib/theme.ts */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
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
        <ThemeProvider>
          <ToasterProvider>
            <ShortcutsProvider>
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
            </ShortcutsProvider>
          </ToasterProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
