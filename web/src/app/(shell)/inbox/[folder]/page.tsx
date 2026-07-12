import { notFound } from 'next/navigation'
import { InboxScreen } from '../../../../components/InboxScreen'
import { listConversations } from '../../../../lib/api'
import type { ConversationFolder } from '../../../../lib/api-types'

const FOLDERS: ReadonlySet<string> = new Set(['open', 'closed', 'spam'])

/**
 * The inbox list — a server component: the API call (and its Bearer token)
 * happens here, and the client screen receives plain data. `?cursor=` pages
 * older conversations via the API's opaque keyset cursor (spec §3a).
 */
export default async function InboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ folder: string }>
  searchParams: Promise<{ cursor?: string }>
}) {
  const { folder } = await params
  if (!FOLDERS.has(folder)) notFound()

  const { cursor } = await searchParams
  const page = await listConversations({
    folder: folder as ConversationFolder,
    ...(cursor !== undefined ? { cursor } : {}),
  })

  return (
    <InboxScreen
      folder={folder as ConversationFolder}
      conversations={page.conversations}
      nextCursor={page.nextCursor}
    />
  )
}
