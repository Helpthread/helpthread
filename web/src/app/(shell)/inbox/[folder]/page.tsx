import { notFound, redirect } from 'next/navigation'
import { InboxScreen } from '../../../../components/InboxScreen'
import { listConversations } from '../../../../lib/api'
import { isAppFolder } from '../../../../lib/folders'

/**
 * The inbox list — a server component: the API call (and its Bearer token)
 * happens here, and the client screen receives plain data. `open` is a
 * legacy alias that redirects to `unassigned` (its default view). `?cursor=`
 * pages older conversations via the API's opaque keyset cursor (spec §3a),
 * for the Closed and Spam folders only — the other five derive their view
 * from a flat `open` fetch (Unassigned/Mine/Assigned split by `assignee`;
 * Starred/Drafts filter an `open`+`closed` fetch against localStorage).
 */
export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ folder: string }>
  searchParams: Promise<{ cursor?: string }>
}) {
  const { folder } = await params
  if (folder === 'open') redirect('/inbox/unassigned')
  if (!isAppFolder(folder)) notFound()

  switch (folder) {
    case 'unassigned':
    case 'mine':
    case 'assigned': {
      const page = await listConversations({ folder: 'open', limit: 50 })
      return <InboxScreen folder={folder} conversations={page.conversations} nextCursor={null} />
    }

    case 'starred':
    case 'drafts': {
      const [openPage, closedPage] = await Promise.all([
        listConversations({ folder: 'open', limit: 50 }),
        listConversations({ folder: 'closed', limit: 50 }),
      ])
      const conversations = [...openPage.conversations, ...closedPage.conversations].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )
      return <InboxScreen folder={folder} conversations={conversations} nextCursor={null} />
    }

    case 'closed':
    case 'spam': {
      const { cursor } = await searchParams
      const page = await listConversations({
        folder,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      return (
        <InboxScreen
          folder={folder}
          conversations={page.conversations}
          nextCursor={page.nextCursor}
        />
      )
    }
  }
}
