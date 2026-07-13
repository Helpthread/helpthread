import Link from 'next/link'
import { EmptyState } from '../components/ds/core/EmptyState'

/**
 * Global 404 (fidelity checklist). Root-level so it also catches an
 * unmatched route; a `notFound()` thrown inside `(shell)` (e.g. an unknown
 * folder) bubbles up here too, since that segment has no not-found of its
 * own — which also means the folder rail doesn't render alongside it.
 */
export default function NotFound() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <EmptyState
          title="Nothing at this address."
          body="This conversation doesn't exist — it may have been removed, or the link is wrong."
        />
        <Link href="/inbox/open" style={{ fontSize: 13, color: 'var(--ht-accent)' }}>
          Back to inbox
        </Link>
      </div>
    </div>
  )
}
