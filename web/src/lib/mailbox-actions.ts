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
 */

import { revalidatePath } from 'next/cache'
import { ApiError, imapCheckConnection, imapConnect } from './api'
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
    revalidatePath('/settings')
    return { ok: true, mailbox }
  } catch (error) {
    return toActionResult(error)
  }
}
