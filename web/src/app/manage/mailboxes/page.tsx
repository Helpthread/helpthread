import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { MailboxListScreen } from '../../../components/MailboxListScreen'
import { getMe, listMailboxes } from '../../../lib/api'

export const metadata: Metadata = {
  title: 'Mailboxes — Helpthread',
}

/**
 * `/manage/mailboxes` — admin-only UI (HT-101 admin-IA correction;
 * specs/ui/admin-ia.md §1: the mailbox LIST is Global-admin scope,
 * `Manage ▾ → Mailboxes`). `GET /api/v1/mailboxes` is engine-enforced
 * admin-only (403 for anyone else) — a non-admin is redirected to the
 * Inbox rather than ever reaching that 403, same posture
 * `/manage/agents/page.tsx` already uses for Team.
 */
export default async function MailboxesListPage() {
  const me = await getMe()
  if (me.role !== 'admin') redirect('/inbox/open')

  const mailboxes = await listMailboxes()
  return <MailboxListScreen mailboxes={mailboxes} />
}
