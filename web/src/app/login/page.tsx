import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LoginScreen } from '../../components/LoginScreen'
import { getAuthProviders } from '../../lib/api'
import { sanitizeNextPath } from '../../lib/next-path'

export const metadata: Metadata = {
  title: 'Sign in — Helpthread',
}

/**
 * A public route `middleware.ts` lets through unauthenticated. Reads
 * `?next=` (where the Agent was headed before the middleware redirected
 * them here) and sanitizes it immediately — see `lib/next-path.ts` — before
 * handing it to the client `LoginScreen`, which passes it straight through to
 * `loginAction` on submit. `loginAction` re-sanitizes the same value before
 * redirecting (defense in depth costs one function call; the two call sites
 * don't need to trust each other).
 *
 * `needsSetup` (HT-54, spec §7): zero Agents exist yet on this deployment —
 * `/login` has nothing to authenticate against, so it redirects to `/setup`.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const { providers, needsSetup } = await getAuthProviders()
  if (needsSetup) redirect('/setup')
  return <LoginScreen next={sanitizeNextPath(next ?? null)} providers={providers} />
}
