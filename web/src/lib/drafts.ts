'use client'

/**
 * Draft state — READ-ONLY here. `localStorage['helpthread.drafts']` is a
 * JSON map of conversationId → text; the reply composer (a later increment)
 * is the only writer. This hook exists so the Drafts folder can derive its
 * membership without a backend affordance (fidelity checklist); an absent
 * or empty map is a valid, expected state today.
 */

import { useEffect, useState } from 'react'

const STORAGE_KEY = 'helpthread.drafts'

function readDrafts(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

export function useDrafts(): Record<string, string> {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  useEffect(() => setDrafts(readDrafts()), [])
  return drafts
}
