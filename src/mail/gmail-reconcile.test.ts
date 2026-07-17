/**
 * `createGmailReconcileHandler` against fully-faked dependencies — no real
 * Gmail API, no real database. Exercises the orchestration control flow
 * (module doc in `gmail-reconcile.ts`): the cursor-advance rule, the
 * expired-cursor pause, the token-failure branches, the inline-vs-blobRef
 * split, and every early-ack short circuit.
 */

import { describe, expect, it, vi } from 'vitest'
import type { GmailReconcileJob } from '../api/gmail-webhook.js'
import { GMAIL_RECONCILE_TOPIC } from '../api/gmail-webhook.js'
import type { GmailHistoryClient } from '../providers/adapters/gmail/history.js'
import type { BlobStore, RawInboundMessage } from '../providers/index.js'
import type { QueueMessage } from '../providers/queue.js'
import type { GmailWatchStateStore } from '../store/gmail-watch-state.js'
import type { MailboxRecord, MailboxStore } from '../store/mailboxes.js'
import type { GmailOAuthTokenService } from './gmail-oauth.js'
import {
  createGmailReconcileHandler,
  DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS,
  type GmailReconcileHandlerDeps,
} from './gmail-reconcile.js'
import type { IngestOutcome } from './ingest.js'

const MAILBOX_ID = '11111111-1111-4111-8111-111111111111'

function activeMailbox(overrides: Partial<MailboxRecord> = {}): MailboxRecord {
  return {
    id: MAILBOX_ID,
    address: 'support@example.test',
    provider: 'gmail',
    status: 'active',
    ...overrides,
  }
}

/** A `MailboxStore` fake backed by an in-memory map, mutable via `records` so tests can assert side effects (markPaused/markNeedsReconnect). */
function fakeMailboxStore(initial: MailboxRecord): {
  store: MailboxStore
  records: Map<string, MailboxRecord>
} {
  const records = new Map<string, MailboxRecord>([[initial.id, initial]])
  return {
    store: {
      async getMailboxByAddress(address) {
        for (const r of records.values()) {
          if (r.address === address) return r
        }
        return null
      },
      async getMailboxById(id) {
        return records.get(id) ?? null
      },
      async markNeedsReconnect(id) {
        const r = records.get(id)
        if (r === undefined) throw new Error(`no mailbox ${id}`)
        records.set(id, { ...r, status: 'needs_reconnect' })
      },
      async markPaused(id) {
        const r = records.get(id)
        if (r === undefined) throw new Error(`no mailbox ${id}`)
        records.set(id, { ...r, status: 'paused' })
      },
      async markDisconnected(id) {
        const r = records.get(id)
        if (r === undefined) throw new Error(`no mailbox ${id}`)
        records.set(id, { ...r, status: 'disconnected' })
      },
      async upsertConnectedMailbox() {
        throw new Error('upsertConnectedMailbox: not used by the reconcile handler')
      },
      async listActiveMailboxes() {
        throw new Error('listActiveMailboxes: not used by the reconcile handler')
      },
    },
    records,
  }
}

/**
 * A `GmailWatchStateStore` fake backed by in-memory maps. `leases` tracks
 * each mailbox's held lease as `{ until, token }` (absent = unclaimed) and
 * is exposed directly so a test can rewind `until` into the past —
 * mirroring `conversations.test.ts`'s `expireLease` helper for the outbound
 * lease — to exercise lease expiry without a real sleep. `token` mirrors
 * the real store's opaque lease-token contract (`src/store/gmail-watch-
 * state.ts`): `claimReconcileLease` returns it on success,
 * `releaseReconcileLease` clears the lease ONLY if the token passed back
 * still matches, exactly like the real `claimed_until`-scoped `UPDATE`.
 * `rows` mirrors the real store's "no `gmail_watch_state` row" case:
 * `claimReconcileLease` requires a row to exist, exactly like the real
 * `UPDATE`-only (non-upserting) SQL.
 */
function fakeWatchStateStore(initial: Record<string, string> = {}): {
  store: GmailWatchStateStore
  cursors: Map<string, string | null>
  setCalls: Array<{ mailboxId: string; historyId: string }>
  leases: Map<string, { until: number; token: string }>
} {
  const cursors = new Map<string, string | null>(Object.entries(initial))
  const rows = new Set<string>(Object.keys(initial))
  const setCalls: Array<{ mailboxId: string; historyId: string }> = []
  const leases = new Map<string, { until: number; token: string }>()
  let leaseTokenCounter = 0
  return {
    store: {
      async getCursor(mailboxId) {
        return cursors.get(mailboxId) ?? null
      },
      async setCursor(mailboxId, historyId) {
        cursors.set(mailboxId, historyId)
        rows.add(mailboxId)
        setCalls.push({ mailboxId, historyId })
      },
      async seedBaseline() {
        throw new Error('seedBaseline: not used by the reconcile handler')
      },
      async setWatchExpiration() {
        throw new Error('setWatchExpiration: not used by the reconcile handler')
      },
      async claimReconcileLease(mailboxId, leaseMs) {
        if (!rows.has(mailboxId)) return null
        const current = leases.get(mailboxId)
        if (current !== undefined && current.until > Date.now()) return null
        const token = `lease-token-${++leaseTokenCounter}`
        leases.set(mailboxId, { until: Date.now() + leaseMs, token })
        return token
      },
      async releaseReconcileLease(mailboxId, leaseToken) {
        // Mirrors the real store's `WHERE claimed_until = $2` scoping: a
        // release whose token no longer matches the CURRENT holder (already
        // superseded, or the row is gone) is a silent no-op, never a throw.
        const current = leases.get(mailboxId)
        if (current !== undefined && current.token === leaseToken) {
          leases.delete(mailboxId)
        }
      },
      async deleteState() {
        throw new Error('deleteState: not used by the reconcile handler')
      },
    },
    cursors,
    setCalls,
    leases,
  }
}

function fakeBlobStore(): { store: BlobStore; puts: Array<{ key: string; data: Uint8Array }> } {
  const objects = new Map<string, Uint8Array>()
  const puts: Array<{ key: string; data: Uint8Array }> = []
  return {
    store: {
      async put(key, data) {
        objects.set(key, data)
        puts.push({ key, data })
      },
      async get(key) {
        const value = objects.get(key)
        if (value === undefined) throw new Error(`fakeBlobStore: no object at ${key}`)
        return value
      },
      async getSignedUrl() {
        throw new Error('fakeBlobStore: getSignedUrl not used by these tests')
      },
      async delete(key) {
        objects.delete(key)
      },
      async exists(key) {
        return objects.has(key)
      },
    },
    puts,
  }
}

function fakeHistoryClient(behavior: {
  listResult: Awaited<ReturnType<GmailHistoryClient['listAddedMessageIds']>>
  rawMessages?: Record<string, { rawBytes: Uint8Array; receivedAt: Date }>
}): GmailHistoryClient {
  return {
    async listAddedMessageIds() {
      return behavior.listResult
    },
    async getRawMessage(messageId) {
      return behavior.rawMessages?.[messageId] ?? null
    },
  }
}

function job(overrides: Partial<GmailReconcileJob> = {}): QueueMessage<GmailReconcileJob> {
  return {
    id: 'q-msg-1',
    topic: GMAIL_RECONCILE_TOPIC,
    payload: { mailboxId: MAILBOX_ID, historyId: '999', ...overrides },
    attempts: 1,
    enqueuedAt: new Date('2026-01-01T00:00:00Z'),
  }
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/**
 * Builds `AddedGmailMessage[]` for a `listResult` fixture — defaults every
 * id to a normal `['INBOX']`-only message (an ordinary customer message,
 * never mistaken for a self-echo) so existing tests don't have to spell out
 * labelIds for the happy path; the self-echo tests below override
 * `labelIds` explicitly per id via {@link taggedMsgs}.
 */
function msgs(ids: string[]): Array<{ id: string; labelIds: string[] }> {
  return ids.map((id) => ({ id, labelIds: ['INBOX'] }))
}

/** Like {@link msgs}, but each id carries its own explicit labelIds — for the self-echo filter tests. */
function taggedMsgs(entries: Array<[string, string[]]>): Array<{ id: string; labelIds: string[] }> {
  return entries.map(([id, labelIds]) => ({ id, labelIds }))
}

function storedOutcome(
  raw: RawInboundMessage,
  overrides: Partial<IngestOutcome> = {},
): IngestOutcome {
  return {
    kind: 'stored',
    deliveryId: `d-${raw.providerMessageId}`,
    mailboxId: raw.mailboxId,
    providerMessageId: raw.providerMessageId,
    conversationId: 'c1',
    threadId: `t-${raw.providerMessageId}`,
    ...overrides,
  } as IngestOutcome
}

/** Builds a full `GmailReconcileHandlerDeps`, letting each test override just what it needs. */
function baseDeps(
  overrides: Partial<GmailReconcileHandlerDeps> & {
    mailboxStore?: MailboxStore
    watchStateStore?: GmailWatchStateStore
  } = {},
): GmailReconcileHandlerDeps {
  const { store: mailboxStore } = fakeMailboxStore(activeMailbox())
  const { store: watchStateStore } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
  const { store: blobStore } = fakeBlobStore()
  return {
    tokenService: { getAccessToken: async () => 'token' },
    mailboxStore,
    watchStateStore,
    blobStore,
    ingest: vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw)),
    // A benign empty-batch client so baseDeps satisfies the now-required
    // `createHistoryClient` on its own; every test that exercises fetching
    // overrides it with a `fakeHistoryClient(...)`.
    createHistoryClient: () => ({
      listAddedMessageIds: async () => ({ kind: 'ok', messages: [], newHistoryId: 'cursor-1' }),
      getRawMessage: async () => null,
    }),
    ...overrides,
  }
}

describe('createGmailReconcileHandler', () => {
  it('happy path: fetches each added message, ingests it, and advances the cursor to the new watermark', async () => {
    const { store: mailboxStore } = fakeMailboxStore(activeMailbox())
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const { store: blobStore, puts } = fakeBlobStore()
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['m1', 'm2']), newHistoryId: 'cursor-2' },
      rawMessages: {
        m1: { rawBytes: textBytes('raw-1'), receivedAt: new Date('2026-01-01T00:00:00Z') },
        m2: { rawBytes: textBytes('raw-2'), receivedAt: new Date('2026-01-02T00:00:00Z') },
      },
    })
    const ingested: RawInboundMessage[] = []
    const ingest = vi.fn(async (raw: RawInboundMessage) => {
      ingested.push(raw)
      return storedOutcome(raw)
    })

    const handler = createGmailReconcileHandler({
      tokenService: { getAccessToken: async () => 'token' },
      mailboxStore,
      watchStateStore,
      blobStore,
      ingest,
      createHistoryClient: () => historyClient,
    })

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(ingest).toHaveBeenCalledTimes(2)
    expect(ingested.map((r) => r.providerMessageId)).toEqual(['m1', 'm2'])
    expect(ingested[0]).toMatchObject({
      mailboxId: MAILBOX_ID,
      providerMessageId: 'm1',
      content: { kind: 'inline', bytes: textBytes('raw-1') },
      receivedAt: new Date('2026-01-01T00:00:00Z'),
    })
    expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
    expect(puts).toHaveLength(0)
  })

  it('an empty batch (no new messages) still advances the cursor to the new watermark', async () => {
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: [], newHistoryId: 'cursor-2' },
    })
    const ingest = vi.fn()

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(ingest).not.toHaveBeenCalled()
    expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
  })

  it('a duplicate push whose messages replay as already-stored still advances the cursor', async () => {
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['m1', 'm2']), newHistoryId: 'cursor-2' },
      rawMessages: {
        m1: { rawBytes: textBytes('raw-1'), receivedAt: new Date() },
        m2: { rawBytes: textBytes('raw-2'), receivedAt: new Date() },
      },
    })
    // Every call replays the ledger's existing 'stored' row — exactly what
    // ingestInboundMessage returns for a re-delivered, already-processed key.
    const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
  })

  it('a mid-batch "failed" outcome blocks the cursor advance and returns retry', async () => {
    const {
      store: watchStateStore,
      setCalls,
      cursors,
    } = fakeWatchStateStore({
      [MAILBOX_ID]: 'cursor-1',
    })
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['m1', 'm2']), newHistoryId: 'cursor-2' },
      rawMessages: {
        m1: { rawBytes: textBytes('raw-1'), receivedAt: new Date() },
        m2: { rawBytes: textBytes('raw-2'), receivedAt: new Date() },
      },
    })
    let call = 0
    const ingest = vi.fn(async (raw: RawInboundMessage): Promise<IngestOutcome> => {
      call++
      if (call === 1) return storedOutcome(raw)
      return {
        kind: 'failed',
        deliveryId: `d-${raw.providerMessageId}`,
        mailboxId: raw.mailboxId,
        providerMessageId: raw.providerMessageId,
        attempts: 1,
        error: 'boom',
      }
    })

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'retry' })
    expect(setCalls).toEqual([])
    expect(cursors.get(MAILBOX_ID)).toBe('cursor-1')
  })

  it('an "in-progress" outcome also blocks the cursor advance and returns retry', async () => {
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['m1']), newHistoryId: 'cursor-2' },
      rawMessages: { m1: { rawBytes: textBytes('raw-1'), receivedAt: new Date() } },
    })
    const ingest = vi.fn(
      async (raw: RawInboundMessage): Promise<IngestOutcome> => ({
        kind: 'in-progress',
        deliveryId: `d-${raw.providerMessageId}`,
        mailboxId: raw.mailboxId,
        providerMessageId: raw.providerMessageId,
      }),
    )

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'retry' })
    expect(setCalls).toEqual([])
  })

  it('a "dead-letter" outcome is terminal and STILL advances the cursor (documented extension beyond spec §4 prose)', async () => {
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['m1', 'm2']), newHistoryId: 'cursor-2' },
      rawMessages: {
        m1: { rawBytes: textBytes('raw-1'), receivedAt: new Date() },
        m2: { rawBytes: textBytes('raw-2'), receivedAt: new Date() },
      },
    })
    const ingest = vi.fn(async (raw: RawInboundMessage): Promise<IngestOutcome> => {
      if (raw.providerMessageId === 'm1') return storedOutcome(raw)
      return {
        kind: 'dead-letter',
        deliveryId: `d-${raw.providerMessageId}`,
        mailboxId: raw.mailboxId,
        providerMessageId: raw.providerMessageId,
        attempts: 5,
        error: 'poison message',
      }
    })

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
  })

  it('a message deleted between list and get (messages.get 404 -> null) is skipped, not retried', async () => {
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['gone', 'here']), newHistoryId: 'cursor-2' },
      rawMessages: { here: { rawBytes: textBytes('raw'), receivedAt: new Date() } },
    })
    const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(ingest).toHaveBeenCalledTimes(1)
    expect((ingest.mock.calls[0][0] as RawInboundMessage).providerMessageId).toBe('here')
    expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
  })

  // --- The self-echo filter (HT-50) — the live-proven failure this ticket
  // fixes: the mailbox's own outbound reply, surfaced by history.list like
  // any other added message, must not spawn a ghost conversation. ---------

  describe('self-echo filter', () => {
    it('a SENT-only self-message (the exact live round-trip that failed) is skipped: no ingest call, no delivery row, cursor still advances', async () => {
      const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
      const getRawMessage = vi.fn(async () => null)
      const historyClient: GmailHistoryClient = {
        listAddedMessageIds: async () => ({
          kind: 'ok',
          // Exactly the production failure: help@resonantiq.app's own
          // just-sent reply, reflected back through history.list with
          // SENT but no INBOX label.
          messages: taggedMsgs([['echo-1', ['SENT']]]),
          newHistoryId: 'cursor-2',
        }),
        getRawMessage,
      }
      const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
      )

      const result = await handler(job())

      expect(result).toEqual({ kind: 'ack' })
      // No inbound_deliveries ledger row is ever attempted for the echo —
      // ingest (the thing that writes that row) is never called for it.
      expect(ingest).not.toHaveBeenCalled()
      // Filtered before the raw fetch, too — no wasted messages.get call.
      expect(getRawMessage).not.toHaveBeenCalled()
      // The skip must not disturb cursor advancement (module doc).
      expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
    })

    it('a SENT+INBOX self-addressed message (the desk emailing itself) is still ingested normally', async () => {
      const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
      const historyClient = fakeHistoryClient({
        listResult: {
          kind: 'ok',
          messages: taggedMsgs([['self-addressed-1', ['SENT', 'INBOX']]]),
          newHistoryId: 'cursor-2',
        },
        rawMessages: {
          'self-addressed-1': { rawBytes: textBytes('raw'), receivedAt: new Date() },
        },
      })
      const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
      )

      const result = await handler(job())

      expect(result).toEqual({ kind: 'ack' })
      expect(ingest).toHaveBeenCalledTimes(1)
      expect((ingest.mock.calls[0][0] as RawInboundMessage).providerMessageId).toBe(
        'self-addressed-1',
      )
      expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
    })

    it('a mixed batch — a genuine customer message plus a self-echo — ingests the customer message, skips the echo, and lands the cursor correctly', async () => {
      const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
      const historyClient = fakeHistoryClient({
        listResult: {
          kind: 'ok',
          messages: taggedMsgs([
            ['customer-1', ['INBOX']],
            ['echo-1', ['SENT']],
          ]),
          newHistoryId: 'cursor-2',
        },
        rawMessages: {
          'customer-1': { rawBytes: textBytes('raw-customer'), receivedAt: new Date() },
        },
      })
      const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
      )

      const result = await handler(job())

      expect(result).toEqual({ kind: 'ack' })
      expect(ingest).toHaveBeenCalledTimes(1)
      expect((ingest.mock.calls[0][0] as RawInboundMessage).providerMessageId).toBe('customer-1')
      expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
    })

    it('an INBOX-only message (no SENT at all — the ordinary case) is never treated as a self-echo', async () => {
      const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
      const historyClient = fakeHistoryClient({
        listResult: {
          kind: 'ok',
          messages: taggedMsgs([['customer-2', ['INBOX']]]),
          newHistoryId: 'cursor-2',
        },
        rawMessages: { 'customer-2': { rawBytes: textBytes('raw'), receivedAt: new Date() } },
      })
      const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
      )

      const result = await handler(job())

      expect(result).toEqual({ kind: 'ack' })
      expect(ingest).toHaveBeenCalledTimes(1)
      expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
    })

    it('a message with no labelIds at all (Gmail omitted the field) fails open and is ingested, never silently dropped', async () => {
      const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
      const historyClient = fakeHistoryClient({
        listResult: {
          kind: 'ok',
          messages: taggedMsgs([['no-labels-1', []]]),
          newHistoryId: 'cursor-2',
        },
        rawMessages: { 'no-labels-1': { rawBytes: textBytes('raw'), receivedAt: new Date() } },
      })
      const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
      )

      const result = await handler(job())

      expect(result).toEqual({ kind: 'ack' })
      expect(ingest).toHaveBeenCalledTimes(1)
      expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
    })
  })

  it('a 404-expired cursor pauses the mailbox, does not advance the cursor, and acks', async () => {
    const { store: mailboxStore, records } = fakeMailboxStore(activeMailbox())
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({
      [MAILBOX_ID]: 'stale-cursor',
    })
    const historyClient = fakeHistoryClient({ listResult: { kind: 'expired' } })
    const ingest = vi.fn()

    const handler = createGmailReconcileHandler(
      baseDeps({ mailboxStore, watchStateStore, ingest, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(records.get(MAILBOX_ID)?.status).toBe('paused')
    expect(setCalls).toEqual([])
    expect(ingest).not.toHaveBeenCalled()
  })

  it('a non-active mailbox is acked without acquiring a token or touching the Gmail client', async () => {
    const { store: mailboxStore } = fakeMailboxStore(activeMailbox({ status: 'paused' }))
    const getAccessToken = vi.fn(async () => 'token')
    const createHistoryClient = vi.fn()
    const ingest = vi.fn()

    const handler = createGmailReconcileHandler(
      baseDeps({ mailboxStore, tokenService: { getAccessToken }, ingest, createHistoryClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(createHistoryClient).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('a disconnected mailbox is acked without acquiring a token or touching the Gmail client (HT-47 review fix, mirrors the paused case)', async () => {
    const { store: mailboxStore } = fakeMailboxStore(activeMailbox({ status: 'disconnected' }))
    const getAccessToken = vi.fn(async () => 'token')
    const createHistoryClient = vi.fn()
    const ingest = vi.fn()

    const handler = createGmailReconcileHandler(
      baseDeps({ mailboxStore, tokenService: { getAccessToken }, ingest, createHistoryClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(createHistoryClient).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('an unknown mailbox id (mailbox row gone) is acked, same as not-active', async () => {
    const { store: mailboxStore } = fakeMailboxStore(activeMailbox())
    const createHistoryClient = vi.fn()
    const ingest = vi.fn()

    const handler = createGmailReconcileHandler(
      baseDeps({ mailboxStore, ingest, createHistoryClient }),
    )

    const result = await handler(job({ mailboxId: '22222222-2222-4222-8222-222222222222' }))

    expect(result).toEqual({ kind: 'ack' })
    expect(createHistoryClient).not.toHaveBeenCalled()
  })

  it('no baseline cursor: acked without touching the Gmail client', async () => {
    const { store: watchStateStore } = fakeWatchStateStore({}) // no cursor for MAILBOX_ID
    const createHistoryClient = vi.fn()
    const ingest = vi.fn()

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, ingest, createHistoryClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(createHistoryClient).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('a large raw message (over maxInlineRawBytes) is written to blobStore and handed to ingest as a blobRef', async () => {
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const { store: blobStore, puts } = fakeBlobStore()
    const bigBytes = textBytes('this raw message is bigger than the tiny threshold below')
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['big1']), newHistoryId: 'cursor-2' },
      rawMessages: { big1: { rawBytes: bigBytes, receivedAt: new Date() } },
    })
    let capturedContent: RawInboundMessage['content'] | undefined
    const ingest = vi.fn(async (raw: RawInboundMessage) => {
      capturedContent = raw.content
      return storedOutcome(raw)
    })

    const handler = createGmailReconcileHandler(
      baseDeps({
        watchStateStore,
        blobStore,
        ingest,
        createHistoryClient: () => historyClient,
        maxInlineRawBytes: 10, // bigBytes.length is well over 10
      }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(puts).toHaveLength(1)
    expect(puts[0].key).toBe(`inbound/raw/${MAILBOX_ID}/big1`)
    expect(puts[0].data).toEqual(bigBytes)
    expect(capturedContent).toEqual({
      kind: 'blobRef',
      blobKey: `inbound/raw/${MAILBOX_ID}/big1`,
    })
    expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
  })

  it('a small raw message (at or under maxInlineRawBytes) stays inline and never touches blobStore', async () => {
    const { store: blobStore, puts } = fakeBlobStore()
    const smallBytes = textBytes('tiny')
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['m1']), newHistoryId: 'cursor-2' },
      rawMessages: { m1: { rawBytes: smallBytes, receivedAt: new Date() } },
    })
    const ingest = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))

    const handler = createGmailReconcileHandler(
      baseDeps({
        blobStore,
        ingest,
        createHistoryClient: () => historyClient,
        maxInlineRawBytes: smallBytes.byteLength,
      }),
    )

    await handler(job())

    expect(puts).toHaveLength(0)
  })

  it('a token-acquisition failure that leaves the mailbox needs_reconnect is acked (dead grant, retry cannot help)', async () => {
    const { store: mailboxStore, records } = fakeMailboxStore(activeMailbox())
    const createHistoryClient = vi.fn()
    const ingest = vi.fn()
    const tokenService: GmailOAuthTokenService = {
      getAccessToken: async (mailboxId) => {
        // Mirrors gmail-oauth.ts's real invalid_grant behavior: it marks the
        // mailbox needs_reconnect itself, THEN throws.
        const current = records.get(mailboxId)
        if (current !== undefined) {
          records.set(mailboxId, { ...current, status: 'needs_reconnect' })
        }
        throw new Error('getAccessToken: refresh token rejected (invalid_grant)')
      },
    }

    const handler = createGmailReconcileHandler(
      baseDeps({ mailboxStore, tokenService, ingest, createHistoryClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'ack' })
    expect(createHistoryClient).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
  })

  it('a token-acquisition failure that leaves the mailbox active is treated as transient and retried', async () => {
    const { store: mailboxStore } = fakeMailboxStore(activeMailbox())
    const createHistoryClient = vi.fn()
    const tokenService: GmailOAuthTokenService = {
      getAccessToken: async () => {
        throw new Error('network error talking to the token endpoint')
      },
    }

    const handler = createGmailReconcileHandler(
      baseDeps({ mailboxStore, tokenService, createHistoryClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'retry' })
    expect(createHistoryClient).not.toHaveBeenCalled()
  })

  it('never logs the access token, even on an unexpected thrown error from the Gmail client', async () => {
    const secretToken = 'super-secret-reconcile-token-do-not-leak'
    const historyClient: GmailHistoryClient = {
      async listAddedMessageIds() {
        throw new Error(
          'createGmailHistoryClient: history.list failed with 500 Internal Server Error',
        )
      },
      async getRawMessage() {
        return null
      },
    }
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const handler = createGmailReconcileHandler(
      baseDeps({
        tokenService: { getAccessToken: async () => secretToken },
        createHistoryClient: () => historyClient,
      }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'retry' })
    for (const call of consoleErrorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secretToken)
    }
    consoleErrorSpy.mockRestore()
  })

  it('an unexpected error from the Gmail client is retried without advancing the cursor', async () => {
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const historyClient: GmailHistoryClient = {
      async listAddedMessageIds() {
        throw new Error('boom: transient network failure')
      },
      async getRawMessage() {
        return null
      },
    }
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'retry' })
    expect(setCalls).toEqual([])
    consoleErrorSpy.mockRestore()
  })

  it('an unexpected error thrown by ingest() itself is retried without advancing the cursor', async () => {
    const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
    const historyClient = fakeHistoryClient({
      listResult: { kind: 'ok', messages: msgs(['m1']), newHistoryId: 'cursor-2' },
      rawMessages: { m1: { rawBytes: textBytes('raw'), receivedAt: new Date() } },
    })
    const ingest = vi.fn(async () => {
      throw new Error('database unreachable')
    })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const handler = createGmailReconcileHandler(
      baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
    )

    const result = await handler(job())

    expect(result).toEqual({ kind: 'retry' })
    expect(setCalls).toEqual([])
    consoleErrorSpy.mockRestore()
  })

  // --- The reconciliation lease (HT-48; gmail-push.md §6) ---------------------

  describe('reconciliation lease', () => {
    it('concurrent reconcile of the same mailbox does the Gmail work once — the loser retries instead of acking', async () => {
      const { store: watchStateStore, setCalls } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
      const listAddedMessageIds = vi.fn(async () => ({
        kind: 'ok' as const,
        messages: [],
        newHistoryId: 'cursor-2',
      }))
      const historyClient: GmailHistoryClient = {
        listAddedMessageIds,
        async getRawMessage() {
          return null
        },
      }
      const ingest = vi.fn()

      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest, createHistoryClient: () => historyClient }),
      )

      // Two triggers landing on the SAME mailbox at once — e.g. a push
      // notification and the daily sweep both enqueuing/consuming a
      // reconcile job for it around the same moment.
      const [first, second] = await Promise.all([handler(job()), handler(job())])

      // Which of the two wins the claim race is nondeterministic — assert
      // on the pair, not on `first`/`second` individually. Exactly one acks
      // (the holder); the other retries with the lease-held backoff hint
      // rather than acking (module doc's "Why a failed claim retries
      // instead of acking") — it did not do the Gmail work, but it also did
      // not silently discard whatever notification it was carrying.
      const results = [first, second]
      expect(results).toContainEqual({ kind: 'ack' })
      expect(results).toContainEqual({
        kind: 'retry',
        backoffSeconds: DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS,
      })
      // Only the lease-holder actually called history.list; the other run
      // skipped its own Gmail work entirely (module doc's "The
      // reconciliation lease" section).
      expect(listAddedMessageIds).toHaveBeenCalledTimes(1)
      expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
    })

    it('different mailboxes reconcile concurrently — one mailbox holding the lease never blocks another', async () => {
      const MAILBOX_A = MAILBOX_ID
      const MAILBOX_B = '22222222-2222-4222-8222-222222222222'
      const recordsByAddress = new Map<string, MailboxRecord>([
        ['support@example.test', activeMailbox({ id: MAILBOX_A })],
        [
          'support-b@example.test',
          activeMailbox({ id: MAILBOX_B, address: 'support-b@example.test' }),
        ],
      ])
      const recordsById = new Map<string, MailboxRecord>(
        [...recordsByAddress.values()].map((r) => [r.id, r]),
      )
      const mailboxStore: MailboxStore = {
        async getMailboxByAddress(address) {
          return recordsByAddress.get(address) ?? null
        },
        async getMailboxById(id) {
          return recordsById.get(id) ?? null
        },
        async markNeedsReconnect() {
          throw new Error('markNeedsReconnect: not used by this test')
        },
        async markPaused() {
          throw new Error('markPaused: not used by this test')
        },
        async markDisconnected() {
          throw new Error('markDisconnected: not used by this test')
        },
        async upsertConnectedMailbox() {
          throw new Error('upsertConnectedMailbox: not used by this test')
        },
        async listActiveMailboxes() {
          throw new Error('listActiveMailboxes: not used by this test')
        },
      }
      const { store: watchStateStore, setCalls } = fakeWatchStateStore({
        [MAILBOX_A]: 'cursor-a-1',
        [MAILBOX_B]: 'cursor-b-1',
      })
      const listAddedMessageIds = vi.fn(async (cursor: string) => ({
        kind: 'ok' as const,
        messages: [],
        newHistoryId: cursor === 'cursor-a-1' ? 'cursor-a-2' : 'cursor-b-2',
      }))
      const historyClient: GmailHistoryClient = {
        listAddedMessageIds,
        async getRawMessage() {
          return null
        },
      }

      const handler = createGmailReconcileHandler(
        baseDeps({
          mailboxStore,
          watchStateStore,
          ingest: vi.fn(),
          createHistoryClient: () => historyClient,
        }),
      )

      const [a, b] = await Promise.all([
        handler(job({ mailboxId: MAILBOX_A })),
        handler(job({ mailboxId: MAILBOX_B })),
      ])

      expect(a).toEqual({ kind: 'ack' })
      expect(b).toEqual({ kind: 'ack' })
      // Both mailboxes did their OWN history.list — a lease is strictly
      // per-mailbox, so mailbox A holding its lease never blocks mailbox B.
      expect(listAddedMessageIds).toHaveBeenCalledTimes(2)
      expect(setCalls).toEqual(
        expect.arrayContaining([
          { mailboxId: MAILBOX_A, historyId: 'cursor-a-2' },
          { mailboxId: MAILBOX_B, historyId: 'cursor-b-2' },
        ]),
      )
    })

    it('a crashed holder lease expires and reconciliation resumes', async () => {
      const {
        store: watchStateStore,
        setCalls,
        leases,
      } = fakeWatchStateStore({
        [MAILBOX_ID]: 'cursor-1',
      })
      // Simulate a PRIOR run that claimed the lease and then crashed before
      // ever reaching its own release (the one case the `finally` in
      // gmail-reconcile.ts's module doc cannot help) — its claimed_until is
      // already in the past, exactly as it would be once reconcileLeaseMs
      // has elapsed with no release call ever having run.
      leases.set(MAILBOX_ID, { until: Date.now() - 1000, token: 'stale-crashed-holder-token' })
      const listAddedMessageIds = vi.fn(async () => ({
        kind: 'ok' as const,
        messages: [],
        newHistoryId: 'cursor-2',
      }))
      const historyClient: GmailHistoryClient = {
        listAddedMessageIds,
        async getRawMessage() {
          return null
        },
      }

      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest: vi.fn(), createHistoryClient: () => historyClient }),
      )

      const result = await handler(job())

      expect(result).toEqual({ kind: 'ack' })
      expect(listAddedMessageIds).toHaveBeenCalledTimes(1)
      expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-2' }])
    })

    it('a run that cannot claim the lease retries with a backoff hint, without touching the Gmail client at all', async () => {
      const {
        store: watchStateStore,
        setCalls,
        leases,
      } = fakeWatchStateStore({
        [MAILBOX_ID]: 'cursor-1',
      })
      // Held by someone else, unexpired.
      leases.set(MAILBOX_ID, { until: Date.now() + 60_000, token: 'live-holder-token' })
      const createHistoryClient = vi.fn()
      const ingest = vi.fn()

      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest, createHistoryClient }),
      )

      const result = await handler(job())

      // NOT an ack: acking here would silently drop a message that arrives
      // in Gmail's history after the holder's own history.list snapshot —
      // see gmail-reconcile.ts's module doc ("Why a failed claim retries
      // instead of acking"). Retrying with a backoff hint gives a later
      // attempt (after the holder has very likely released) a chance to
      // pick that message up.
      expect(result).toEqual({
        kind: 'retry',
        backoffSeconds: DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS,
      })
      expect(createHistoryClient).not.toHaveBeenCalled()
      expect(ingest).not.toHaveBeenCalled()
      expect(setCalls).toEqual([])
    })

    it("the arrives-after-snapshot case: a message that lands after the holder's history.list is picked up on the retried attempt, not dropped", async () => {
      const {
        store: watchStateStore,
        setCalls,
        cursors,
        leases,
      } = fakeWatchStateStore({
        [MAILBOX_ID]: 'cursor-1',
      })
      // Simulate holder A already in flight: it claimed the lease and — in
      // the concrete scenario this guards against — has already called
      // history.list (fixing its own snapshot) and is mid-fetch/ingest.
      leases.set(MAILBOX_ID, { until: Date.now() + 60_000, token: 'holder-a-token' })
      const createHistoryClient = vi.fn()
      const ingest = vi.fn()
      const handler = createGmailReconcileHandler(
        baseDeps({ watchStateStore, ingest, createHistoryClient }),
      )

      // Worker B's job — enqueued by a push notification for message M,
      // which arrived AFTER holder A's history.list snapshot — cannot claim
      // the lease and gets a retry, not an ack.
      const firstAttempt = await handler(job())
      expect(firstAttempt).toEqual({
        kind: 'retry',
        backoffSeconds: DEFAULT_RECONCILE_LEASE_RETRY_BACKOFF_SECONDS,
      })
      expect(createHistoryClient).not.toHaveBeenCalled()

      // Holder A finishes its own run and releases with ITS token. The
      // cursor is now at A's snapshot watermark, which does NOT yet cover
      // message M (that is exactly the scenario: M arrived after A's list
      // call, so A's own advance cannot have reached it).
      await watchStateStore.releaseReconcileLease(MAILBOX_ID, 'holder-a-token')
      cursors.set(MAILBOX_ID, 'cursor-after-a')

      // The retried delivery of B's job now claims the free lease and runs
      // its OWN history.list from the advanced cursor, picking up M.
      const historyClient: GmailHistoryClient = {
        listAddedMessageIds: vi.fn(async (cursor: string) => ({
          kind: 'ok' as const,
          messages: cursor === 'cursor-after-a' ? msgs(['m-arrived-after-a']) : [],
          newHistoryId: 'cursor-after-b',
        })),
        getRawMessage: vi.fn(async () => ({
          rawBytes: textBytes('raw-M'),
          receivedAt: new Date('2026-01-03T00:00:00Z'),
        })),
      }
      const ingestedAfterRetry = vi.fn(async (raw: RawInboundMessage) => storedOutcome(raw))
      const retriedHandler = createGmailReconcileHandler(
        baseDeps({
          watchStateStore,
          ingest: ingestedAfterRetry,
          createHistoryClient: () => historyClient,
        }),
      )

      const secondAttempt = await retriedHandler(job())

      expect(secondAttempt).toEqual({ kind: 'ack' })
      expect(ingestedAfterRetry).toHaveBeenCalledTimes(1)
      expect((ingestedAfterRetry.mock.calls[0][0] as RawInboundMessage).providerMessageId).toBe(
        'm-arrived-after-a',
      )
      expect(setCalls).toEqual([{ mailboxId: MAILBOX_ID, historyId: 'cursor-after-b' }])
    })

    it('an unexpected throw releases the lease immediately — a next run need not wait out reconcileLeaseMs', async () => {
      const { store: watchStateStore, leases } = fakeWatchStateStore({ [MAILBOX_ID]: 'cursor-1' })
      const historyClient: GmailHistoryClient = {
        async listAddedMessageIds() {
          throw new Error('boom: transient network failure')
        },
        async getRawMessage() {
          return null
        },
      }
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const handler = createGmailReconcileHandler(
        baseDeps({
          watchStateStore,
          createHistoryClient: () => historyClient,
          // A long lease — if release-on-throw did NOT happen, the lease
          // would still read as held for a very long time.
          reconcileLeaseMs: 10 * 60_000,
        }),
      )

      const result = await handler(job())
      expect(result).toEqual({ kind: 'retry' })

      // The lease must already be free — released in the `finally` before
      // the throw propagated — not still held for another ~10 minutes.
      expect(leases.has(MAILBOX_ID)).toBe(false)
      consoleErrorSpy.mockRestore()
    })
  })
})
