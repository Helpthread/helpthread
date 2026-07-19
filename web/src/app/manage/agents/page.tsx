import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { TeamListScreen } from '../../../components/TeamListScreen'
import { getMe, listAgents } from '../../../lib/api'

export const metadata: Metadata = {
  title: 'Team — Helpthread',
}

/**
 * `/manage/agents` — admin-only UI (HT-54, spec §7); the engine enforces
 * the mutations regardless, but `GET /agents` itself is open to any active
 * Agent (the assignee UI's roster — see `src/api/agents.ts`'s module doc),
 * so a non-admin CAN fetch this list without a 403. The UI-level choice
 * (brief's "pick the simpler" of two options): a non-admin visiting here is
 * sent to their own profile instead of a list they have no reason to browse
 * — never an engine 403 rendered as a crash.
 *
 * Moved off `/settings/team` per TJ's 2026-07-18 admin-IA fidelity review
 * (HT-54): Team management is `Manage ▾`-scoped, not a Settings subpage —
 * the avatar menu carries personal-scope items only (Your Profile, Log out).
 */
export default async function TeamListPage() {
  const me = await getMe()
  if (me.role !== 'admin') redirect(`/manage/agents/${me.id}`)

  const agents = await listAgents()
  return <TeamListScreen agents={agents} />
}
