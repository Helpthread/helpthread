import type { ReactNode } from 'react'
import { FolderNav } from '../../components/FolderNav'

/**
 * The app shell shared by the inbox and conversation routes: the persistent
 * folder rail on the warm-paper canvas, with each screen as the elevated
 * work surface beside it (the design system's layer model).
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: 0, flex: 1 }}>
      <FolderNav />
      {children}
    </div>
  )
}
