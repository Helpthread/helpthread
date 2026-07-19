/**
 * Build the "new passkey added" notification email (HT-75;
 * specs/auth/passkeys.md §5.3) — sent on every successful
 * `registration/verify`, out-of-band evidence that a credential was
 * created, since §10 notes a stolen session's registration attempt would
 * otherwise be invisible to the legitimate Agent.
 *
 * Same precedent as `src/auth/invite-email.ts`'s `buildInviteEmail`: build
 * a fresh {@link OutboundEmail} and hand it directly to the configured
 * `EmailSender`, NOT through `sendReply`/`src/mail/send.ts` — there is no
 * conversation this belongs to. `messageId` is likewise a bare id, not a
 * reply token — nothing ever routes an inbound reply back to it.
 */

import { randomUUID } from 'node:crypto'
import type { OutboundEmail } from '../providers/email-sender.js'

/** Input to {@link buildPasskeyAddedEmail}. */
export interface PasskeyAddedEmailInput {
  /** The Agent's own email address. */
  to: string
  /** The credential's user-assigned (or server-defaulted) name — spec §9's `name` field. */
  credentialName: string
  /** The deployment's configured support address — the `from` on this email. */
  supportAddress: string
  /** Domain minted into the bare `Message-ID` — matches every other outbound message's `@domain` part. */
  mailDomain: string
}

/**
 * Build the notification email. Text-only, minimal — matches
 * `buildInviteEmail`'s "no fabricated tracking or styling" posture.
 * Content per spec §5.3: which credential, roughly when, and a one-line
 * "if this wasn't you" remediation pointer.
 */
export function buildPasskeyAddedEmail(input: PasskeyAddedEmailInput): OutboundEmail {
  return {
    messageId: `<webauthn-${randomUUID()}@${input.mailDomain}>`,
    from: input.supportAddress,
    to: [input.to],
    subject: 'A new passkey was added to your Helpthread account',
    text: [
      `A new passkey named "${input.credentialName}" was just added to your account.`,
      '',
      `Time: ${new Date().toISOString()}`,
      '',
      "If this wasn't you, revoke it from your profile and change your password immediately.",
    ].join('\n'),
  }
}
