import { SettingsScreen } from '../../components/SettingsScreen'
import { getMe, listMailboxes } from '../../lib/api'

/**
 * Settings — a plain top-level route (no folder rail; the design deliberately
 * puts it outside the shell). The Deployment card is read-only display: this
 * app has no API affordance for these values (they're engine-side deploy
 * config, spec's `mailDomain`/`supportAddress` deps), so this server
 * component reads them from its own env — falling back to the same dev
 * defaults the local harness uses (`scripts/dev-api.ts`) when unset.
 *
 * The Inboxes section (HT-101) fetches the connected-mailbox roster the same
 * way `/manage/agents` fetches its Agent roster: an async server component
 * awaiting the `server-only` API client, passed down as a plain prop —
 * `ConnectInboxForm`'s server actions `revalidatePath('/settings')` on a
 * successful connect, and the client calls `router.refresh()` to re-run this
 * component and hand `SettingsScreen` the fresh list without a navigation.
 *
 * `GET /api/v1/mailboxes` is admin-only (`handleListMailboxes`,
 * `src/api/agents.ts` — 403 for a non-admin caller), unlike every other
 * section this page already renders — so, same posture as `/manage/agents`
 * gating Team behind `me.role === 'admin'`, the roster is only fetched for
 * an admin viewer, and `SettingsScreen` hides the whole Inboxes section for
 * anyone else rather than surfacing a section whose one API call always
 * 403s.
 */
export default async function SettingsPage() {
  const deployment = {
    productName: 'Helpthread',
    supportAddress: process.env.HELPTHREAD_SUPPORT_ADDRESS ?? 'support@dev.localhost',
    mailDomain: process.env.HELPTHREAD_MAIL_DOMAIN ?? 'mail.dev.localhost',
  }
  const me = await getMe()
  const viewerIsAdmin = me.role === 'admin'
  const mailboxes = viewerIsAdmin ? await listMailboxes() : []

  return (
    <SettingsScreen deployment={deployment} mailboxes={mailboxes} viewerIsAdmin={viewerIsAdmin} />
  )
}
