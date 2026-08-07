import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { NewMailboxScreen } from '../../../../components/NewMailboxScreen'
import { getMe } from '../../../../lib/api'

export const metadata: Metadata = {
  title: 'New inbox — Helpthread',
}

/**
 * `/manage/mailboxes/new` — admin-only (HT-101 admin-IA correction). `POST
 * /api/v1/inbound/imap/connect` has no acting-Agent/role gate of its own
 * (`src/api/imap-connect.ts`'s module doc: an ordinary Bearer-gated route,
 * same trust level as every other admin action), but there is no reason
 * for a non-admin to see this form — sent to the mailboxes redirect,
 * same posture `/manage/agents/new` uses for Team.
 */
export default async function NewMailboxPage() {
  const me = await getMe()
  if (me.role !== 'admin') redirect('/inbox/open')

  return <NewMailboxScreen />
}
