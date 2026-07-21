/**
 * `fetchImapInboundMessages` against a FAKE {@link ImapClient} — no real
 * IMAP server, no network call. Two jobs:
 *
 * 1. The sacred-invariant equivalence proof this ticket's brief calls for:
 *    the SAME raw RFC822 fixture bytes that go INTO the fake client's
 *    `uidFetchRawSince` come OUT of `fetchImapInboundMessages` byte-
 *    identical (never re-encoded, never touched), and running the pipeline's
 *    single `parseInboundEmail` over those bytes yields the exact structured
 *    result `src/mail/parse.test.ts` already proves for this same fixture —
 *    i.e. the IMAP transport mangles nothing and produces the same result
 *    any other transport would (`../../inbound-email.ts`'s "raw bytes in,
 *    nothing pre-parsed" invariant).
 * 2. The UIDVALIDITY-reset branch and the cursor-advance/bounding logic
 *    (specs/mail/mailbox-connection.md §5), including that the connection
 *    is always closed, even on a mid-fetch throw.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseInboundEmail } from '../../../mail/parse.js'
import type { ImapClient, ImapMailboxInfo, ImapRawMessage } from './client.js'
import { fetchImapInboundMessages } from './fetch.js'

const fixturesDir = fileURLToPath(new URL('../../../../tests/mail/fixtures/', import.meta.url))

/** Load a fixture's bytes EXACTLY as they sit on disk — no encoding, no normalization (mirrors what a real `BODY.PEEK[]` response would hand over). */
function loadFixtureBytes(name: string): Uint8Array {
  return readFileSync(`${fixturesDir}${name}.eml`)
}

/** True iff two byte sequences are identical, content-wise (works across `Buffer`/`Uint8Array`). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b)) === 0
}

/** Records every call made against a fake {@link ImapClient}, in order. */
interface FakeClientCalls {
  connect: number
  selectInbox: number
  uidFetchRawSince: Array<{ sinceUid: number; max: number }>
  close: number
}

function newCallLog(): FakeClientCalls {
  return { connect: 0, selectInbox: 0, uidFetchRawSince: [], close: 0 }
}

/** Build a fake `ImapClient` — records calls in `calls`, returns `mailbox` from `selectInbox`, and either returns `messages` or throws `fetchError` from `uidFetchRawSince`. */
function createFakeClient(
  calls: FakeClientCalls,
  mailbox: ImapMailboxInfo,
  messages: ImapRawMessage[],
  fetchError?: Error,
): ImapClient {
  return {
    async connect() {
      calls.connect++
    },
    async selectInbox() {
      calls.selectInbox++
      return mailbox
    },
    async uidFetchRawSince(sinceUid, max) {
      calls.uidFetchRawSince.push({ sinceUid, max })
      if (fetchError) throw fetchError
      return messages
    },
    async close() {
      calls.close++
    },
  }
}

describe('fetchImapInboundMessages', () => {
  // --- (1) Equivalence proof ------------------------------------------------

  it('emits the fixture bytes byte-identical, and a single parseInboundEmail over them matches the known-good parse', async () => {
    const fixtureBytes = loadFixtureBytes('multipart-alternative')
    const calls = newCallLog()
    const mailbox: ImapMailboxInfo = { uidValidity: 1, uidNext: 33 }
    const internalDate = new Date('2026-06-02T09:30:05.000Z')
    const client = createFakeClient(calls, mailbox, [{ uid: 32, raw: fixtureBytes, internalDate }])

    const result = await fetchImapInboundMessages('mailbox-1', null, () => client, 50)

    expect(result.messages).toHaveLength(1)
    const [message] = result.messages

    // Byte-identical, not merely "similar" — the sacred invariant.
    expect(message.content.kind).toBe('inline')
    if (message.content.kind !== 'inline') throw new Error('unreachable')
    expect(bytesEqual(message.content.bytes, fixtureBytes)).toBe(true)

    expect(message.mailboxId).toBe('mailbox-1')
    expect(message.providerMessageId).toBe('imap:1:32')
    expect(message.receivedAt).toEqual(internalDate)

    // Same single parse the pipeline would run, over the SAME bytes this
    // adapter emitted (not a re-read of the fixture file) — proves the
    // adapter handed over exactly what parseInboundEmail needs, untouched.
    const parsed = await parseInboundEmail(message.content.bytes)
    // Matches src/mail/parse.test.ts's known-good assertions for this exact
    // fixture (multipart/alternative, text AND html both present).
    expect(parsed.messageId).toBe('<msg-b-0001@example.test>')
    expect(parsed.from).toEqual({ address: 'carol@example.test', name: 'Carol Cross' })
    expect(parsed.to).toEqual([{ address: 'dave@example.test', name: 'Dave Recipient' }])
    expect(parsed.subject).toBe('Multipart alternative message')
    expect(parsed.text).toContain('This is the plain text alternative.')
    expect(parsed.html).toContain('This is the <strong>HTML</strong> alternative.')

    // Connection lifecycle: connect -> selectInbox -> fetch -> close, in order.
    expect(calls.connect).toBe(1)
    expect(calls.selectInbox).toBe(1)
    expect(calls.uidFetchRawSince).toEqual([{ sinceUid: 0, max: 50 }])
    expect(calls.close).toBe(1)
  })

  // --- (2) UIDVALIDITY-change branch ----------------------------------------

  it('rebuilds from UID 0 and reports uidValidityReset when the server UIDVALIDITY no longer matches the stored cursor', async () => {
    const calls = newCallLog()
    const mailbox: ImapMailboxInfo = { uidValidity: 2, uidNext: 10 }
    const client = createFakeClient(calls, mailbox, [])

    const result = await fetchImapInboundMessages(
      'mailbox-1',
      { uidValidity: 1, lastUid: 50 }, // stale epoch
      () => client,
      50,
    )

    expect(result.uidValidityReset).toBe(true)
    // Rebuilt from UID 0, NOT the stale lastUid: 50.
    expect(calls.uidFetchRawSince).toEqual([{ sinceUid: 0, max: 50 }])
    expect(result.newCursor).toEqual({ uidValidity: 2, lastUid: 0 })
  })

  it('does NOT report a reset for a brand-new mailbox (cursor === null) — the expected first-run case, not an anomaly', async () => {
    const calls = newCallLog()
    const mailbox: ImapMailboxInfo = { uidValidity: 7, uidNext: 5 }
    const client = createFakeClient(calls, mailbox, [])

    const result = await fetchImapInboundMessages('mailbox-1', null, () => client, 50)

    expect(result.uidValidityReset).toBe(false)
    expect(calls.uidFetchRawSince).toEqual([{ sinceUid: 0, max: 50 }])
    expect(result.newCursor).toEqual({ uidValidity: 7, lastUid: 0 })
  })

  it('does NOT reset when the stored UIDVALIDITY matches the server', async () => {
    const calls = newCallLog()
    const mailbox: ImapMailboxInfo = { uidValidity: 1, uidNext: 60 }
    const client = createFakeClient(calls, mailbox, [])

    const result = await fetchImapInboundMessages(
      'mailbox-1',
      { uidValidity: 1, lastUid: 50 },
      () => client,
      50,
    )

    expect(result.uidValidityReset).toBe(false)
    expect(calls.uidFetchRawSince).toEqual([{ sinceUid: 50, max: 50 }])
    // No new messages -> cursor does not advance past 50.
    expect(result.newCursor).toEqual({ uidValidity: 1, lastUid: 50 })
  })

  // --- (3) Cursor-advance / bounding logic ----------------------------------

  it('advances the cursor to the HIGHEST uid fetched, regardless of return order', async () => {
    const calls = newCallLog()
    const mailbox: ImapMailboxInfo = { uidValidity: 1, uidNext: 20 }
    const d = new Date('2026-06-02T00:00:00.000Z')
    const client = createFakeClient(calls, mailbox, [
      { uid: 12, raw: new Uint8Array([1]), internalDate: d },
      { uid: 15, raw: new Uint8Array([2]), internalDate: d },
      { uid: 13, raw: new Uint8Array([3]), internalDate: d },
    ])

    const result = await fetchImapInboundMessages(
      'mailbox-1',
      { uidValidity: 1, lastUid: 10 },
      () => client,
      50,
    )

    expect(result.newCursor).toEqual({ uidValidity: 1, lastUid: 15 })
    expect(result.messages).toHaveLength(3)
  })

  it('passes maxPerInvocation straight through to uidFetchRawSince, and honours a custom value', async () => {
    const calls = newCallLog()
    const mailbox: ImapMailboxInfo = { uidValidity: 1, uidNext: 20 }
    const client = createFakeClient(calls, mailbox, [])

    await fetchImapInboundMessages('mailbox-1', { uidValidity: 1, lastUid: 5 }, () => client, 7)

    expect(calls.uidFetchRawSince).toEqual([{ sinceUid: 5, max: 7 }])
  })

  it('defaults maxPerInvocation to a conservative bound when not supplied', async () => {
    const calls = newCallLog()
    const mailbox: ImapMailboxInfo = { uidValidity: 1, uidNext: 20 }
    const client = createFakeClient(calls, mailbox, [])

    await fetchImapInboundMessages('mailbox-1', { uidValidity: 1, lastUid: 5 }, () => client)

    expect(calls.uidFetchRawSince[0]?.max).toBe(50)
  })

  it('closes the connection even when uidFetchRawSince throws — never leaves a connection open', async () => {
    const calls = newCallLog()
    const mailbox: ImapMailboxInfo = { uidValidity: 1, uidNext: 20 }
    const client = createFakeClient(calls, mailbox, [], new Error('boom'))

    await expect(
      fetchImapInboundMessages('mailbox-1', { uidValidity: 1, lastUid: 5 }, () => client, 50),
    ).rejects.toThrow('boom')

    expect(calls.connect).toBe(1)
    expect(calls.close).toBe(1)
  })
})
