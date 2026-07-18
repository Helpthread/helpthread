import { notFound } from 'next/navigation'
import { ConversationScreen } from '../../../../components/ConversationScreen'
import {
  ApiError,
  getConversation,
  getMe,
  listAgents,
  listConversations,
} from '../../../../lib/api'

/**
 * One conversation — server-fetched, client-rendered. A 404 from the API
 * (missing or deleted — indistinguishable, spec §3b) is the app's 404.
 *
 * Also fetches the open folder's first 50 (a lightweight stand-in for "the
 * current folder" — the toolbar doesn't otherwise know which of the seven
 * app folders the Agent arrived from) to derive prev/next neighbors and a
 * "{i} of {n}" position. If this conversation isn't in that page (closed,
 * spam, or past the first 50), the toolbar just hides prev/next.
 *
 * Also fetches the closed folder's first 50 and, together with the open
 * page, derives the context panel's "Previous conversations" list: every
 * other conversation from the same customer, newest-updated first.
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const conversation = await getConversation(id)
    const [openPage, closedPage, me, agents] = await Promise.all([
      listConversations({ folder: 'open', limit: 50 }),
      listConversations({ folder: 'closed', limit: 50 }),
      getMe(),
      listAgents(),
    ])
    const ids = openPage.conversations.map((c) => c.id)
    const index = ids.indexOf(id)
    const position =
      index === -1
        ? null
        : {
            index: index + 1,
            total: ids.length,
            prevId: index > 0 ? (ids[index - 1] ?? null) : null,
            nextId: index < ids.length - 1 ? (ids[index + 1] ?? null) : null,
          }
    const previousConversations = [...openPage.conversations, ...closedPage.conversations]
      .filter((c) => c.customerEmail === conversation.customerEmail && c.id !== id)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((c) => ({ id: c.id, subject: c.subject, status: c.status, updatedAt: c.updatedAt }))
    return (
      <ConversationScreen
        conversation={conversation}
        position={position}
        previousConversations={previousConversations}
        agents={agents}
        selfId={me.id}
      />
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }
}
