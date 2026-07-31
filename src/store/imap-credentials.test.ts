import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createImapCredentialStore, ImapCredentialDecryptError } from './imap-credentials.js'
import { ENCRYPTION_KEY_BYTES } from './token-crypto.js'

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'
const KEY = randomBytes(ENCRYPTION_KEY_BYTES)

async function insertMailbox(db: Db, address = 'mailbox@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "INSERT INTO mailboxes (address, provider) VALUES ($1, 'imap') RETURNING id",
    [address],
  )
  return rows[0].id
}

describe('createImapCredentialStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(key: Buffer = KEY) {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createImapCredentialStore(db, key) }
  }

  it('getPassword returns null when no credential row exists for the mailbox', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    expect(await store.getPassword(mailboxId)).toBeNull()
  })

  it('getPassword returns null for a mailbox id that does not exist at all', async () => {
    const { store } = await freshStore()
    expect(await store.getPassword(RANDOM_UUID)).toBeNull()
  })

  it('upsertPassword then getPassword round-trips the plaintext', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.upsertPassword(mailboxId, 'super-secret-app-password')

    expect(await store.getPassword(mailboxId)).toBe('super-secret-app-password')
  })

  it('a second upsertPassword call replaces the row (ON CONFLICT DO UPDATE), not a second row', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await store.upsertPassword(mailboxId, 'password-v1')
    await store.upsertPassword(mailboxId, 'password-v2')

    expect(await store.getPassword(mailboxId)).toBe('password-v2')
    const rowCount = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM imap_mailbox_credentials WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(rowCount[0].n).toBe(1)
  })

  it('two different mailboxes have independent credential rows', async () => {
    const { db, store } = await freshStore()
    const mailboxA = await insertMailbox(db, 'a@example.test')
    const mailboxB = await insertMailbox(db, 'b@example.test')

    await store.upsertPassword(mailboxA, 'password-a')
    await store.upsertPassword(mailboxB, 'password-b')

    expect(await store.getPassword(mailboxA)).toBe('password-a')
    expect(await store.getPassword(mailboxB)).toBe('password-b')
  })

  it('upsertPassword runs against a caller-supplied tx, committing atomically with it', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    await db.transaction(async (tx) => {
      await store.upsertPassword(mailboxId, 'tx-password', tx)
    })

    expect(await store.getPassword(mailboxId)).toBe('tx-password')
  })

  // --- encryption-at-rest: the security-critical property ---------------

  it('the stored ciphertext bytes never contain the plaintext password', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    const secret = 'super-secret-app-password-should-not-appear-in-storage'

    await store.upsertPassword(mailboxId, secret)

    const rows = await db.query<{ password_ciphertext: Uint8Array }>(
      'SELECT password_ciphertext FROM imap_mailbox_credentials WHERE mailbox_id = $1',
      [mailboxId],
    )
    const raw = Buffer.from(rows[0].password_ciphertext)
    expect(raw.toString('utf8')).not.toContain(secret)
    expect(raw.toString('base64')).not.toContain(Buffer.from(secret).toString('base64'))
  })

  it('the stored ciphertext for the same plaintext differs across two mailboxes (random IV, no deterministic leakage)', async () => {
    const { db, store } = await freshStore()
    const mailboxA = await insertMailbox(db, 'a2@example.test')
    const mailboxB = await insertMailbox(db, 'b2@example.test')

    await store.upsertPassword(mailboxA, 'identical-value')
    await store.upsertPassword(mailboxB, 'identical-value')

    const rows = await db.query<{ mailbox_id: string; password_ciphertext: Uint8Array }>(
      'SELECT mailbox_id, password_ciphertext FROM imap_mailbox_credentials WHERE mailbox_id IN ($1, $2)',
      [mailboxA, mailboxB],
    )
    const [a, b] = rows
    expect(Buffer.from(a.password_ciphertext).equals(Buffer.from(b.password_ciphertext))).toBe(
      false,
    )
  })

  it('getPassword throws (rather than returning garbage) when decrypted with the wrong key', async () => {
    const { db, store } = await freshStore(KEY)
    const mailboxId = await insertMailbox(db)
    await store.upsertPassword(mailboxId, 'app-password-value')

    const wrongKeyStore = createImapCredentialStore(db, randomBytes(ENCRYPTION_KEY_BYTES))
    // Typed, so `../mail/sender-resolver.ts` can contain THIS while letting a
    // database fault propagate and abort the sweep for a retry.
    await expect(wrongKeyStore.getPassword(mailboxId)).rejects.toBeInstanceOf(
      ImapCredentialDecryptError,
    )
    // The underlying crypto error is preserved as `cause`, not discarded.
    await expect(wrongKeyStore.getPassword(mailboxId)).rejects.toMatchObject({
      mailboxId,
      cause: expect.objectContaining({ message: expect.stringMatching(/decrypt failed/) }),
    })
  })

  it('getPassword throws when the stored ciphertext has been tampered with at rest', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)
    await store.upsertPassword(mailboxId, 'app-password-value')

    const rows = await db.query<{ password_ciphertext: Uint8Array }>(
      'SELECT password_ciphertext FROM imap_mailbox_credentials WHERE mailbox_id = $1',
      [mailboxId],
    )
    const tampered = Buffer.from(rows[0].password_ciphertext)
    tampered[tampered.length - 1] ^= 0xff
    await db.query(
      'UPDATE imap_mailbox_credentials SET password_ciphertext = $1 WHERE mailbox_id = $2',
      [new Uint8Array(tampered), mailboxId],
    )

    await expect(store.getPassword(mailboxId)).rejects.toBeInstanceOf(ImapCredentialDecryptError)
  })

  it('a MISSING row is still null, not a decrypt error — absent and unreadable are different states', async () => {
    const { db, store } = await freshStore()
    const mailboxId = await insertMailbox(db)

    expect(await store.getPassword(mailboxId)).toBeNull()
  })
})
