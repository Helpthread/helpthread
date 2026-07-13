'use client'

/**
 * Star state — client-only, no backend affordance yet (fidelity checklist).
 * Persisted as a plain id array in `localStorage['helpthread.starred']`.
 * The conversation-view toolbar star is a LATER increment; this module and
 * `useStarred` are wired into the inbox row's star toggle only.
 *
 * Two independent components read this in the same tab at once — the folder
 * rail's count and the inbox row's toggle — and the browser's `storage`
 * event only fires in OTHER tabs, not the one that made the write. A custom
 * event closes that gap so both instances stay in sync without a shared
 * store.
 */

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'helpthread.starred'
const CHANGE_EVENT = 'helpthread:starred-changed'

function readStarred(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function writeStarred(ids: string[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function useStarred(): {
  starredIds: string[]
  isStarred: (id: string) => boolean
  toggle: (id: string) => void
} {
  const [starredIds, setStarredIds] = useState<string[]>([])

  // Adopt the persisted list once mounted — same hydration-safety pattern as
  // `ThemeProvider`: server render and first client render must agree — then
  // stay synced with writes from any other mounted instance of this hook.
  useEffect(() => {
    setStarredIds(readStarred())
    function onChange(): void {
      setStarredIds(readStarred())
    }
    window.addEventListener(CHANGE_EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  const toggle = useCallback((id: string) => {
    const current = readStarred()
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
    writeStarred(next)
  }, [])

  const isStarred = useCallback((id: string) => starredIds.includes(id), [starredIds])

  return { starredIds, isStarred, toggle }
}
