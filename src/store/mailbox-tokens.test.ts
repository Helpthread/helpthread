import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createMailboxTokenStore } from './mailbox-tokens.js'
import { ENCRYPTION_KEY_BYTES } from './token-crypto.js'

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'
const KEY = randomBytes(ENCRYPTION_KEY_BYTES)

async function insertMailbox(db: Db, address = 'mailbox@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "INSERT INTO mailboxes (address, provider) VALUES ($1, 'gmail') RETURNING id",
    [address],
  )
  return rows[0].id
}

describe('createMailboxTokenStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(key: Buffer = KEY) {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createMailboxTokenStore(db, key) }
  }

  it('getTokens returns null when no token row exists for the mailbox', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    expect(await store.getTokens(mailboxId)).toBeNull()
  })

  it('upsertTokens with only refreshToken → getTokens round-trips it with null access fields', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.upsertTokens(mailboxId, { refreshToken: 'refresh-token-value' })
    const tokens = await store.getTokens(mailboxId)

    expect(tokens).not.toBeNull()
    expect(tokens?.mailboxId).toBe(mailboxId)
    expect(tokens?.refreshToken).toBe('refresh-token-value')
    expect(tokens?.accessToken).toBeNull()
    expect(tokens?.accessTokenExpiresAt).toBeNull()
    expect(tokens?.scopes).toBeNull()
    expect(tokens?.updatedAt).toBeInstanceOf(Date)
  })

  it('upsertTokens with every field → getTokens round-trips all of them', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    const expiresAt = new Date('2026-08-01T00:00:00.000Z')

    await store.upsertTokens(mailboxId, {
      refreshToken: 'refresh-token-value',
      accessToken: 'access-token-value',
      accessTokenExpiresAt: expiresAt,
      scopes: 'https://www.googleapis.com/auth/gmail.send',
    })
    const tokens = await store.getTokens(mailboxId)

    expect(tokens?.refreshToken).toBe('refresh-token-value')
    expect(tokens?.accessToken).toBe('access-token-value')
    expect(tokens?.accessTokenExpiresAt?.toISOString()).toBe(expiresAt.toISOString())
    expect(tokens?.scopes).toBe('https://www.googleapis.com/auth/gmail.send')
  })

  it('a second upsertTokens call replaces the row (ON CONFLICT DO UPDATE), not a second row', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.upsertTokens(mailboxId, {
      refreshToken: 'refresh-v1',
      accessToken: 'access-v1',
      accessTokenExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
      scopes: 'scope-v1',
    })
    await store.upsertTokens(mailboxId, {
      refreshToken: 'refresh-v2',
      accessToken: 'access-v2',
      accessTokenExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
      scopes: 'scope-v2',
    })

    const tokens = await store.getTokens(mailboxId)
    expect(tokens?.refreshToken).toBe('refresh-v2')
    expect(tokens?.accessToken).toBe('access-v2')
    expect(tokens?.scopes).toBe('scope-v2')

    const rowCount = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM mailbox_oauth_tokens WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(rowCount[0].n).toBe(1)
  })

  it('upsertTokens is a full replace: omitting accessToken on the second call clears the previously cached one', async () => {
    const { store } = await freshStore()
    const db2 = db as Db
    const mailboxId = await insertMailbox(db2)

    await store.upsertTokens(mailboxId, {
      refreshToken: 'refresh-v1',
      accessToken: 'access-v1',
      accessTokenExpiresAt: new Date('2026-01-01T00:00:00.000Z'),
    })
    await store.upsertTokens(mailboxId, { refreshToken: 'refresh-v1' })

    const tokens = await store.getTokens(mailboxId)
    expect(tokens?.accessToken).toBeNull()
    expect(tokens?.accessTokenExpiresAt).toBeNull()
  })

  it('two different mailboxes have independent token rows', async () => {
    const { db, store } = await freshStore()
    const mailboxA = await insertMailbox(db, 'a@example.test')
    const mailboxB = await insertMailbox(db, 'b@example.test')

    await store.upsertTokens(mailboxA, { refreshToken: 'refresh-a' })
    await store.upsertTokens(mailboxB, { refreshToken: 'refresh-b' })

    expect((await store.getTokens(mailboxA))?.refreshToken).toBe('refresh-a')
    expect((await store.getTokens(mailboxB))?.refreshToken).toBe('refresh-b')
  })

  it('getTokens returns null for a mailbox id that does not exist at all', async () => {
    const { store } = await freshStore()
    expect(await store.getTokens(RANDOM_UUID)).toBeNull()
  })

  // --- encryption-at-rest: the security-critical property ---------------

  it('the stored ciphertext bytes never contain the plaintext refresh token', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    const secret = 'super-secret-refresh-token-value-should-not-appear-in-storage'

    await store.upsertTokens(mailboxId, { refreshToken: secret })

    const rows = await db.query<{ refresh_token_ciphertext: Uint8Array }>(
      'SELECT refresh_token_ciphertext FROM mailbox_oauth_tokens WHERE mailbox_id = $1',
      [mailboxId],
    )
    const raw = Buffer.from(rows[0].refresh_token_ciphertext)
    expect(raw.toString('utf8')).not.toContain(secret)
    expect(raw.toString('base64')).not.toContain(Buffer.from(secret).toString('base64'))
  })

  it('the stored ciphertext for the same plaintext differs across two mailboxes (random IV, no deterministic leakage)', async () => {
    const { db, store } = await freshStore()
    const mailboxA = await insertMailbox(db, 'a2@example.test')
    const mailboxB = await insertMailbox(db, 'b2@example.test')

    await store.upsertTokens(mailboxA, { refreshToken: 'identical-value' })
    await store.upsertTokens(mailboxB, { refreshToken: 'identical-value' })

    const rows = await db.query<{ mailbox_id: string; refresh_token_ciphertext: Uint8Array }>(
      'SELECT mailbox_id, refresh_token_ciphertext FROM mailbox_oauth_tokens WHERE mailbox_id IN ($1, $2)',
      [mailboxA, mailboxB],
    )
    const [a, b] = rows
    expect(
      Buffer.from(a.refresh_token_ciphertext).equals(Buffer.from(b.refresh_token_ciphertext)),
    ).toBe(false)
  })

  it('getTokens throws (rather than returning garbage) when decrypted with the wrong key', async () => {
    const { db, store } = await freshStore(KEY)
    const mailboxId = await insertMailbox(db)
    await store.upsertTokens(mailboxId, { refreshToken: 'refresh-token-value' })

    const wrongKeyStore = createMailboxTokenStore(db, randomBytes(ENCRYPTION_KEY_BYTES))
    await expect(wrongKeyStore.getTokens(mailboxId)).rejects.toThrow(/decrypt failed/)
  })

  it('getTokens throws when the stored ciphertext has been tampered with at rest', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await store.upsertTokens(mailboxId, { refreshToken: 'refresh-token-value' })

    const rows = await db.query<{ refresh_token_ciphertext: Uint8Array }>(
      'SELECT refresh_token_ciphertext FROM mailbox_oauth_tokens WHERE mailbox_id = $1',
      [mailboxId],
    )
    const tampered = Buffer.from(rows[0].refresh_token_ciphertext)
    tampered[tampered.length - 1] ^= 0xff
    await db.query(
      'UPDATE mailbox_oauth_tokens SET refresh_token_ciphertext = $1 WHERE mailbox_id = $2',
      [new Uint8Array(tampered), mailboxId],
    )

    await expect(store.getTokens(mailboxId)).rejects.toThrow(/decrypt failed/)
  })

  // --- deleteTokens (HT-47, gmail-connect.md's disconnect section) -----------

  it('deleteTokens removes the token row — getTokens returns null afterward', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await store.upsertTokens(mailboxId, { refreshToken: 'refresh-token-value' })

    await store.deleteTokens(mailboxId)

    expect(await store.getTokens(mailboxId)).toBeNull()
    const rows = await db.query(
      'SELECT mailbox_id FROM mailbox_oauth_tokens WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(rows).toHaveLength(0)
  })

  it('deleteTokens is idempotent — deleting a mailbox with no token row is a harmless no-op', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await expect(store.deleteTokens(mailboxId)).resolves.toBeUndefined()
  })

  it('deleteTokens only removes the targeted mailbox — a sibling mailbox keeps its tokens', async () => {
    const { db, store } = await freshStore()
    const mailboxA = await insertMailbox(db, 'a4@example.test')
    const mailboxB = await insertMailbox(db, 'b4@example.test')
    await store.upsertTokens(mailboxA, { refreshToken: 'refresh-a' })
    await store.upsertTokens(mailboxB, { refreshToken: 'refresh-b' })

    await store.deleteTokens(mailboxA)

    expect(await store.getTokens(mailboxA)).toBeNull()
    expect((await store.getTokens(mailboxB))?.refreshToken).toBe('refresh-b')
  })
})
