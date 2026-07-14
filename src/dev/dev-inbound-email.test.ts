/**
 * `createDevInboundEmailProvider` against no real provider — proves the
 * fake's shape satisfies `InboundEmailProvider` (a compile-time check, via
 * the first test's variable annotation) and that queued raw messages
 * (inline bytes AND blob references, metadata included) round-trip through
 * `receiveDelivery` unchanged, in order, matching the interface's "0..N
 * messages per delivery" contract (`src/providers/inbound-email.ts`).
 */

import { describe, expect, it } from 'vitest'
import type { InboundEmailProvider, RawInboundMessage } from '../providers/index.js'
import { createDevInboundEmailProvider } from './dev-inbound-email.js'

const DUMMY_REQUEST = new Request('https://example.test/webhook')

const inlineMessage: RawInboundMessage = {
  content: { kind: 'inline', bytes: new TextEncoder().encode('From: a@example.test\r\n\r\nHi') },
  mailboxId: 'mbox-1',
  providerMessageId: 'provider-msg-1',
  receivedAt: new Date('2026-07-13T12:00:00.000Z'),
}

const blobRefMessage: RawInboundMessage = {
  content: { kind: 'blobRef', blobKey: 'mbox-1/raw/provider-msg-2' },
  mailboxId: 'mbox-1',
  providerMessageId: 'provider-msg-2',
  receivedAt: new Date('2026-07-13T12:05:00.000Z'),
}

describe('createDevInboundEmailProvider', () => {
  it('satisfies the InboundEmailProvider interface', () => {
    // Assigning to the narrower interface type is a compile-time proof the
    // fake's shape satisfies it — if the two drift apart, `npm run
    // typecheck` fails right here, not at some future call site.
    const provider: InboundEmailProvider = createDevInboundEmailProvider()
    expect(typeof provider.verifySignature).toBe('function')
    expect(typeof provider.receiveDelivery).toBe('function')
  })

  it('round-trips a delivery of several raw messages (inline and blobRef) unchanged, in order', async () => {
    const fake = createDevInboundEmailProvider()
    fake.enqueue([inlineMessage, blobRefMessage])

    const received = await fake.receiveDelivery(DUMMY_REQUEST)

    expect(received).toEqual([inlineMessage, blobRefMessage])
  })

  it('returns [] when nothing is queued, matching a real delivery that resolves to zero messages', async () => {
    const fake = createDevInboundEmailProvider()
    await expect(fake.receiveDelivery(DUMMY_REQUEST)).resolves.toEqual([])
  })

  it('drains queued batches FIFO across separate receiveDelivery calls', async () => {
    const fake = createDevInboundEmailProvider()
    fake.enqueue([inlineMessage])
    fake.enqueue([blobRefMessage])

    await expect(fake.receiveDelivery(DUMMY_REQUEST)).resolves.toEqual([inlineMessage])
    await expect(fake.receiveDelivery(DUMMY_REQUEST)).resolves.toEqual([blobRefMessage])
    await expect(fake.receiveDelivery(DUMMY_REQUEST)).resolves.toEqual([])
  })

  it('verifySignature resolves the configured result (default true, overridable to false)', async () => {
    const defaulted = createDevInboundEmailProvider()
    await expect(defaulted.verifySignature(DUMMY_REQUEST)).resolves.toBe(true)

    const rejecting = createDevInboundEmailProvider({ verifySignatureResult: false })
    await expect(rejecting.verifySignature(DUMMY_REQUEST)).resolves.toBe(false)
  })
})
