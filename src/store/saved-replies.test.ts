import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createSavedReplyStore, type SavedReplyStore } from './saved-replies.js'

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

async function insertMailbox(db: Db, address = 'support@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    'INSERT INTO mailboxes (address, provider) VALUES ($1, $2) RETURNING id',
    [address, 'gmail'],
  )
  return rows[0].id
}

describe('SavedReplyStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(): Promise<{ db: Db; store: SavedReplyStore; mailboxId: string }> {
    db = await createPgliteDb()
    await migrate(db)
    const mailboxId = await insertMailbox(db)
    return { db, store: createSavedReplyStore(db), mailboxId }
  }

  it('createSavedReply defaults actions to {} and sortOrder to 0', async () => {
    const { store, mailboxId } = await freshStore()

    const created = await store.createSavedReply({
      mailboxId,
      name: 'Thanks',
      bodyText: 'Thanks for reaching out!',
    })

    expect(created).toMatchObject({
      mailboxId,
      name: 'Thanks',
      bodyText: 'Thanks for reaching out!',
      bodyHtml: null,
      actions: {},
      sortOrder: 0,
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('createSavedReply persists actions and bodyHtml/sortOrder verbatim', async () => {
    const { store, mailboxId } = await freshStore()

    const created = await store.createSavedReply({
      mailboxId,
      name: 'Refund macro',
      bodyText: 'Refund issued.',
      bodyHtml: '<p>Refund issued.</p>',
      actions: { setStatus: 'closed', addTags: ['refunded'], assignToSelf: true },
      sortOrder: 5,
    })

    expect(created.bodyHtml).toBe('<p>Refund issued.</p>')
    expect(created.actions).toEqual({
      setStatus: 'closed',
      addTags: ['refunded'],
      assignToSelf: true,
    })
    expect(created.sortOrder).toBe(5)
  })

  it('createSavedReply throws when mailboxId names no mailbox (FK)', async () => {
    const { store } = await freshStore()
    await expect(
      store.createSavedReply({ mailboxId: RANDOM_UUID, name: 'x', bodyText: 'x' }),
    ).rejects.toThrow()
  })

  it('listByMailbox returns rows ordered by sort_order then created_at, scoped to the mailbox', async () => {
    const { db, store, mailboxId } = await freshStore()
    const otherMailboxId = await insertMailbox(db, 'other@example.test')
    await store.createSavedReply({ mailboxId: otherMailboxId, name: 'Other', bodyText: 'z' })

    const second = await store.createSavedReply({
      mailboxId,
      name: 'Second',
      bodyText: 'b',
      sortOrder: 2,
    })
    const first = await store.createSavedReply({
      mailboxId,
      name: 'First',
      bodyText: 'a',
      sortOrder: 1,
    })

    const list = await store.listByMailbox(mailboxId)
    expect(list.map((r) => r.id)).toEqual([first.id, second.id])
  })

  it('listByMailbox returns [] for a mailbox with no saved replies', async () => {
    const { store, mailboxId } = await freshStore()
    expect(await store.listByMailbox(mailboxId)).toEqual([])
  })

  it('getSavedReply returns null for an unknown id', async () => {
    const { store } = await freshStore()
    expect(await store.getSavedReply(RANDOM_UUID)).toBeNull()
  })

  it('updateSavedReply changes only the given fields', async () => {
    const { store, mailboxId } = await freshStore()
    const created = await store.createSavedReply({
      mailboxId,
      name: 'Original',
      bodyText: 'original body',
      actions: { setStatus: 'pending' },
    })

    const updated = await store.updateSavedReply(created.id, { name: 'Renamed' })
    expect(updated).toMatchObject({
      name: 'Renamed',
      bodyText: 'original body',
      actions: { setStatus: 'pending' },
    })
  })

  it('updateSavedReply with an empty patch is a no-op read', async () => {
    const { store, mailboxId } = await freshStore()
    const created = await store.createSavedReply({ mailboxId, name: 'x', bodyText: 'y' })
    const updated = await store.updateSavedReply(created.id, {})
    expect(updated).toMatchObject({ name: 'x', bodyText: 'y' })
  })

  it('updateSavedReply returns null for an unknown id', async () => {
    const { store } = await freshStore()
    expect(await store.updateSavedReply(RANDOM_UUID, { name: 'x' })).toBeNull()
  })

  it('deleteSavedReply removes the row and returns true; false on a second call', async () => {
    const { store, mailboxId } = await freshStore()
    const created = await store.createSavedReply({ mailboxId, name: 'x', bodyText: 'y' })

    expect(await store.deleteSavedReply(created.id)).toBe(true)
    expect(await store.getSavedReply(created.id)).toBeNull()
    expect(await store.deleteSavedReply(created.id)).toBe(false)
  })

  it('deleting the owning mailbox cascades and removes its saved replies', async () => {
    const { db, store, mailboxId } = await freshStore()
    const created = await store.createSavedReply({ mailboxId, name: 'x', bodyText: 'y' })

    await db.query('DELETE FROM mailboxes WHERE id = $1', [mailboxId])

    expect(await store.getSavedReply(created.id)).toBeNull()
  })
})
