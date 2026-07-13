import { DashboardScreen } from '../../components/DashboardScreen'
import { loadFolderCounts } from '../../lib/folder-counts'

/**
 * /dashboard — a plain top-level route (no folder rail; the design puts the
 * mailbox overview outside the shell, same as `/settings`). The wordmark
 * and the top bar's Mailbox tab both land here.
 */
export default async function DashboardPage() {
  const counts = await loadFolderCounts()
  const supportAddress = process.env.HELPTHREAD_SUPPORT_ADDRESS ?? 'support@dev.localhost'

  return <DashboardScreen supportAddress={supportAddress} counts={counts} />
}
