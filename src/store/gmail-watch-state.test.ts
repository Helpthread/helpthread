import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createGmailWatchStateStore } from './gmail-watch-state.js'

async function insertMailbox(db: Db, address = 'mailbox@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    'INSERT INTO mailboxes (address, provider) VALUES ($1, $2) RETURNING id',
    [address, 'gmail'],
  )
  return rows[0].id
}

describe('createGmailWatchStateStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore() {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createGmailWatchStateStore(db) }
  }

  it('getCursor returns null when no watch-state row exists yet', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    expect(await store.getCursor(mailboxId)).toBeNull()
  })

  it('getCursor returns null when a row exists but history_id is still null', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query('INSERT INTO gmail_watch_state (mailbox_id) VALUES ($1)', [mailboxId])

    expect(await store.getCursor(mailboxId)).toBeNull()
  })

  it('getCursor returns the stored history_id', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query('INSERT INTO gmail_watch_state (mailbox_id, history_id) VALUES ($1, $2)', [
      mailboxId,
      '123456789',
    ])

    expect(await store.getCursor(mailboxId)).toBe('123456789')
  })

  it('setCursor inserts a baseline row when none exists yet (upsert)', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.setCursor(mailboxId, '111')

    const rows = await db.query<{ history_id: string | null }>(
      'SELECT history_id FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].history_id).toBe('111')
  })

  it('setCursor updates an existing row rather than colliding on the PK (upsert, not a plain insert)', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query('INSERT INTO gmail_watch_state (mailbox_id, history_id) VALUES ($1, $2)', [
      mailboxId,
      '111',
    ])

    await store.setCursor(mailboxId, '222')

    const rows = await db.query<{ history_id: string | null }>(
      'SELECT history_id FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(rows).toHaveLength(1) // still exactly one row for this mailbox
    expect(rows[0].history_id).toBe('222')
  })

  it('setCursor is safe to call twice in a row, always landing on the latest value', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.setCursor(mailboxId, '111')
    await store.setCursor(mailboxId, '222')

    expect(await store.getCursor(mailboxId)).toBe('222')
    const rows = await db.query('SELECT mailbox_id FROM gmail_watch_state WHERE mailbox_id = $1', [
      mailboxId,
    ])
    expect(rows).toHaveLength(1)
  })

  it('setCursor bumps updated_at', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query(
      "INSERT INTO gmail_watch_state (mailbox_id, history_id, updated_at) VALUES ($1, $2, now() - interval '1 hour')",
      [mailboxId, '111'],
    )
    const before = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )

    await store.setCursor(mailboxId, '222')

    const after = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime())
  })

  it('setCursor is per-mailbox — advancing one mailbox does not touch another', async () => {
    const { db, store } = await freshStore()
    const mailboxA = await insertMailbox(db, 'a@example.test')
    const mailboxB = await insertMailbox(db, 'b@example.test')
    await store.setCursor(mailboxA, 'a-1')
    await store.setCursor(mailboxB, 'b-1')

    await store.setCursor(mailboxA, 'a-2')

    expect(await store.getCursor(mailboxA)).toBe('a-2')
    expect(await store.getCursor(mailboxB)).toBe('b-1')
  })
})
