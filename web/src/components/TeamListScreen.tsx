'use client'

/**
 * `/manage/agents` — the Agent roster (HT-54; specs/auth/agents-and-auth.md
 * §7): FreeScout-modelled cards (avatar-or-initials, name, email, a role
 * chip), a "New Agent" action, and a client-side search filter. Admin-only
 * UI (the engine enforces the actual mutations anyway); a non-admin never
 * reaches this screen — `app/manage/agents/page.tsx` sends them to their own
 * profile instead (the simpler of the brief's two options). **NEW designed
 * surface — requires TJ fidelity sign-off.**
 *
 * Moved off `/settings/team` per TJ's 2026-07-18 admin-IA fidelity review
 * (HT-54): Team is `Manage ▾`-scoped, not a Settings subpage, so the back
 * link now returns to the Inbox rather than to Settings — the same
 * top-level-peer back affordance `SettingsScreen` itself uses.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { Agent } from '../lib/api-types'
import { initialsFromName } from '../lib/format'
import { Avatar } from './ds/core/Avatar'
import { Button } from './ds/core/Button'
import { EmptyState } from './ds/core/EmptyState'
import { StatusPill } from './ds/core/StatusPill'
import { TextInput } from './ds/core/TextInput'

function statusBadge(status: Agent['status']) {
  if (status === 'invited') return <StatusPill status="pending" label="Invited" />
  if (status === 'disabled') return <StatusPill status="closed" label="Disabled" />
  return null
}

export function TeamListScreen({ agents }: { agents: Agent[] }) {
  const router = useRouter()
  const [query, setQuery] = useState('')

  const normalizedQuery = query.trim().toLowerCase()
  const visible =
    normalizedQuery.length === 0
      ? agents
      : agents.filter(
          (agent) =>
            agent.name.toLowerCase().includes(normalizedQuery) ||
            agent.email.toLowerCase().includes(normalizedQuery),
        )

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Link
          href="/inbox/open"
          style={{ fontSize: 13, color: 'var(--ht-ink-muted)', textDecoration: 'none' }}
        >
          ← Inbox
        </Link>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Team</h1>
          <span style={{ flex: 1 }} />
          <div style={{ width: 220 }}>
            <TextInput
              value={query}
              onChange={(event: { target: { value: string } }) => setQuery(event.target.value)}
              placeholder="Search Agents…"
            />
          </div>
          <Button variant="primary" onClick={() => router.push('/manage/agents/new')}>
            New Agent
          </Button>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title={agents.length === 0 ? 'No Agents yet' : 'No matches'}
            body={
              agents.length === 0
                ? 'Invite your first teammate to get started.'
                : 'Try a different name or email.'
            }
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {visible.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => router.push(`/manage/agents/${agent.id}`)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  boxSizing: 'border-box',
                  textAlign: 'left',
                  border: '1px solid var(--ht-border)',
                  background: 'var(--ht-surface)',
                  borderRadius: 'var(--ht-radius-lg, 8px)',
                  padding: '12px 14px',
                  cursor: 'pointer',
                }}
              >
                <Avatar email={agent.email} initials={initialsFromName(agent.name)} size={36} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ht-ink)' }}>
                    {agent.name}
                  </div>
                  <div
                    style={{
                      marginTop: 1,
                      fontSize: 12,
                      color: 'var(--ht-ink-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {agent.email}
                  </div>
                </div>
                {/* `status="role"` deliberately doesn't match a StatusPill META key — this
                    is a role chip, not a lifecycle pill, so it falls back to the
                    component's own neutral styling with our label (its designed
                    fallback for an unrecognized status, not a hack). */}
                <StatusPill status="role" label={agent.role === 'admin' ? 'Admin' : 'Agent'} />
                {statusBadge(agent.status)}
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
