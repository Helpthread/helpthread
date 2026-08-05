'use client'

/**
 * The "Connect an inbox" form (HT-101) — one flow, not a two-step
 * create-then-configure (the maintainer's fixed decision): address, IMAP/SMTP
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
 *
 * ## OAuth-first ordering (HT-123)
 *
 * Applies only to the fresh "New inbox" flow (`!lockAddress`) — reconnect
 * (`lockAddress`, `initialConfig` set) always reached this form because a
 * mailbox is already connected over IMAP/SMTP (`GET .../imap-config`
 * returning something to prefill), so it stays app-password-only,
 * unchanged, exactly as before.
 *
 * For a fresh connect, the typed address routes the operator to the right
 * method (`specs/mail/mailbox-connection.md` §3's recommended default:
 * OAuth for Google, app password everywhere else):
 *
 * - `gmail.com`/`googlemail.com` → "Connect with Google" is PRIMARY, with a
 *   collapsed "Use an app password instead" disclosure revealing this same
 *   form.
 * - An {@link OAUTH_ONLY_DOMAINS} match (Microsoft) → plainly not yet
 *   supported. No button is offered — Microsoft OAuth is a separate,
 *   unbuilt connector, and a button that cannot work is worse than none.
 * - Every other domain, including an unrecognized one (self-hosted, or a
 *   Google Workspace org's own domain — {@link PROVIDER_PRESETS} has no way
 *   to tell) → the app-password form stays PRIMARY, with a small "Connect
 *   with Google Workspace instead" alternative. A domain WITH a known
 *   non-Google preset (Fastmail, Zoho, iCloud, Yahoo) never gets that
 *   alternative — offering Google there is just confusing, not helpful.
 *
 * The typed address is a routing HINT only: the engine resolves the real
 * connected address from the OAuth grant itself
 * (`GmailConnectService.completeConnect`'s `getProfile()` step,
 * gmail-connect.md §4 step 3), not from what the operator typed here. The
 * engine's `beginConnect()` takes no login-hint parameter today, so none is
 * invented or sent — see `mailbox-actions.ts`'s `beginGoogleConnect` doc.
 */

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { beginGoogleConnect, checkMailboxConnection, connectMailbox } from '../lib/mailbox-actions'
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
 * Recognized-domain starter set. **Every host, port and TLS value below was
 * checked against that provider's own published documentation on 2026-07-31**
 * — Gmail, Yahoo, iCloud, Fastmail and Zoho support pages, not a secondary
 * source. All were correct as configured; the audit's finding was about who is
 * MISSING (see {@link OAUTH_ONLY_DOMAINS}), not about a wrong port.
 *
 * A domain earns a preset only if its provider accepts an app password for
 * IMAP and SMTP. That is the whole gate: an entry here is a promise that
 * typing this address and pasting an app password will work.
 *
 * SMTP `secure` follows nodemailer's documented convention — `true` (implicit
 * TLS) for the port 465 providers, `false` (STARTTLS) for the 587 ones —
 * because `verifySmtpConnection` (`src/providers/adapters/smtp/verify.ts`)
 * passes it straight through, and `secure: true` on 587 fails the handshake.
 * Note this flag describes the SMTP leg ONLY; the IMAP leg derives its own
 * mode from its port (`imapImplicitTlsForPort`), and making that per-leg and
 * explicit is tracked separately.
 *
 * The spec text's SMTP hosts for iCloud/Fastmail/Zoho read
 * "smtp.smtp.____.com" (a doubled prefix); that is a copy/paste typo against
 * the real single-prefix hostnames, which the provider docs confirm and which
 * are used here.
 *
 * Known gap, unresolved: Apple publishes DIFFERENT usernames per leg for
 * iCloud — the local part for IMAP, the full address for SMTP — and
 * `ImapConnectInput` carries one `username` for both. Apple's own guidance is
 * to try the full address if the short form fails, so this preset may work as
 * written, but it is untested and the data model cannot express the split.
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

/**
 * Domains whose provider does NOT accept an app password for IMAP/SMTP at all,
 * mapped to the label shown when an operator types one.
 *
 * These are not "presets we haven't written yet" — they cannot work by any
 * host/port combination, so offering a preset would hand the operator a
 * credential their provider will refuse. Microsoft removed Basic
 * authentication from Exchange Online entirely ("no one (you or Microsoft
 * support) can re-enable" it) and requires OAuth2 for POP, IMAP and SMTP on
 * consumer Outlook.com too; app passwords are explicitly covered by that
 * removal.
 *
 * `specs/mail/mailbox-connection.md` §3 already recorded Microsoft 365
 * business as **No** and consumer Outlook.com as *unresolved — test before
 * claiming support*. Presets for these domains shipped anyway; this is the
 * correction. Verified against Microsoft's own documentation 2026-07-31.
 *
 * ## This list CANNOT detect Microsoft, and must not be read as if it does
 *
 * It is an exact-match hint for well-known CONSUMER domains, nothing more. A
 * Microsoft 365 business tenant uses its own domain — `ops@contoso.example`
 * has no Microsoft-shaped string in it — so it matches nothing here, gets no
 * notice, and the operator is invited to enter an app password Exchange
 * Online will refuse. Subdomains (`user@mail.outlook.com`) miss for the same
 * reason.
 *
 * Real detection needs provider discovery (an MX or Autodiscover lookup at the
 * moment the address is typed), which this screen does not do. Until it does,
 * spec §4's requirement that "for an M365 business domain the app-password
 * option is disabled with an explanation" is **not implemented** — recorded
 * there as a known gap rather than quietly assumed satisfied by this list.
 * Adding more domains narrows the gap; it never closes it.
 */
const OAUTH_ONLY_DOMAINS: Record<string, string> = {
  'outlook.com': 'Outlook',
  'outlook.co.uk': 'Outlook',
  'hotmail.com': 'Outlook',
  'hotmail.co.uk': 'Outlook',
  'hotmail.de': 'Outlook',
  'hotmail.fr': 'Outlook',
  'hotmail.it': 'Outlook',
  'hotmail.es': 'Outlook',
  'live.com': 'Outlook',
  'live.co.uk': 'Outlook',
  'live.ca': 'Outlook',
  'live.com.au': 'Outlook',
  'msn.com': 'Outlook',
  'passport.com': 'Outlook',
  'office365.com': 'Microsoft 365',
}

function domainFromAddress(address: string): string | null {
  const at = address.lastIndexOf('@')
  if (at < 0 || at === address.length - 1) return null
  return (
    address
      .slice(at + 1)
      .trim()
      .toLowerCase()
      // A trailing dot is a legal fully-qualified DNS name (`outlook.com.`) and
      // resolves to the same host, so leaving it on let an address slip past
      // both maps — no preset AND no OAuth notice (2026-07-31).
      .replace(/\.+$/, '')
  )
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
  const [isBeginningOAuth, startOAuth] = useTransition()

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
  // OAuth-first ordering (HT-123, module doc). `null` = use the
  // domain-derived default; set once the operator explicitly toggles
  // between "Connect with Google" and "Use an app password instead".
  const [connectModeOverride, setConnectModeOverride] = useState<'oauth' | 'password' | null>(null)

  const domain = domainFromAddress(address)
  const preset = domain !== null ? PROVIDER_PRESETS[domain] : undefined
  const oauthOnlyLabel = domain !== null ? OAUTH_ONLY_DOMAINS[domain] : undefined
  const advancedOpen = manualAdvancedOverride ?? preset === undefined

  // OAuth-first routing (module doc) — only for a fresh connect.
  // Reconnect (`lockAddress`) always stays on the app-password form below.
  const isGoogleDomain = domain === 'gmail.com' || domain === 'googlemail.com'
  const microsoftOnly = !lockAddress && oauthOnlyLabel !== undefined
  // A known non-Google preset (Fastmail, Zoho, iCloud, Yahoo) never offers
  // Google — offering it there would just be confusing, not helpful
  // (module doc). An unrecognized domain might be a Workspace org's own
  // domain, so it does.
  // Offered whenever Google is a real possibility for this address: a Google
  // domain (so someone who opened the app-password option can get BACK to
  // OAuth — without this they are stuck in password mode until they retype the
  // address), or an unrecognized domain that may belong to a Workspace org. A
  // known non-Google preset (Fastmail, Zoho, iCloud, Yahoo) never offers it.
  const offerGoogleAlternative =
    !lockAddress && !microsoftOnly && (isGoogleDomain || preset === undefined)
  const defaultConnectMode: 'oauth' | 'password' = isGoogleDomain ? 'oauth' : 'password'
  const connectRenderMode: 'oauth' | 'password' | 'unsupported' = lockAddress
    ? 'password'
    : microsoftOnly
      ? 'unsupported'
      : (connectModeOverride ?? defaultConnectMode)
  const showGooglePrimary = connectRenderMode === 'oauth'
  const passwordFormVisible = connectRenderMode === 'password'

  function clearCheckState(): void {
    setCheckResult(null)
    setFormError(null)
  }

  function handleAddressChange(value: string): void {
    setAddress(value)
    clearCheckState()
    // A domain change recomputes the OAuth-vs-password default from
    // scratch — an override made for gmail.com must not stick around once
    // the operator has typed a Fastmail address (module doc).
    setConnectModeOverride(null)
    const nextDomain = domainFromAddress(value)
    // An OAuth-only domain clears whatever a previous preset left behind.
    // Without this, typing gmail.com and then outlook.com leaves Gmail's hosts
    // sitting underneath an "Outlook requires OAuth" warning — the form would
    // be showing one provider's settings while warning about another's.
    if (nextDomain !== null && OAUTH_ONLY_DOMAINS[nextDomain] !== undefined) {
      setImapHost('')
      setImapPort('')
      setSmtpHost('')
      setSmtpPort('')
      setAppliedPresetDomain(null)
      return
    }
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
  const isPending = isChecking || isConnecting || isBeginningOAuth

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

  /**
   * "Connect with Google" (HT-123, module doc). Mints the consent URL
   * server-side, then does a full top-level navigation to it — Google's
   * consent screen cannot be reached from inside this SPA, and a
   * `window.location.href` assignment is the plain, correct way to leave
   * the app for it. `beginGoogleConnect` never forwards anything from the
   * engine response beyond `consentUrl` (see its own doc), so there is
   * nothing secret to have handled here in the first place.
   */
  function handleConnectWithGoogle(): void {
    if (isPending) return
    setFormError(null)
    startOAuth(async () => {
      let response: Awaited<ReturnType<typeof beginGoogleConnect>>
      try {
        response = await beginGoogleConnect()
      } catch {
        setFormError('Could not reach the server. Please try again.')
        return
      }
      if (!response.ok || response.consentUrl === undefined) {
        setFormError(response.message ?? 'Could not start the Google connection. Please try again.')
        return
      }
      window.location.href = response.consentUrl
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
        {/* `htmlFor` only when the id it names actually exists — the locked
            (reconnect) branch renders a plain div, so an unconditional
            `htmlFor` pointed at nothing, breaking the label association for
            screen readers and click-to-focus (2026-07-31). */}
        {lockAddress ? (
          <FieldLabel>Email address</FieldLabel>
        ) : (
          <FieldLabel htmlFor="ht-connect-inbox-address">Email address</FieldLabel>
        )}
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
        {/* Deliberately NOT gated on `!lockAddress`, unlike the preset hint
            above. A reconnect screen is where an operator is MOST likely to
            retry a stored Outlook mailbox that has never been able to
            authenticate, and hiding the reason there was exactly backwards
            (2026-07-31). The stored host/port values are left visible
            rather than cleared — this screen exists to review them, and
            blanking a locked form would destroy the context it is for. */}
        {oauthOnlyLabel !== undefined && (
          <p
            role="status"
            style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--ht-warn, var(--ht-ink))' }}
          >
            {oauthOnlyLabel} does not allow app passwords for IMAP or SMTP — it requires OAuth.
            {lockAddress
              ? ' Reconnecting this inbox will not work.'
              : ` Connecting a ${oauthOnlyLabel} inbox is not yet supported.`}
          </p>
        )}
      </div>

      {showGooglePrimary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Button variant="primary" disabled={isPending} onClick={handleConnectWithGoogle}>
            {isBeginningOAuth ? 'Redirecting to Google…' : 'Connect with Google'}
          </Button>
          <p style={{ margin: 0, fontSize: 11.5, color: 'var(--ht-ink-dim)' }}>
            Helpthread only requests the access it needs to read and send mail for this inbox, and
            you can revoke it from your Google account at any time. An app password can&apos;t be
            scoped this way and never expires.
          </p>
          <button
            type="button"
            onClick={() => setConnectModeOverride('password')}
            disabled={isPending}
            style={{
              alignSelf: 'flex-start',
              border: 'none',
              background: 'none',
              padding: 0,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--ht-ink-muted)',
              cursor: 'pointer',
            }}
          >
            Use an app password instead
          </button>
        </div>
      )}

      {passwordFormVisible && (
        <>
          {offerGoogleAlternative && (
            <button
              type="button"
              onClick={() => setConnectModeOverride('oauth')}
              disabled={isPending}
              style={{
                alignSelf: 'flex-start',
                border: 'none',
                background: 'none',
                padding: 0,
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--ht-accent)',
                cursor: 'pointer',
              }}
            >
              {isGoogleDomain
                ? 'Connect with Google instead'
                : 'Connect with Google Workspace instead'}
            </button>
          )}

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
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ht-ink)' }}>
                    Use TLS
                  </span>
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
        </>
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
        {passwordFormVisible && (
          <>
            <Button variant="outline" disabled={!canSubmit || isPending} onClick={handleCheck}>
              {isChecking ? 'Checking…' : 'Check connection'}
            </Button>
            <Button variant="primary" disabled={!canSubmit || isPending} onClick={handleConnect}>
              {isConnecting ? 'Connecting…' : 'Connect'}
            </Button>
          </>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" disabled={isPending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
