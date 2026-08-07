import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { EmailSender, OutboundEmail } from '../providers/index.js'
import {
  type ConversationStore,
  createConversationStore,
  type SendEnvelope,
} from '../store/conversations.js'
import { createMailboxStore } from '../store/mailboxes.js'
import { runDeliveryWorker } from './delivery-worker.js'
import type { Keyring, SigningKey } from './reply-token.js'
import { type SendReplyDeps, sendReply } from './send.js'
import { SenderResolutionError, type SenderResolver } from './sender-resolver.js'

// --- fixtures ----------------------------------------------------------------

const KEY_A: SigningKey = { keyId: 'k1', secret: 'secret-A-high-entropy-0123456789abcdef' }
const keyring: Keyring = { current: KEY_A }
const mailDomain = 'mail.example.test'

/** Records every `OutboundEmail` it is asked to send; never fails. */
function fakeSender(): EmailSender & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = []
  return {
    sent,
    maxSendMs: 30_000,
    async send(email) {
      sent.push(email)
      return { providerMessageId: 'provider-1' }
    },
  }
}

/**
 * A `SenderResolver` fake that ignores `mailboxId` and always resolves to
 * `sender` — for every test in this suite EXCEPT the dedicated per-mailbox
 * routing test below, which builds its own resolver that actually branches
 * on `mailboxId`. Mirrors this suite's pre-HT-101 single-fixed-sender
 * behavior exactly.
 */
function fixedSenderResolver(sender: EmailSender): SenderResolver {
  return { resolve: async () => ({ sender, from: 'support@example.test' }) }
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
      { store, senderResolver: fixedSenderResolver(sender) },
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
    const report = await runDeliveryWorker(
      { store, senderResolver: fixedSenderResolver(sender) },
      { staleAfterMs: 5 * 60_000 },
    )

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
    const report = await runDeliveryWorker({ store, senderResolver: fixedSenderResolver(sender) })

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
    const report = await runDeliveryWorker({ store, senderResolver: fixedSenderResolver(sender) })

    expect(report).toEqual({ attempted: 0, sent: 0, failed: 0, skipped: 1 })
    expect(sender.sent).toHaveLength(0)
  })

  // HT-16 fix: claimThreadForDelivery now re-checks delivery_status
  // (src/store/conversations.ts), not just the lease — this is the worker-level
  // regression for that fix, using the REAL claim (not a mocked always-null
  // one, unlike the TOCTOU test above) so it actually exercises the store's
  // WHERE clause.
  it('a row eligible at listing time but delivered (marked "sent") by a concurrent keyed retry before this worker claims it is skipped, never re-sent', async () => {
    const { db: rawDb, store: realStore } = await freshStore()
    const { conversationId } = await seedConversation(realStore)
    const raced = await realStore.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.raced-sent.sig@mail.example.test>',
      fromAddress: 'support@example.test',
      bodyText: 'retry me',
      deliveryStatus: 'failed',
      sendEnvelope: envelope(),
    })
    if (!raced.ok) throw new Error('unreachable')

    // Listing behaves normally (the row IS eligible — still 'failed' and
    // unleased when the sweep starts). Immediately after, simulate a
    // concurrent keyed sendReply replay completing delivery of this exact
    // row before this worker gets to its own claim call. claimThreadForDelivery
    // is the REAL implementation here — the fix, not a mock, is what must
    // make this row unclaimable now that it is 'sent'.
    const store: ConversationStore = {
      ...realStore,
      async listDeliverableThreads(options) {
        const rows = await realStore.listDeliverableThreads(options)
        await rawDb.query(
          "UPDATE threads SET delivery_status = 'sent', claimed_until = NULL WHERE id = $1",
          [raced.threadId],
        )
        return rows
      },
    }

    const sender = fakeSender()
    const report = await runDeliveryWorker({ store, senderResolver: fixedSenderResolver(sender) })

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
    const report = await runDeliveryWorker(
      { store, senderResolver: fixedSenderResolver(sender) },
      { batchSize: 2 },
    )

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
      maxSendMs: 30_000,
      async send() {
        throw new Error('still down')
      },
    }
    const report = await runDeliveryWorker({ store, senderResolver: fixedSenderResolver(sender) })

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
        maxSendMs: 30_000,
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
      maxSendMs: 30_000,
      async send() {
        workerSendCalls++
        await workerSendGate
        return {}
      },
    }

    const workerPromise = runDeliveryWorker(
      { store, senderResolver: fixedSenderResolver(workerSender) },
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

  // HT-101 Stage 2b-ii: the sender is no longer one fixed value known
  // upfront — it varies per claimed row's own mailbox — so this bound check
  // can no longer run before ANY row is listed/claimed (that would require
  // knowing every candidate's sender before knowing any candidate at all).
  // It still runs before the sender is ever INVOKED, per candidate,
  // immediately after that candidate's own claim + sender resolution — the
  // property this test now proves is the one that actually matters: a
  // misconfigured lease/sender bound is caught loudly and `sender.send()` is
  // never reached, rather than silently reopening the double-send hole.
  it("a leaseMs that does not strictly exceed the sender's maxSendMs throws before attempting delivery, never invoking the sender", async () => {
    const { store } = await freshStore()
    const { conversationId } = await seedConversation(store)
    await store.appendThread(conversationId, {
      direction: 'outbound',
      messageId: '<ht.k1.boundcheck.sig@mail.example.test>',
      fromAddress: 'support@example.test',
      bodyText: 'retry me',
      deliveryStatus: 'failed',
      sendEnvelope: envelope(),
    })

    const sender = fakeSender() // maxSendMs: 30_000

    // Equality is a violation too — the lease must STRICTLY exceed the
    // sender's enforced bound (specs/mail/sending.md §3a).
    await expect(
      runDeliveryWorker(
        { store, senderResolver: fixedSenderResolver(sender) },
        { leaseMs: sender.maxSendMs },
      ),
    ).rejects.toThrow(/must strictly exceed/)

    expect(sender.sent).toHaveLength(0)
  })

  // --- per-mailbox sender resolution (HT-101 Stage 2b-ii) ---------------------

  describe('per-mailbox sender resolution (HT-101 Stage 2b-ii)', () => {
    /** Builds a conversation stamped with `mailbox.id` and one 'failed' outbound thread whose `fromAddress` is `mailbox.address` — a retry candidate whose persisted From matches the inbox it belongs to (so the worker's from/transport guard passes on the happy path). */
    async function seedConversationForMailbox(
      store: ConversationStore,
      mailbox: { id: string; address: string },
      messageId: string,
    ): Promise<{ conversationId: string; threadId: string }> {
      const { conversationId } = await store.createConversation({
        subject: 'Help with my order',
        customerEmail: 'customer@example.test',
        firstMessage: {
          direction: 'inbound',
          messageId: `<inbound-${messageId}@customer.example.test>`,
          fromAddress: 'customer@example.test',
          bodyText: 'Where is my order?',
        },
        mailboxId: mailbox.id,
      })
      const appended = await store.appendThread(conversationId, {
        direction: 'outbound',
        messageId,
        fromAddress: mailbox.address,
        bodyText: 'retry me',
        deliveryStatus: 'failed',
        sendEnvelope: envelope(),
      })
      if (!appended.ok) throw new Error('unreachable')
      return { conversationId, threadId: appended.threadId }
    }

    it("resolves each claimed thread's sender from ITS OWN conversation's mailbox, not a single fixed sender", async () => {
      const { db: rawDb, store } = await freshStore()
      const mailboxStore = createMailboxStore(rawDb)
      const mailboxA = await mailboxStore.upsertConnectedMailbox({
        address: 'inbox-a@example.test',
        provider: 'gmail',
      })
      const mailboxB = await mailboxStore.upsertConnectedMailbox({
        address: 'inbox-b@example.test',
        provider: 'imap',
      })

      await seedConversationForMailbox(store, mailboxA, '<ht.k1.mailbox-a.sig@mail.example.test>')
      await seedConversationForMailbox(store, mailboxB, '<ht.k1.mailbox-b.sig@mail.example.test>')

      const senderA = fakeSender()
      const senderB = fakeSender()
      const resolvedMailboxIds: (string | null)[] = []
      const senderResolver: SenderResolver = {
        async resolve(mailboxId) {
          resolvedMailboxIds.push(mailboxId)
          if (mailboxId === mailboxA.id) return { sender: senderA, from: mailboxA.address }
          if (mailboxId === mailboxB.id) return { sender: senderB, from: mailboxB.address }
          throw new Error(`unexpected mailboxId: ${mailboxId}`)
        },
      }

      const report = await runDeliveryWorker({ store, senderResolver })

      expect(report).toEqual({ attempted: 2, sent: 2, failed: 0, skipped: 0 })
      expect(senderA.sent.map((e) => e.messageId)).toEqual([
        '<ht.k1.mailbox-a.sig@mail.example.test>',
      ])
      expect(senderB.sent.map((e) => e.messageId)).toEqual([
        '<ht.k1.mailbox-b.sig@mail.example.test>',
      ])
      expect(resolvedMailboxIds.sort()).toEqual([mailboxA.id, mailboxB.id].sort())
    })

    it('a claimed thread whose mailbox cannot be resolved (SenderResolutionError) is marked failed and the sweep continues with the next candidate', async () => {
      const { db: rawDb, store } = await freshStore()
      const mailboxStore = createMailboxStore(rawDb)
      const goodMailbox = await mailboxStore.upsertConnectedMailbox({
        address: 'inbox-good@example.test',
        provider: 'gmail',
      })
      // A REAL mailbox row (the FK on conversations.mailbox_id requires one),
      // but standing in for one whose IMAP config/credential is missing —
      // exactly the condition SenderResolver itself throws
      // SenderResolutionError for (`missing-imap-connection`).
      const brokenMailbox = await mailboxStore.upsertConnectedMailbox({
        address: 'inbox-broken@example.test',
        provider: 'imap',
      })

      const { threadId: brokenThreadId } = await seedConversationForMailbox(
        store,
        brokenMailbox,
        '<ht.k1.broken-mailbox.sig@mail.example.test>',
      )
      await seedConversationForMailbox(
        store,
        goodMailbox,
        '<ht.k1.good-mailbox.sig@mail.example.test>',
      )

      const goodSender = fakeSender()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const senderResolver: SenderResolver = {
        async resolve(mailboxId) {
          if (mailboxId === goodMailbox.id) return { sender: goodSender, from: goodMailbox.address }
          throw new SenderResolutionError(
            'missing-imap-connection',
            `mailbox ${mailboxId} is missing its IMAP/SMTP connection config`,
          )
        },
      }

      const report = await runDeliveryWorker({ store, senderResolver })

      // Both candidates were claimed successfully (`attempted = sent +
      // failed`, per DeliveryWorkerReport's doc) — the broken one counts
      // toward `failed` even though `sender.send()` was never reached for
      // it, same as a claim that led to a genuine provider rejection would.
      expect(report).toEqual({ attempted: 2, sent: 1, failed: 1, skipped: 0 })
      expect(goodSender.sent.map((e) => e.messageId)).toEqual([
        '<ht.k1.good-mailbox.sig@mail.example.test>',
      ])

      const conversation = await store.getConversationByThreadId(brokenThreadId)
      const brokenThread = conversation?.threads.find((t) => t.id === brokenThreadId)
      expect(brokenThread?.deliveryStatus).toBe('failed')
      errorSpy.mockRestore()
    })

    it('a null mailboxId (pre-2b-i conversation) is passed through to the resolver as null', async () => {
      const { store } = await freshStore()
      const { conversationId } = await seedConversation(store)
      await store.appendThread(conversationId, {
        direction: 'outbound',
        messageId: '<ht.k1.null-mailbox.sig@mail.example.test>',
        fromAddress: 'support@example.test',
        bodyText: 'retry me',
        deliveryStatus: 'failed',
        sendEnvelope: envelope(),
      })

      const defaultSender = fakeSender()
      const resolvedMailboxIds: (string | null)[] = []
      const senderResolver: SenderResolver = {
        async resolve(mailboxId) {
          resolvedMailboxIds.push(mailboxId)
          return { sender: defaultSender, from: 'support@example.test' }
        },
      }

      const report = await runDeliveryWorker({ store, senderResolver })

      expect(report).toEqual({ attempted: 1, sent: 1, failed: 0, skipped: 0 })
      expect(resolvedMailboxIds).toEqual([null])
    })

    it('refuses to retry a row whose persisted fromAddress no longer matches its resolved transport (mailbox deleted → default) — fails it, never sends mismatched', async () => {
      const { store } = await freshStore()
      // A conversation with no mailbox (mailbox_id null, as if its inbox was
      // hard-deleted) but a row originally sent as a SPECIFIC inbox address.
      const { conversationId } = await seedConversation(store)
      await store.appendThread(conversationId, {
        direction: 'outbound',
        messageId: '<ht.k1.mismatch.sig@mail.example.test>',
        fromAddress: 'deleted-inbox@example.test',
        bodyText: 'retry me',
        deliveryStatus: 'failed',
        sendEnvelope: envelope(),
      })

      const defaultSender = fakeSender()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // resolve(null) yields the DEFAULT transport (from = support@...), which
      // does NOT match the row's persisted 'deleted-inbox@example.test'.
      const senderResolver: SenderResolver = {
        async resolve() {
          return { sender: defaultSender, from: 'support@example.test' }
        },
      }

      const report = await runDeliveryWorker({ store, senderResolver })

      expect(report).toEqual({ attempted: 1, sent: 0, failed: 1, skipped: 0 })
      // The from/transport guard fired BEFORE the sender was ever invoked.
      expect(defaultSender.sent).toHaveLength(0)
      errorSpy.mockRestore()
    })
  })
})
