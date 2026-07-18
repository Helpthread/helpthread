import { notFound, redirect } from 'next/navigation'
import { AgentProfileScreen } from '../../../../components/AgentProfileScreen'
import { ApiError, getAgent, getMe } from '../../../../lib/api'

/**
 * `/settings/team/{id}` — admin for anyone, self for their own (HT-54, spec
 * §6/§7). `GET /agents/{id}` is engine-enforced (admin, or self) — a
 * non-admin trying to view someone ELSE's profile is redirected to their own
 * here rather than ever reaching that 403, matching the team-list page's
 * same "never render an engine 403 as a crash" posture.
 */
export default async function AgentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const me = await getMe()
  if (me.id !== id && me.role !== 'admin') redirect(`/settings/team/${me.id}`)

  try {
    const agent = await getAgent(id)
    return <AgentProfileScreen agent={agent} viewer={me} />
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }
}
