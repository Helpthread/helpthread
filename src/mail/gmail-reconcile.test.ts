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
import { createGmailReconcileHandler, type GmailReconcileHandlerDeps } from './gmail-reconcile.js'
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
    },
    records,
  }
}

function fakeWatchStateStore(initial: Record<string, string> = {}): {
  store: GmailWatchStateStore
  cursors: Map<string, string | null>
  setCalls: Array<{ mailboxId: string; historyId: string }>
} {
  const cursors = new Map<string, string | null>(Object.entries(initial))
  const setCalls: Array<{ mailboxId: string; historyId: string }> = []
  return {
    store: {
      async getCursor(mailboxId) {
        return cursors.get(mailboxId) ?? null
      },
      async setCursor(mailboxId, historyId) {
        cursors.set(mailboxId, historyId)
        setCalls.push({ mailboxId, historyId })
      },
    },
    cursors,
    setCalls,
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
      listAddedMessageIds: async () => ({ kind: 'ok', messageIds: [], newHistoryId: 'cursor-1' }),
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
      listResult: { kind: 'ok', messageIds: ['m1', 'm2'], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: [], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: ['m1', 'm2'], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: ['m1', 'm2'], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: ['m1'], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: ['m1', 'm2'], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: ['gone', 'here'], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: ['big1'], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: ['m1'], newHistoryId: 'cursor-2' },
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
      listResult: { kind: 'ok', messageIds: ['m1'], newHistoryId: 'cursor-2' },
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
})
