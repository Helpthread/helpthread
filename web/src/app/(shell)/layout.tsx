import type { ReactNode } from 'react'
import { FolderNav } from '../../components/FolderNav'
import { getMe } from '../../lib/api'
import { loadFolderCounts } from '../../lib/folder-counts'

/**
 * The app shell shared by the inbox and conversation routes: the persistent
 * folder rail on the warm-paper canvas, with each screen as the elevated
 * work surface beside it (the design system's layer model). The rail's
 * counts and support address are fetched here (server-side, with the
 * Bearer token) and handed to the client `FolderNav` as props. `getMe()`
 * resolves "Mine" (HT-54: a real Agent id, not the old `'me'` sentinel) — a
 * 401 here (a stale/disabled Agent's still-valid cookie) propagates to the
 * nearest error boundary ABOVE this segment (`app/error.tsx` — a segment's
 * own `error.tsx` never catches its own layout's errors), which routes the
 * SESSION_ERROR digest to a re-login redirect, exactly as intended.
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const me = await getMe()
  const counts = await loadFolderCounts(me.id)
  const supportAddress = process.env.HELPTHREAD_SUPPORT_ADDRESS ?? 'support@dev.localhost'

  return (
    <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
      <FolderNav supportAddress={supportAddress} counts={counts} />
      {children}
    </div>
  )
}
