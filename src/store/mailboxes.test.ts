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

  it('does NOT downgrade a disconnected mailbox — guard holds, silent no-op, no throw (review fix)', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'disconnected' })

    // The guarded row exists, so this must NOT throw the "no mailbox" error
    // — only a genuinely missing row does that (see the previous test).
    await expect(store.markNeedsReconnect(mailboxId)).resolves.toBeUndefined()

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('disconnected')
  })

  it('getMailboxById finds an existing mailbox by id', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { address: 'support@example.test' })

    const mailbox = await store.getMailboxById(mailboxId)
    expect(mailbox).toEqual({
      id: mailboxId,
      address: 'support@example.test',
      provider: 'gmail',
      status: 'active',
    })
  })

  it('getMailboxById returns null for an unknown id', async () => {
    const { store } = await freshStore()
    expect(await store.getMailboxById(RANDOM_UUID)).toBeNull()
  })

  it('getMailboxById returns a non-active mailbox WITH its real status', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'needs_reconnect' })

    const mailbox = await store.getMailboxById(mailboxId)
    expect(mailbox?.status).toBe('needs_reconnect')
  })

  it('markPaused flips an active mailbox to paused', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'active' })

    await store.markPaused(mailboxId)

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('paused')
  })

  it('markPaused bumps updated_at', async () => {
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

    await store.markPaused(mailboxId)

    const after = await db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM mailboxes WHERE id = $1',
      [mailboxId],
    )
    expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime() - 60_000)
  })

  it('markPaused is idempotent — marking an already paused mailbox succeeds', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'paused' })

    await expect(store.markPaused(mailboxId)).resolves.toBeUndefined()

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('paused')
  })

  it('markPaused throws for a mailbox id that does not exist', async () => {
    const { store } = await freshStore()
    await expect(store.markPaused(RANDOM_UUID)).rejects.toThrow(/no mailbox/)
  })

  it('markPaused does NOT downgrade a disconnected mailbox — guard holds, silent no-op, no throw (review fix)', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'disconnected' })

    await expect(store.markPaused(mailboxId)).resolves.toBeUndefined()

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('disconnected')
  })

  // --- markDisconnected (HT-47, gmail-connect.md's disconnect section) -------

  it('markDisconnected flips an active mailbox to disconnected', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'active' })

    await store.markDisconnected(mailboxId)

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('disconnected')
  })

  it('markDisconnected is idempotent — marking an already disconnected mailbox succeeds', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'disconnected' })

    await expect(store.markDisconnected(mailboxId)).resolves.toBeUndefined()

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('disconnected')
  })

  it('markDisconnected throws for a mailbox id that does not exist', async () => {
    const { store } = await freshStore()
    await expect(store.markDisconnected(RANDOM_UUID)).rejects.toThrow(/no mailbox/)
  })

  it('markDisconnected runs against a caller-supplied tx when given', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'needs_reconnect' })

    await db.transaction(async (tx) => {
      await store.markDisconnected(mailboxId, tx)
    })

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('disconnected')
  })

  it('markDisconnected PARTICIPATES in the caller-supplied tx — a rollback takes the status write with it (review fix)', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db, { status: 'needs_reconnect' })

    // The commit test above would pass even if markDisconnected ignored `tx`
    // and wrote through its bound `db` — only a rollback can prove the write
    // actually rode the transaction, which is what the disconnect flow's
    // atomic-cleanup contract (`../mail/gmail-disconnect.ts`'s step-3
    // transaction) depends on.
    await expect(
      db.transaction(async (tx) => {
        await store.markDisconnected(mailboxId, tx)
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')

    const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
      mailboxId,
    ])
    expect(rows[0].status).toBe('needs_reconnect')
  })

  // --- upsertConnectedMailbox (HT-40, gmail-connect.md §4-§5) -----------------

  describe('upsertConnectedMailbox', () => {
    it('inserts a brand-new mailbox as active and returns the row', async () => {
      const { db, store } = await freshStore()

      const mailbox = await store.upsertConnectedMailbox({
        address: 'new@example.test',
        provider: 'gmail',
      })

      expect(mailbox.address).toBe('new@example.test')
      expect(mailbox.provider).toBe('gmail')
      expect(mailbox.status).toBe('active')
      expect(typeof mailbox.id).toBe('string')

      const rows = await db.query<{ address: string; provider: string; status: string }>(
        'SELECT address, provider, status FROM mailboxes WHERE id = $1',
        [mailbox.id],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({ address: 'new@example.test', provider: 'gmail', status: 'active' })
    })

    it('reactivates an existing needs_reconnect mailbox to active — same row, not a duplicate', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db, {
        address: 'reconnect@example.test',
        status: 'needs_reconnect',
      })

      const mailbox = await store.upsertConnectedMailbox({
        address: 'reconnect@example.test',
        provider: 'gmail',
      })

      expect(mailbox.id).toBe(mailboxId)
      expect(mailbox.status).toBe('active')

      const rows = await db.query<{ id: string }>('SELECT id FROM mailboxes WHERE address = $1', [
        'reconnect@example.test',
      ])
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(mailboxId)
    })

    it('reactivates an existing paused mailbox to active — same row, not a duplicate', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db, {
        address: 'paused2@example.test',
        status: 'paused',
      })

      const mailbox = await store.upsertConnectedMailbox({
        address: 'paused2@example.test',
        provider: 'gmail',
      })

      expect(mailbox.id).toBe(mailboxId)
      expect(mailbox.status).toBe('active')
      const rows = await db.query('SELECT id FROM mailboxes WHERE address = $1', [
        'paused2@example.test',
      ])
      expect(rows).toHaveLength(1)
    })

    it('reconnect updates provider from EXCLUDED.provider (seed differs from reconnect)', async () => {
      const { db, store } = await freshStore()
      // Seed with a DIFFERENT provider than the reconnect uses, so this
      // actually proves EXCLUDED.provider overwrote the row rather than the
      // value happening to already match. Migration 009's `provider` column is
      // unconstrained text, so a placeholder value is valid here.
      await insertMailbox(db, { address: 'provider-swap@example.test', provider: 'legacy-imap' })

      const mailbox = await store.upsertConnectedMailbox({
        address: 'provider-swap@example.test',
        provider: 'gmail',
      })

      expect(mailbox.provider).toBe('gmail')
      const rows = await db.query<{ provider: string }>(
        'SELECT provider FROM mailboxes WHERE address = $1',
        ['provider-swap@example.test'],
      )
      expect(rows[0].provider).toBe('gmail')
    })

    it('bumps updated_at on reconnect', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db, { address: 'bump@example.test', status: 'paused' })
      await db.query('UPDATE mailboxes SET updated_at = $1 WHERE id = $2', [
        new Date(Date.now() - 60_000),
        mailboxId,
      ])
      const before = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM mailboxes WHERE id = $1',
        [mailboxId],
      )

      await store.upsertConnectedMailbox({ address: 'bump@example.test', provider: 'gmail' })

      const after = await db.query<{ updated_at: Date }>(
        'SELECT updated_at FROM mailboxes WHERE id = $1',
        [mailboxId],
      )
      expect(after[0].updated_at.getTime()).toBeGreaterThan(before[0].updated_at.getTime())
    })

    it('an already-active mailbox stays active (idempotent) and keeps the same row', async () => {
      const { db, store } = await freshStore()
      const mailboxId = await insertMailbox(db, {
        address: 'active@example.test',
        status: 'active',
      })

      const mailbox = await store.upsertConnectedMailbox({
        address: 'active@example.test',
        provider: 'gmail',
      })

      expect(mailbox.id).toBe(mailboxId)
      expect(mailbox.status).toBe('active')
      const rows = await db.query('SELECT id FROM mailboxes WHERE address = $1', [
        'active@example.test',
      ])
      expect(rows).toHaveLength(1)
    })

    it('two different addresses produce two distinct mailbox rows', async () => {
      const { store } = await freshStore()

      const a = await store.upsertConnectedMailbox({
        address: 'a3@example.test',
        provider: 'gmail',
      })
      const b = await store.upsertConnectedMailbox({
        address: 'b3@example.test',
        provider: 'gmail',
      })

      expect(a.id).not.toBe(b.id)
    })
  })

  // --- listActiveMailboxes (HT-42, gmail-push.md §6) -----------------------

  describe('listActiveMailboxes', () => {
    it('returns only active mailboxes — paused and needs_reconnect are excluded', async () => {
      const { db, store } = await freshStore()
      const activeId = await insertMailbox(db, { address: 'active@example.test', status: 'active' })
      await insertMailbox(db, { address: 'paused@example.test', status: 'paused' })
      await insertMailbox(db, {
        address: 'needs-reconnect@example.test',
        status: 'needs_reconnect',
      })

      const mailboxes = await store.listActiveMailboxes()

      expect(mailboxes).toHaveLength(1)
      expect(mailboxes[0]).toEqual({
        id: activeId,
        address: 'active@example.test',
        provider: 'gmail',
        status: 'active',
      })
    })

    it('orders by created_at', async () => {
      const { db, store } = await freshStore()
      const first = await insertMailbox(db, { address: 'first@example.test' })
      const second = await insertMailbox(db, { address: 'second@example.test' })
      const third = await insertMailbox(db, { address: 'third@example.test' })
      // Force distinguishable timestamps, deliberately out of insertion
      // order, so a passing test actually proves the ORDER BY clause rather
      // than coincidentally matching insertion order.
      await db.query('UPDATE mailboxes SET created_at = $1 WHERE id = $2', [
        new Date('2026-01-03T00:00:00Z'),
        first,
      ])
      await db.query('UPDATE mailboxes SET created_at = $1 WHERE id = $2', [
        new Date('2026-01-01T00:00:00Z'),
        second,
      ])
      await db.query('UPDATE mailboxes SET created_at = $1 WHERE id = $2', [
        new Date('2026-01-02T00:00:00Z'),
        third,
      ])

      const mailboxes = await store.listActiveMailboxes()

      expect(mailboxes.map((m) => m.id)).toEqual([second, third, first])
    })

    it('returns [] when no mailbox is active', async () => {
      const { db, store } = await freshStore()
      await insertMailbox(db, { address: 'paused3@example.test', status: 'paused' })
      await insertMailbox(db, {
        address: 'needs-reconnect3@example.test',
        status: 'needs_reconnect',
      })

      expect(await store.listActiveMailboxes()).toEqual([])
    })

    it('returns [] when there are no mailboxes at all', async () => {
      const { store } = await freshStore()

      expect(await store.listActiveMailboxes()).toEqual([])
    })
  })
})
