import { SettingsScreen } from '../../components/SettingsScreen'

/**
 * Settings — a plain top-level route (no folder rail; the design deliberately
 * puts it outside the shell). The Deployment card is read-only display: this
 * app has no API affordance for these values (they're engine-side deploy
 * config, spec's `mailDomain`/`supportAddress` deps), so this server
 * component reads them from its own env — falling back to the same dev
 * defaults the local harness uses (`scripts/dev-api.ts`) when unset.
 */
export default function SettingsPage() {
  const deployment = {
    productName: 'Helpthread',
    supportAddress: process.env.HELPTHREAD_SUPPORT_ADDRESS ?? 'support@dev.localhost',
    mailDomain: process.env.HELPTHREAD_MAIL_DOMAIN ?? 'mail.dev.localhost',
  }

  return <SettingsScreen deployment={deployment} />
}
