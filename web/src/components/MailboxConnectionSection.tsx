'use client'

/**
 * The mailbox-scoped **Connection** section — the only `available` entry
 * in `resolveInboxSettingsSections` this pass (`../lib/inbox-settings-
 * sections.ts`). Read-only display of the mailbox's CURRENT IMAP/SMTP
 * config (`GET /api/v1/mailboxes/{id}/imap-config`, HT-101 Stage 2b —
 * never the credential; see that endpoint's doc), grouped **Fetching**
 * (IMAP)/**Sending** (SMTP) so it maps to the two transports, plus a
 * "Reconnect / update settings" action that opens the existing
 * `ConnectInboxForm` prefilled (`initialConfig`, `lockAddress` — see that
 * component's doc) — `POST /imap/connect` upserts BY address and preserves
 * the fetch cursor on a reconnect, so re-submitting this form IS the
 * update path.
 *
 * "Send test email" is deliberately NOT built — no such endpoint exists
 * yet. It is surfaced here only as a disabled, honestly-labeled affordance
 * (never a fake result), same posture `InboxSettingsShell` uses for
 * `planned` nav entries.
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import type { ImapMailboxConfigView } from '../lib/api-types'
import { ConnectInboxForm } from './ConnectInboxForm'
import { Button } from './ds/core/Button'
import { EmptyState } from './ds/core/EmptyState'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      style={{
        background: 'var(--ht-surface)',
        border: '1px solid var(--ht-border)',
        borderRadius: 'var(--ht-radius-lg, 8px)',
        padding: 18,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14 }}>{title}</div>
      {children}
    </section>
  )
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: 'var(--ht-ink-dim)' }}>{label}</dt>
      <dd style={{ margin: 0, fontFamily: 'var(--ht-mono)' }}>{value}</dd>
    </>
  )
}

export function MailboxConnectionSection({
  mailbox,
  config,
}: {
  mailbox: { id: string; address: string }
  /** `null` when this mailbox has no IMAP/SMTP config on file (e.g. a Gmail-connected mailbox) — `getMailboxImapConfig`'s 404 case. */
  config: ImapMailboxConfigView | null
}) {
  const [reconnecting, setReconnecting] = useState(false)

  if (config === null) {
    return (
      <Card title="Connection">
        <EmptyState
          title="Not connected over IMAP/SMTP"
          body="This mailbox isn't using an IMAP/SMTP connection — there's nothing to show here."
        />
      </Card>
    )
  }

  if (reconnecting) {
    return (
      <ConnectInboxForm
        initialConfig={{
          address: mailbox.address,
          imapHost: config.imapHost,
          imapPort: config.imapPort,
          smtpHost: config.smtpHost,
          smtpPort: config.smtpPort,
          secure: config.secure,
        }}
        lockAddress
        onConnected={() => setReconnecting(false)}
        onCancel={() => setReconnecting(false)}
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Fetching (IMAP)">
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            rowGap: 10,
            columnGap: 16,
            fontSize: 13,
          }}
        >
          <ConfigRow label="Host" value={config.imapHost} />
          <ConfigRow label="Port" value={String(config.imapPort)} />
        </dl>
      </Card>

      <Card title="Sending (SMTP)">
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            rowGap: 10,
            columnGap: 16,
            fontSize: 13,
          }}
        >
          <ConfigRow label="Host" value={config.smtpHost} />
          <ConfigRow label="Port" value={String(config.smtpPort)} />
        </dl>
      </Card>

      <Card title="Credential">
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            rowGap: 10,
            columnGap: 16,
            fontSize: 13,
          }}
        >
          <ConfigRow label="Username" value={config.username} />
          <ConfigRow label="TLS" value={config.secure ? 'On' : 'Off (STARTTLS)'} />
          <dt style={{ color: 'var(--ht-ink-dim)' }}>App password</dt>
          <dd style={{ margin: 0 }}>Configured — never shown again.</dd>
        </dl>
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="primary" onClick={() => setReconnecting(true)}>
          Reconnect / update settings
        </Button>
        <Button variant="outline" disabled title="Not yet available — no send-test endpoint yet">
          Send test email
        </Button>
      </div>
    </div>
  )
}
