/**
 * Theme state shape and the pre-hydration init script — a plain module (no
 * 'use client', no React) so it can be imported by both the server-rendered
 * root layout (for the inline `<script>`) and the client `ThemeProvider`
 * without crossing a server/client boundary.
 */

export type Theme = 'light' | 'dark' | 'system'

export const THEME_STORAGE_KEY = 'helpthread.theme'

/** Resolves 'system' against the live OS preference; 'light'/'dark' pass through. */
export function resolveIsDark(theme: Theme): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Runs before hydration (see `app/layout.tsx`'s inline `<script>`) so the
 * correct theme is on `<html>` before the first paint — otherwise a
 * dark-mode user sees a flash of the light theme while React boots. Kept as
 * a self-contained string (it must run standalone, before any bundle
 * loads); mirrors `ThemeProvider`'s `applyTheme`, so change both together.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var t=localStorage.getItem(k);if(t!=='light'&&t!=='dark'&&t!=='system')t='system';var dark=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(dark)document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();`
