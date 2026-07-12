'use client'

/**
 * Global keyboard-shortcut wiring, mounted once in `app/layout.tsx`.
 *
 * Wired now: `?` toggles the shortcuts overlay, `Escape` closes it.
 *
 * NOT wired yet (LATER increment — needs selection/focus state in the inbox
 * and conversation screens to act on, which doesn't exist yet):
 *   - j / k  — move through the inbox
 *   - ↵      — open the focused conversation
 *   - x      — select a conversation
 *   - r      — reply
 *   - n      — add a note
 *   - ⌘+↵    — send
 * See `ShortcutsOverlay` for the full listing shown to the user.
 */

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { ShortcutsOverlay } from './ShortcutsOverlay'

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false)
        return
      }

      if (event.key !== '?') return

      const target = event.target as HTMLElement | null
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) return

      event.preventDefault()
      setOpen((current) => !current)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      {children}
      {open && <ShortcutsOverlay onClose={() => setOpen(false)} />}
    </>
  )
}
