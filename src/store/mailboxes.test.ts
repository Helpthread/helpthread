import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createMailboxStore } from './mailboxes.js'

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

async function insertMailbox(
  db: Db,
  overrides: { address?: string; provider?: string; status?: string } = {},
): Promise<string> {
  const rows = await db.query<{ id: string }>(
    'INSERT INTO mailboxes (address, provider, status) VALUES ($1, $2, $3) RETURNING id',
    [
      overrides.address ?? 'mailbox@example.test',
      overrides.provider ?? 'gmail',
      overrides.status ?? 'active',
    ],
  )
  return rows[0].id
}

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

  it('markNeedsReconnect flips an active mailbox to needs_reconnect', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'active' })

    await store.markNeedsReconnect(mailboxId)

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('needs_reconnect')
  })

  it('bumps updated_at', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    const before = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM mailboxes WHERE id = $1',
      [mailboxId],
    )
    // Force a distinguishable prior timestamp so a same-instant now() still
    // reads as strictly later — a bare now()-vs-now() race is not what this
    // test is proving.
    await db.query('UPDATE mailboxes SET updated_at = $1 WHERE id = $2', [
      new Date(before[0].updated_at.getTime() - 60_000),
      mailboxId,
    ])

    await store.markNeedsReconnect(mailboxId)

    const after = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM mailboxes WHERE id = $1',
      [mailboxId],
    )
    expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime() - 60_000)
  })

  it('is idempotent — marking an already needs_reconnect mailbox succeeds', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'needs_reconnect' })

    await expect(store.markNeedsReconnect(mailboxId)).resolves.toBeUndefined()

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('needs_reconnect')
  })

  it('throws for a mailbox id that does not exist', async () => {
    const { store } = await freshStore()
    await expect(store.markNeedsReconnect(RANDOM_UUID)).rejects.toThrow(/no mailbox/)
  })
})
