import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from './client.js'

describe('createPgliteDb', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  it('creates an in-memory database that can run parameterized queries', async () => {
    db = await createPgliteDb()
    const rows = await db.query<{ x: number }>('SELECT $1::int AS x', [42])
    expect(rows).toEqual([{ x: 42 }])
  })

  it('with a dataDir, persists data to disk across separate Db instances', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'helpthread-pglite-'))
    try {
      db = await createPgliteDb({ dataDir })
      await db.query('CREATE TABLE t (id serial PRIMARY KEY, name text)')
      await db.query('INSERT INTO t (name) VALUES ($1)', ['persisted'])
      await db.close()
      db = undefined

      // A second, independent Db instance pointed at the same dataDir sees
      // the first instance's writes — proves this is real on-disk
      // persistence, not just an in-memory handle that happens to reuse
      // state.
      db = await createPgliteDb({ dataDir })
      const rows = await db.query<{ name: string }>('SELECT name FROM t')
      expect(rows).toEqual([{ name: 'persisted' }])
    } finally {
      // Close the open handle before removing its directory — on platforms
      // that refuse to unlink open files, an rm with the DB still open would
      // fail teardown.
      await db?.close()
      db = undefined
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it("transaction commits and returns fn's result when fn resolves", async () => {
    db = await createPgliteDb()
    await db.query('CREATE TABLE t (id serial PRIMARY KEY, name text)')

    const result = await db.transaction(async (tx) => {
      await tx.query('INSERT INTO t (name) VALUES ($1)', ['a'])
      return 'done'
    })

    expect(result).toBe('done')
    const rows = await db.query<{ name: string }>('SELECT name FROM t')
    expect(rows).toEqual([{ name: 'a' }])
  })

  it('transaction rolls back every write when fn throws', async () => {
    db = await createPgliteDb()
    await db.query('CREATE TABLE t (id serial PRIMARY KEY, name text)')

    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO t (name) VALUES ($1)', ['should-not-survive'])
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const rows = await db.query<{ name: string }>('SELECT name FROM t')
    expect(rows).toEqual([])
  })

  it('close() releases the underlying engine — a query after close rejects', async () => {
    db = await createPgliteDb()
    await db.close()
    await expect(db.query('SELECT 1')).rejects.toThrow()
    db = undefined
  })
})
