import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import '../theme/helpthread.css'
import { ShortcutsProvider } from '../components/ShortcutsProvider'
import { ThemeProvider } from '../components/ThemeProvider'
import { ToasterProvider } from '../components/Toaster'
import { TopBar } from '../components/TopBar'
import { getMe, listConversations } from '../lib/api'
import type { ConversationSummary, SelfAgent } from '../lib/api-types'
import { THEME_INIT_SCRIPT } from '../lib/theme'

export const metadata: Metadata = {
  title: 'Helpthread',
  description: 'Helpthread Agent Inbox',
}

/**
 * The app shell: the accent-filled top bar — the design system's ONE colored
 * surface — carrying the wordmark (plain text, serif, muted dot; there is no
 * logo) and the Mailbox/Manage/Notifications/Agent menus (`TopBar`), over the
 * warm-paper canvas everything else sits on. Stays a server component: the
 * Notifications panel's data (6 most recent open conversations) is fetched
 * here, with the Bearer token, and handed to the client `TopBar` as props.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  // The notifications bell is non-critical chrome. Its fetch MUST NOT be able
  // to take down the whole app: an error thrown here (e.g. a bad token
  // surfacing as 401) would escape ABOVE every route error boundary — the
  // boundaries live under this layout — so the designed AuthFailure screen
  // would never render and the app would hard-crash instead. Swallowing it to
  // an empty bell lets the SAME 401 resurface from the page-level fetch, which
  // the route error boundaries DO catch and route to AuthFailure.
  let recentOpen: ConversationSummary[] = []
  try {
    recentOpen = (await listConversations({ folder: 'open', limit: 6 })).conversations
  } catch {
    // Empty bell; the real error surfaces (and is handled) at the page level.
  }

  // Same defensive posture as the notifications fetch above, same reason:
  // this layout has no boundary above it, so a thrown 401 here (there's no
  // session at all on `/login`/`/setup`/`/invite/{token}`, or a stale one
  // elsewhere) would hard-crash the whole app instead of letting the PAGE's
  // own boundary handle it. `null` just means the avatar menu shows no name
  // — harmless on the public routes, and momentary elsewhere.
  let me: SelfAgent | null = null
  try {
    me = await getMe()
  } catch {
    // Anonymous avatar; the real 401 surfaces (and is handled) at the page level.
  }

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
              <TopBar recentOpen={recentOpen} me={me} />
              {children}
            </ShortcutsProvider>
          </ToasterProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
