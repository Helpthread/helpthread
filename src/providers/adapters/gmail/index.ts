/**
 * Barrel for the Gmail adapters (outbound `EmailSender` + the push-webhook
 * OIDC JWT verifier, HT-39). Composition roots import from here (never from
 * `sender.ts`/`mime.ts`/`push-auth.ts` directly) — see
 * `src/providers/README.md`'s "adapters are selected at the composition
 * root" rule.
 */

export {
  createGmailPushSignatureVerifier,
  createGooglePushKeySource,
  type GmailPushJwtConfig,
  type GmailPushKeySource,
  verifyGmailPushJwt,
} from './push-auth.js'
export type { GmailEmailSenderOptions } from './sender.js'
export { createGmailEmailSender } from './sender.js'
