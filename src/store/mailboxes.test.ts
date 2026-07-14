import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createMailboxStore } from './mailboxes.js'

describe('createMailboxStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore() {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createMailboxStore(db) }
  }

  it('getMailboxByAddress finds an existing mailbox by its exact address', async () => {
    const { db, store } = await freshStore()
    const [row] = await db.query<{ id: string }>(
      'INSERT INTO mailboxes (address, provider) VALUES ($1, $2) RETURNING id',
      ['support@example.test', 'gmail'],
    )

    const mailbox = await store.getMailboxByAddress('support@example.test')
    expect(mailbox).toEqual({
      id: row.id,
      address: 'support@example.test',
      provider: 'gmail',
      status: 'active', // migration 009's default
    })
  })

  it('returns null for an unknown address', async () => {
    const { store } = await freshStore()
    const mailbox = await store.getMailboxByAddress('nobody@example.test')
    expect(mailbox).toBeNull()
  })

  it('returns a non-active mailbox WITH its real status — does not filter by status itself', async () => {
    const { db, store } = await freshStore()
    await db.query('INSERT INTO mailboxes (address, provider) VALUES ($1, $2)', [
      'paused@example.test',
      'gmail',
    ])
    await db.query("UPDATE mailboxes SET status = 'paused' WHERE address = $1", [
      'paused@example.test',
    ])

    const mailbox = await store.getMailboxByAddress('paused@example.test')
    expect(mailbox?.status).toBe('paused')
  })

  it('is exact-match, not case-insensitive or substring — a near-miss address is unknown', async () => {
    const { db, store } = await freshStore()
    await db.query('INSERT INTO mailboxes (address, provider) VALUES ($1, $2)', [
      'support@example.test',
      'gmail',
    ])

    expect(await store.getMailboxByAddress('SUPPORT@example.test')).toBeNull()
    expect(await store.getMailboxByAddress('support@example.test.evil')).toBeNull()
  })
})
