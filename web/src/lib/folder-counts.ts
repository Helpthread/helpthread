/**
 * Sidebar/dashboard folder counts — one server-side fetch (open(50) +
 * closed/spam first pages), shared by the shell rail (`FolderNav`) and
 * `/dashboard` so the derivation lives in exactly one place. Unassigned,
 * Mine, and Assigned split client-of-the-server from the single open(50)
 * fetch (assignment folders show up to 50 unpaged, per the fidelity
 * checklist); Closed/Spam show "50+" once their first page's `nextCursor`
 * is non-null. Starred/Drafts are localStorage-only and merged in
 * client-side — see `mergeFolderCounts`.
 *
 * `selfId` (the caller's own Agent id, from `getMe()`) is required post
 * HT-54: "Mine" is real-Agent `assigneeAgentId === selfId` now, not the old
 * single-operator `'me'` sentinel.
 */

import { listConversations } from './api'
import type { ServerFolderCounts } from './folders'

const COUNT_LIMIT = 50

function pageLabel(count: number, hasMore: boolean): string {
  if (count === 0) return ''
  return hasMore ? `${COUNT_LIMIT}+` : String(count)
}

export async function loadFolderCounts(selfId: string): Promise<ServerFolderCounts> {
  const [openPage, closedPage, spamPage] = await Promise.all([
    listConversations({ folder: 'open', limit: COUNT_LIMIT }),
    listConversations({ folder: 'closed', limit: COUNT_LIMIT }),
    listConversations({ folder: 'spam', limit: COUNT_LIMIT }),
  ])

  const unassigned = openPage.conversations.filter((c) => c.assigneeAgentId === null).length
  const mine = openPage.conversations.filter((c) => c.assigneeAgentId === selfId).length
  const assigned = openPage.conversations.filter((c) => c.assigneeAgentId !== null).length

  return {
    unassigned: unassigned > 0 ? String(unassigned) : '',
    mine: mine > 0 ? String(mine) : '',
    assigned: assigned > 0 ? String(assigned) : '',
    closed: pageLabel(closedPage.conversations.length, closedPage.nextCursor !== null),
    spam: pageLabel(spamPage.conversations.length, spamPage.nextCursor !== null),
  }
}
