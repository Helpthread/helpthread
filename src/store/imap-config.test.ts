import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createImapConfigStore } from './imap-config.js'

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'

async function insertMailbox(db: Db, address = 'mailbox@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "INSERT INTO mailboxes (address, provider) VALUES ($1, 'imap') RETURNING id",
    [address],
  )
  return rows[0].id
}

describe('createImapConfigStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore() {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createImapConfigStore(db) }
  }

  it('getConfig returns null when no config row exists yet', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    expect(await store.getConfig(mailboxId)).toBeNull()
  })

  it('getConfig returns null for a mailbox id that does not exist at all', async () => {
    const { store } = await freshStore()
    expect(await store.getConfig(RANDOM_UUID)).toBeNull()
  })

  it('upsertConfig then getConfig round-trips every field', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.upsertConfig(mailboxId, {
      imapHost: 'imap.example.test',
      imapPort: 993,
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      username: 'agent@example.test',
      secure: true,
    })
    const config = await store.getConfig(mailboxId)

    expect(config).toEqual({
      imapHost: 'imap.example.test',
      imapPort: 993,
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      username: 'agent@example.test',
      secure: true,
    })
  })

  it('round-trips secure: false explicitly (not just the default)', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.upsertConfig(mailboxId, {
      imapHost: 'imap.example.test',
      imapPort: 143,
      smtpHost: 'smtp.example.test',
      smtpPort: 25,
      username: 'agent@example.test',
      secure: false,
    })

    expect((await store.getConfig(mailboxId))?.secure).toBe(false)
  })

  it('a second upsertConfig call replaces the row (ON CONFLICT DO UPDATE), not a second row', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.upsertConfig(mailboxId, {
      imapHost: 'imap-v1.example.test',
      imapPort: 993,
      smtpHost: 'smtp-v1.example.test',
      smtpPort: 587,
      username: 'v1@example.test',
      secure: true,
    })
    await store.upsertConfig(mailboxId, {
      imapHost: 'imap-v2.example.test',
      imapPort: 143,
      smtpHost: 'smtp-v2.example.test',
      smtpPort: 25,
      username: 'v2@example.test',
      secure: false,
    })

    const config = await store.getConfig(mailboxId)
    expect(config?.imapHost).toBe('imap-v2.example.test')
    expect(config?.username).toBe('v2@example.test')
    expect(config?.secure).toBe(false)

    const rowCount = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM imap_mailbox_config WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(rowCount[0].n).toBe(1)
  })

  it('two different mailboxes have independent config rows', async () => {
    const { db, store } = await freshStore()
    const mailboxA = await insertMailbox(db, 'a@example.test')
    const mailboxB = await insertMailbox(db, 'b@example.test')

    await store.upsertConfig(mailboxA, {
      imapHost: 'imap-a.example.test',
      imapPort: 993,
      smtpHost: 'smtp-a.example.test',
      smtpPort: 587,
      username: 'a@example.test',
      secure: true,
    })
    await store.upsertConfig(mailboxB, {
      imapHost: 'imap-b.example.test',
      imapPort: 993,
      smtpHost: 'smtp-b.example.test',
      smtpPort: 587,
      username: 'b@example.test',
      secure: true,
    })

    expect((await store.getConfig(mailboxA))?.imapHost).toBe('imap-a.example.test')
    expect((await store.getConfig(mailboxB))?.imapHost).toBe('imap-b.example.test')
  })

  it('upsertConfig bumps updated_at', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await db.query(
      `INSERT INTO imap_mailbox_config
         (mailbox_id, imap_host, imap_port, smtp_host, smtp_port, username, updated_at)
       VALUES ($1, 'imap.example.test', 993, 'smtp.example.test', 587, 'agent@example.test', now() - interval '1 hour')`,
      [mailboxId],
    )
    const before = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM imap_mailbox_config WHERE mailbox_id = $1',
      [mailboxId],
    )

    await store.upsertConfig(mailboxId, {
      imapHost: 'imap.example.test',
      imapPort: 993,
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      username: 'agent@example.test',
      secure: true,
    })

    const after = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM imap_mailbox_config WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime())
  })

  it('upsertConfig runs against a caller-supplied tx, committing atomically with it', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await db.transaction(async (tx) => {
      await store.upsertConfig(
        mailboxId,
        {
          imapHost: 'imap.example.test',
          imapPort: 993,
          smtpHost: 'smtp.example.test',
          smtpPort: 587,
          username: 'agent@example.test',
          secure: true,
        },
        tx,
      )
    })

    expect((await store.getConfig(mailboxId))?.imapHost).toBe('imap.example.test')
  })
})
