import { Skeleton } from '../../../../components/ds/core/Skeleton'
import { ToolbarBand } from '../../../../components/ds/inbox/ToolbarBand'

/**
 * Inbox list loading state. The `(shell)` layout stays mounted across the
 * navigation (folder rail, top bar unaffected) — only this work surface
 * swaps in while the folder's conversations fetch.
 */
function SkeletonRow() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '9px 14px',
        borderBottom: '1px solid var(--ht-divider)',
      }}
    >
      <Skeleton width={32} height={32} radius={999} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Skeleton width="35%" height={12} />
        <Skeleton width="65%" height={11} />
      </div>
    </div>
  )
}

export default function InboxLoading() {
  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--ht-surface)',
        boxShadow: 'var(--ht-seam-shadow, -1px 0 0 var(--ht-divider))',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ToolbarBand />
      <div>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </main>
  )
}
