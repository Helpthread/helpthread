'use client'

/**
 * The left sidebar for an Agent's detail area (`/manage/agents/{id}/**`) —
 * HT-54 fidelity correction, TJ's 2026-07-18 admin-IA review (the
 * three-scope rule: Team management is `Manage ▾`-scoped, never the avatar
 * menu). Sections: **Profile** (always) and **Permissions** (admin-only —
 * a non-admin viewer, on their own profile, never sees it). Replaces the
 * old bare "← Team" back-link: the back affordance now lives at the top of
 * this sidebar, in the same FolderNav-style rail the rest of the app uses,
 * rather than a lone text link floating above the content.
 */

import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'
import { FolderItem } from './ds/inbox/FolderItem'

function ProfileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 12c2.7 0 4.9-2.2 4.9-4.9S14.7 2.2 12 2.2 7.1 4.4 7.1 7.1 9.3 12 12 12zm0 2.4c-3.3 0-9.8 1.6-9.8 4.9v2.5h19.6v-2.5c0-3.3-6.5-4.9-9.8-4.9z"
      />
    </svg>
  )
}

function PermissionsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2 4 5v6c0 5.1 3.4 9.7 8 11 4.6-1.3 8-5.9 8-11V5l-8-3zm0 9.99h6c-.5 3.6-2.9 6.8-6 7.9V12H6V6.3l6-2.3v7.99z"
      />
    </svg>
  )
}

export function AgentDetailShell({
  agentId,
  active,
  viewerIsAdmin,
  children,
}: {
  agentId: string
  active: 'profile' | 'permissions'
  /** Gates BOTH the "← Team" back link and the Permissions section — a
   *  non-admin has no Team list to return to and no Permissions to manage. */
  viewerIsAdmin: boolean
  children: ReactNode
}) {
  const router = useRouter()

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 24, display: 'flex', gap: 28 }}>
      <div style={{ width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {viewerIsAdmin && (
          <button
            type="button"
            onClick={() => router.push('/manage/agents')}
            style={{
              alignSelf: 'flex-start',
              border: 'none',
              background: 'none',
              padding: '0 0 4px',
              fontSize: 13,
              color: 'var(--ht-ink-muted)',
              cursor: 'pointer',
            }}
          >
            ← Team
          </button>
        )}
        <nav aria-label="Agent" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <FolderItem
            icon={<ProfileIcon />}
            label="Profile"
            active={active === 'profile'}
            hasItems
            onClick={() => router.push(`/manage/agents/${agentId}`)}
          />
          {viewerIsAdmin && (
            <FolderItem
              icon={<PermissionsIcon />}
              label="Permissions"
              active={active === 'permissions'}
              hasItems
              onClick={() => router.push(`/manage/agents/${agentId}/permissions`)}
            />
          )}
        </nav>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </main>
  )
}
