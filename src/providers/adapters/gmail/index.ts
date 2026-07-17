/**
 * Barrel for the Gmail adapters (outbound `EmailSender`, the push-webhook
 * OIDC JWT verifier, the history/raw-fetch client, and the watch-arm/
 * profile client, HT-39/HT-40/HT-41). Composition roots import from here
 * (never from
 * `sender.ts`/`mime.ts`/`push-auth.ts`/`history.ts`/`watch.ts` directly) —
 * see `src/providers/README.md`'s "adapters are selected at the
 * composition root" rule.
 */

export type {
  AddedGmailMessage,
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
export type {
  GmailProfileResult,
  GmailWatchClient,
  GmailWatchClientOptions,
  GmailWatchInput,
  GmailWatchResult,
} from './watch.js'
export { createGmailWatchClient } from './watch.js'
