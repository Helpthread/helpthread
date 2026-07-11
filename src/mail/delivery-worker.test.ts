import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import {
  type ConversationStore,
  createConversationStore,
  type SendEnvelope,
} from '../store/conversations.js'
import { runDeliveryWorker } from './delivery-worker.js'
import type { Keyring, SigningKey } from './reply-token.js'
import { type SendReplyDeps, sendReply } from './send.js'

// --- fixtures ----------------------------------------------------------------

const KEY_A: SigningKey = { keyId: 'k1', secret: 'secret-A-high-entropy-0123456789abcdef' }
const keyring: Keyring = { current: KEY_A }
const mailDomain = 'mail.example.test'

/** Records every `OutboundEmail` it is asked to send; never fails. */
function fakeSender(): EmailSender & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = []
  return {
    sent,
    async send(email) {
      sent.push(email)
      return { providerMessageId: 'provider-1' }
    },
  }
}

function envelope(overrides: Partial<SendEnvelope> = {}): SendEnvelope {
  return {
    to: ['customer@example.test'],
    subject: 'Re: Help with my order',
    ...overrides,
  }
}

describe('runDeliveryWorker', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: ConversationStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createConversationStore(db) }
  }

  async function seedConversation(store: ConversationStore) {
    return store.createConversation({
      subject: 'Help with my order',
      customerEmail: 'customer@example.test',
      firstMessage: {
        direction: 'inbound',
        messageId: '<inbound-1@customer.example.test>',
        fromAddress: 'customer@example.test',
        bodyText: 'Where is my order?',
      },
    })
  }

  async function setCreatedAt(rawDb: Db, threadId: string, createdAt: Date) {
    await rawDb.query('UPDATE threads SET created_at = $1 WHERE id = $2', [createdAt, threadId])
  }

  it('sweeps one stale pending row and one failed row: both retried with the ORIGINAL messageId, both end sent', async () => {
    const { db: rawDb, store } = await freshStore()
    const { conversationId } = await seedConversation(store)

    const stalePending = await store.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.stale.sig@mail.example.test>',
      fromAddress: 'support@example.test',
      bodyText: 'Looking into it!',
      deliveryStatus: 'pending',
      sendEnvelope: envelope(),
    })
    const failedOne = await store.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.failed.sig@mail.example.test>',
      fromAddress: 'support@example.test',
      bodyText: 'Second try coming',
      deliveryStatus: 'failed',
      sendEnvelope: envelope(),
    })
    if (!stalePending.ok || !failedOne.ok) throw new Error('unreachable')
    await setCreatedAt(rawDb, stalePending.threadId, new Date(Date.now() - 10 * 60_000))

    const sender = fakeSender()
    const report = await runDeliveryWorker(
      { store, sender },
      { staleAfterMs: 5 * 60_000, batchSize: 50 },
    )

    expect(report).toEqual({ attempted: 2, sent: 2, failed: 0, skipped: 0 })
    expect(sender.sent.map((e) => e.messageId).sort()).toEqual(
      ['<ht.k1.failed.sig@mail.example.test>', '<ht.k1.stale.sig@mail.example.test>'].sort(),
    )

    const conversation = await store.getConversation(conversationId)
    const stale = conversation?.threads.find((t) => t.id === stalePending.threadId)
    const failed = conversation?.threads.find((t) => t.id === failedOne.threadId)
    expect(stale).toMatchObject({
      deliveryStatus: 'sent',
      messageId: '<ht.k1.stale.sig@mail.example.test>',
    })
    expect(failed).toMatchObject({
      deliveryStatus: 'sent',
      messageId: '<ht.k1.failed.sig@mail.example.test>',
    })
  })

  it('does not retry a fresh pending row (younger than staleAfterMs)', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    await store.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.fresh.sig@mail.example.test>',
      fromAddress: 'support@example.test',
      bodyText: 'Just sent',
      deliveryStatus: 'pending',
      sendEnvelope: envelope(),
    })

    const sender = fakeSender()
    const report = await runDeliveryWorker({ store, sender }, { staleAfterMs: 5 * 60_000 })

    expect(report).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0 })
    expect(sender.sent).toHaveLength(0)
  })

  it('a row already leased BEFORE the sweep starts is excluded from the listing entirely — never even attempted', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    const failedOne = await store.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.leased.sig@mail.example.test>',
      fromAddress: 'support@example.test',
      bodyText: 'Second try coming',
      deliveryStatus: 'failed',
      sendEnvelope: envelope(),
    })
    if (!failedOne.ok) throw new Error('unreachable')

    // Someone else (a concurrent keyed sendReply retry, or another worker)
    // already holds this row's lease before this sweep's own listing query
    // runs — listDeliverableThreads' own WHERE clause excludes it, so it
    // never reaches this worker's per-row claim step at all.
    await store.claimThreadForDelivery(failedOne.threadId, 30_000)

    const sender = fakeSender()
    const report = await runDeliveryWorker({ store, sender })

    expect(report).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 0 })
    expect(sender.sent).toHaveLength(0)
  })

  it("skips a candidate claimed by someone else BETWEEN the listing and this worker's own claim attempt (TOCTOU), counting it as skipped rather than attempted", async () => {
    const { store: realStore } = await freshStore()
    const { conversationId } = await seedConversation(realStore)
    const raced = await realStore.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.raced.sig@mail.example.test>',
      fromAddress: 'support@example.test',
      bodyText: 'retry me',
      deliveryStatus: 'failed',
      sendEnvelope: envelope(),
    })
    if (!raced.ok) throw new Error('unreachable')

    // A store double that reports the row as eligible (as a real listing
    // would, since it was still unleased when the sweep started) but whose
    // claim always loses — simulating another process winning the race in
    // the gap between listDeliverableThreads and claimThreadForDelivery.
    const store: ConversationStore = {
      ...realStore,
      async claimThreadForDelivery() {
        return null
      },
    }

    const sender = fakeSender()
    const report = await runDeliveryWorker({ store, sender })

    expect(report).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 1 })
    expect(sender.sent).toHaveLength(0)
  })

  it('respects batchSize', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    for (let i = 0; i < 3; i++) {
      await store.appendThread(conversationId, {
        direction: 'outbound',
        messageId: `<ht.k1.failed-${i}.sig@mail.example.test>`,
        fromAddress: 'support@example.test',
        bodyText: 'retry me',
        deliveryStatus: 'failed',
        sendEnvelope: envelope(),
      })
    }

    const sender = fakeSender()
    const report = await runDeliveryWorker({ store, sender }, { batchSize: 2 })

    expect(report).toEqual({ attempted: 2, sent: 2, failed: 0, skipped: 0 })
  })

  it('a send that still fails on retry is counted as failed and left retryable', async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    await store.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.stillfailing.sig@mail.example.test>',
      fromAddress: 'support@example.test',
      bodyText: 'retry me',
      deliveryStatus: 'failed',
      sendEnvelope: envelope(),
    })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sender: EmailSender = {
      async send() {
        throw new Error('still down')
      },
    }
    const report = await runDeliveryWorker({ store, sender })

    expect(report).toEqual({ attempted: 1, sent: 0, failed: 1, skipped: 0 })

    const conversation = await store.getConversation(conversationId)
    const thread = conversation?.threads.find((t) => t.direction === 'outbound')
    expect(thread?.deliveryStatus).toBe('failed')
    expect(thread?.claimedUntil).toBeNull()
    errorSpy.mockRestore()
  })

  // --- cross-path race: worker vs. a keyed sendReply replay -------------------

  // (Runs against the single-connection, in-process PGlite used in tests —
  // the sender gate below deterministically interleaves the worker sweep and
  // the keyed replay at the application level, but both still execute their
  // `claimThreadForDelivery` UPDATE against the same single DB connection,
  // never two genuinely concurrent ones. This proves the sequential
  // claim-while-held logic — whichever caller claims second sees the lease
  // and backs off — but NOT true multi-connection atomicity of the
  // row-locked `UPDATE`. Real-race coverage waits for a multi-connection
  // backend, same caveat as migrate.ts's advisory-lock note.)
  it('cross-path race: a stale pending row is contended between runDeliveryWorker and a keyed sendReply replay — exactly one of them sends, the other observes the lease', async () => {
    const { db: rawDb, store } = await freshStore()
    const { conversationId } = await seedConversation(store)

    // Seed the stale row via a keyed sendReply call whose sender fails, so
    // the row ends up 'failed' with a real stored envelope/messageId — the
    // shape a genuine retry candidate has in production.
    const seedDeps: SendReplyDeps = {
      store,
      sender: {
        async send() {
          throw new Error('boom')
        },
      },
      keyring,
      mailDomain,
    }
    const seedInput = {
      conversationId,
      from: 'support@example.test',
      to: ['customer@example.test'],
      subject: 'Re: Help with my order',
      text: "We're looking into it!",
      idempotencyKey: 'race-key',
    }
    const seeded = await sendReply(seedInput, seedDeps)
    expect(seeded).toMatchObject({ ok: false, reason: 'send-failed', persistedStatus: 'failed' })
    if (seeded.ok || seeded.reason !== 'send-failed') throw new Error('unreachable')
    await setCreatedAt(rawDb, seeded.threadId, new Date(Date.now() - 10 * 60_000))

    // Now race a worker sweep against a keyed replay. The worker's sender is
    // gated so we can force the interleaving deterministically: the worker
    // claims the row and is blocked mid-send when the replay call is made.
    let releaseWorkerSend: () => void = () => {}
    const workerSendGate = new Promise<void>((resolve) => {
      releaseWorkerSend = resolve
    })
    let workerSendCalls = 0
    const workerSender: EmailSender = {
      async send() {
        workerSendCalls++
        await workerSendGate
        return {}
      },
    }

    const workerPromise = runDeliveryWorker(
      { store, sender: workerSender },
      { staleAfterMs: 5 * 60_000 },
    )
    await vi.waitFor(() => expect(workerSendCalls).toBe(1))

    // The worker now holds the lease. A concurrent keyed replay must observe
    // it and refuse to send again.
    const replaySender = fakeSender()
    const replayDeps: SendReplyDeps = { store, sender: replaySender, keyring, mailDomain }
    const replayResult = await sendReply(seedInput, replayDeps)
    expect(replayResult).toEqual({ ok: false, reason: 'retry-in-progress' })
    expect(replaySender.sent).toHaveLength(0)

    releaseWorkerSend()
    const workerReport = await workerPromise
    expect(workerReport).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 })

    const conversation = await store.getConversation(conversationId)
    const thread = conversation?.threads.find((t) => t.id === seeded.threadId)
    expect(thread?.deliveryStatus).toBe('sent')
    expect(thread?.messageId).toBe(seeded.messageId)
  })
})
