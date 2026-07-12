import type { ReactNode } from 'react'
import { FolderNav } from '../../components/FolderNav'
import { loadFolderCounts } from '../../lib/folder-counts'

/**
 * The app shell shared by the inbox and conversation routes: the persistent
 * folder rail on the warm-paper canvas, with each screen as the elevated
 * work surface beside it (the design system's layer model). The rail's
 * counts and support address are fetched here (server-side, with the
 * Bearer token) and handed to the client `FolderNav` as props.
 */
export default async function ShellLayout({ children }: { children: ReactNode }) {
  const counts = await loadFolderCounts()
  const supportAddress = process.env.HELPTHREAD_SUPPORT_ADDRESS ?? 'support@dev.localhost'

  return (
    <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
      <FolderNav supportAddress={supportAddress} counts={counts} />
      {children}
    </div>
  )
}
