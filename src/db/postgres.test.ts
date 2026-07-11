/**
 * Tests for the Postgres `Db` adapter — run against REAL Postgres over the
 * REAL wire protocol, no mocks: a PGlite instance (genuine Postgres in
 * WASM) is exposed on a loopback TCP port via `@electric-sql/pglite-socket`,
 * and `PostgresDb` connects to it with the actual `pg` driver. Everything
 * from connection handling to extended-protocol parameter binding to
 * transaction-local `search_path` is exercised for real.
 *
 * What this harness canNOT simulate: a transaction-mode POOLER's backend
 * shuffling (Supavisor handing consecutive autocommit statements to
 * different backends). The adapter's defense against that — schema
 * enforcement rides INSIDE a transaction (see `src/db/postgres.ts` module
 * doc) — is verified here structurally (the search_path is provably
 * transaction-local and provably applied on both the `query()` and
 * `transaction()` paths), while the pooler's placement contract itself
 * ("one transaction, one backend") is Supavisor's documented guarantee.
 *
 * All connection strings herein are loopback-to-PGlite with throwaway fake
 * credentials (the socket server does not authenticate).
 */

import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from './client.js'
import { migrate } from './migrate.js'
import { createPostgresDb } from './postgres.js'

let pglite: PGlite
let server: PGLiteSocketServer
let connectionString: string

/** Dbs opened during a test, closed (best-effort) after it. */
let openDbs: Db[] = []

async function openDb(options?: { schema?: string; max?: number }): Promise<Db> {
  const db = await createPostgresDb({ connectionString, ...options })
  openDbs.push(db)
  return db
}

beforeAll(async () => {
  pglite = await PGlite.create()
  server = new PGLiteSocketServer({
    db: pglite,
    host: '127.0.0.1',
    // Port 0: the OS picks a free port — no collisions with anything else
    // on the machine or with parallel test files. The bound port arrives
    // via the `listening` event.
    port: 0,
    // The server multiplexes multiple client sockets onto the single PGlite
    // instance (routing in-transaction traffic back to the same client), so
    // a pg.Pool with a few connections works. Headroom over the pool sizes
    // used below.
    maxConnections: 10,
  })
  const listening = new Promise<number>((resolve) => {
    server.addEventListener('listening', (event) => resolve((event as CustomEvent).detail.port), {
      once: true,
    })
  })
  await server.start()
  const port = await listening
  connectionString = `postgresql://fake_user:fake_password@127.0.0.1:${port}/postgres`
})

afterAll(async () => {
  await server.stop()
  await pglite.close()
})

afterEach(async () => {
  for (const db of openDbs) {
    await db.close().catch(() => {})
  }
  openDbs = []
  // One PGlite backs every test in this file — drop test tables and schemas
  // between tests so each starts clean.
  const schemas = await pglite.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'",
  )
  for (const { nspname } of schemas.rows) {
    if (nspname === 'public') {
      const tables = await pglite.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      )
      for (const { tablename } of tables.rows) {
        await pglite.exec(`DROP TABLE IF EXISTS public."${tablename}" CASCADE`)
      }
    } else {
      await pglite.exec(`DROP SCHEMA "${nspname}" CASCADE`)
    }
  }
})

describe('createPostgresDb (no schema option)', () => {
  it('runs parameterized queries through the real pg driver', async () => {
    const db = await openDb()
    const rows = await db.query<{ x: number; s: string }>('SELECT $1::int AS x, $2::text AS s', [
      42,
      'hello',
    ])
    expect(rows).toEqual([{ x: 42, s: 'hello' }])
  })

  it("transaction commits and returns fn's result when fn resolves", async () => {
    const db = await openDb()
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
    const db = await openDb()
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

  it('transaction rolls back when a STATEMENT fails mid-transaction, and the pool stays usable', async () => {
    const db = await openDb({ max: 1 })
    await db.query('CREATE TABLE t (id serial PRIMARY KEY, name text NOT NULL)')

    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO t (name) VALUES ($1)', ['first'])
        // NOT NULL violation — the statement itself errors, poisoning the
        // transaction; the adapter must ROLLBACK and re-throw.
        await tx.query('INSERT INTO t (name) VALUES ($1)', [null])
      }),
    ).rejects.toThrow()

    // With max: 1 the follow-up query MUST reuse the same pooled connection —
    // proving it was returned to the pool clean (not stuck in an aborted
    // transaction, which would fail every subsequent statement on it).
    const rows = await db.query<{ name: string }>('SELECT name FROM t')
    expect(rows).toEqual([])
  })

  it('binds Uint8Array params as bytea, matching PGlite behavior', async () => {
    const db = await openDb()
    await db.query('CREATE TABLE b (data bytea NOT NULL)')
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
    await db.query('INSERT INTO b (data) VALUES ($1)', [bytes])
    const rows = await db.query<{ data: Uint8Array }>('SELECT data FROM b')
    expect(rows).toHaveLength(1)
    expect(Buffer.from(rows[0].data)).toEqual(Buffer.from(bytes))
  })

  it('close() ends the pool — a query after close rejects', async () => {
    const db = await openDb()
    await db.query('SELECT 1')
    await db.close()
    await expect(db.query('SELECT 1')).rejects.toThrow()
  })
})

describe('createPostgresDb schema name validation', () => {
  // Validation happens before any connection is opened, so a deliberately
  // unroutable connection string proves it never touches the network.
  const noNetwork = 'postgresql://fake_user:fake_password@127.0.0.1:1/nope'

  it.each([
    ['uppercase', 'Helpthread'],
    ['hyphen', 'help-thread'],
    ['injection attempt', 'x"; DROP SCHEMA public CASCADE; --'],
    ['leading digit', '1helpthread'],
    ['empty', ''],
    ['whitespace', 'help thread'],
    ['too long', 'a'.repeat(64)],
  ])('rejects %s (%j) without connecting', async (_label, schema) => {
    await expect(createPostgresDb({ connectionString: noNetwork, schema })).rejects.toThrow(
      /invalid schema name/,
    )
  })

  it('rejects the reserved pg_ prefix without connecting', async () => {
    await expect(
      createPostgresDb({ connectionString: noNetwork, schema: 'pg_helpthread' }),
    ).rejects.toThrow(/reserved by Postgres/)
  })
})

describe('createPostgresDb with a schema option', () => {
  it('creates the schema and lands unqualified DDL + DML in it — not in public', async () => {
    const db = await openDb({ schema: 'helpthread' })

    // Unqualified — exactly what every store module writes.
    await db.query('CREATE TABLE t (id serial PRIMARY KEY, name text)')
    await db.query('INSERT INTO t (name) VALUES ($1)', ['scoped'])

    const rows = await db.query<{ name: string }>('SELECT name FROM t')
    expect(rows).toEqual([{ name: 'scoped' }])

    // Verify placement via the catalog, straight on the PGlite instance
    // (bypassing the adapter, so the adapter can't fool the check).
    const placed = await pglite.query<{ table_schema: string }>(
      "SELECT table_schema FROM information_schema.tables WHERE table_name = 't'",
    )
    expect(placed.rows).toEqual([{ table_schema: 'helpthread' }])
  })

  it('applies the schema inside transaction() as well as query()', async () => {
    const db = await openDb({ schema: 'helpthread' })
    await db.transaction(async (tx) => {
      await tx.query('CREATE TABLE tx_made (id int)')
      await tx.query('INSERT INTO tx_made VALUES (1)')
    })
    const placed = await pglite.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM helpthread.tx_made',
    )
    expect(placed.rows).toEqual([{ n: 1 }])
  })

  it('does not leak search_path onto pooled connections used without schema', async () => {
    // A schema-mode Db and a schema-less Db against the same server: after
    // the schema-mode Db has run queries, the schema-less Db must still see
    // the DEFAULT search_path (i.e. the transaction-local set_config did not
    // stick to any shared session state).
    const scoped = await openDb({ schema: 'helpthread' })
    await scoped.query('CREATE TABLE only_here (id int)')

    const plain = await openDb()
    // Default search_path resolves to public — the scoped table is invisible
    // unqualified…
    await expect(plain.query('SELECT * FROM only_here')).rejects.toThrow()
    // …but exists when qualified, proving the failure above was search_path,
    // not a missing table.
    const rows = await plain.query('SELECT * FROM helpthread.only_here')
    expect(rows).toEqual([])
  })

  it('two Dbs with different schemas are isolated from each other', async () => {
    const a = await openDb({ schema: 'tenant_a' })
    const b = await openDb({ schema: 'tenant_b' })

    await a.query('CREATE TABLE items (id int)')
    await a.query('INSERT INTO items VALUES (1)')
    await b.query('CREATE TABLE items (id int)')

    const aRows = await a.query<{ id: number }>('SELECT id FROM items')
    const bRows = await b.query<{ id: number }>('SELECT id FROM items')
    expect(aRows).toEqual([{ id: 1 }])
    expect(bRows).toEqual([])
  })

  it('is idempotent — a second Db against an existing schema sees its data', async () => {
    const first = await openDb({ schema: 'helpthread' })
    await first.query('CREATE TABLE t (name text)')
    await first.query('INSERT INTO t (name) VALUES ($1)', ['survives'])
    await first.close()

    const second = await openDb({ schema: 'helpthread' })
    const rows = await second.query<{ name: string }>('SELECT name FROM t')
    expect(rows).toEqual([{ name: 'survives' }])
  })

  it('runs the real migrations into the configured schema — _migrations included', async () => {
    const db = await openDb({ schema: 'helpthread' })
    await migrate(db)
    // Idempotent second run, same as every boot does.
    await migrate(db)

    const placed = await pglite.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'helpthread' ORDER BY table_name",
    )
    expect(placed.rows.map((r) => r.table_name)).toEqual([
      '_migrations',
      'conversations',
      'threads',
    ])

    const inPublic = await pglite.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )
    expect(inPublic.rows).toEqual([])

    // And the migrated schema actually works end-to-end.
    await db.query('INSERT INTO conversations (customer_email, subject) VALUES ($1, $2)', [
      'customer@example.com',
      'hello',
    ])
    const convs = await db.query<{ status: string }>('SELECT status FROM conversations')
    expect(convs).toEqual([{ status: 'open' }])
  })
})
