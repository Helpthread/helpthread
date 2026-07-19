import { notFound, redirect } from 'next/navigation'
import { AgentDetailShell } from '../../../../components/AgentDetailShell'
import { AgentProfileScreen } from '../../../../components/AgentProfileScreen'
import { ApiError, getAgent, getMe } from '../../../../lib/api'

/**
 * `/manage/agents/{id}` — admin for anyone, self for their own (HT-54, spec
 * §6/§7). `GET /agents/{id}` is engine-enforced (admin, or self) — a
 * non-admin trying to view someone ELSE's profile is redirected to their own
 * here rather than ever reaching that 403, matching the team-list page's
 * same "never render an engine 403 as a crash" posture.
 *
 * Moved off `/settings/team/{id}` per TJ's 2026-07-18 admin-IA fidelity
 * review (HT-54): Team management is `Manage ▾`-scoped, not a Settings
 * subpage. Renders inside `AgentDetailShell` as the "Profile" section.
 */
export default async function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await getMe()
  if (me.id !== id && me.role !== 'admin') redirect(`/manage/agents/${me.id}`)

  try {
    const agent = await getAgent(id)
    return (
      <AgentDetailShell agentId={id} active="profile" viewerIsAdmin={me.role === 'admin'}>
        {/* Keyed by the Agent id: the client component seeds its form state
            from `agent` on mount only, so a same-route navigation (Agent A →
            Agent B) must remount rather than reuse A's state against B's id. */}
        <AgentProfileScreen key={agent.id} agent={agent} viewer={me} />
      </AgentDetailShell>
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }
}
