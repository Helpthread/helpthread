'use client'

/**
 * The "Connect an inbox" form (HT-101) — one flow, not a two-step
 * create-then-configure (TJ's fixed decision): address, IMAP/SMTP
 * connection, and the app-password credential all live in one card.
 * Composed entirely from `ds/core` primitives, same conventions
 * `NewAgentScreen` already established for a CLIENT form backed by a
 * `server-only` API client — see `mailbox-actions.ts`'s module doc for why
 * the calls go through a server action rather than `lib/api.ts` directly.
 *
 * Two homes (HT-101 admin-IA correction, specs/ui/admin-ia.md §1): the
 * plain "New inbox" flow at `/manage/mailboxes/new` (Global-admin scope,
 * `NewMailboxScreen`) with no `initialConfig`, and the "Reconnect / update
 * settings" flow inside the mailbox-scoped Connection section
 * (`MailboxConnectionSection`) with `initialConfig` + `lockAddress` set —
 * see those props' own docs. Both render the SAME form; only the
 * surrounding chrome and prefill differ.
 *
 * Address-first with presets: typing a recognized domain prefills
 * host/port/TLS from {@link PROVIDER_PRESETS}; an unrecognized domain
 * expands "Advanced" for manual entry. The preset is applied once per
 * newly-recognized domain (`appliedPresetDomain`) so it never clobbers a
 * manual edit the operator makes afterward. Reconnect (`initialConfig` set)
 * starts with Advanced already open and skips preset auto-fill entirely
 * (the existing config IS the source of truth there, not a domain guess).
 *
 * The app password is write-only (never rendered back) and, like
 * `NewAgentScreen`'s own password field, a plain styled `<input
 * type="password">` — `ds/core/TextInput` hardcodes `type="text"` and has
 * no variant for this, so a raw input matching its exact visual style is
 * the established pattern here, not a deviation from it.
 */

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { checkMailboxConnection, connectMailbox } from '../lib/mailbox-actions'
import { Button } from './ds/core/Button'
import { StatusPill } from './ds/core/StatusPill'
import { TextInput } from './ds/core/TextInput'
import { useToast } from './Toaster'

interface ProviderPreset {
  label: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  secure: boolean
}

/**
 * Recognized-domain starter set (spec's list). SMTP `secure` follows
 * nodemailer's own documented convention — `true` (implicit TLS) for the
 * port 465 providers, `false` (STARTTLS) for the port 587 ones — rather
 * than a blanket `true` for every preset: `verifySmtpConnection`
 * (`src/providers/adapters/smtp/verify.ts`) passes `secure` straight to
 * nodemailer, and nodemailer's own docs are explicit that `secure: true` on
 * port 587 fails the handshake. **Flagged for TJ**: this is a factual
 * correction of the spec text's "default secure: true" for Outlook/iCloud,
 * not a product decision — see the PR description.
 *
 * The spec text's SMTP hosts for iCloud/Fastmail/Zoho read
 * "smtp.smtp.____.com" (a doubled prefix); that looks like a copy/paste
 * typo against the real single-prefix hostnames, so the real hostnames are
 * used here. **Flagged for TJ** alongside the `secure` correction above.
 */
const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  'gmail.com': {
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    secure: true,
  },
  'googlemail.com': {
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    secure: true,
  },
  'outlook.com': {
    label: 'Outlook',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    secure: false,
  },
  'hotmail.com': {
    label: 'Outlook',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    secure: false,
  },
  'live.com': {
    label: 'Outlook',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    secure: false,
  },
  'yahoo.com': {
    label: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    secure: true,
  },
  'icloud.com': {
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    secure: false,
  },
  'me.com': {
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    secure: false,
  },
  'fastmail.com': {
    label: 'Fastmail',
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 465,
    secure: true,
  },
  'zoho.com': {
    label: 'Zoho Mail',
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    secure: true,
  },
}

function domainFromAddress(address: string): string | null {
  const at = address.lastIndexOf('@')
  if (at < 0 || at === address.length - 1) return null
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
}

function parsePort(value: string): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null
}

function FieldLabel({ children, htmlFor }: { children: string; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--ht-ink-dim)',
        marginBottom: 6,
      }}
    >
      {children}
    </label>
  )
}

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <polyline
        points="6 9 12 15 18 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Prefill for the reconnect path (`MailboxConnectionSection`, HT-101 Stage 2b) — every field the read-only Connection view already knows EXCEPT the password, which is write-only and never comes back from the engine (module doc). */
export interface ConnectInboxFormInitialConfig {
  address: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  secure: boolean
}

export function ConnectInboxForm({
  onConnected,
  onCancel,
  initialConfig,
  lockAddress = false,
}: {
  onConnected: () => void
  onCancel: () => void
  /** Reconnect prefill — same shape a fresh connect ends with, minus the password (module doc). Omitted for the ordinary "New inbox" flow. */
  initialConfig?: ConnectInboxFormInitialConfig
  /** Reconnect locks the address field: `POST /imap/connect` upserts BY address (module doc's "re-submitting IS the update path"), so an editable address here could silently create a second mailbox instead of updating this one. */
  lockAddress?: boolean
}) {
  const router = useRouter()
  const showToast = useToast()
  const [isChecking, startChecking] = useTransition()
  const [isConnecting, startConnecting] = useTransition()

  const [address, setAddress] = useState(initialConfig?.address ?? '')
  const [password, setPassword] = useState('')
  const [imapHost, setImapHost] = useState(initialConfig?.imapHost ?? '')
  const [imapPort, setImapPort] = useState(
    initialConfig !== undefined ? String(initialConfig.imapPort) : '',
  )
  const [smtpHost, setSmtpHost] = useState(initialConfig?.smtpHost ?? '')
  const [smtpPort, setSmtpPort] = useState(
    initialConfig !== undefined ? String(initialConfig.smtpPort) : '',
  )
  const [secure, setSecure] = useState(initialConfig?.secure ?? true)
  const [appliedPresetDomain, setAppliedPresetDomain] = useState<string | null>(null)
  // Reconnect starts with Advanced already open — the whole point is
  // reviewing/editing the current host/port values, never a fresh preset
  // guess overriding them.
  const [manualAdvancedOverride, setManualAdvancedOverride] = useState<boolean | null>(
    initialConfig !== undefined ? true : null,
  )
  const [checkResult, setCheckResult] = useState<Awaited<
    ReturnType<typeof checkMailboxConnection>
  > | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const domain = domainFromAddress(address)
  const preset = domain !== null ? PROVIDER_PRESETS[domain] : undefined
  const advancedOpen = manualAdvancedOverride ?? preset === undefined

  function clearCheckState(): void {
    setCheckResult(null)
    setFormError(null)
  }

  function handleAddressChange(value: string): void {
    setAddress(value)
    clearCheckState()
    const nextDomain = domainFromAddress(value)
    const nextPreset = nextDomain !== null ? PROVIDER_PRESETS[nextDomain] : undefined
    if (nextPreset !== undefined && nextDomain !== appliedPresetDomain) {
      setImapHost(nextPreset.imapHost)
      setImapPort(String(nextPreset.imapPort))
      setSmtpHost(nextPreset.smtpHost)
      setSmtpPort(String(nextPreset.smtpPort))
      setSecure(nextPreset.secure)
      setAppliedPresetDomain(nextDomain)
    }
  }

  function buildConfig(): {
    address: string
    imapHost: string
    imapPort: number
    smtpHost: string
    smtpPort: number
    username: string
    password: string
    secure: boolean
  } | null {
    const trimmedAddress = address.trim()
    const trimmedImapHost = imapHost.trim()
    const trimmedSmtpHost = smtpHost.trim()
    const imapPortNum = parsePort(imapPort)
    const smtpPortNum = parsePort(smtpPort)
    if (
      trimmedAddress.length === 0 ||
      password.length === 0 ||
      trimmedImapHost.length === 0 ||
      imapPortNum === null ||
      trimmedSmtpHost.length === 0 ||
      smtpPortNum === null
    ) {
      return null
    }
    return {
      address: trimmedAddress,
      imapHost: trimmedImapHost,
      imapPort: imapPortNum,
      smtpHost: trimmedSmtpHost,
      smtpPort: smtpPortNum,
      username: trimmedAddress,
      password,
      secure,
    }
  }

  const canSubmit = buildConfig() !== null
  const isPending = isChecking || isConnecting

  function handleCheck(): void {
    const config = buildConfig()
    if (config === null || isPending) return
    setCheckResult(null)
    setFormError(null)
    startChecking(async () => {
      let response: Awaited<ReturnType<typeof checkMailboxConnection>>
      try {
        response = await checkMailboxConnection(config)
      } catch {
        setFormError('Could not reach the server. Please try again.')
        return
      }
      if (!response.ok || response.result === undefined) {
        setFormError(response.message ?? 'Could not check the connection. Please try again.')
        return
      }
      setCheckResult(response)
    })
  }

  function handleConnect(): void {
    const config = buildConfig()
    if (config === null || isPending) return
    setFormError(null)
    startConnecting(async () => {
      let response: Awaited<ReturnType<typeof connectMailbox>>
      try {
        response = await connectMailbox(config)
      } catch {
        setFormError('Could not reach the server. Please try again.')
        return
      }
      if (!response.ok) {
        setFormError(response.message ?? 'Could not connect the mailbox. Please try again.')
        return
      }
      showToast({
        title: 'Mailbox connected',
        ...(response.mailbox !== undefined ? { detail: response.mailbox.address } : {}),
      })
      router.refresh()
      onConnected()
    })
  }

  return (
    <div
      style={{
        border: '1px solid var(--ht-border)',
        borderRadius: 'var(--ht-radius-sm)',
        background: 'var(--ht-bg)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700 }}>
        {lockAddress ? 'Reconnect this inbox' : 'Connect an inbox'}
      </div>

      <div>
        <FieldLabel htmlFor="ht-connect-inbox-address">Email address</FieldLabel>
        {lockAddress ? (
          // Locked, not disabled — `ds/core/TextInput` has no disabled
          // variant, and rendering a plain (read-only) value here is more
          // honest than a fake-disabled input anyway. `POST /imap/connect`
          // upserts BY address (module doc): an editable address on
          // reconnect could silently create a second mailbox instead of
          // updating this one.
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--ht-ink)',
              background: 'var(--ht-surface-2)',
              border: '1px solid var(--ht-divider)',
              borderRadius: 'var(--ht-radius-sm)',
              padding: '6px 10px',
              fontFamily: 'var(--ht-mono)',
            }}
          >
            {address}
          </div>
        ) : (
          <TextInput
            id="ht-connect-inbox-address"
            value={address}
            onChange={(event: { target: { value: string } }) =>
              handleAddressChange(event.target.value)
            }
            placeholder="support@yourcompany.com"
          />
        )}
        {preset !== undefined && !lockAddress && (
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ht-ink-dim)' }}>
            {preset.label} recognized — using {preset.imapHost} / {preset.smtpHost}.
          </p>
        )}
      </div>

      <div>
        <FieldLabel htmlFor="ht-connect-inbox-password">App password</FieldLabel>
        <input
          id="ht-connect-inbox-password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
            clearCheckState()
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            fontFamily: 'var(--ht-sans)',
            fontSize: 12.5,
            color: 'var(--ht-ink)',
            background: 'var(--ht-bg)',
            border: '1px solid var(--ht-divider)',
            borderRadius: 'var(--ht-radius-sm)',
            padding: '6px 10px',
            outline: 'none',
          }}
        />
        <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--ht-ink-dim)' }}>
          {lockAddress
            ? "The engine never returns a stored password — re-enter it to reconnect, even if it hasn't changed."
            : "Generated in your provider's security settings — not your account's main password."}
        </p>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setManualAdvancedOverride(!advancedOpen)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: 'none',
            background: 'none',
            padding: 0,
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--ht-accent)',
            cursor: 'pointer',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              transform: advancedOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.15s',
            }}
          >
            <ChevronDownIcon />
          </span>
          Advanced
        </button>

        {advancedOpen && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <FieldLabel htmlFor="ht-connect-inbox-imap-host">IMAP host</FieldLabel>
                <TextInput
                  id="ht-connect-inbox-imap-host"
                  value={imapHost}
                  onChange={(event: { target: { value: string } }) => {
                    setImapHost(event.target.value)
                    clearCheckState()
                  }}
                  placeholder="imap.yourprovider.com"
                />
              </div>
              <div style={{ width: 90 }}>
                <FieldLabel htmlFor="ht-connect-inbox-imap-port">Port</FieldLabel>
                <TextInput
                  id="ht-connect-inbox-imap-port"
                  value={imapPort}
                  onChange={(event: { target: { value: string } }) => {
                    setImapPort(event.target.value)
                    clearCheckState()
                  }}
                  placeholder="993"
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <FieldLabel htmlFor="ht-connect-inbox-smtp-host">SMTP host</FieldLabel>
                <TextInput
                  id="ht-connect-inbox-smtp-host"
                  value={smtpHost}
                  onChange={(event: { target: { value: string } }) => {
                    setSmtpHost(event.target.value)
                    clearCheckState()
                  }}
                  placeholder="smtp.yourprovider.com"
                />
              </div>
              <div style={{ width: 90 }}>
                <FieldLabel htmlFor="ht-connect-inbox-smtp-port">Port</FieldLabel>
                <TextInput
                  id="ht-connect-inbox-smtp-port"
                  value={smtpPort}
                  onChange={(event: { target: { value: string } }) => {
                    setSmtpPort(event.target.value)
                    clearCheckState()
                  }}
                  placeholder="587"
                />
              </div>
            </div>

            <button
              type="button"
              aria-pressed={secure}
              onClick={() => {
                setSecure((current) => !current)
                clearCheckState()
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                border: '1px solid var(--ht-border)',
                background: 'var(--ht-surface)',
                borderRadius: 'var(--ht-radius-md)',
                padding: '10px 12px',
                cursor: 'pointer',
                width: '100%',
                textAlign: 'left',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 32,
                  height: 18,
                  borderRadius: 999,
                  background: secure ? 'var(--ht-accent)' : 'var(--ht-surface-2)',
                  position: 'relative',
                  flexShrink: 0,
                  transition: 'background 0.15s',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: 2,
                    left: secure ? 16 : 2,
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: 'var(--ht-surface)',
                    transition: 'left 0.15s',
                  }}
                />
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ht-ink)' }}>Use TLS</span>
            </button>
          </div>
        )}
      </div>

      {checkResult !== null && checkResult.result !== undefined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <StatusPill
              status={checkResult.result.imap.ok ? 'active' : 'spam'}
              label={checkResult.result.imap.ok ? 'IMAP ✓' : 'IMAP ✗'}
            />
            <StatusPill
              status={checkResult.result.smtp.ok ? 'active' : 'spam'}
              label={checkResult.result.smtp.ok ? 'SMTP ✓' : 'SMTP ✗'}
            />
          </div>
          {!checkResult.result.imap.ok && (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--ht-critical)' }}>
              IMAP: {checkResult.result.imap.error}
            </p>
          )}
          {!checkResult.result.smtp.ok && (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--ht-critical)' }}>
              SMTP: {checkResult.result.smtp.error}
            </p>
          )}
        </div>
      )}

      {formError !== null && (
        <div
          role="alert"
          aria-live="assertive"
          style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ht-critical)' }}
        >
          {formError}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="outline" disabled={!canSubmit || isPending} onClick={handleCheck}>
          {isChecking ? 'Checking…' : 'Check connection'}
        </Button>
        <Button variant="primary" disabled={!canSubmit || isPending} onClick={handleConnect}>
          {isConnecting ? 'Connecting…' : 'Connect'}
        </Button>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" disabled={isPending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
