/**
 * `createImapClient` against a FAKE {@link ImapFlowLike} — no real IMAP
 * server, no network. This is the coverage the injectable-flow factory exists
 * for: the UID-discovery/bounding/ordering logic that talks to imapflow lives
 * in `client.ts` and cannot be reached through the higher-level `ImapClient`
 * fake that `fetch.test.ts` uses.
 *
 * The fake reproduces the two IMAP behaviours that make naive bounding wrong:
 *   1. UIDs are SPARSE — a mailbox's live messages can sit at any UID, not
 *      near 1 (expunged history, or a fresh UIDVALIDITY epoch on a busy
 *      server). A `sinceUid+1 : sinceUid+max` UID *range* would fetch nothing
 *      here while mail waits above it — the stall this client was fixed to
 *      avoid (see `client.ts`'s module doc).
 *   2. `UID SEARCH UID N:*` still matches the single highest message when `N`
 *      exceeds it (IMAP ranges are order-independent), so the client must
 *      filter to strictly `> sinceUid` or it would re-fetch an already-seen
 *      message forever.
 */

import { describe, expect, it } from 'vitest'
import type { ImapFlowLike } from './client.js'
import { createImapClient, IMAPS_PORT, imapImplicitTlsForPort } from './client.js'

interface FakeFlowState {
  uidValidity: bigint | number
  uidNext: number
  /** UID -> raw source bytes for every message currently in the mailbox. */
  messages: Map<number, Buffer>
  /** Order the fake's FETCH stream yields UIDs in (defaults to as-requested); used to prove the client re-sorts. */
  fetchYieldOrder?: number[]
  /** Records the arguments the client passed, for assertions. */
  calls: { searchRanges: string[]; fetchUidSets: number[][]; connect: number; logout: number }
}

function newState(
  partial: Partial<FakeFlowState> & { messages: Map<number, Buffer> },
): FakeFlowState {
  return {
    uidValidity: 1,
    uidNext: 1,
    calls: { searchRanges: [], fetchUidSets: [], connect: 0, logout: 0 },
    ...partial,
  }
}

/** A fake imapflow that faithfully models `UID SEARCH UID N:*` (including the >max quirk) and a UID FETCH of an explicit set. */
function createFakeFlow(state: FakeFlowState): ImapFlowLike {
  return {
    async connect() {
      state.calls.connect++
    },
    async mailboxOpen() {
      return { uidValidity: state.uidValidity, uidNext: state.uidNext }
    },
    async search(query) {
      state.calls.searchRanges.push(query.uid)
      const lower = Number(query.uid.split(':')[0])
      const present = [...state.messages.keys()]
      let matches = present.filter((uid) => uid >= lower)
      // IMAP: `N:*` matches the highest message even when N exceeds it.
      if (matches.length === 0 && present.length > 0) {
        matches = [Math.max(...present)]
      }
      return matches.sort((a, b) => a - b)
    },
    async *fetch(range) {
      state.calls.fetchUidSets.push([...range])
      const order = state.fetchYieldOrder ?? range
      for (const uid of order) {
        if (!range.includes(uid)) continue
        const source = state.messages.get(uid)
        if (source === undefined) continue
        yield { uid, source, internalDate: new Date('2026-06-02T00:00:00.000Z') }
      }
    },
    async logout() {
      state.calls.logout++
    },
    close() {},
  }
}

function rawFor(uid: number): Buffer {
  return Buffer.from(`raw-bytes-for-uid-${uid}`)
}

describe('createImapClient.uidFetchRawSince', () => {
  it('fetches messages that sit at high, sparse UIDs — the case a UID range would have stalled on', async () => {
    // Live mail at 900001/900002/900005 and nothing near 1. The old
    // `1:50` range would return zero here and the cursor would never move.
    const messages = new Map([
      [900001, rawFor(900001)],
      [900002, rawFor(900002)],
      [900005, rawFor(900005)],
    ])
    const state = newState({ uidValidity: 7, uidNext: 900006, messages })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await client.connect()
    const result = await client.uidFetchRawSince(0, 50)

    expect(result.map((m) => m.uid)).toEqual([900001, 900002, 900005])
    expect(result.map((m) => Buffer.from(m.raw).toString())).toEqual([
      'raw-bytes-for-uid-900001',
      'raw-bytes-for-uid-900002',
      'raw-bytes-for-uid-900005',
    ])
    // Discovered via SEARCH UID 1:*, then fetched the explicit UID set.
    expect(state.calls.searchRanges).toEqual(['1:*'])
    expect(state.calls.fetchUidSets).toEqual([[900001, 900002, 900005]])
  })

  it('does not stall when the next real UID is far above the stored cursor', async () => {
    // Cursor at 50, but the next message is at 900001. A `51:100` range would
    // fetch nothing forever; count-based discovery catches it.
    const state = newState({
      uidValidity: 1,
      uidNext: 900002,
      messages: new Map([[900001, rawFor(900001)]]),
    })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await client.connect()
    const result = await client.uidFetchRawSince(50, 50)

    expect(result.map((m) => m.uid)).toEqual([900001])
    expect(state.calls.searchRanges).toEqual(['51:*'])
  })

  it('bounds by message COUNT, returning the lowest `max` new UIDs', async () => {
    const messages = new Map([
      [10, rawFor(10)],
      [20, rawFor(20)],
      [30, rawFor(30)],
      [40, rawFor(40)],
    ])
    const state = newState({ messages })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await client.connect()
    const result = await client.uidFetchRawSince(5, 2)

    expect(result.map((m) => m.uid)).toEqual([10, 20])
    expect(state.calls.fetchUidSets).toEqual([[10, 20]])
  })

  it('never re-fetches an already-seen message via the `N:*` includes-highest quirk', async () => {
    // We have already fetched everything up to UID 32 (the highest present).
    // `SEARCH UID 33:*` still returns [32] on a real server; the client must
    // drop it because 32 is not > sinceUid(32).
    const state = newState({ messages: new Map([[32, rawFor(32)]]) })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await client.connect()
    const result = await client.uidFetchRawSince(32, 50)

    expect(result).toEqual([])
    // Filtered before any FETCH — no wasted fetch of the already-seen message.
    expect(state.calls.fetchUidSets).toEqual([])
  })

  it('returns an empty result for an empty mailbox', async () => {
    const state = newState({ messages: new Map() })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await client.connect()
    expect(await client.uidFetchRawSince(0, 50)).toEqual([])
    expect(state.calls.fetchUidSets).toEqual([])
  })

  it('re-sorts the FETCH stream into oldest-UID-first order', async () => {
    const messages = new Map([
      [10, rawFor(10)],
      [20, rawFor(20)],
      [30, rawFor(30)],
    ])
    // Server streams them out of order.
    const state = newState({ messages, fetchYieldOrder: [30, 10, 20] })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await client.connect()
    const result = await client.uidFetchRawSince(0, 50)

    expect(result.map((m) => m.uid)).toEqual([10, 20, 30])
  })

  it('narrows a bigint UIDVALIDITY to a number in selectInbox', async () => {
    const state = newState({ uidValidity: 4294967295n, uidNext: 5, messages: new Map() })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await client.connect()
    const info = await client.selectInbox()
    expect(info.uidValidity).toBe(4294967295)
    expect(typeof info.uidValidity).toBe('number')
  })

  it('throws if any method is called before connect()', async () => {
    const state = newState({ messages: new Map() })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await expect(client.selectInbox()).rejects.toThrow('connect() must be called')
  })

  it('logs out on close', async () => {
    const state = newState({ messages: new Map() })
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => createFakeFlow(state),
    )

    await client.connect()
    await client.close()
    expect(state.calls.logout).toBe(1)
  })

  it('throws (never silently drops) when the server returns a UID with no source', async () => {
    const flow: ImapFlowLike = {
      async connect() {},
      async mailboxOpen() {
        return { uidValidity: 1, uidNext: 2 }
      },
      async search() {
        return [1]
      },
      async *fetch() {
        yield { uid: 1, source: undefined, internalDate: new Date() }
      },
      async logout() {},
      close() {},
    }
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => flow,
    )

    await client.connect()
    await expect(client.uidFetchRawSince(0, 50)).rejects.toThrow('returned no message source')
  })

  it('throws when INTERNALDATE came back unparsed (a string, not a Date)', async () => {
    const flow: ImapFlowLike = {
      async connect() {},
      async mailboxOpen() {
        return { uidValidity: 1, uidNext: 2 }
      },
      async search() {
        return [1]
      },
      async *fetch() {
        yield { uid: 1, source: Buffer.from('x'), internalDate: 'not-a-date' }
      },
      async logout() {},
      close() {},
    }
    const client = createImapClient(
      { host: 'imap.test', port: 993, auth: { user: 'u', pass: 'p' } },
      () => flow,
    )

    await client.connect()
    await expect(client.uidFetchRawSince(0, 50)).rejects.toThrow(
      'did not return a parsed INTERNALDATE',
    )
  })
})

// HT-101 review fix (CodeRabbit, 2026-07-31). A single shared `secure` flag was
// fed to BOTH the IMAP and SMTP legs. Every connect-UI preset pairs IMAP on 993
// with SMTP on 465 or 587, so an Outlook/iCloud preset (`smtpPort: 587`,
// `secure: false`) made the IMAP leg attempt STARTTLS against an implicit-TLS
// port, which cannot succeed. TLS mode is now derived per leg from its own port.
describe('imapImplicitTlsForPort', () => {
  it('uses implicit TLS on 993, the IANA imaps port', () => {
    expect(imapImplicitTlsForPort(993)).toBe(true)
    expect(imapImplicitTlsForPort(IMAPS_PORT)).toBe(true)
  })

  it('uses STARTTLS on 143, the cleartext-then-upgrade port', () => {
    expect(imapImplicitTlsForPort(143)).toBe(false)
  })

  it("does NOT take its answer from an SMTP port — 587 and 465 are the SMTP leg's business", () => {
    expect(imapImplicitTlsForPort(587)).toBe(false)
    expect(imapImplicitTlsForPort(465)).toBe(false)
  })

  it('the regression itself: an Outlook-shaped preset still gets implicit TLS on its IMAP leg', () => {
    // imapPort 993 + smtpPort 587 + secure:false — the exact shape that broke.
    const preset = { imapPort: 993, smtpPort: 587, secure: false }
    expect(imapImplicitTlsForPort(preset.imapPort)).toBe(true)
    // ...and the shared flag is NOT what decides it.
    expect(imapImplicitTlsForPort(preset.imapPort)).not.toBe(preset.secure)
  })
})
