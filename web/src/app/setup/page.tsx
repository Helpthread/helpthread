import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { SetupScreen } from '../../components/SetupScreen'
import { getAuthProviders } from '../../lib/api'

export const metadata: Metadata = {
  title: 'Set up — Helpthread',
}

/**
 * `/setup` — a public route `middleware.ts` lets through unauthenticated
 * (HT-54, spec §6/§7). Zero-Agents-guarded: once `needsSetup` is false
 * (an admin already exists), this redirects to `/login` — a one-shot
 * screen, not a route that stays usable after the deployment is bootstrapped.
 */
export default async function SetupPage() {
  const { needsSetup } = await getAuthProviders()
  if (!needsSetup) redirect('/login')
  return <SetupScreen />
}
