import { notFound } from 'next/navigation'
import { ConversationScreen } from '../../../../components/ConversationScreen'
import { ApiError, getConversation } from '../../../../lib/api'

/** One conversation — server-fetched, client-rendered. A 404 from the API (missing or deleted — indistinguishable, spec §3b) is the app's 404. */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const conversation = await getConversation(id)
    return <ConversationScreen conversation={conversation} />
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound()
    throw error
  }
}
