/**
 * A dev-only, in-memory `InboundEmailProvider` (`src/providers/inbound-
 * email.ts`) fake: no real provider, no network call, no webhook wire
 * format. Messages are queued directly via `enqueue` rather than decoded
 * from a `Request` body, so downstream tests (the ingest pipeline, HT-36+;
 * specs/mail/inbound-ingestion.md §8's acceptance suite) can drive
 * `InboundEmailProvider` consumers without a real provider or its adapter —
 * mirrors `dev-sender.ts`'s role for `EmailSender`.
 *
 * `receiveDelivery` ignores its `request` argument entirely and returns the
 * next queued batch (FIFO), or `[]` if nothing is queued — matching a real
 * provider's "zero messages" delivery case (see the interface doc).
 * `verifySignature` resolves a fixed, constructor-supplied result (default
 * `true`) for every call, since this fake has no signature scheme of its
 * own to check.
 */

import type { InboundEmailProvider, RawInboundMessage } from '../providers/index.js'

/** Options for {@link createDevInboundEmailProvider}. */
export interface DevInboundEmailProviderOptions {
  /** What `verifySignature` resolves to for every call. Defaults to `true`. */
  verifySignatureResult?: boolean
}

/** The `InboundEmailProvider` fake this module builds. See the module doc. */
export interface DevInboundEmailProvider extends InboundEmailProvider {
  /**
   * Queue `messages` to be returned by the NEXT `receiveDelivery` call. Each
   * `receiveDelivery` call drains exactly one previously-queued batch
   * (FIFO), so a test can simulate a delivery containing zero, one, or
   * several messages simply by choosing what it queues — including queueing
   * `[]` explicitly to simulate a delivery that resolved to nothing new.
   */
  enqueue(messages: RawInboundMessage[]): void
}

/**
 * Build the dev `InboundEmailProvider` fake. See the module doc for what it
 * does and does not simulate.
 */
export function createDevInboundEmailProvider(
  options: DevInboundEmailProviderOptions = {},
): DevInboundEmailProvider {
  const { verifySignatureResult = true } = options
  const queue: RawInboundMessage[][] = []

  return {
    async verifySignature(_request: Request): Promise<boolean> {
      return verifySignatureResult
    },

    async receiveDelivery(_request: Request): Promise<RawInboundMessage[]> {
      return queue.shift() ?? []
    },

    enqueue(messages: RawInboundMessage[]): void {
      queue.push(messages)
    },
  }
}
