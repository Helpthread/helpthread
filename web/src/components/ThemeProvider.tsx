'use client'

/**
 * Theme state — 'light' | 'dark' | 'system' — persisted in
 * `localStorage[THEME_STORAGE_KEY]`. The DOM attribute is set synchronously
 * pre-hydration by the inline script in `app/layout.tsx` (see
 * `lib/theme.ts`'s `THEME_INIT_SCRIPT`, which avoids a flash of the wrong
 * theme); this provider only reads the saved choice AFTER mount — never
 * during the initial render — so the server-rendered HTML and the client's
 * first render always agree (no hydration mismatch), then keeps the
 * attribute in sync afterward, including 'system' tracking
 * `prefers-color-scheme` live.
 */

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { resolveIsDark, THEME_STORAGE_KEY, type Theme } from '../lib/theme'

export type { Theme }

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (resolveIsDark(theme)) {
    root.setAttribute('data-theme', 'dark')
  } else {
    root.removeAttribute('data-theme')
  }
}

const ThemeContext = createContext<{ theme: Theme; setTheme: (next: Theme) => void } | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system')

  // Adopt the persisted choice once mounted (see the hydration note above).
  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      setThemeState(stored)
    }
  }, [])

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = () => applyTheme('system')
    mql.addEventListener('change', listener)
    return () => mql.removeEventListener('change', listener)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  }, [])

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme(): { theme: Theme; setTheme: (next: Theme) => void } {
  const ctx = useContext(ThemeContext)
  if (ctx === null) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
