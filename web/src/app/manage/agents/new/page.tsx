import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { NewAgentScreen } from '../../../../components/NewAgentScreen'
import { getMe } from '../../../../lib/api'

export const metadata: Metadata = {
  title: 'New Agent — Helpthread',
}

/**
 * `/manage/agents/new` — admin-only (HT-54, spec §7). `POST /agents` itself
 * is engine-enforced admin-only (403 for anyone else), but there is no
 * useful reason for a non-admin to see this form at all — sent to the team
 * redirect (their own profile) instead, same UI-level posture as the team
 * list page.
 *
 * Moved off `/settings/team/new` per TJ's 2026-07-18 admin-IA fidelity
 * review (HT-54) — see `manage/agents/page.tsx`'s doc comment.
 */
export default async function NewAgentPage() {
  const me = await getMe()
  if (me.role !== 'admin') redirect(`/manage/agents/${me.id}`)

  return <NewAgentScreen />
}
