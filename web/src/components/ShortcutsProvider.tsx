'use client'

/**
 * Global keyboard-shortcut wiring, mounted once in `app/layout.tsx`.
 *
 * Wired now: `?` toggles the shortcuts overlay, `Escape` closes it. The
 * overlay can also be opened imperatively — `useShortcutsOverlay()` returns
 * an `open()` function — for the top bar's "Keyboard shortcuts" menu items.
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
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { ShortcutsOverlay } from './ShortcutsOverlay'

const ShortcutsOverlayContext = createContext<(() => void) | null>(null)

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

  const openOverlay = useCallback(() => setOpen(true), [])

  return (
    <ShortcutsOverlayContext.Provider value={openOverlay}>
      {children}
      {open && <ShortcutsOverlay onClose={() => setOpen(false)} />}
    </ShortcutsOverlayContext.Provider>
  )
}

/** `const openShortcuts = useShortcutsOverlay(); <button onClick={openShortcuts}>`. */
export function useShortcutsOverlay(): () => void {
  const ctx = useContext(ShortcutsOverlayContext)
  if (ctx === null) throw new Error('useShortcutsOverlay must be used within ShortcutsProvider')
  return ctx
}
