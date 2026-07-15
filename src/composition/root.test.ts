/**
 * Integration test for the composition root (HT-43): build the WHOLE app over
 * an in-memory PGlite `Db` + a fake `BlobStore` (no real Postgres, Supabase,
 * or network) and drive real `Request`s through the unified handler. This is
 * the end-to-end proof that every adapter is wired correctly — the inbox API,
 * the two CRON_SECRET-guarded cron endpoints, and the Gmail connect/webhook
 * surfaces all respond as expected through one `buildApp` call.
 *
 * buildApp is network-free at construction: `createPostgresDb` is skipped (a
 * PGlite `Db` is injected), and `createGooglePushKeySource` only fetches
 * Google's JWKS lazily on first verify — which none of these cases triggers
 * (the webhook case fails the pre-verify checks first).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../db/client.js'
import { createPgliteDb } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { BlobStore } from '../providers/index.js'
import type { AppConfig } from './config.js'
import { buildApp } from './root.js'

const API_TOKEN = 'test-api-token-16-plus-chars'
const CRON_SECRET = 'test-cron-secret-16-plus'
const ORIGIN = 'https://desk.example.test'

/** A fully-valid AppConfig for the injected-infra build (databaseUrl/supabase* are unused when db/blobStore are injected). */
function testConfig(): AppConfig {
  return {
    databaseUrl: 'postgres://unused',
    supabaseUrl: 'https://unused.supabase.co',
    supabaseServiceRoleKey: 'unused',
    blobBucket: 'unused',
    gmailOAuthClientId: 'test-client-id',
    gmailOAuthClientSecret: 'test-client-secret',
    gmailPubsubTopic: 'projects/p/topics/gmail-push',
    gmailPubsubSubscription: 'projects/p/subscriptions/gmail-push-sub',
    gmailPushServiceAccount: 'push@p.iam.gserviceaccount.com',
    tokenEncryptionKey: Buffer.alloc(32, 5),
    apiToken: API_TOKEN,
    signingSecret: 'signing-secret-at-least-32-characters-long!',
    cronSecret: CRON_SECRET,
    publicBaseUrl: ORIGIN,
    mailDomain: 'mail.example.test',
    supportAddress: 'support@example.test',
  }
}

/** In-memory BlobStore fake, mirroring `src/mail/ingest.test.ts`'s. */
function fakeBlobStore(): BlobStore {
  const store = new Map<string, Uint8Array>()
  return {
    async put(key, data) {
      store.set(key, data)
    },
    async get(key) {
      const data = store.get(key)
      if (data === undefined) throw new Error(`fakeBlobStore: no object at key ${key}`)
      return data
    },
    async getSignedUrl(key) {
      return `https://blob.example.test/${key}`
    },
    async delete(key) {
      store.delete(key)
    },
    async exists(key) {
      return store.has(key)
    },
  }
}

describe('buildApp — end-to-end wiring over PGlite', () => {
  let db: Db
  let handler: (request: Request) => Promise<Response>

  beforeEach(async () => {
    db = await createPgliteDb()
    await migrate(db)
    handler = await buildApp(testConfig(), { db, blobStore: fakeBlobStore() })
  })

  afterEach(async () => {
    await db.close()
  })

  it('serves the Agent Inbox API: GET /conversations with the service Bearer → 200', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/conversations`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { conversations: unknown[] }
    expect(Array.isArray(body.conversations)).toBe(true)
  })

  it('rejects an inbox request with a wrong service Bearer → 401', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/conversations`, {
        headers: { Authorization: 'Bearer wrong-token-0000' },
      }),
    )
    expect(res.status).toBe(401)
  })

  it('drives the queue-drain cron endpoint: authenticated GET drains the (empty) queue → 200 report', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/internal/queue/drain`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; report: { claimed: number } }
    expect(body.ok).toBe(true)
    expect(body.report.claimed).toBe(0)
  })

  it('drives the watch-maintenance cron endpoint: authenticated GET → 200 report (0 active mailboxes)', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/internal/cron/watch-maintenance`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; report: { total: number } }
    expect(body.ok).toBe(true)
    expect(body.report.total).toBe(0)
  })

  it('guards the cron endpoints with CRON_SECRET, not the service token → 401 on the wrong secret', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/internal/queue/drain`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }),
    )
    expect(res.status).toBe(401)
  })

  it('wires gmailConnect: POST /inbound/gmail/connect (Bearer) → 200 with a Google consent URL', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/inbound/gmail/connect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { consentUrl: string }
    expect(body.consentUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    expect(body.consentUrl).toContain('client_id=test-client-id')
    // redirect_uri is PUBLIC_BASE_URL + the callback path, URL-encoded.
    expect(body.consentUrl).toContain(encodeURIComponent(`${ORIGIN}/api/v1/inbound/gmail/callback`))
  })

  it('wires the Gmail push webhook: POST /inbound/gmail with no valid OIDC JWT → uniform 403 (route handled, not 404)', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/inbound/gmail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('gmail_push_rejected')
  })
})
