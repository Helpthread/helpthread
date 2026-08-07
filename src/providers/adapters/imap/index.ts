/**
 * Barrel for the IMAP adapter (HT-101 Stage 1: bounded scheduled fetch,
 * specs/mail/mailbox-connection.md §5/§7). Composition roots import from
 * here (never from `client.ts`/`fetch.ts` directly) — see
 * `src/providers/README.md`'s "adapters are selected at the composition
 * root" rule.
 */

export type { ImapClient, ImapClientOptions, ImapMailboxInfo, ImapRawMessage } from './client.js'
export { createImapClient, IMAPS_PORT, imapImplicitTlsForPort } from './client.js'
export type { ImapCursor, ImapFetchResult } from './fetch.js'
export { DEFAULT_MAX_PER_INVOCATION, fetchImapInboundMessages } from './fetch.js'
