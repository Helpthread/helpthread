/**
 * Push a synthetic inbound email through the REAL ingest pipeline
 * (`src/mail/ingest.ts`) from the local harness — the missing half of a
 * local end-to-end run.
 *
 * `dev-inbound-email.ts` fakes the provider *interface*, which suits tests
 * that drive `InboundEmailProvider` consumers. It does not help someone who
 * wants a conversation to appear and a `conversation.message_received`
 * event to fire, because nothing in the harness was pumping that provider.
 * This goes the other way: build RFC822 bytes, hand them to
 * `ingestInboundMessage`, and let every downstream consequence — threading,
 * dedup, the outbox write — happen exactly as it does in production.
 *
 * Dev-only by construction: it fabricates a `providerMessageId` and treats
 * the caller's word as the transport's, both of which a real provider
 * would supply and neither of which anything should trust outside a
 * local harness.
 */

import { randomUUID } from 'node:crypto'
import { type IngestDeps, type IngestOutcome, ingestInboundMessage } from '../mail/ingest.js'

export interface InjectInboundOptions {
  /** Which connected mailbox the message arrives at. */
  mailboxId: string
  /** Envelope sender — the "customer" writing in. */
  from: string
  /** Envelope recipient; normally the mailbox's own support address. */
  to: string
  subject: string
  /** Plain-text body. */
  text: string
  /**
   * The transport's own message id — ingest's idempotency authority
   * (inbound-ingestion.md §4). Omitted, a fresh one is generated, so each
   * call is a distinct delivery. Supply the SAME value twice to replay one
   * delivery and exercise dedup, which is otherwise unreachable from this
   * harness.
   */
  providerMessageId?: string
  /**
   * `In-Reply-To` for a reply into an existing thread. Omitted for a fresh
   * message, which is what makes the difference between
   * `conversation.created` + `message_received` and a bare
   * `message_received`.
   */
  inReplyTo?: string
}

/**
 * Reject a header value carrying a line break. A bare CR or LF ends the
 * header — and two end the header block — so an unescaped newline in a
 * subject or address silently rewrites the rest of the message, including
 * the body boundary. Dev-only input is still input.
 */
function headerValue(name: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`inject-inbound: ${name} must not contain a line break`)
  }
  return value
}

/** Build the RFC822 bytes for {@link injectInboundMessage}. Exported for tests that want to assert on the wire format rather than the outcome. */
export function buildRawMessage(options: InjectInboundOptions, messageId: string): string {
  const headers = [
    `From: ${headerValue('from', options.from)}`,
    `To: ${headerValue('to', options.to)}`,
    `Subject: ${headerValue('subject', options.subject)}`,
    `Message-ID: <${headerValue('messageId', messageId)}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ]
  if (options.inReplyTo !== undefined) {
    const inReplyTo = headerValue('inReplyTo', options.inReplyTo)
    headers.push(`In-Reply-To: <${inReplyTo}>`)
    headers.push(`References: <${inReplyTo}>`)
  }
  return `${headers.join('\r\n')}\r\n\r\n${options.text}\r\n`
}

/**
 * Ingest one synthetic message. Returns the pipeline's own outcome, so a
 * caller can see which conversation it landed on and whether it threaded
 * or created.
 */
export async function injectInboundMessage(
  options: InjectInboundOptions,
  deps: IngestDeps,
): Promise<IngestOutcome> {
  const messageId = `dev-${randomUUID()}@dev.localhost`
  const raw = buildRawMessage(options, messageId)

  return ingestInboundMessage(
    {
      content: { kind: 'inline', bytes: new TextEncoder().encode(raw) },
      mailboxId: options.mailboxId,
      // A real provider's own id. Generated per call by default, so two
      // injections of identical text are two deliveries — but caller-
      // supplied when replaying, because regenerating it unconditionally
      // made a retried POST silently create a second conversation and a
      // second webhook, and made the harness structurally unable to
      // exercise dedup at all.
      providerMessageId: options.providerMessageId ?? `dev-${randomUUID()}`,
      receivedAt: new Date(),
      // Nothing classified this message; 'unknown' is the honest answer and
      // keeps a synthetic message out of the spam status.
      providerSpamVerdict: 'unknown',
    },
    deps,
  )
}
