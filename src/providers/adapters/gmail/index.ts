/**
 * Barrel for the Gmail `EmailSender` adapter. Composition roots import from
 * here (never from `sender.ts`/`mime.ts` directly) — see
 * `src/providers/README.md`'s "adapters are selected at the composition
 * root" rule.
 */

export type { GmailEmailSenderOptions } from './sender.js'
export { createGmailEmailSender } from './sender.js'
