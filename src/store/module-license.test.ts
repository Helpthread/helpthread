import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import {
  createModuleLicenseDecryptor,
  createModuleLicenseStore,
  ModuleLicenseDecryptError,
} from './module-license.js'
import { ENCRYPTION_KEY_BYTES } from './token-crypto.js'

const KEY = randomBytes(ENCRYPTION_KEY_BYTES)
const OTHER_KEY = randomBytes(ENCRYPTION_KEY_BYTES)

/**
 * This ticket's owned files do not include `src/db/migrate.ts` (the
 * `module_license` table has no migration yet — see module-license.ts's
 * module doc "Migration dependency" section for the exact SQL it expects).
 * These tests create that table directly against a fresh PGlite instance
 * rather than calling `migrate()`, so they still exercise real Postgres SQL
 * (PGlite, not a mock) without reaching outside this ticket's scope.
 */
async function freshDb(): Promise<Db> {
  const db = await createPgliteDb()
  await db.query(`
    CREATE TABLE module_license (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      key_ciphertext bytea NOT NULL,
      fingerprint text NOT NULL,
      last_four text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  return db
}

describe('createModuleLicenseStore / createModuleLicenseDecryptor', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  it('getDisplayInfo returns null when no license is installed', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)
    expect(await store.getDisplayInfo()).toBeNull()
  })

  it('decryptForCatalogClient returns null when no license is installed', async () => {
    db = await freshDb()
    const decryptor = createModuleLicenseDecryptor(db, KEY)
    expect(await decryptor.decryptForCatalogClient()).toBeNull()
  })

  it('store then decryptForCatalogClient round-trips the plaintext', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)
    const decryptor = createModuleLicenseDecryptor(db, KEY)

    await store.store('hpml_live_abcdef1234567890')

    expect(await decryptor.decryptForCatalogClient()).toBe('hpml_live_abcdef1234567890')
  })

  it('a second store call replaces the singleton row (upsert), not a second row', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)
    const decryptor = createModuleLicenseDecryptor(db, KEY)

    await store.store('hpml_live_v1_00000000000')
    await store.store('hpml_live_v2_11111111111')

    expect(await decryptor.decryptForCatalogClient()).toBe('hpml_live_v2_11111111111')
    const rows = await db.query('SELECT * FROM module_license')
    expect(rows).toHaveLength(1)
  })

  it('delete removes the installed license', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)

    await store.store('hpml_live_abcdef1234567890')
    await store.delete()

    expect(await store.getDisplayInfo()).toBeNull()
  })

  it('delete is a no-op when no license is installed', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)
    await expect(store.delete()).resolves.toBeUndefined()
  })

  it('store rejects a license key shorter than the minimum length', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)
    await expect(store.store('short')).rejects.toThrow(/at least/)
  })

  it('decryptForCatalogClient throws ModuleLicenseDecryptError when decrypted under the wrong key', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)
    await store.store('hpml_live_abcdef1234567890')

    const wrongDecryptor = createModuleLicenseDecryptor(db, OTHER_KEY)
    await expect(wrongDecryptor.decryptForCatalogClient()).rejects.toThrow(
      ModuleLicenseDecryptError,
    )
  })

  // --- fingerprint / last-four display never exposes the key --------------

  it('getDisplayInfo never contains the plaintext license key', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)
    const licenseKey = 'hpml_live_super_secret_key_material_9999'

    await store.store(licenseKey)
    const info = await store.getDisplayInfo()

    expect(info).not.toBeNull()
    expect(info?.fingerprint).not.toContain(licenseKey)
    expect(info?.lastFour).not.toBe(licenseKey)
    // Serialize the whole display object the way an API response would,
    // and check the full key never appears anywhere in it.
    expect(JSON.stringify(info)).not.toContain(licenseKey)
  })

  it('getDisplayInfo.lastFour is exactly the last four characters of the key', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)
    await store.store('hpml_live_abcdef1234567890')

    const info = await store.getDisplayInfo()
    expect(info?.lastFour).toBe('7890')
  })

  it('getDisplayInfo.fingerprint is deterministic for the same key and differs for different keys', async () => {
    db = await freshDb()
    const store = createModuleLicenseStore(db, KEY)

    await store.store('hpml_live_key_one_000000000000')
    const infoOne = await store.getDisplayInfo()

    await store.store('hpml_live_key_two_111111111111')
    const infoTwo = await store.getDisplayInfo()

    expect(infoOne?.fingerprint).not.toBe(infoTwo?.fingerprint)

    // Re-storing the SAME key produces the SAME fingerprint (deterministic,
    // not a fresh random salt per call) — an operator re-entering the same
    // key should see a stable fingerprint.
    await store.store('hpml_live_key_one_000000000000')
    const infoOneAgain = await store.getDisplayInfo()
    expect(infoOneAgain?.fingerprint).toBe(infoOne?.fingerprint)
  })
})
