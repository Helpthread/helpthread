import { DashboardScreen } from '../../components/DashboardScreen'
import { getMe } from '../../lib/api'
import { loadFolderCounts } from '../../lib/folder-counts'

/**
 * /dashboard — a plain top-level route (no folder rail; the design puts the
 * mailbox overview outside the shell, same as `/settings`). The wordmark
 * and the top bar's Mailbox tab both land here.
 */
export default async function DashboardPage() {
  const me = await getMe()
  const counts = await loadFolderCounts(me.id)
  const supportAddress = process.env.HELPTHREAD_SUPPORT_ADDRESS ?? 'support@dev.localhost'

  return <DashboardScreen supportAddress={supportAddress} counts={counts} />
}
