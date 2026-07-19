import type { Metadata } from 'next'
import { InviteAcceptScreen } from '../../../components/InviteAcceptScreen'

export const metadata: Metadata = {
  title: 'Accept invite — Helpthread',
}

/**
 * `/invite/{token}` — a public PREFIX route `middleware.ts` lets through
 * unauthenticated (HT-54, spec §6/§7). The token itself is validated only at
 * submit time by the engine (`POST /auth/invite/accept`) — there is no GET
 * validation endpoint — so this page always renders the form.
 */
export default async function InviteAcceptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <InviteAcceptScreen token={token} />
}
