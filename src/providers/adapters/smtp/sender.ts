/**
 * SMTP `EmailSender` adapter — transmits `OutboundEmail`s through the
 * operator's OWN mail server (specs/mail/mailbox-connection.md §5,
 * "Outbound — the operator's own SMTP"; §7 build order item 4, HT-101
 * Stage 1). Built on **nodemailer** (MIT-0 — verified in
 * `node_modules/nodemailer/package.json` at adoption, 2026-07-20), injected
 * as a `transporter` port (mirrors the Gmail adapter's `fetchImpl`
 * injection, `../gmail/sender.ts`) so the mapping logic below is
 * unit-testable with a fake — no real SMTP server, no network call.
 *
 * ## The `Message-ID` contract — verified against nodemailer's own source
 *
 * Per `../../email-sender.ts`'s module doc, every `EmailSender` MUST
 * transmit `messageId`/`inReplyTo`/`references` verbatim and must NOT let
 * the provider generate or overwrite `Message-ID`. Traced directly (not
 * assumed) in `node_modules/nodemailer/lib/mail-composer/index.js`'s
 * `compile()`: when `mail.messageId` is set, it calls
 * `this.message.setHeader('message-id', mail.messageId)` explicitly, THEN
 * calls `this.message.messageId()` to ensure the header is present.
 * `mime-node`'s `messageId()` (`lib/mime-node/index.js`) only generates and
 * sets a RANDOM id when `getHeader('Message-ID')` is falsy — since
 * `compile()` already set it, the random generator never fires. This is the
 * SAME "pre-declared field, generator only fires if unset" shape the Gmail
 * adapter's `mime.ts` documents for `mimetext`, verified independently here
 * for nodemailer. `references`/`in-reply-to` are set the same explicit way.
 * `mime-node`'s `_encodeHeaderValue` wraps `Message-ID`/`In-Reply-To` in
 * angle brackets ONLY IF NOT ALREADY PRESENT (`OutboundEmail.messageId`/
 * `.inReplyTo` already carry them — see that module's doc), so this is
 * idempotent, not a rewrite.
 *
 * `EmailSendResult.providerMessageId` is read from nodemailer's own
 * `info.messageId` — NEVER copied from `OutboundEmail.messageId` in this
 * module's code, per the seam's module doc. Note for the reviewer: unlike
 * Gmail's `users.messages.send` (which returns a genuinely distinct
 * Gmail-internal id), nodemailer's own type doc for `SentMessageInfo`
 * states "most transports should return the final Message-Id value used" —
 * i.e. for SMTP, `info.messageId` is typically just an ECHO of the same
 * `Message-ID` header we set, not a separate provider id. Confirmed
 * empirically in `sender.test.ts` via nodemailer's real (no-network)
 * `streamTransport`. This is directly relevant to specs/mail/mailbox-
 * connection.md's still-UNRESOLVED self-echo-suppression question
 * (candidate answer: suppress on our own minted Message-ID) — flagged for
 * the reviewer, not resolved here; Stage 1 does not wire the suppression
 * ledger at all.
 *
 * ## Injection hardening — verified, then added anyway where verification
 * left a gap
 *
 * Traced `_normalizeAddress` (`lib/mime-node/index.js`): address headers
 * (`from`/`to`/`cc`) already strip control characters (including CR/LF) and
 * angle brackets before assembly. `_encodeHeaderValue`'s `Message-ID`/
 * `In-Reply-To`/`References`/`default` branches all strip embedded newlines
 * too. So nodemailer already neutralizes header-injection at the VALUE
 * level for everything this adapter sends — verified by reading the
 * source, not assumed. The one gap that verification does NOT close: those
 * strips are silent (a newline becomes a space), which would silently
 * mangle `email.messageId` — the one sacred, verbatim-or-nothing field —
 * into something that no longer matches what `mintReplyMessageId` produced,
 * without ever throwing. So this module adds ONE loud guard on `messageId`
 * specifically (not the whole gmail/mime.ts guard suite, which exists to
 * work around mimetext NOT sanitizing at all — a different library with a
 * different gap): a stray control character there means the engine itself
 * minted something malformed, which should fail loudly rather than be
 * silently reformatted.
 */

import nodemailer from 'nodemailer'
import type { EmailSender, EmailSendResult, OutboundEmail } from '../../email-sender.js'

/**
 * The minimal nodemailer surface this adapter depends on — injectable for
 * tests (mirrors `fetchImpl` in `../gmail/sender.ts`). A real nodemailer
 * `Transporter` satisfies this structurally; tests pass a fake with no real
 * SMTP/network machinery involved.
 */
export interface SmtpTransporter {
  sendMail(mailOptions: nodemailer.SendMailOptions): Promise<{ messageId?: string }>
}

/** Options for {@link createSmtpEmailSender}. */
export interface SmtpEmailSenderOptions {
  host: string
  port: number
  /** Implicit TLS. Defaults to `true` (submission-over-TLS, port 465) — matches `../imap/client.ts`'s default rationale. */
  secure?: boolean
  auth: {
    user: string
    /** An app password or equivalent mailbox-send credential. Never logged by this module. */
    pass: string
  }
  /**
   * Milliseconds before `send()` is abandoned. Defaults to 30 000, matching
   * the Gmail adapter (`../gmail/sender.ts`). Applied to nodemailer's own
   * `connectionTimeout`/`greetingTimeout`/`socketTimeout` (bounding the
   * real socket-level phases) AND to an outer `Promise.race` this module
   * enforces itself (see `send()`'s implementation doc) — this is also
   * declared as `EmailSender.maxSendMs`, so raising it must be weighed
   * against the delivery lease exactly as `../gmail/sender.ts`'s doc
   * describes.
   */
  timeoutMs?: number
  /**
   * Injectable transporter, for tests (see `sender.test.ts`). Defaults to a
   * real nodemailer SMTP transporter built from `host`/`port`/`secure`/
   * `auth`/`timeoutMs` above. REQUIRED to be absent for the real adapter to
   * touch the network at all — a test that supplies this never does.
   */
  transporter?: SmtpTransporter
}

/** Matches the Gmail adapter's `timeoutMs` default (`../gmail/sender.ts`). */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * True if `value` contains any C0 control character (codes 0-31, including
 * CR/LF/TAB) or DEL (127) — the messageId verbatim-contract guard (module
 * doc's "Injection hardening" section). Written as an explicit code-point
 * scan, not a regex character class, so no raw control-character literal
 * needs to appear in this source file at all.
 */
function hasControlOrNewline(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Race `promise` against a timer that REJECTS after `timeoutMs` — a real,
 * mechanical bound (`EmailSender.maxSendMs`'s doc: "not an estimate or an
 * aspiration"). Unlike the Gmail adapter's `AbortSignal.timeout` (which
 * actually cancels the underlying `fetch`), nodemailer's `sendMail()`
 * exposes no cancellation token, so this cannot abort an in-flight SMTP
 * conversation — only nodemailer's own `connectionTimeout`/
 * `greetingTimeout`/`socketTimeout` (set to the same `timeoutMs` where this
 * module builds the default transporter) can do that, at the socket level.
 * What this race DOES guarantee, unconditionally, is the contract's literal
 * requirement: the `send()` call itself SETTLES (by rejecting) within
 * `timeoutMs`, even in the pathological case those socket-level timeouts
 * fail to fire (or an injected fake transporter's promise never settles at
 * all). Flagged for review as a judgment call: this is a weaker guarantee
 * than Gmail's true cancellation, though it satisfies the same contract.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`createSmtpEmailSender: send timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Build the `EmailSender` implementation for SMTP. See the module doc for
 * the `Message-ID` verbatim contract (verified against nodemailer's own
 * source) and the injection-hardening rationale.
 */
export function createSmtpEmailSender(options: SmtpEmailSenderOptions): EmailSender {
  const { host, port, secure = true, auth, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  const transporter: SmtpTransporter =
    options.transporter ??
    nodemailer.createTransport({
      host,
      port,
      secure,
      auth,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    })

  return {
    // Same value the race below enforces — one variable, so the declared
    // bound and the enforced one cannot drift apart (mirrors
    // `../gmail/sender.ts`'s identical rationale).
    maxSendMs: timeoutMs,

    async send(email: OutboundEmail): Promise<EmailSendResult> {
      if (!email.text && !email.html) {
        throw new Error(
          'createSmtpEmailSender: OutboundEmail must include at least one of text/html — refusing to send a bodyless message',
        )
      }
      // The one sacred field: a control/CRLF character here means the
      // engine itself minted a malformed Message-ID (module doc's
      // "Injection hardening" section) — loud failure, not nodemailer's own
      // silent CRLF->space mangling, which would otherwise violate the
      // verbatim contract without ever telling anyone.
      if (hasControlOrNewline(email.messageId)) {
        throw new Error(
          'createSmtpEmailSender: messageId contains a control or newline character — refusing to send (this would violate the verbatim Message-ID contract)',
        )
      }

      const info = await withTimeout(
        transporter.sendMail({
          messageId: email.messageId,
          inReplyTo: email.inReplyTo,
          references: email.references,
          from: email.from,
          to: email.to,
          cc: email.cc,
          subject: email.subject,
          text: email.text,
          html: email.html,
        }),
        timeoutMs,
      )

      // The provider's OWN id — never OutboundEmail.messageId (module doc).
      return { providerMessageId: info.messageId }
    },
  }
}
