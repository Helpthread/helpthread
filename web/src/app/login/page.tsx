import type { Metadata } from 'next'
import { LoginScreen } from '../../components/LoginScreen'
import { sanitizeNextPath } from '../../lib/next-path'

export const metadata: Metadata = {
  title: 'Sign in — Helpthread',
}

/**
 * The one public route `middleware.ts` lets through unauthenticated. Reads
 * `?next=` (where the operator was headed before the middleware redirected
 * them here) and sanitizes it immediately — see `lib/next-path.ts` — before
 * handing it to the client `LoginScreen`, which passes it straight through to
 * `loginAction` on submit. `loginAction` re-sanitizes the same value before
 * redirecting (defense in depth costs one function call; the two call sites
 * don't need to trust each other).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  return <LoginScreen next={sanitizeNextPath(next ?? null)} />
}
