'use client'

/**
 * `/manage/mailboxes/new` — connect a new inbox (HT-101 admin-IA
 * correction; specs/ui/admin-ia.md §1). Thin chrome (back link + heading)
 * around the existing `ConnectInboxForm`, mirroring `NewAgentScreen`'s
 * shape for `/manage/agents/new` — the form's own internals are unchanged,
 * only its home moved here from the old `SettingsScreen` "Inboxes" section.
 */

import { useRouter } from 'next/navigation'
import { ConnectInboxForm } from './ConnectInboxForm'

export function NewMailboxScreen() {
  const router = useRouter()

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
      <div style={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <button
          type="button"
          onClick={() => router.push('/manage/mailboxes')}
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'none',
            padding: 0,
            fontSize: 13,
            color: 'var(--ht-ink-muted)',
            cursor: 'pointer',
          }}
        >
          ← Mailboxes
        </button>

        <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>New inbox</h1>

        <ConnectInboxForm
          onConnected={() => router.push('/manage/mailboxes')}
          onCancel={() => router.push('/manage/mailboxes')}
        />
      </div>
    </main>
  )
}
