/**
 * `InboundEmailProvider` — the seam for inbound mail arriving via provider
 * webhooks.
 *
 * See `src/providers/README.md` for the pattern this fits into. Per
 * CHARTER.md §2/§4, inbound mail arrives via **push webhooks**, never IMAP
 * polling — "no daemons, no polling loops" applies to inbound mail first
 * and foremost. This is where Gmail-push-via-Pub/Sub plugs in today, and
 * where later providers (Postmark inbound, SES inbound, etc.) plug in
 * without the engine changing: regardless of provider, the engine only
 * ever sees a `NormalizedInboundEmail`.
 */

/** A normalized attachment reference. Bytes live in the `BlobStore`, not inline. */
export interface NormalizedInboundAttachment {
  filename: string
  contentType: string
  /** Size in bytes. */
  size: number
  /**
   * Key into a `BlobStore` where the attachment's bytes have already been
   * written by the provider adapter. Attachments are never carried inline
   * in `NormalizedInboundEmail` — the adapter is responsible for writing
   * bytes to the `BlobStore` (with a correctly tenant/conversation-
   * namespaced key, per `BlobStore`'s key-namespacing contract) before
   * producing this reference.
   */
  contentRef: string
}

/**
 * The provider-agnostic shape the engine consumes for every inbound
 * email, regardless of which provider webhook produced it.
 *
 * `inReplyTo` and `references` are carried through unmodified from the
 * inbound message's headers for the threading engine to consume — this
 * interface only normalizes and transports them; it does not interpret
 * them. Per CHARTER.md §2 ("Threading authority lives on the outbound
 * side"), these inbound headers are not trusted as the authority for
 * threading — the engine's outbound-Message-ID signed-reply-token scheme
 * is. See HT-8 for that spec; this type does not re-specify it.
 */
export interface NormalizedInboundEmail {
  /** The `Message-ID` of the inbound message, as received. */
  messageId: string

  /** The `In-Reply-To` header, if present, verbatim. */
  inReplyTo?: string

  /** The `References` header, split into individual message-ids, verbatim order preserved. */
  references: string[]

  from: string
  to: string[]
  cc: string[]
  subject: string

  /** When the provider recorded/delivered the message (not a header-parsed date). */
  receivedAt: Date

  /** Plain-text body, if the message provided one. */
  text?: string

  /** HTML body, if the message provided one. */
  html?: string

  /**
   * Raw headers as received, lower-cased keys, for any header the engine
   * needs beyond the fields already normalized above. Multi-value headers
   * are joined per the provider adapter's convention; consumers that need
   * exact multi-value semantics should not rely on this bag for those
   * headers.
   */
  headers: Record<string, string>

  attachments: NormalizedInboundAttachment[]
}

/**
 * Provider for turning one inbound-mail provider's webhook delivery into
 * the engine's normalized shape. One implementation per provider (Gmail
 * push/Pub/Sub, Postmark inbound, SES inbound, ...).
 */
export interface InboundEmailProvider {
  /**
   * Verify that `request` is an authentic webhook delivery from this
   * provider (signature/token/shared-secret check, as the provider
   * requires). MUST be called — and MUST resolve `true` — before
   * `parseWebhook` is trusted to run against `request`'s body;
   * implementations of `parseWebhook` may assume the caller has already
   * verified the request and are not required to re-verify internally.
   *
   * Async by contract: the first adapter (Gmail push) verifies a Google
   * OIDC JWT, which may require fetching/refreshing signing certificates.
   * Adapters whose check is purely synchronous simply return a resolved
   * promise.
   */
  verifySignature(request: Request): Promise<boolean>

  /**
   * Parse and normalize one webhook delivery into a
   * `NormalizedInboundEmail`. Rejects if the payload cannot be parsed as a
   * valid message for this provider. Any attachment bytes present in the
   * payload are written to a `BlobStore` by the implementation before
   * this resolves, so the returned attachments carry `contentRef`s rather
   * than inline bytes.
   */
  parseWebhook(request: Request): Promise<NormalizedInboundEmail>
}
