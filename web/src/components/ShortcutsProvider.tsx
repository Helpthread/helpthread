'use client'

/**
 * Global keyboard-shortcut wiring, mounted once in `app/layout.tsx`.
 *
 * `?` toggles the shortcuts overlay, `Escape` closes it. The overlay can
 * also be opened imperatively — `useShortcutsOverlay().open()` — for the
 * top bar's "Keyboard shortcuts" menu item.
 *
 * `isOpen` is exposed too: the inbox and conversation screens run their OWN
 * key handling (j/k, r/n, ⌘+↵, a cascading Escape — see `InboxScreen` and
 * `ConversationScreen`), and this Escape listener doesn't stop propagation,
 * so a screen's own handler would otherwise ALSO react to the same Escape
 * press that closes the overlay. Screens check `isOpen` first and skip
 * their own handling while the overlay is open.
 */

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { ShortcutsOverlay } from './ShortcutsOverlay'

interface ShortcutsOverlayContextValue {
  open: () => void
  isOpen: boolean
}

const ShortcutsOverlayContext = createContext<ShortcutsOverlayContextValue | null>(null)

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
  const value = useMemo(() => ({ open: openOverlay, isOpen: open }), [openOverlay, open])

  return (
    <ShortcutsOverlayContext.Provider value={value}>
      {children}
      {open && <ShortcutsOverlay onClose={() => setOpen(false)} />}
    </ShortcutsOverlayContext.Provider>
  )
}

/** `const { open, isOpen } = useShortcutsOverlay()`. */
export function useShortcutsOverlay(): ShortcutsOverlayContextValue {
  const ctx = useContext(ShortcutsOverlayContext)
  if (ctx === null) throw new Error('useShortcutsOverlay must be used within ShortcutsProvider')
  return ctx
}
