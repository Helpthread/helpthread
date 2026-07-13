'use client'

/**
 * Top-level route error boundary — the fallback for any route NOT inside a
 * more specific boundary (notably `/dashboard`, which lives outside the
 * `(shell)` group). Routes a 401 (the `unauthorized:` prefix) to the designed
 * AuthFailure screen, like the segment boundaries do. It does NOT catch errors
 * thrown by the ROOT LAYOUT itself (only a global-error boundary can) — but the
 * layout is now resilient (its one fetch is swallowed on failure), so nothing
 * there throws, and the errors that reach here come from page components.
 */

import { AppError } from '../components/AppError'

export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <AppError {...props} />
}
