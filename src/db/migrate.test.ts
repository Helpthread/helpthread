import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from './client.js'
import { migrate } from './migrate.js'

describe('migrate', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  it('creates the conversations and threads tables, with gen_random_uuid() working', async () => {
    db = await createPgliteDb()
    await migrate(db)

    const [conversation] = await db.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )
    // A real UUID came back — proves gen_random_uuid() actually ran, not
    // just that the column accepted a default.
    expect(conversation.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )

    const [thread] = await db.query<{ id: string }>(
      `INSERT INTO threads (conversation_id, direction, from_address)
       VALUES ($1, 'inbound', $2) RETURNING id`,
      [conversation.id, 'customer@example.test'],
    )
    expect(thread.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('records exactly one _migrations row per migration', async () => {
    db = await createPgliteDb()
    await migrate(db)

    const rows = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM _migrations ORDER BY id',
    )
    expect(rows).toEqual([
      { id: 1, name: 'conversations_and_threads' },
      { id: 2, name: 'add_thread_delivery_status' },
      { id: 3, name: 'add_thread_send_idempotency' },
    ])
  })

  it('is idempotent: a second call is a clean no-op', async () => {
    db = await createPgliteDb()
    await migrate(db)
    await migrate(db) // must not throw (e.g. "relation already exists")

    const rows = await db.query<{ id: number }>('SELECT id FROM _migrations ORDER BY id')
    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('migration 002 ties delivery_status to direction: inbound must be NULL, outbound must be pending/sent/failed', async () => {
    db = await createPgliteDb()
    await migrate(db)

    const [conversation] = await db.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )

    // Inbound → NULL is the only legal value.
    const [nullRow] = await db.query<{ delivery_status: string | null }>(
      `INSERT INTO threads (conversation_id, direction, from_address)
       VALUES ($1, 'inbound', $2) RETURNING delivery_status`,
      [conversation.id, 'customer@example.test'],
    )
    expect(nullRow.delivery_status).toBeNull()

    // Outbound → one of the three outbox states.
    const [pendingRow] = await db.query<{ delivery_status: string | null }>(
      `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
       VALUES ($1, 'outbound', $2, 'pending') RETURNING delivery_status`,
      [conversation.id, 'support@example.test'],
    )
    expect(pendingRow.delivery_status).toBe('pending')

    // Outbound with an out-of-domain value → rejected.
    await expect(
      db.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
         VALUES ($1, 'outbound', $2, 'bogus')`,
        [conversation.id, 'support@example.test'],
      ),
    ).rejects.toThrow()

    // Cross-column invariant: an INBOUND thread may NOT carry a status...
    await expect(
      db.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
         VALUES ($1, 'inbound', $2, 'sent')`,
        [conversation.id, 'customer@example.test'],
      ),
    ).rejects.toThrow()

    // ...and an OUTBOUND thread may NOT be left NULL (invisible to a delivery worker).
    await expect(
      db.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
         VALUES ($1, 'outbound', $2, NULL)`,
        [conversation.id, 'support@example.test'],
      ),
    ).rejects.toThrow()
  })

  it('migration 002 upgrades a NON-fresh 001 database with preexisting outbound rows (backfills, does not fail)', async () => {
    db = await createPgliteDb()

    // Apply ONLY migration 001, then write an outbound thread the way a
    // pre-002 deployment would have — no delivery_status column yet.
    await migrate(db, { throughId: 1 })
    const [conversation] = await db.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )
    const [outbound] = await db.query<{ id: string }>(
      `INSERT INTO threads (conversation_id, direction, from_address)
       VALUES ($1, 'outbound', $2) RETURNING id`,
      [conversation.id, 'support@example.test'],
    )

    // Now apply 002 over that existing data. Without the backfill this throws
    // (the preexisting outbound row is NULL and violates the new CHECK).
    await expect(migrate(db)).resolves.toBeUndefined()

    // The preexisting outbound row was backfilled to 'pending', and the
    // constraint is now live (a fresh NULL outbound insert is rejected).
    const [row] = await db.query<{ delivery_status: string | null }>(
      'SELECT delivery_status FROM threads WHERE id = $1',
      [outbound.id],
    )
    expect(row.delivery_status).toBe('pending')
    await expect(
      db.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
         VALUES ($1, 'outbound', $2, NULL)`,
        [conversation.id, 'support@example.test'],
      ),
    ).rejects.toThrow()
  })

  it('migration 003 ties idempotency_key and send_envelope to direction: inbound must be NULL, outbound may carry either', async () => {
    db = await createPgliteDb()
    await migrate(db)

    const [conversation] = await db.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )

    // Outbound with both columns set is legal.
    const [outboundRow] = await db.query<{
      idempotency_key: string | null
      send_envelope: { to: string[]; subject: string } | null
      claimed_until: string | null
    }>(
      `INSERT INTO threads (conversation_id, direction, from_address, delivery_status, idempotency_key, send_envelope)
       VALUES ($1, 'outbound', $2, 'pending', $3, $4)
       RETURNING idempotency_key, send_envelope, claimed_until`,
      [
        conversation.id,
        'support@example.test',
        'retry-key-1',
        JSON.stringify({ to: ['customer@example.test'], subject: 'Re: Help' }),
      ],
    )
    expect(outboundRow.idempotency_key).toBe('retry-key-1')
    expect(outboundRow.send_envelope).toEqual({
      to: ['customer@example.test'],
      subject: 'Re: Help',
    })
    expect(outboundRow.claimed_until).toBeNull()

    // Outbound with neither column set (the no-key path) is also legal.
    const [outboundNoKeyRow] = await db.query<{ idempotency_key: string | null }>(
      `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
       VALUES ($1, 'outbound', $2, 'pending') RETURNING idempotency_key`,
      [conversation.id, 'support@example.test'],
    )
    expect(outboundNoKeyRow.idempotency_key).toBeNull()

    // Inbound may NOT carry an idempotency_key...
    await expect(
      db.query(
        `INSERT INTO threads (conversation_id, direction, from_address, idempotency_key)
         VALUES ($1, 'inbound', $2, $3)`,
        [conversation.id, 'customer@example.test', 'some-key'],
      ),
    ).rejects.toThrow()

    // ...nor a send_envelope.
    await expect(
      db.query(
        `INSERT INTO threads (conversation_id, direction, from_address, send_envelope)
         VALUES ($1, 'inbound', $2, $3)`,
        [conversation.id, 'customer@example.test', JSON.stringify({ to: [], subject: '' })],
      ),
    ).rejects.toThrow()
  })

  it('migration 003 enforces one idempotency_key per conversation via the partial unique index, but never collides on NULL', async () => {
    db = await createPgliteDb()
    await migrate(db)

    const [conversation] = await db.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )

    await db.query(
      `INSERT INTO threads (conversation_id, direction, from_address, delivery_status, idempotency_key)
       VALUES ($1, 'outbound', $2, 'pending', 'dup-key')`,
      [conversation.id, 'support@example.test'],
    )

    // A second outbound row in the SAME conversation with the SAME key collides.
    await expect(
      db.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status, idempotency_key)
         VALUES ($1, 'outbound', $2, 'pending', 'dup-key')`,
        [conversation.id, 'support@example.test'],
      ),
    ).rejects.toThrow()

    // Two NULL-key outbound rows in the same conversation never collide (the
    // partial index excludes NULL keys entirely) — this is the "no key ⇒ no
    // dedup protection" contract, enforced at the schema level too.
    await db.query(
      `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
       VALUES ($1, 'outbound', $2, 'pending')`,
      [conversation.id, 'support@example.test'],
    )
    await expect(
      db.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
         VALUES ($1, 'outbound', $2, 'pending')`,
        [conversation.id, 'support@example.test'],
      ),
    ).resolves.toBeDefined()
  })

  it('migration 003 upgrades a NON-fresh 002 database with preexisting outbound rows (no backfill needed, does not fail)', async () => {
    db = await createPgliteDb()

    // Apply only through migration 002, then write an outbound thread the way
    // a pre-003 deployment would have — no idempotency/envelope/lease columns
    // yet.
    await migrate(db, { throughId: 2 })
    const [conversation] = await db.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )
    const [outbound] = await db.query<{ id: string }>(
      `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
       VALUES ($1, 'outbound', $2, 'pending') RETURNING id`,
      [conversation.id, 'support@example.test'],
    )

    // Applying 003 over that existing data must not fail — the new columns
    // default to NULL, which satisfies both new CHECK constraints as-is.
    await expect(migrate(db)).resolves.toBeUndefined()

    const [row] = await db.query<{
      idempotency_key: string | null
      send_envelope: unknown
      claimed_until: string | null
    }>('SELECT idempotency_key, send_envelope, claimed_until FROM threads WHERE id = $1', [
      outbound.id,
    ])
    expect(row).toEqual({ idempotency_key: null, send_envelope: null, claimed_until: null })
  })
})
