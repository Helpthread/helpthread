/**
 * `verifySmtpConnection` — the SMTP leg of the connect/check API (HT-101
 * Stage 2a-ii; specs/mail/mailbox-connection.md §5's connect flow). Builds a
 * nodemailer transporter from `host`/`port`/`secure`/`auth`/`timeoutMs` — the
 * SAME options shape `./sender.ts`'s `createSmtpEmailSender` builds its own
 * transporter from — and calls its `.verify()`: an SMTP handshake plus AUTH,
 * per nodemailer's own contract, with NO message ever composed or sent. This
 * is a pure connectivity/credential check, never a send — the outbound send
 * path (`./sender.ts`, `src/mail/send.ts`) is untouched by this module.
 *
 * Resolves on success; throws whatever nodemailer's `.verify()` rejects with,
 * UNWRAPPED — this module adds no message of its own and does no logging.
 * The caller (`src/mail/imap-connect.ts`) is what turns a thrown error into a
 * bounded, secret-free string for a `LegResult`/`ImapConnectError`; keeping
 * that sanitization in ONE place (the connect service) rather than
 * duplicating it here matches `./sender.ts`'s own division of labor (this
 * adapter maps options, the caller decides what is safe to surface).
 *
 * `transporter` is injectable, mirroring `./sender.ts`'s identical
 * `SmtpTransporter` pattern — tests pass a fake `.verify()`, no real SMTP
 * server or network call. REQUIRED to be absent for the real adapter to
 * touch the network at all.
 *
 * Never logs the password: this function does no logging of any kind, and
 * nodemailer's transporter is built with the SAME `logger: false`-equivalent
 * posture `./sender.ts`/`../imap/client.ts` already apply to their own
 * transports — nodemailer transporters do not log connection detail unless a
 * `logger`/`debug` option is explicitly turned on, which this module never
 * sets.
 */

import nodemailer from 'nodemailer'

/**
 * The minimal nodemailer surface this module depends on — injectable for
 * tests (mirrors `./sender.ts`'s `SmtpTransporter`). A real nodemailer
 * `Transporter` satisfies this structurally; tests pass a fake with no real
 * SMTP/network machinery involved.
 */
export interface SmtpVerifyTransporter {
  verify(): Promise<true>
}

/** Options for {@link verifySmtpConnection}. */
export interface VerifySmtpConnectionOptions {
  host: string
  port: number
  /** Implicit TLS. Defaults to `true` — matches `./sender.ts`'s/`../imap/client.ts`'s own default rationale. */
  secure?: boolean
  auth: {
    user: string
    /** The app password (or equivalent) being verified. Never logged by this module. */
    pass: string
  }
  /**
   * Milliseconds before the verify handshake is abandoned. Defaults to
   * 30 000, matching `./sender.ts`. Applied to nodemailer's own
   * `connectionTimeout`/`greetingTimeout`/`socketTimeout`.
   */
  timeoutMs?: number
  /**
   * Injectable transporter, for tests (see `verify.test.ts`). Defaults to a
   * real nodemailer SMTP transporter built from `host`/`port`/`secure`/
   * `auth`/`timeoutMs` above. REQUIRED to be absent for the real adapter to
   * touch the network at all — a test that supplies this never does.
   */
  transporter?: SmtpVerifyTransporter
}

/** Matches `./sender.ts`'s own default. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Race `promise` against a rejecting timer — the same outer backstop
 * `./sender.ts` applies to `sendMail`, for the same reason its doc gives:
 * nodemailer exposes no cancellation token, so the socket-level
 * `connectionTimeout`/`greetingTimeout`/`socketTimeout` are the only bounds,
 * and this guarantees the call settles even in the pathological case those
 * fail to fire.
 *
 * `verify()` needed it MORE than `sendMail` did, not less (found by review,
 * 2026-07-25): sending happens on a cron tick, where a hang costs one wasted
 * invocation, but `verifySmtpConnection` runs synchronously inside the
 * connect/check HTTP request, where a hang holds an operator's request open
 * indefinitely.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`verifySmtpConnection: verify timed out after ${timeoutMs}ms`))
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
 * Verify an SMTP connection: handshake + AUTH, no message sent. See the
 * module doc for the full contract. Throws the provider's own error,
 * unwrapped, on any failure.
 */
export async function verifySmtpConnection(options: VerifySmtpConnectionOptions): Promise<void> {
  const { host, port, secure = true, auth, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  const transporter: SmtpVerifyTransporter =
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

  await withTimeout(Promise.resolve(transporter.verify()), timeoutMs)
}
