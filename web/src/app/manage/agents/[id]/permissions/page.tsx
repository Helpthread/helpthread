import { notFound, redirect } from 'next/navigation'
import { AgentDetailShell } from '../../../../../components/AgentDetailShell'
import { AgentPermissionsScreen } from '../../../../../components/AgentPermissionsScreen'
import { ApiError, getAgent, getAgentMailboxes, getMe, listMailboxes } from '../../../../../lib/api'

/**
 * `/manage/agents/{id}/permissions` — admin-only (HT-54 fidelity
 * correction, TJ's 2026-07-18 admin-IA review; specs/auth/agents-and-
 * auth.md §6 "Mailbox access"). A non-admin viewer — even viewing their own
 * profile — is sent to the Profile section instead, same "never render an
 * engine 403 as a crash" posture the other admin-only Team pages use.
 *
 * The mailbox roster is only fetched for a non-admin target: an admin
 * target renders the implicit-access note instead of checkboxes (spec
 * §3.4), so there is nothing for the roster to back.
 */
export default async function AgentPermissionsPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const me = await getMe()
  if (me.role !== 'admin') redirect(`/manage/agents/${me.id}`)

  try {
    const agent = await getAgent(id)
    const isAdminTarget = agent.role === 'admin'
    const [mailboxes, mailboxIds] = await Promise.all([
      isAdminTarget ? Promise.resolve([]) : listMailboxes(),
      getAgentMailboxes(id),
    ])

    return (
      <AgentDetailShell agentId={id} active="permissions" viewerIsAdmin>
        <AgentPermissionsScreen
          key={agent.id}
          agent={agent}
          mailboxes={mailboxes}
          initialMailboxIds={mailboxIds}
        />
      </AgentDetailShell>
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }
}
