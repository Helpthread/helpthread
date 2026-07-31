/**
 * `SenderResolver` — resolves the `EmailSender` + `from` address a REPLY
 * should use from the mailbox its conversation belongs to (HT-101 Stage
 * 2b-ii; specs/mail/mailbox-connection.md's "route each outbound reply
 * through the same inbox its conversation arrived at").
 *
 * Before this module, every reply sent through a single, hardcoded
 * `EmailSender` bound to the deployment's one Gmail mailbox
 * (`config.supportAddress`) — `src/composition/root.ts`'s original `sender`
 * wiring. Stage 2b-i stamped each conversation with the `mailboxId` its
 * first inbound message arrived at (`StoredConversation.mailboxId`); this
 * module is what a caller (`handleReply`, the delivery worker) uses to turn
 * that id back into a live, per-mailbox sender at send time — a Gmail
 * mailbox sends through ITS OWN OAuth token, an IMAP/SMTP mailbox through
 * ITS OWN configured mail server, never the deployment's single default.
 *
 * ## `null` means "the deployment's default" (pre-2b-i conversations)
 *
 * A conversation created before Stage 2b-i carries `mailboxId: null`. {@link
 * SenderResolver.resolve} treats `null` as "resolve the deployment's default
 * mailbox" — the mailbox whose address is {@link SenderResolverDeps
 * .defaultAddress} (`config.supportAddress`) — and then resolves THAT
 * mailbox by the exact same provider-branch logic below. This preserves
 * today's pre-2b-i behavior byte-for-byte: every reply on an unstamped
 * conversation keeps going out through the same mailbox it always did.
 *
 * That is the ONLY way `null` arises. A stamped conversation can never
 * decay to `null`: migration 028's FK is `ON DELETE RESTRICT`, so a mailbox
 * with conversations cannot be deleted. This matters here specifically —
 * if a delete could null the column, this function would silently start
 * sending an existing thread's replies from a different address, which is
 * the authorship guarantee CHARTER.md §2 makes explicit.
 *
 * ## Never imports an adapter directly
 *
 * Per `src/providers/README.md`'s composition-root discipline, this module
 * never imports `createGmailEmailSender`/`createSmtpEmailSender` — only
 * their TYPES, for typing the two factories it requires as dependencies. The
 * composition root (`src/composition/root.ts`) is the one place the REAL
 * factories are passed in; tests inject fakes.
 *
 * ## Never logs or returns a password/token
 *
 * The IMAP branch reads `mailbox.id`'s decrypted app password
 * (`ImapCredentialStore.getPassword`) only to hand it straight to
 * `createSmtpEmailSender`'s `auth.pass` — it is never logged, never included
 * in a thrown error message, and never returned to any caller. The Gmail
 * branch never touches a token directly at all — it hands
 * `tokenService.getAccessToken` through as a callback, exactly like
 * `src/composition/root.ts`'s original wiring did.
 */

import type { GmailEmailSenderOptions } from '../providers/adapters/gmail/index.js'
import type { SmtpEmailSenderOptions } from '../providers/adapters/smtp/index.js'
import type { EmailSender } from '../providers/index.js'
import type { ImapConfigStore } from '../store/imap-config.js'
import { ImapCredentialDecryptError, type ImapCredentialStore } from '../store/imap-credentials.js'
import type { MailboxRecord, MailboxStore } from '../store/mailboxes.js'
import type { GmailOAuthTokenService } from './gmail-oauth.js'

/** The two failure shapes {@link SenderResolutionError} can carry — every one is a "this reply cannot be sent as configured" condition, never a transient fault. */
export type SenderResolutionErrorCode =
  | 'mailbox-not-found'
  | 'missing-imap-connection'
  | 'unreadable-imap-credential'
  | 'unknown-provider'

/**
 * Thrown by {@link SenderResolver.resolve} when a mailbox cannot be resolved
 * to a live sender — a genuinely unexpected/operator-fixable condition (a
 * dangling `mailboxId`, an IMAP mailbox never finished its connect flow, or a
 * mailbox row with a provider this resolver doesn't know), never a routine
 * outcome a caller is expected to branch on. `message` never includes a
 * password or token (module doc).
 */
export class SenderResolutionError extends Error {
  readonly code: SenderResolutionErrorCode

  constructor(code: SenderResolutionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SenderResolutionError'
    this.code = code
  }
}

/** Dependencies {@link createSenderResolver} needs. */
export interface SenderResolverDeps {
  mailboxStore: MailboxStore
  /** Resolves a Gmail mailbox's live OAuth access token by mailbox id (`src/mail/gmail-oauth.ts`). */
  tokenService: Pick<GmailOAuthTokenService, 'getAccessToken'>
  imapConfigStore: ImapConfigStore
  imapCredentialStore: ImapCredentialStore
  /**
   * Builds a Gmail `EmailSender` — REQUIRED and injected, never imported
   * directly (module doc). The composition root passes in the real
   * `createGmailEmailSender` (`../providers/adapters/gmail/index.js`); tests
   * pass a fake.
   */
  createGmailEmailSender: (options: GmailEmailSenderOptions) => EmailSender
  /**
   * Builds an SMTP `EmailSender` — REQUIRED and injected, same rationale as
   * `createGmailEmailSender` above. The composition root passes in the real
   * `createSmtpEmailSender` (`../providers/adapters/smtp/index.js`); tests
   * pass a fake.
   */
  createSmtpEmailSender: (options: SmtpEmailSenderOptions) => EmailSender
  /**
   * The deployment's configured default/support address
   * (`config.supportAddress`) — the mailbox a `null` `mailboxId` resolves to
   * (module doc's "`null` means the deployment's default" section).
   */
  defaultAddress: string
}

/** Resolves the `EmailSender` + `from` address a reply to a given mailbox should use. See the module doc for the full contract. */
export interface SenderResolver {
  /**
   * Resolve `mailboxId` (or, when `null`, the deployment's default mailbox —
   * module doc) to a live `EmailSender` bound to THAT mailbox's own
   * credentials, plus the `from` address to send as (always that mailbox's
   * `address`). Throws {@link SenderResolutionError} if the mailbox cannot be
   * resolved to a sender — see that class's doc comment for the specific
   * conditions.
   */
  resolve(mailboxId: string | null): Promise<{ sender: EmailSender; from: string }>
}

/** Build a {@link SenderResolver}. See the module doc for the full contract. */
export function createSenderResolver(deps: SenderResolverDeps): SenderResolver {
  const {
    mailboxStore,
    tokenService,
    imapConfigStore,
    imapCredentialStore,
    createGmailEmailSender,
    createSmtpEmailSender,
    defaultAddress,
  } = deps

  async function resolveForMailbox(
    mailbox: MailboxRecord,
  ): Promise<{ sender: EmailSender; from: string }> {
    if (mailbox.provider === 'gmail') {
      return {
        sender: createGmailEmailSender({
          getAccessToken: () => tokenService.getAccessToken(mailbox.id),
        }),
        from: mailbox.address,
      }
    }

    if (mailbox.provider === 'imap') {
      // `getPassword` THROWS on an undecryptable credential (wrong
      // HELPTHREAD_TOKEN_ENC_KEY, tampered ciphertext) rather than returning
      // null. Left raw, it escapes as something `runDeliveryWorker` does not
      // recognise, and that worker rethrows anything that is not a
      // `SenderResolutionError`, aborting the ENTIRE sweep — one mailbox with
      // a bad key would stop outbound retries for every other mailbox.
      //
      // ONLY `ImapCredentialDecryptError` is contained. An earlier revision
      // caught every rejection here, which swept database faults into the same
      // bucket: `runDeliveryWorker` marks a `SenderResolutionError` row
      // `failed`, so a transient Postgres blip would have permanently failed
      // outbound mail that merely needed retrying (review, 2026-07-31). A
      // store fault must keep propagating and abort the sweep for a retry.
      const [config, password] = await Promise.all([
        imapConfigStore.getConfig(mailbox.id),
        imapCredentialStore.getPassword(mailbox.id).catch((cause: unknown) => {
          if (!(cause instanceof ImapCredentialDecryptError)) {
            throw cause
          }
          throw new SenderResolutionError(
            'unreadable-imap-credential',
            `mailbox ${mailbox.id} (${mailbox.address}) has an IMAP/SMTP credential that could not be decrypted — ` +
              `check HELPTHREAD_TOKEN_ENC_KEY, or reconnect the inbox to store a fresh app password`,
            { cause },
          )
        }),
      ])
      if (config === null || password === null) {
        throw new SenderResolutionError(
          'missing-imap-connection',
          `mailbox ${mailbox.id} (${mailbox.address}) is missing its IMAP/SMTP ` +
            `${config === null ? 'connection config' : 'credential'} — cannot send as this mailbox`,
        )
      }
      return {
        sender: createSmtpEmailSender({
          host: config.smtpHost,
          port: config.smtpPort,
          secure: config.secure,
          auth: { user: config.username, pass: password },
        }),
        from: mailbox.address,
      }
    }

    throw new SenderResolutionError(
      'unknown-provider',
      `mailbox ${mailbox.id} (${mailbox.address}) has unrecognized provider '${mailbox.provider}' — cannot resolve a sender`,
    )
  }

  return {
    async resolve(mailboxId) {
      if (mailboxId === null) {
        const mailbox = await mailboxStore.getMailboxByAddress(defaultAddress)
        if (mailbox === null) {
          throw new SenderResolutionError(
            'mailbox-not-found',
            `no connected mailbox for the deployment's default address (${defaultAddress}) — ` +
              `connect it via the OAuth or IMAP/SMTP connect flow first`,
          )
        }
        return resolveForMailbox(mailbox)
      }

      const mailbox = await mailboxStore.getMailboxById(mailboxId)
      if (mailbox === null) {
        throw new SenderResolutionError('mailbox-not-found', `no mailbox with id ${mailboxId}`)
      }
      return resolveForMailbox(mailbox)
    },
  }
}
