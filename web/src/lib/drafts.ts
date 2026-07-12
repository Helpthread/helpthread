'use client'

/**
 * Draft state — `localStorage['helpthread.drafts']` is a JSON map of
 * conversationId → plain-text reply draft. `useDrafts` (read) backs the
 * Drafts folder's membership; `getDraft` / `writeDraft` / `clearDraft`
 * (write) are used by the conversation screen's summoned reply composer —
 * the only writer. Reply drafts only: internal notes are never persisted
 * here.
 */

import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'helpthread.drafts'
const CHANGE_EVENT = 'helpthread:drafts-changed'

function readDraftsMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

/** The saved draft for one conversation, or `null` if none is saved. */
export function getDraft(conversationId: string): string | null {
  return readDraftsMap()[conversationId] ?? null
}

/** Save the draft for one conversation; empty text removes it. */
export function writeDraft(conversationId: string, text: string): void {
  if (typeof window === 'undefined') return
  const map = readDraftsMap()
  if (text.length === 0) {
    delete map[conversationId]
  } else {
    map[conversationId] = text
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** Remove a conversation's draft outright (e.g. after a successful send). */
export function clearDraft(conversationId: string): void {
  writeDraft(conversationId, '')
}

export function useDrafts(): Record<string, string> {
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const refresh = useCallback(() => setDrafts(readDraftsMap()), [])

  // Same cross-instance sync as `useStarred`: a `storage` event only fires
  // in OTHER tabs, so a custom event closes the gap for the tab that wrote.
  useEffect(() => {
    refresh()
    window.addEventListener(CHANGE_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [refresh])

  return drafts
}
