/**
 * A dev-only `EmailSender` (`src/providers/email-sender.ts`) for the local
 * API harness (HT-24): it delivers nothing, ever — no provider, no network
 * call — and instead logs the full `OutboundEmail` to stdout, so a developer
 * running `npm run dev:api` can see exactly what the engine would have sent.
 *
 * `maxSendMs` is set well below `DEFAULT_LEASE_MS` (`src/mail/send.ts`,
 * 120 000ms) — required by the `EmailSender` contract (see that interface's
 * doc comment) so `assertLeaseExceedsSenderBound` never rejects this sender
 * at a claim site. `5_000` is arbitrary but generous for a synchronous
 * console write that never actually waits on I/O.
 */

import type { EmailSender, EmailSendResult, OutboundEmail } from '../providers/index.js'

/** See the module doc: comfortably below `DEFAULT_LEASE_MS`, and irrelevant in practice since `send` never actually waits on anything. */
const DEV_SENDER_MAX_SEND_MS = 5_000

/**
 * Build the dev `EmailSender`. Every call resolves immediately with an empty
 * result (no `providerMessageId` — there is no provider) after logging the
 * recipient(s), subject, and `Message-ID` (the reply-token contract every
 * `EmailSender` must transmit verbatim — see the interface doc) to stdout.
 */
export function createDevEmailSender(): EmailSender {
  return {
    maxSendMs: DEV_SENDER_MAX_SEND_MS,

    async send(email: OutboundEmail): Promise<EmailSendResult> {
      console.log('[dev-sender] would send (nothing actually delivered):')
      console.log(`  To:         ${email.to.join(', ')}`)
      if (email.cc !== undefined && email.cc.length > 0) {
        console.log(`  Cc:         ${email.cc.join(', ')}`)
      }
      console.log(`  Subject:    ${email.subject}`)
      console.log(`  Message-ID: ${email.messageId}`)
      return {}
    },
  }
}
