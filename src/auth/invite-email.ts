/**
 * Build the invite email `OutboundEmail` (HT-54; specs/auth/agents-and-auth.md
 * §8) — the ONE place this feature constructs a message for the core
 * `EmailSender` transport (`src/providers/email-sender.ts`).
 *
 * ## This is NOT `sendReply`/`src/mail/send.ts`
 *
 * An invite has no conversation, no thread, no reply-token, no delivery
 * lease — routing it through `sendReply` would mint bogus `threads`/
 * `send_envelope` rows for something that isn't a reply to anything (spec
 * §8's explicit call-out). This module builds a fresh {@link OutboundEmail}
 * and the caller (`src/api/agents.ts`) hands it directly to the configured
 * `EmailSender`.
 *
 * ## `messageId` is a bare id, not a reply token
 *
 * `<invite-{uuid}@{mailDomain}>` — NOT `ht.`-shaped (`mintReplyMessageId`),
 * carries no signature, and nothing ever routes on it (there is no inbound
 * reply to an invite email that needs threading back to anything). A bare
 * RFC 5322 Message-ID is exactly what a message with no threading identity
 * needs, and reusing the reply-token format here would falsely imply this
 * id has threading authority it does not.
 */

import { randomUUID } from 'node:crypto'
import type { OutboundEmail } from '../providers/email-sender.js'

/** Input to {@link buildInviteEmail}. */
export interface InviteEmailInput {
  /** The invited Agent's email address. */
  to: string
  /** The signed invite token (`mintInviteToken`, `src/auth/invite-token.ts`) — embedded verbatim in the accept link. */
  token: string
  /** The web UI's base URL (`HELPTHREAD_UI_BASE_URL`) — the link is `${uiBaseUrl}/invite/${token}`. */
  uiBaseUrl: string
  /** The deployment's configured support address — the `from` on this email, matching every other Agent-facing message this engine sends. */
  supportAddress: string
  /** Domain minted into the bare `Message-ID` — matches every other outbound message's `@domain` part. */
  mailDomain: string
}

/**
 * Build the invite email. Text-only (per the brief: "do NOT fabricate
 * tracking or styling") — a minimal, professional message using Agent/Team
 * vocabulary (CLAUDE.md), never "user".
 */
export function buildInviteEmail(input: InviteEmailInput): OutboundEmail {
  const link = `${input.uiBaseUrl}/invite/${input.token}`
  return {
    messageId: `<invite-${randomUUID()}@${input.mailDomain}>`,
    from: input.supportAddress,
    to: [input.to],
    subject: `You're invited to join ${input.mailDomain} on Helpthread`,
    text: [
      "You've been invited to join the support team on Helpthread.",
      '',
      `Accept your invite: ${link}`,
      '',
      "If you weren't expecting this invite, you can safely ignore this email.",
    ].join('\n'),
  }
}
