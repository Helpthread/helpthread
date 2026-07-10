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

  it('records exactly one _migrations row for migration 001', async () => {
    db = await createPgliteDb()
    await migrate(db)

    const rows = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM _migrations ORDER BY id',
    )
    expect(rows).toEqual([{ id: 1, name: 'conversations_and_threads' }])
  })

  it('is idempotent: a second call is a clean no-op', async () => {
    db = await createPgliteDb()
    await migrate(db)
    await migrate(db) // must not throw (e.g. "relation already exists")

    const rows = await db.query<{ id: number }>('SELECT id FROM _migrations ORDER BY id')
    expect(rows).toEqual([{ id: 1 }])
  })
})
