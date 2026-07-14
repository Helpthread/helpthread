/**
 * Barrel for the Gmail adapters (outbound `EmailSender`, the push-webhook
 * OIDC JWT verifier, and the history/raw-fetch client, HT-39/HT-41).
 * Composition roots import from here (never from
 * `sender.ts`/`mime.ts`/`push-auth.ts`/`history.ts` directly) — see
 * `src/providers/README.md`'s "adapters are selected at the composition
 * root" rule.
 */

export type {
  GmailHistoryClient,
  GmailHistoryClientOptions,
  ListAddedMessageIdsResult,
  RawGmailMessage,
} from './history.js'
export { createGmailHistoryClient } from './history.js'
export {
  createGmailPushSignatureVerifier,
  createGooglePushKeySource,
  type GmailPushJwtConfig,
  type GmailPushKeySource,
  verifyGmailPushJwt,
} from './push-auth.js'
export type { GmailEmailSenderOptions } from './sender.js'
export { createGmailEmailSender } from './sender.js'
