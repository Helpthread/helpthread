import { Skeleton } from '../../../../components/ds/core/Skeleton'
import { ToolbarBand } from '../../../../components/ds/inbox/ToolbarBand'

/**
 * Conversation-view loading state — the fidelity checklist's last §5 gap.
 * Mirrors the inbox loading skeleton's approach (bare ds primitives, no real
 * data) but shaped like THIS screen's actual layout: a toolbar band, the
 * subject row, a run of message-band placeholders, and the Customer context
 * panel — so the swap from skeleton to real content doesn't jump the eye
 * around. Like `inbox/[folder]/loading.tsx`, the `(shell)` layout (folder
 * rail, top bar) stays mounted across the navigation; only this work surface
 * is replaced while the conversation fetches.
 */
function SkeletonMessageBand({ sameSpeakerAsPrev = false }: { sameSpeakerAsPrev?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '14px 18px',
        borderTop: sameSpeakerAsPrev ? '1px solid var(--ht-divider)' : 'none',
      }}
    >
      <Skeleton width={32} height={32} radius={999} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <Skeleton width={90} height={12} />
          <Skeleton width={140} height={11} />
        </div>
        <Skeleton width="85%" height={11} />
        <Skeleton width="60%" height={11} />
      </div>
    </div>
  )
}

export default function ConversationLoading() {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', minHeight: 0 }}>
      <main
        style={{
          flex: 1,
          minWidth: 0,
          background: 'var(--ht-surface)',
          boxShadow: 'var(--ht-seam-shadow, -1px 0 0 var(--ht-divider))',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <ToolbarBand />

        <div
          style={{
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Skeleton width="35%" height={19} />
          <Skeleton width={64} height={20} radius={999} />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <SkeletonMessageBand />
          <SkeletonMessageBand />
          <SkeletonMessageBand sameSpeakerAsPrev />
        </div>
      </main>

      <aside
        aria-label="Conversation details"
        style={{
          width: 240,
          flexShrink: 0,
          borderLeft: '1px solid var(--ht-divider)',
          background: 'var(--ht-surface)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <ToolbarBand tone="panel" />
        <div style={{ padding: '0 14px 16px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ marginTop: -36 }}>
            <Skeleton width={72} height={72} radius={999} />
          </div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton width="60%" height={19} />
            <Skeleton width="80%" height={11} />
          </div>
          <div
            style={{ height: 1, background: 'var(--ht-divider)', margin: '14px 0' }}
            aria-hidden="true"
          />
          <Skeleton width="70%" height={11} />
        </div>
      </aside>
    </div>
  )
}
