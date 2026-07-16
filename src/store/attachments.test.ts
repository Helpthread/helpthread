import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import {
  createThreadAttachmentStore,
  insertThreadAttachmentsInTx,
  type ThreadAttachmentStore,
} from './attachments.js'
import { type ConversationStore, createConversationStore } from './conversations.js'

// --- fixtures ----------------------------------------------------------------

/** Insert a conversation + its first (inbound) thread directly via the real store, returning both ids. */
async function createConversationWithThread(
  store: ConversationStore,
): Promise<{ conversationId: string; threadId: string }> {
  return store.createConversation({
    subject: 'Test',
    customerEmail: 'customer@example.test',
    firstMessage: {
      direction: 'inbound',
      messageId: '<msg-1@customer.example.test>',
      fromAddress: 'customer@example.test',
      bodyText: 'hi',
    },
  })
}

// --- suite ---------------------------------------------------------------------

describe('ThreadAttachmentStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshDeps(): Promise<{
    db: Db
    conversationStore: ConversationStore
    attachmentStore: ThreadAttachmentStore
  }> {
    db = await createPgliteDb()
    await migrate(db)
    return {
      db,
      conversationStore: createConversationStore(db),
      attachmentStore: createThreadAttachmentStore(db),
    }
  }

  it('listByConversationId returns [] for a conversation with no attachments', async () => {
    const { conversationStore, attachmentStore } = await freshDeps()
    const { conversationId } = await createConversationWithThread(conversationStore)

    expect(await attachmentStore.listByConversationId(conversationId)).toEqual([])
  })

  it('listByConversationId returns [] for a nonexistent conversation id', async () => {
    const { attachmentStore } = await freshDeps()
    expect(
      await attachmentStore.listByConversationId('00000000-0000-4000-8000-000000000000'),
    ).toEqual([])
  })

  it('insertThreadAttachmentsInTx is a no-op for an empty array', async () => {
    const { db, conversationStore, attachmentStore } = await freshDeps()
    const { conversationId } = await createConversationWithThread(conversationStore)

    await db.transaction(async (tx) => {
      await insertThreadAttachmentsInTx(tx, [])
    })

    expect(await attachmentStore.listByConversationId(conversationId)).toEqual([])
  })

  it('persists multiple attachments for one thread and reads them back, oldest-first, scoped to their conversation', async () => {
    const { db, conversationStore, attachmentStore } = await freshDeps()
    const { conversationId, threadId } = await createConversationWithThread(conversationStore)
    // A second, unrelated conversation whose attachments must never leak into
    // the first conversation's read.
    const other = await createConversationWithThread(conversationStore)

    await db.transaction(async (tx) => {
      await insertThreadAttachmentsInTx(tx, [
        {
          threadId,
          filename: 'a.txt',
          contentType: 'text/plain',
          size: 3,
          blobKey: 'mbox/a/a.txt',
        },
        {
          threadId,
          filename: 'b.png',
          contentType: 'image/png',
          size: 100,
          blobKey: 'mbox/b/b.png',
        },
      ])
      await insertThreadAttachmentsInTx(tx, [
        {
          threadId: other.threadId,
          filename: 'other.txt',
          contentType: 'text/plain',
          size: 1,
          blobKey: 'mbox/o/other.txt',
        },
      ])
    })

    // Both inserts above ran inside the SAME transaction, so `created_at`
    // (bound to that transaction's `now()`) ties for both rows — the `id`
    // tiebreak then decides order, which is not insertion order. Sort by
    // filename before asserting so this test doesn't depend on that tie's
    // resolution.
    const rows = (await attachmentStore.listByConversationId(conversationId)).sort((a, b) =>
      (a.filename ?? '').localeCompare(b.filename ?? ''),
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.filename)).toEqual(['a.txt', 'b.png'])
    expect(rows[0]).toMatchObject({
      threadId,
      filename: 'a.txt',
      contentType: 'text/plain',
      size: 3,
      blobKey: 'mbox/a/a.txt',
    })
    expect(rows[0].id).toEqual(expect.any(String))
    expect(rows[0].createdAt).toBeInstanceOf(Date)

    const otherRows = await attachmentStore.listByConversationId(other.conversationId)
    expect(otherRows).toHaveLength(1)
    expect(otherRows[0].filename).toBe('other.txt')
  })

  it('supports a null filename (e.g. an inline image with no Content-Disposition filename)', async () => {
    const { db, conversationStore, attachmentStore } = await freshDeps()
    const { conversationId, threadId } = await createConversationWithThread(conversationStore)

    await db.transaction(async (tx) => {
      await insertThreadAttachmentsInTx(tx, [
        {
          threadId,
          filename: null,
          contentType: 'image/png',
          size: 10,
          blobKey: 'mbox/x/attachment',
        },
      ])
    })

    const rows = await attachmentStore.listByConversationId(conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0].filename).toBeNull()
  })

  it('a rolled-back transaction leaves no attachment row behind', async () => {
    const { db, conversationStore, attachmentStore } = await freshDeps()
    const { conversationId, threadId } = await createConversationWithThread(conversationStore)

    await expect(
      db.transaction(async (tx) => {
        await insertThreadAttachmentsInTx(tx, [
          {
            threadId,
            filename: 'a.txt',
            contentType: 'text/plain',
            size: 3,
            blobKey: 'mbox/a/a.txt',
          },
        ])
        throw new Error('simulated abort')
      }),
    ).rejects.toThrow('simulated abort')

    expect(await attachmentStore.listByConversationId(conversationId)).toEqual([])
  })
})
