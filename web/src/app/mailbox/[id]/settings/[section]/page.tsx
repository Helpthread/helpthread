import { notFound, redirect } from 'next/navigation'
import { InboxSettingsShell } from '../../../../../components/InboxSettingsShell'
import { MailboxConnectionSection } from '../../../../../components/MailboxConnectionSection'
import { ApiError, getMailboxImapConfig, getMe, listMailboxes } from '../../../../../lib/api'
import { resolveInboxSettingsSections } from '../../../../../lib/inbox-settings-sections'

/**
 * `/mailbox/{id}/settings/{section}` — Mailbox-scoped settings
 * (specs/ui/admin-ia.md §1: entered from the folder rail's gear, never
 * `Manage ▾`). Admin-only, same posture as `GET /mailboxes`/`GET
 * .../imap-config` (both engine-enforced admin-only) — a non-admin is
 * redirected to the Inbox rather than ever reaching a 403, matching
 * `/manage/agents`' "never render an engine 403 as a crash" posture.
 *
 * `section` is validated against `resolveInboxSettingsSections()` — the
 * SAME registry `InboxSettingsShell`'s nav and the folder rail's gear menu
 * render from (admin-ia.md §3 Rule 2's injection point). An unknown section
 * 404s; a known-but-`planned` section renders an honest "Not yet available"
 * card inside the shell (never a crash, never faked content) — only
 * `connection` has real content this pass.
 */
export default async function MailboxSettingsPage({
  params,
}: {
  params: Promise<{ id: string; section: string }>
}) {
  const { id, section } = await params
  const me = await getMe()
  if (me.role !== 'admin') redirect('/inbox/open')

  const mailboxes = await listMailboxes()
  const mailbox = mailboxes.find((entry) => entry.id === id)
  if (mailbox === undefined) notFound()

  const sectionDef = resolveInboxSettingsSections().find((entry) => entry.key === section)
  if (sectionDef === undefined) notFound()

  return (
    <InboxSettingsShell mailbox={mailbox} mailboxes={mailboxes} activeSection={section}>
      {sectionDef.status === 'planned' ? (
        <PlannedSection label={sectionDef.label} />
      ) : (
        <ConnectionSection mailboxId={mailbox.id} address={mailbox.address} />
      )}
    </InboxSettingsShell>
  )
}

/** The honest placeholder every `planned` section renders — never a crash, never faked content (admin-ia.md Rule 6). */
function PlannedSection({ label }: { label: string }) {
  return (
    <section
      style={{
        background: 'var(--ht-surface)',
        border: '1px solid var(--ht-border)',
        borderRadius: 'var(--ht-radius-lg, 8px)',
        padding: 18,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{label}</div>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--ht-ink-muted)' }}>Not yet available.</p>
    </section>
  )
}

/**
 * Fetches the read-only IMAP/SMTP config for the `connection` section only
 * (the one `available` entry) — kept as its own small server component so
 * `getMailboxImapConfig`'s 404 (no config on file) is caught HERE, not
 * treated as the whole page missing.
 */
async function ConnectionSection({ mailboxId, address }: { mailboxId: string; address: string }) {
  let config: Awaited<ReturnType<typeof getMailboxImapConfig>> | null
  try {
    config = await getMailboxImapConfig(mailboxId)
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      config = null
    } else {
      throw error
    }
  }

  return <MailboxConnectionSection mailbox={{ id: mailboxId, address }} config={config} />
}
