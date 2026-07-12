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
      { id: 4, name: 'four_state_conversation_status' },
      { id: 5, name: 'conversation_number' },
      { id: 6, name: 'tags_and_assignee' },
      { id: 7, name: 'note_thread_direction' },
      { id: 8, name: 'customer_viewed_at' },
    ])
  })

  it('is idempotent: a second call is a clean no-op', async () => {
    db = await createPgliteDb()
    await migrate(db)
    await migrate(db) // must not throw (e.g. "relation already exists")

    const rows = await db.query<{ id: number }>('SELECT id FROM _migrations ORDER BY id')
    expect(rows).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
      { id: 5 },
      { id: 6 },
      { id: 7 },
      { id: 8 },
    ])
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

  it("migration 004 upgrades a NON-fresh 003 database: 'open' rows become 'active', closed/deleted untouched", async () => {
    // A local const binding so the helper closures below see a narrowed `Db`
    // (the shared `db` let stays assigned for afterEach's cleanup).
    const database = await createPgliteDb()
    db = database

    // Apply only through migration 003, then write conversations the way a
    // pre-004 deployment would have — the old open/closed/deleted model.
    await migrate(database, { throughId: 3 })
    const insert = async (status: string) => {
      const [row] = await database.query<{ id: string }>(
        'INSERT INTO conversations (customer_email, status) VALUES ($1, $2) RETURNING id',
        ['customer@example.test', status],
      )
      return row.id
    }
    const openId = await insert('open')
    const closedId = await insert('closed')
    const deletedId = await insert('deleted')

    // Applying 004 over that existing data must not fail — the old CHECK is
    // dropped BEFORE the open→active backfill (order is load-bearing; see the
    // migration's doc comment).
    await expect(migrate(database)).resolves.toBeUndefined()

    const statusOf = async (id: string) =>
      (
        await database.query<{ status: string }>('SELECT status FROM conversations WHERE id = $1', [
          id,
        ])
      )[0].status
    expect(await statusOf(openId)).toBe('active')
    expect(await statusOf(closedId)).toBe('closed')
    expect(await statusOf(deletedId)).toBe('deleted')
  })

  it("migration 004 installs the four-state model: default is 'active', all four + deleted accepted, 'open' rejected", async () => {
    db = await createPgliteDb()
    await migrate(db)

    // The column default moved to 'active' — a status-less INSERT (the
    // inbound-mail path) creates an active conversation.
    const [defaulted] = await db.query<{ status: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING status',
      ['customer@example.test'],
    )
    expect(defaulted.status).toBe('active')

    for (const status of ['pending', 'closed', 'spam', 'deleted']) {
      await expect(
        db.query('INSERT INTO conversations (customer_email, status) VALUES ($1, $2)', [
          'customer@example.test',
          status,
        ]),
      ).resolves.toBeDefined()
    }

    // The pre-004 value is no longer legal — the migration is a rename, not a
    // widening that quietly keeps both spellings alive.
    await expect(
      db.query('INSERT INTO conversations (customer_email, status) VALUES ($1, $2)', [
        'customer@example.test',
        'open',
      ]),
    ).rejects.toThrow()
  })

  it('migration 005 upgrades a NON-fresh 004 database: existing rows numbered in creation order, the sequence continues after them', async () => {
    const database = await createPgliteDb()
    db = database

    // Apply only through migration 004, then write conversations the way a
    // pre-005 deployment would have — no number column yet. Explicit,
    // strictly-increasing created_at values so "creation order" is fully
    // controlled rather than relying on clock granularity.
    await migrate(database, { throughId: 4 })
    const insert = async (createdAt: string) => {
      const [row] = await database.query<{ id: string }>(
        'INSERT INTO conversations (customer_email, created_at) VALUES ($1, $2) RETURNING id',
        ['customer@example.test', createdAt],
      )
      return row.id
    }
    // Inserted out of creation order on purpose — the backfill must number by
    // created_at, not by insertion/physical order.
    const second = await insert('2026-01-02T00:00:00.000Z')
    const first = await insert('2026-01-01T00:00:00.000Z')
    const third = await insert('2026-01-03T00:00:00.000Z')

    await expect(migrate(database)).resolves.toBeUndefined()

    const numberOf = async (id: string) =>
      (
        await database.query<{ number: number }>('SELECT number FROM conversations WHERE id = $1', [
          id,
        ])
      )[0].number
    expect(await numberOf(first)).toBe(1)
    expect(await numberOf(second)).toBe(2)
    expect(await numberOf(third)).toBe(3)

    // The sequence picked up AFTER the backfilled rows — a fresh insert is #4.
    const [fresh] = await database.query<{ number: number }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING number',
      ['customer@example.test'],
    )
    expect(fresh.number).toBe(4)
  })

  it('migration 005 on a fresh database: numbering starts at 1, increments per insert, and duplicates are rejected', async () => {
    db = await createPgliteDb()
    await migrate(db)

    const [a] = await db.query<{ number: number }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING number',
      ['customer@example.test'],
    )
    const [b] = await db.query<{ number: number }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING number',
      ['customer@example.test'],
    )
    expect(a.number).toBe(1)
    expect(b.number).toBe(2)

    // UNIQUE holds — a manual duplicate is rejected at the schema level.
    await expect(
      db.query('INSERT INTO conversations (customer_email, number) VALUES ($1, $2)', [
        'customer@example.test',
        1,
      ]),
    ).rejects.toThrow()
  })

  it('migration 006 upgrades a NON-fresh 005 database: existing rows get [] tags and NULL assignee; the assignee CHECK is live', async () => {
    const database = await createPgliteDb()
    db = database

    await migrate(database, { throughId: 5 })
    const [existing] = await database.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )

    await expect(migrate(database)).resolves.toBeUndefined()

    const [row] = await database.query<{ tags: unknown; assignee: string | null }>(
      'SELECT tags, assignee FROM conversations WHERE id = $1',
      [existing.id],
    )
    expect(row).toEqual({ tags: [], assignee: null })

    // 'me' and NULL are the only legal assignee values (spec §4f) — the
    // CHECK rejects anything else at the schema level.
    await expect(
      database.query('UPDATE conversations SET assignee = $1 WHERE id = $2', ['me', existing.id]),
    ).resolves.toBeDefined()
    await expect(
      database.query('UPDATE conversations SET assignee = $1 WHERE id = $2', [
        'someone-else',
        existing.id,
      ]),
    ).rejects.toThrow()
  })

  it("migration 007 admits 'note' threads with NULL delivery status only; existing direction rules stay intact", async () => {
    const database = await createPgliteDb()
    db = database
    await migrate(database)

    const [conversation] = await database.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )

    // A note with NULL delivery status is legal…
    const [note] = await database.query<{ delivery_status: string | null }>(
      `INSERT INTO threads (conversation_id, direction, from_address, body_text)
       VALUES ($1, 'note', $2, 'internal context') RETURNING delivery_status`,
      [conversation.id, 'support@example.test'],
    )
    expect(note.delivery_status).toBeNull()

    // …a note with ANY delivery status is not (delivery is not a concept
    // for a message that is never sent)…
    await expect(
      database.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
         VALUES ($1, 'note', $2, 'sent')`,
        [conversation.id, 'support@example.test'],
      ),
    ).rejects.toThrow()

    // …and the pre-007 rules survived the constraint swap: outbound still
    // must carry a status, and an unknown direction is still rejected.
    await expect(
      database.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status)
         VALUES ($1, 'outbound', $2, NULL)`,
        [conversation.id, 'support@example.test'],
      ),
    ).rejects.toThrow()
    await expect(
      database.query(
        `INSERT INTO threads (conversation_id, direction, from_address)
         VALUES ($1, 'bogus', $2)`,
        [conversation.id, 'support@example.test'],
      ),
    ).rejects.toThrow()
  })
  it('migration 008 ties customer_viewed_at to direction: outbound may carry one, inbound and note may not', async () => {
    const database = await createPgliteDb()
    db = database
    await migrate(database)

    const [conversation] = await database.query<{ id: string }>(
      'INSERT INTO conversations (customer_email) VALUES ($1) RETURNING id',
      ['customer@example.test'],
    )

    await expect(
      database.query(
        `INSERT INTO threads (conversation_id, direction, from_address, delivery_status, customer_viewed_at)
         VALUES ($1, 'outbound', $2, 'sent', now())`,
        [conversation.id, 'support@example.test'],
      ),
    ).resolves.toBeDefined()

    for (const direction of ['inbound', 'note']) {
      await expect(
        database.query(
          `INSERT INTO threads (conversation_id, direction, from_address, customer_viewed_at)
           VALUES ($1, $2, $3, now())`,
          [conversation.id, direction, 'customer@example.test'],
        ),
      ).rejects.toThrow()
    }
  })
})
