/**
 * Barrel for the SMTP adapter (HT-101 Stage 1: `EmailSender` over the
 * operator's own mail server, specs/mail/mailbox-connection.md §5/§7).
 * Composition roots import from here (never from `sender.ts` directly) —
 * see `src/providers/README.md`'s "adapters are selected at the
 * composition root" rule.
 */

export type { SmtpEmailSenderOptions, SmtpTransporter } from './sender.js'
export { createSmtpEmailSender } from './sender.js'
