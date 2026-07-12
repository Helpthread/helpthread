/**
 * `EmailSender` — the seam for transmitting outbound mail.
 *
 * See `src/providers/README.md` for the pattern this fits into. This is the
 * `send()` half of specs/mail/sending.md; `src/mail/send.ts` (`sendReply`)
 * is the engine-side orchestration that calls it as step 3 of the
 * persist→send→mark ordering (specs/mail/sending.md §3).
 *
 * ## The `Message-ID` contract is load-bearing
 *
 * Outbound-anchored threading (specs/mail/threading.md §2, specs/mail/sending.md
 * §1) only works if the `Message-ID` a customer's reply eventually echoes
 * back in `In-Reply-To`/`References` is EXACTLY the signed-token id the
 * engine minted (`mintReplyMessageId`, `src/mail/reply-token.ts`) — not a
 * provider-generated substitute. So every `EmailSender` implementation MUST
 * transmit `OutboundEmail.messageId` **verbatim** as the RFC 5322
 * `Message-ID` header, and MUST NOT generate or overwrite it with a
 * provider-assigned id. `inReplyTo` and `references`, when present, are
 * likewise engine-set (specs/mail/sending.md §5: caller-supplied from the
 * inbound message being answered) and must be transmitted as given, not
 * reinterpreted. A provider SDK that cannot set `Message-ID` explicitly
 * (some transactional-email APIs only expose a "reply-to" concept and mint
 * their own `Message-ID` unconditionally) is unusable for Helpthread and
 * must not be adapted to this interface — there is no fallback path that
 * preserves threading correctness.
 *
 * `EmailSendResult.providerMessageId` is a SEPARATE, optional field for the
 * provider's own internal delivery id (e.g. for looking up delivery status
 * or bounce webhooks in that provider's dashboard/API later). It carries no
 * threading authority and is never compared against `messageId` — the two
 * ids serve entirely different purposes and must not be confused.
 */

/** One fully-formed outbound email, ready to transmit. */
export interface OutboundEmail {
  /**
   * Engine-minted `Message-ID` (the signed reply token, WITH angle
   * brackets — see `mintReplyMessageId`). The provider MUST send this
   * verbatim as the RFC 5322 `Message-ID` header; see the module doc.
   */
  messageId: string

  /** `In-Reply-To` header value, if this is a reply, verbatim (engine-set — see the module doc). */
  inReplyTo?: string

  /** `References` header values, verbatim, in the order they should appear (engine-set — see the module doc). */
  references?: string[]

  from: string
  to: string[]
  cc?: string[]
  subject: string

  /** Plain-text body. At least one of `text`/`html` should be provided. */
  text?: string

  /** HTML body. At least one of `text`/`html` should be provided. */
  html?: string
}

/**
 * The result of a successful send. `providerMessageId` — the provider's own
 * internal id for this delivery, if it returns one — carries no threading
 * authority; see the module doc for why it is kept separate from
 * `OutboundEmail.messageId`.
 */
export interface EmailSendResult {
  providerMessageId?: string
}

/**
 * Provider for transmitting one outbound email. One implementation per
 * provider (Postmark, SES, Resend, ...). See the module doc for the
 * `Message-ID` contract every implementation must uphold.
 */
export interface EmailSender {
  /**
   * The upper bound, in milliseconds, that this implementation ITSELF
   * enforces on one `send()` call — a real, mechanical timeout (e.g. an
   * `AbortSignal.timeout` on the underlying HTTP request), not an estimate
   * or an aspiration. Every `send()` call MUST settle (resolve or reject)
   * within this many milliseconds.
   *
   * Why the contract carries this: the delivery lease (`DEFAULT_LEASE_MS`,
   * `src/mail/send.ts`) must strictly exceed the worst-case `send()`
   * duration, or a re-claimed retry can race a still-in-flight send into a
   * concurrent double-send (specs/mail/sending.md §3a, §4). The engine's
   * retry paths assert `maxSendMs < leaseMs` before claiming a row, so an
   * adapter whose bound is missing or too large fails loudly at the call
   * site instead of silently re-opening that hole. Declaring a value the
   * implementation does not actually enforce defeats the check — set it
   * from the same variable that configures the real timeout (see the Gmail
   * adapter's `timeoutMs`).
   */
  readonly maxSendMs: number

  /**
   * Send `email`. Resolves with an {@link EmailSendResult} on success.
   * Rejects (throws) on any failure to hand the message to the provider —
   * `src/mail/send.ts`'s `sendReply` treats a rejection as a delivery
   * failure and marks the outbound thread `'failed'` accordingly
   * (specs/mail/sending.md §3). Must settle within {@link maxSendMs}.
   */
  send(email: OutboundEmail): Promise<EmailSendResult>
}
