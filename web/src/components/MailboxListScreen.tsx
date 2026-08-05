'use client'

/**
 * `/manage/mailboxes` — the connected-mailbox roster (HT-101 admin-IA
 * correction; specs/ui/admin-ia.md §1: the mailbox LIST is Global-admin
 * scope, `Manage ▾ → Mailboxes` — never a Settings subpage, and never
 * mixed with per-mailbox connection settings, which are Mailbox-scoped
 * instead — see `InboxSettingsShell`). Mirrors `TeamListScreen`'s
 * card-list structure/styling (address, a status pill, a "New inbox"
 * action) — no search here, since the list is expected to stay small.
 *
 * DECISION FLAGGED FOR THE MAINTAINER: the spec draft asked for address + PROVIDER +
 * status per card. `GET /api/v1/mailboxes` deliberately omits `provider`
 * (`src/api/agents.ts`'s `toMailboxJson` doc: "never `provider`... this
 * mapper is the one place that decides what crosses the wire", spec
 * §3.4/§6) — a documented decision predating this ticket. Rather than
 * silently widen that wire contract, this list shows address + status only
 * and flags the gap here; adding `provider` to `GET /mailboxes` is a
 * one-line follow-up if the maintainer wants the card to show it.
 *
 * ## `?connected=` / `?connect_error=` (HT-123)
 *
 * The engine's Gmail OAuth callback (`src/api/gmail-connect.ts`) redirects
 * back here on both success and failure, carrying only the connected
 * address or a short error code — never a token, `code`, `state`, or
 * secret (that contract lives entirely on the engine side; this screen just
 * renders what already arrived). On mount, a matching param shows a toast
 * and the params are stripped from the URL via `router.replace` so a page
 * refresh doesn't re-show the toast.
 */

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'
import type { MailboxStatus, MailboxSummary } from '../lib/api-types'
import { Button } from './ds/core/Button'
import { EmptyState } from './ds/core/EmptyState'
import { StatusPill } from './ds/core/StatusPill'
import { useToast } from './Toaster'

/** `?connect_error=` codes the engine's callback can send (`src/api/gmail-connect.ts`'s `ConnectRedirectErrorCode`) — kept in sync by hand, same convention `ACTING_AGENT_HEADER` in `lib/api.ts` already uses for a cross-package constant. */
const CONNECT_ERROR_MESSAGES: Record<string, string> = {
  missing_params: 'The connect link was missing required parameters. Please try again.',
  invalid_state: 'That connect link is invalid or has expired. Please try again.',
  exchange_failed: 'Google could not complete the connection. Please try again.',
  no_refresh_token:
    'Google did not grant lasting access. Please try again — the consent screen will show again.',
  watch_failed: 'The mailbox could not be fully connected. Please try again.',
  server_error: 'Something went wrong connecting the mailbox. Please try again.',
}

/**
 * `MailboxStatus` → `StatusPill` — `active` matches the pill's own META key
 * directly; the other three lifecycle states don't (`src/store/
 * mailboxes.ts`'s states are mailbox-specific, not the conversation-status
 * vocabulary `StatusPill` ships with), so they borrow a META key for color
 * only and supply their own label — the same "unrecognized status, our
 * label" pattern `TeamListScreen`'s `statusBadge` uses.
 */
function mailboxStatusPill(status: MailboxStatus) {
  if (status === 'active') return <StatusPill status="active" />
  if (status === 'paused') return <StatusPill status="pending" label="Paused" />
  if (status === 'needs_reconnect') return <StatusPill status="spam" label="Needs reconnect" />
  return <StatusPill status="closed" label="Disconnected" />
}

export function MailboxListScreen({ mailboxes }: { mailboxes: MailboxSummary[] }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const showToast = useToast()

  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when the params actually change — router.replace/showToast are stable across renders (next/navigation, ToasterProvider's useCallback).
  useEffect(() => {
    const connected = searchParams.get('connected')
    const connectError = searchParams.get('connect_error')
    if (connected === null && connectError === null) return

    if (connected !== null) {
      // Only claim success if that address is ACTUALLY in the freshly-fetched
      // roster. `?connected=` is just a query param — anyone can link to
      // /manage/mailboxes?connected=anything and would otherwise be shown a
      // "Mailbox connected" toast for a mailbox that was never connected (a
      // UI-integrity/phishing gap, not XSS — React escapes the text). The
      // roster is server-fetched on this same request, so a genuine callback
      // redirect always finds its mailbox here.
      // Case-INSENSITIVE: the address in the redirect comes from Google's
      // `getProfile()`, whose casing need not match the stored row. An exact
      // comparison would silently swallow the confirmation after a genuinely
      // successful connect — the param is stripped either way, so the operator
      // would be left with no feedback at all.
      const isConnected = mailboxes.some(
        (mailbox) => mailbox.address.toLowerCase() === connected.toLowerCase(),
      )
      if (isConnected) {
        showToast({ title: 'Mailbox connected', detail: connected })
      }
    } else if (connectError !== null) {
      showToast({
        title: 'Could not connect mailbox',
        detail: CONNECT_ERROR_MESSAGES[connectError] ?? 'Please try again.',
      })
    }
    router.replace('/manage/mailboxes')
  }, [searchParams])

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 24 }}>
      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Link
          href="/inbox/open"
          style={{ fontSize: 13, color: 'var(--ht-ink-muted)', textDecoration: 'none' }}
        >
          ← Inbox
        </Link>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Mailboxes</h1>
          <span style={{ flex: 1 }} />
          <Button variant="primary" onClick={() => router.push('/manage/mailboxes/new')}>
            New inbox
          </Button>
        </div>

        {mailboxes.length === 0 ? (
          <EmptyState
            title="No inboxes connected"
            body="Connect a mailbox over IMAP/SMTP to start receiving mail here."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {mailboxes.map((mailbox) => (
              <button
                key={mailbox.id}
                type="button"
                onClick={() => router.push(`/mailbox/${mailbox.id}/settings/connection`)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  boxSizing: 'border-box',
                  textAlign: 'left',
                  border: '1px solid var(--ht-border)',
                  background: 'var(--ht-surface)',
                  borderRadius: 'var(--ht-radius-lg, 8px)',
                  padding: '12px 14px',
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    minWidth: 0,
                    flex: 1,
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: 'var(--ht-ink)',
                    fontFamily: 'var(--ht-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {mailbox.address}
                </div>
                {mailboxStatusPill(mailbox.status)}
              </button>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
