import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { ENCRYPTION_KEY_BYTES } from './token-crypto.js'
import {
  createWebhookEndpointStore,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  type WebhookEndpointStore,
} from './webhook-endpoints.js'

const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'
const KEY = randomBytes(ENCRYPTION_KEY_BYTES)

describe('WebhookEndpointStore', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStore(key: Buffer = KEY): Promise<{ db: Db; store: WebhookEndpointStore }> {
    db = await createPgliteDb()
    await migrate(db)
    return { db, store: createWebhookEndpointStore(db, key) }
  }

  it('create returns the plaintext secret once, defaults to active/0 failures, and never persists the secret in plaintext', async () => {
    const { db, store } = await freshStore()

    const created = await store.create({
      url: 'https://example.test/hook',
      secret: 'super-secret-value',
      events: ['conversation.message_received'],
      module: 'draft-reply',
    })

    expect(created.secret).toBe('super-secret-value')
    expect(created.status).toBe('active')
    expect(created.consecutiveFailures).toBe(0)
    expect(created.events).toEqual(['conversation.message_received'])
    expect(created.module).toBe('draft-reply')

    const raw = await db.query<{ secret_ciphertext: Uint8Array }>(
      'SELECT secret_ciphertext FROM webhook_endpoints WHERE id = $1',
      [created.id],
    )
    const ciphertextText = Buffer.from(raw[0].secret_ciphertext).toString('utf8')
    expect(ciphertextText).not.toContain('super-secret-value')
  })

  it('create with module omitted stores NULL, and events defaults are persisted verbatim', async () => {
    const { store } = await freshStore()
    const created = await store.create({
      url: 'https://example.test/hook',
      secret: 's',
      events: [],
    })
    expect(created.module).toBeNull()
    expect(created.events).toEqual([])
  })

  it('getSecret decrypts the stored secret; wrong key throws; unknown id returns null', async () => {
    const { db, store } = await freshStore()
    const created = await store.create({
      url: 'https://example.test/hook',
      secret: 'sekrit',
      events: [],
    })

    expect(await store.getSecret(created.id)).toBe('sekrit')
    expect(await store.getSecret(RANDOM_UUID)).toBeNull()

    const wrongKeyStore = createWebhookEndpointStore(db, randomBytes(ENCRYPTION_KEY_BYTES))
    await expect(wrongKeyStore.getSecret(created.id)).rejects.toThrow()
  })

  it('list returns every endpoint ordered by created_at, never including the secret', async () => {
    const { store } = await freshStore()
    const a = await store.create({ url: 'https://a.example.test', secret: 's1', events: [] })
    const b = await store.create({ url: 'https://b.example.test', secret: 's2', events: [] })

    const list = await store.list()
    expect(list.map((e) => e.id)).toEqual([a.id, b.id])
    for (const endpoint of list) {
      expect(endpoint).not.toHaveProperty('secret')
    }
  })

  it('patch updates url/events/module/status, and returns null for an unknown id', async () => {
    const { store } = await freshStore()
    const created = await store.create({ url: 'https://a.example.test', secret: 's', events: [] })

    const patched = await store.patch(created.id, {
      url: 'https://b.example.test',
      events: ['draft.created'],
      module: 'other-module',
    })
    expect(patched).toMatchObject({
      url: 'https://b.example.test',
      events: ['draft.created'],
      module: 'other-module',
    })

    expect(await store.patch(RANDOM_UUID, { status: 'disabled' })).toBeNull()
  })

  it('patch status: "active" resets consecutive_failures to 0 (re-enable clears the near-threshold count)', async () => {
    const { store } = await freshStore()
    const created = await store.create({ url: 'https://a.example.test', secret: 's', events: [] })

    for (let i = 0; i < 5; i++) {
      await store.recordDeliveryFailure(created.id)
    }
    const midway = await store.list()
    expect(midway[0].consecutiveFailures).toBe(5)

    const reenabled = await store.patch(created.id, { status: 'active' })
    expect(reenabled).toMatchObject({ status: 'active', consecutiveFailures: 0 })
  })

  it('delete removes the row; returns false for an unknown id', async () => {
    const { store } = await freshStore()
    const created = await store.create({ url: 'https://a.example.test', secret: 's', events: [] })

    expect(await store.delete(created.id)).toBe(true)
    expect(await store.list()).toEqual([])
    expect(await store.delete(created.id)).toBe(false)
  })

  it('recordDeliveryFailure increments the counter and auto-disables at exactly the threshold, never overriding a manually disabled endpoint', async () => {
    const { store } = await freshStore()
    const created = await store.create({ url: 'https://a.example.test', secret: 's', events: [] })

    let latest = await store.recordDeliveryFailure(created.id)
    expect(latest).toMatchObject({ consecutiveFailures: 1, status: 'active' })

    for (let i = 2; i < WEBHOOK_AUTO_DISABLE_THRESHOLD; i++) {
      latest = await store.recordDeliveryFailure(created.id)
      expect(latest?.status).toBe('active')
      expect(latest?.consecutiveFailures).toBe(i)
    }

    // The threshold-th failure flips status → auto_disabled, in the same write.
    latest = await store.recordDeliveryFailure(created.id)
    expect(latest).toMatchObject({
      consecutiveFailures: WEBHOOK_AUTO_DISABLE_THRESHOLD,
      status: 'auto_disabled',
    })

    // A manually disabled endpoint is never reclassified as auto_disabled.
    const other = await store.create({ url: 'https://b.example.test', secret: 's', events: [] })
    await store.patch(other.id, { status: 'disabled' })
    for (let i = 0; i < WEBHOOK_AUTO_DISABLE_THRESHOLD + 1; i++) {
      await store.recordDeliveryFailure(other.id)
    }
    const stillDisabled = await store.list()
    const otherRow = stillDisabled.find((e) => e.id === other.id)
    expect(otherRow?.status).toBe('disabled')
  })

  it('recordDeliverySuccess resets the counter to 0 without changing status', async () => {
    const { store } = await freshStore()
    const created = await store.create({ url: 'https://a.example.test', secret: 's', events: [] })
    await store.recordDeliveryFailure(created.id)
    await store.recordDeliveryFailure(created.id)

    const reset = await store.recordDeliverySuccess(created.id)
    expect(reset).toMatchObject({ consecutiveFailures: 0, status: 'active' })
  })

  it('recordDeliveryFailure/recordDeliverySuccess return null for an unknown id', async () => {
    const { store } = await freshStore()
    expect(await store.recordDeliveryFailure(RANDOM_UUID)).toBeNull()
    expect(await store.recordDeliverySuccess(RANDOM_UUID)).toBeNull()
  })
})
