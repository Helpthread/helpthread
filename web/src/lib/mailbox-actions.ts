'use server'

/**
 * IMAP/SMTP mailbox-connect server actions (HT-101) — mirrors
 * `agent-actions.ts`'s pattern for `NewAgentScreen`: `ConnectInboxForm`
 * never touches `lib/api.ts` directly (server-only, holds the Bearer
 * token), so every call from the form goes through one of these. Neither
 * action ever returns or logs the submitted password — `imapCheckConnection`
 * and `imapConnect`'s own responses never carry it either (see
 * `src/api/imap-connect.ts`'s module doc), so there is nothing to
 * accidentally forward.
 *
 * `connectMailbox` revalidates both the mailboxes list (`/manage/mailboxes`,
 * Global-admin scope) and the mailbox-scoped Connection section
 * (`/mailbox/[id]/settings/connection`) — the two admin-IA-correct homes
 * this ticket moved "New inbox"/"Reconnect" into (specs/ui/admin-ia.md §1),
 * replacing the old single `/settings` revalidation.
 */

import { revalidatePath } from 'next/cache'
import { ApiError, gmailBeginConnect, imapCheckConnection, imapConnect } from './api'
import type { ConnectedMailbox, ImapCheckResult, ImapConnectionInput } from './api-types'

export interface MailboxActionResult {
  ok: boolean
  code?: string
  message?: string
}

function toActionResult(error: unknown): MailboxActionResult {
  if (error instanceof ApiError) {
    return { ok: false, code: error.code, message: error.message }
  }
  return { ok: false, code: 'network', message: 'Could not reach the server.' }
}

export interface CheckMailboxConnectionResult extends MailboxActionResult {
  result?: ImapCheckResult
}

/** `ConnectInboxForm`'s "Check connection" button — attempts both legs, persists nothing regardless of outcome. */
export async function checkMailboxConnection(
  config: ImapConnectionInput,
): Promise<CheckMailboxConnectionResult> {
  try {
    const result = await imapCheckConnection(config)
    return { ok: true, result }
  } catch (error) {
    return toActionResult(error)
  }
}

export interface ConnectMailboxActionResult extends MailboxActionResult {
  mailbox?: ConnectedMailbox
}

/** `ConnectInboxForm`'s "Connect" button — verifies both legs then persists the mailbox. */
export async function connectMailbox(
  config: ImapConnectionInput,
): Promise<ConnectMailboxActionResult> {
  try {
    const mailbox = await imapConnect(config)
    revalidatePath('/manage/mailboxes')
    revalidatePath(`/mailbox/${mailbox.id}/settings/connection`)
    return { ok: true, mailbox }
  } catch (error) {
    return toActionResult(error)
  }
}

export interface BeginGoogleConnectResult extends MailboxActionResult {
  consentUrl?: string
}

/**
 * `ConnectInboxForm`'s "Connect with Google" button (HT-123) — mints the
 * consent URL server-side (the Bearer token never reaches the browser) and
 * hands it back for the client to navigate to. The engine's response only
 * ever carries `consentUrl`, so there is nothing else to accidentally
 * forward.
 */
export async function beginGoogleConnect(): Promise<BeginGoogleConnectResult> {
  try {
    const { consentUrl } = await gmailBeginConnect()
    return { ok: true, consentUrl }
  } catch (error) {
    return toActionResult(error)
  }
}
