/**
 * Inbound email parsing — turns a raw RFC 5322/MIME message into a
 * normalized, structured `ParsedEmail`.
 *
 * Pure function, no I/O, no side effects, no storage. Built on
 * **postal-mime** (MIT-0, verified at adoption — see CLAUDE.md References &
 * provenance), a modern serverless-friendly MIME parser with zero
 * dependencies of its own.
 *
 * `ParsedEmail` is deliberately RICHER than
 * `NormalizedInboundEmail` (`src/providers/inbound-email.ts`): it carries
 * attachment BYTES inline (`ParsedAttachment.content`), whereas
 * `NormalizedInboundEmail` carries only a `BlobStore` key (`contentRef`).
 * Writing attachment bytes to blob storage is a later step at the store
 * layer, downstream of this pure parse — this module knows nothing about
 * `BlobStore` and never will.
 */

import PostalMime, { type Address, type Attachment, type Header } from 'postal-mime'

/** A single email address, decoded. */
export interface ParsedAddress {
  address: string
  name?: string
}

/**
 * One attachment, bytes included. See the module doc above for why this
 * differs from `NormalizedInboundAttachment` (which carries a `contentRef`
 * instead of `content`).
 */
export interface ParsedAttachment {
  filename: string | null
  contentType: string
  disposition: 'attachment' | 'inline' | null
  contentId: string | null
  /** Size in bytes — `content.byteLength`. */
  size: number
  /** The raw attachment bytes. */
  content: Uint8Array
}

export interface ParsedEmail {
  /**
   * The `Message-ID` header, verbatim including angle brackets, or `null`
   * if absent.
   *
   * Threading-critical: per specs/mail/threading.md, this is a candidate
   * carrier for outbound reply tokens once this message is itself replied
   * to. Never reformatted or stripped of its angle brackets — downstream
   * token matching depends on exact-string comparison.
   */
  messageId: string | null

  /**
   * The `In-Reply-To` header, verbatim, or `null` if absent.
   *
   * Threading-critical: specs/mail/threading.md §3 rule 1 scans this
   * header FIRST for a candidate reply token, ahead of `references`. This
   * parser only surfaces the header faithfully — it does not interpret or
   * verify tokens; that is the threading engine's job.
   */
  inReplyTo: string | null

  /**
   * The `References` header, split into individual message-ids, order
   * preserved (oldest-first, as written on the wire); `[]` if the header
   * is absent or empty.
   *
   * Threading-critical: postal-mime exposes `References` as a single raw
   * string. This parser extracts the angle-bracketed `<...>` message-id
   * tokens (RFC 5322 §3.6.4) via regex, so any CFWS/comments legally
   * interspersed between ids are ignored rather than emitted as bogus
   * "ids", and folded/space-separated ids are handled uniformly. Order is
   * preserved (oldest-first, as written on the wire). specs/mail/threading.md
   * §3 rule 1 scans this array most-recent-first — i.e. the CONSUMER
   * reverses it; this parser preserves wire order and does not reverse.
   */
  references: string[]

  from: ParsedAddress | null
  to: ParsedAddress[]
  cc: ParsedAddress[]

  /** Decoded subject; `''` if the header is absent. */
  subject: string

  /** Parsed `Date` header, or `null` if absent or unparseable. */
  date: Date | null

  /** Plain-text body, if the message provided one; `null` otherwise. */
  text: string | null

  /**
   * HTML body, if the message provided one; `null` otherwise. Captured
   * RAW — NOT sanitized, including any `<script>` content. Sanitization is
   * a deliberately separate, later concern (specs/mail/threading.md §5,
   * "HTML `<script>` tag stored verbatim"); this parser's job is a
   * faithful transcription of what arrived, nothing more.
   */
  html: string | null

  /**
   * All headers, lowercased keys. Where a header name repeats (e.g.
   * multiple `Received` lines), values are joined in wire order with
   * `", "` — postal-mime itself exposes headers as a flat array of
   * individual entries with no built-in multi-value join, so this is this
   * module's own convention, not postal-mime's. Consumers that need exact
   * multi-value semantics (order, repetition) should not rely on this bag
   * for those headers — same caveat `NormalizedInboundEmail.headers`
   * documents.
   */
  headers: Record<string, string>

  attachments: ParsedAttachment[]
}

/**
 * Parse a raw RFC 5322/MIME email into a `ParsedEmail`. Pure: no I/O, no
 * side effects. Rejects if postal-mime cannot parse `raw` at all; malformed
 * individual headers/parts are handled leniently by postal-mime itself and
 * do not throw.
 */
export async function parseInboundEmail(
  raw: Uint8Array | ArrayBuffer | string,
): Promise<ParsedEmail> {
  const email = await PostalMime.parse(raw)

  return {
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null,
    references: parseReferences(email.references),
    from: toParsedAddress(email.from),
    to: toParsedAddressList(email.to),
    cc: toParsedAddressList(email.cc),
    subject: email.subject ?? '',
    date: parseDate(email.date),
    text: email.text ?? null,
    html: email.html ?? null,
    headers: toHeaderRecord(email.headers),
    attachments: email.attachments.map(toParsedAttachment),
  }
}

/**
 * Extract the individual message-ids from a raw `References` header value.
 * A message-id is an angle-bracketed `<...>` token (RFC 5322 §3.6.4).
 * We match those tokens directly rather than splitting on whitespace, so
 * that CFWS/comments legally interspersed between ids (e.g.
 * `References: (legacy MUA) <a@b> <c@d>`) don't leak in as bogus
 * "message-ids". Order is preserved. This is threading-critical.
 */
function parseReferences(references: string | undefined): string[] {
  if (!references) return []
  return references.match(/<[^>]+>/g) ?? []
}

/**
 * Parse postal-mime's `date` (an ISO-8601 string when the header parsed
 * cleanly, or the original raw header string when it didn't — postal-mime
 * does not surface a parse failure separately) into a `Date`, or `null`
 * when the header was absent or unparseable either way.
 */
function parseDate(date: string | undefined): Date | null {
  if (!date) return null
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * postal-mime's `Address` type is a union of a plain `Mailbox`
 * (`{name, address}`) and an RFC 5322 address GROUP
 * (`{name, group: Mailbox[]}`, no top-level `address`). Group syntax is
 * common in `To`/`Cc` and — per RFC 6854 — also legal in `From`. Since
 * `ParsedAddress` is a single flat mailbox, a group-form `From` maps to
 * its FIRST member rather than being dropped to `null` (which would lose
 * the sender). An empty group (no members) maps to `null`. `to`/`cc` use
 * `toParsedAddressList`, which flattens every group member.
 */
function toParsedAddress(addr: Address | undefined): ParsedAddress | null {
  if (!addr) return null
  if (addr.address) {
    return addr.name ? { address: addr.address, name: addr.name } : { address: addr.address }
  }
  const first = addr.group?.[0]
  if (first) {
    return first.name ? { address: first.address, name: first.name } : { address: first.address }
  }
  return null
}

/**
 * Maps a `To`/`Cc` address list. Unlike `toParsedAddress`, an RFC 5322
 * address GROUP entry here is flattened into its member mailboxes rather
 * than dropped — a group is a real, deliverable list of recipients, and
 * flattening preserves them where `ParsedAddress`'s flat shape has no
 * other way to represent a group.
 */
function toParsedAddressList(addrs: Address[] | undefined): ParsedAddress[] {
  if (!addrs) return []
  const result: ParsedAddress[] = []
  for (const addr of addrs) {
    if (addr.address) {
      result.push(
        addr.name ? { address: addr.address, name: addr.name } : { address: addr.address },
      )
    } else if (addr.group) {
      for (const member of addr.group) {
        result.push(
          member.name
            ? { address: member.address, name: member.name }
            : { address: member.address },
        )
      }
    }
  }
  return result
}

/**
 * Builds the lowercased headers `Record`. postal-mime's `headers` array
 * already has lowercased `key`s (per its own README), so this only needs
 * to fold repeated header names together — see the `headers` field doc on
 * `ParsedEmail` for the join convention.
 */
function toHeaderRecord(headers: Header[]): Record<string, string> {
  // Null-prototype: header names come from untrusted senders, so a header
  // literally named `__proto__` or `constructor` must be stored as an
  // ordinary own key, not mutate the object's prototype or read an
  // inherited value. (Prototype-pollution hardening.)
  const record: Record<string, string> = Object.create(null)
  for (const header of headers) {
    const key = header.key.toLowerCase()
    const existing = record[key]
    record[key] = existing === undefined ? header.value : `${existing}, ${header.value}`
  }
  return record
}

/**
 * postal-mime types `Attachment.content` as
 * `ArrayBuffer | Uint8Array | string` because the library CAN emit a
 * decoded string when `attachmentEncoding: 'utf8'` is passed to
 * `PostalMime.parse`. This module never passes that option, so in
 * practice postal-mime's default (`'arraybuffer'`) always applies and
 * `content` is always an `ArrayBuffer` — but the full union is handled
 * here defensively, without `any`, so this stays correct even if a future
 * change threads options through.
 */
function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  if (content instanceof Uint8Array) return content
  return new Uint8Array(content)
}

function toParsedAttachment(attachment: Attachment): ParsedAttachment {
  const content = toBytes(attachment.content)
  return {
    filename: attachment.filename,
    contentType: attachment.mimeType,
    disposition: attachment.disposition,
    contentId: attachment.contentId ?? null,
    size: content.byteLength,
    content,
  }
}
