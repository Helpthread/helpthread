/**
 * `InboundEmailProvider` — the seam for inbound mail arriving via provider
 * webhooks.
 *
 * See `src/providers/README.md` for the pattern this fits into. Per
 * CHARTER.md §2/§4, inbound mail arrives via **push webhooks**, never IMAP
 * polling — "no daemons, no polling loops" applies to inbound mail first
 * and foremost. This is where Gmail-push-via-Pub/Sub plugs in today, and
 * where later providers (Postmark inbound, SES inbound, a forwarding-
 * address transport, ...) plug in without the engine changing.
 *
 * ## Raw bytes in, nothing pre-parsed
 *
 * specs/mail/inbound-ingestion.md §2 is the contract this interface
 * implements, in full. A provider's job is narrow: authenticate a
 * delivery, and produce, per message, the raw RFC822 bytes (or a reference
 * to them) plus the metadata the transport authoritatively knows. A
 * provider MUST NOT parse the MIME, and MUST NOT extract attachments —
 * both require parsing the message, and that spec's invariant #1 ("parse
 * exactly once, by our own code", §1) reserves to the pipeline's single
 * `parseInboundEmail` call (`src/mail/parse.ts`). A second, provider-
 * specific parser living inside an adapter is exactly the divergence that
 * invariant forbids — threading would end up depending on how faithfully a
 * given provider happened to preserve headers we never controlled.
 *
 * This is a correction (HT-35) of the interface as first drafted, which
 * returned a `NormalizedInboundEmail` — headers and body already parsed,
 * attachments already blob-referenced — putting the parse inside the
 * provider and handing attachment ownership to the transport. See
 * specs/mail/inbound-ingestion.md §2's "Correction (HT-35)" note.
 *
 * A provider MAY still need to interpret its OWN transport envelope to do
 * its job — e.g. a Gmail-push adapter reads a Pub/Sub JSON body to learn a
 * `historyId`, then calls the Gmail API to resolve which messages that
 * batch contains. That is not the parsing this boundary forbids: the line
 * is the RFC822/MIME content of the message itself, which stays untouched
 * bytes all the way to `receiveDelivery`'s return value.
 */

/**
 * The raw RFC822 message bytes for one inbound message, or a reference to
 * them.
 *
 * A discriminated union tagged on `kind` — matching this codebase's
 * convention for result-shape polymorphism (see `QueueHandlerResult`,
 * `src/providers/queue.ts`) — rather than a plain `Uint8Array | { blobKey:
 * string }` union, so consumers narrow with a `kind` check instead of an
 * `instanceof` test, and a future third representation (e.g. a stream)
 * could be added without disturbing existing narrowing code.
 *
 * `blobRef` exists for a delivery whose payload makes holding the full raw
 * message in memory impractical (e.g. one large message inside a Gmail
 * history batch of many). The provider writes the raw bytes to the shared
 * `BlobStore` (`src/providers/blob.ts`) under a mailbox-namespaced key
 * BEFORE returning, and `blobKey` is that key — read back with
 * `BlobStore.get`. This is a DIFFERENT blob than any attachment blob the
 * pipeline writes after parsing (specs/mail/inbound-ingestion.md §3): this
 * one holds the whole unparsed message and is written by the provider, not
 * the pipeline.
 */
export type RawMessageContent =
  | { kind: 'inline'; bytes: Uint8Array }
  | { kind: 'blobRef'; blobKey: string }

/**
 * One inbound message as handed off by the provider: raw, unparsed content
 * (see the module doc) plus the minimum metadata the pipeline needs and the
 * transport authoritatively knows (specs/mail/inbound-ingestion.md §2).
 */
export interface RawInboundMessage {
  /** The raw RFC822 bytes for this message, or a reference to them. */
  content: RawMessageContent

  /**
   * Which connected mailbox this arrived at — the namespace anchor for
   * storage, blobs, dedup, and, later, tenancy (HT-36). The provider
   * resolves this to a known mailbox and rejects a delivery it cannot; the
   * pipeline receives an already-resolved `mailboxId`, never a raw provider
   * address.
   */
  mailboxId: string

  /**
   * The transport's own stable id for this message (for Gmail, the Gmail
   * message id). This is the idempotency authority
   * (specs/mail/inbound-ingestion.md §4) — NOT the RFC `Message-ID`, which
   * is optional (`NewThread.messageId` permits `null`,
   * `src/store/conversations.ts`) and entirely sender-controlled.
   */
  providerMessageId: string

  /** When the provider recorded/delivered the message — not a header-parsed `Date`. */
  receivedAt: Date
}

/**
 * Provider for turning one inbound-mail provider's webhook delivery into
 * the raw message(s) it contains. One implementation per provider (Gmail
 * push/Pub/Sub, Postmark inbound, SES inbound, ...).
 */
export interface InboundEmailProvider {
  /**
   * Verify that `request` is an authentic webhook delivery from this
   * provider (signature/token/shared-secret check, as the provider
   * requires). MUST be called — and MUST resolve `true` — before
   * `receiveDelivery` is trusted to run against `request`; implementations
   * of `receiveDelivery` may assume the caller has already verified the
   * request and are not required to re-verify internally.
   *
   * Async by contract: the first adapter (Gmail push) verifies a Google
   * OIDC JWT, which may require fetching/refreshing signing certificates.
   * Adapters whose check is purely synchronous simply return a resolved
   * promise.
   */
  verifySignature(request: Request): Promise<boolean>

  /**
   * Read one webhook delivery and return the raw message(s) it carries —
   * unparsed, per the module doc — plus each one's provider metadata. A
   * single delivery may carry zero messages (e.g. a Gmail Pub/Sub
   * notification whose history batch resolved to nothing new) up to N (e.g.
   * a history batch spanning several new messages); callers MUST NOT assume
   * exactly one. Rejects if `request` cannot be recognized as a valid
   * delivery notification for this provider — recognizing the transport's
   * own envelope (e.g. Pub/Sub JSON) is not the MIME-parsing this boundary
   * forbids; see the module doc.
   *
   * A `Request` body can only be read once. Whichever call site invokes
   * both `verifySignature` and `receiveDelivery` against the same incoming
   * request owns making sure each still has a readable body if its
   * implementation needs one (e.g. by passing `request.clone()` to one of
   * the two calls) — this interface does not thread a pre-read body between
   * them.
   */
  receiveDelivery(request: Request): Promise<RawInboundMessage[]>
}
