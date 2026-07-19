/**
 * Integration test for the composition root (HT-43): build the WHOLE app over
 * an in-memory PGlite `Db` + a fake `BlobStore` (no real Postgres, Supabase,
 * or network) and drive real `Request`s through the unified handler. This is
 * the end-to-end proof that every adapter is wired correctly — the inbox API,
 * the CRON_SECRET-guarded internal endpoints (two cron jobs + the HT-44
 * health check), and the Gmail connect/webhook surfaces all respond as
 * expected through one `buildApp` call.
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

  it('drives the snooze-wake cron endpoint (HT-77): authenticated GET → 200 report (0 due), and actually wakes a due snoozed conversation end-to-end', async () => {
    const emptyRes = await handler(
      new Request(`${ORIGIN}/api/v1/internal/cron/snooze-wake`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    )
    expect(emptyRes.status).toBe(200)
    const emptyBody = (await emptyRes.json()) as {
      ok: boolean
      report: { due: number; woken: number }
    }
    expect(emptyBody.ok).toBe(true)
    expect(emptyBody.report).toEqual({ due: 0, woken: 0 })

    // Seed a due-snoozed conversation directly, then confirm a real tick
    // wakes it — proves the composition root's `store` closure (not a
    // separately-constructed one) is what the cron handler actually uses.
    const [{ id: conversationId }] = await db.query<{ id: string }>(
      "INSERT INTO conversations (customer_email, status, snoozed_until) VALUES ('c@example.test', 'pending', now() - interval '1 minute') RETURNING id",
    )

    const wakeRes = await handler(
      new Request(`${ORIGIN}/api/v1/internal/cron/snooze-wake`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    )
    expect(wakeRes.status).toBe(200)
    const wakeBody = (await wakeRes.json()) as { report: { due: number; woken: number } }
    expect(wakeBody.report).toEqual({ due: 1, woken: 1 })

    const [row] = await db.query<{ status: string; snoozed_until: unknown }>(
      'SELECT status, snoozed_until FROM conversations WHERE id = $1',
      [conversationId],
    )
    expect(row).toEqual({ status: 'active', snoozed_until: null })
  })

  it('rejects the snooze-wake endpoint with a wrong cron secret → 401', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/internal/cron/snooze-wake`, {
        headers: { Authorization: 'Bearer wrong-secret-0000000000' },
      }),
    )
    expect(res.status).toBe(401)
  })

  it('drives the health endpoint: authenticated GET over the empty database → 200 ok report (HT-44)', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/internal/health`, {
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      alerts: string[]
      queue: { ready: number }
      mailboxes: unknown[]
    }
    expect(body.ok).toBe(true)
    expect(body.alerts).toEqual([])
    expect(body.queue.ready).toBe(0)
    expect(body.mailboxes).toEqual([])
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

  it('wires gmailDisconnect: POST /inbound/gmail/disconnect (Bearer) → reaches the handler (404 for an unconnected address, no real network call needed to prove it)', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/inbound/gmail/disconnect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: 'nobody@example.test' }),
      }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('not_found')
  })

  it('rejects a disconnect request without the service Bearer token → 401', async () => {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/inbound/gmail/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: 'nobody@example.test' }),
      }),
    )
    expect(res.status).toBe(401)
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

describe('buildApp — passkeys (HT-75; specs/auth/passkeys.md §3)', () => {
  let db: Db

  afterEach(async () => {
    await db.close()
  })

  async function buildWithUiBaseUrl(uiBaseUrl: string | undefined) {
    db = await createPgliteDb()
    await migrate(db)
    return buildApp(
      { ...testConfig(), ...(uiBaseUrl !== undefined ? { uiBaseUrl } : {}) },
      { db, blobStore: fakeBlobStore() },
    )
  }

  async function providerKinds(
    handler: (request: Request) => Promise<Response>,
  ): Promise<string[]> {
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/auth/providers`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }),
    )
    const body = (await res.json()) as { providers: { kind: string }[] }
    return body.providers.map((p) => p.kind)
  }

  it('with no uiBaseUrl configured, webauthn is absent: GET /auth/providers omits it, and every webauthn route 404s', async () => {
    const handler = await buildWithUiBaseUrl(undefined)
    expect(await providerKinds(handler)).toEqual(['credentials'])

    const res = await handler(
      new Request(`${ORIGIN}/api/v1/auth/webauthn/authentication/options`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }),
    )
    expect(res.status).toBe(404)
  })

  it('with a valid domain-form uiBaseUrl, webauthn is wired: GET /auth/providers includes it', async () => {
    const handler = await buildWithUiBaseUrl('https://inbox.example.test')
    expect(await providerKinds(handler)).toEqual(['credentials', 'webauthn'])
  })

  it('with an IP-literal uiBaseUrl, buildApp does NOT crash — it degrades to webauthn-absent, exactly like an unset uiBaseUrl (a deliberate choice: a passkeys-only misconfiguration must not take down the whole engine)', async () => {
    const handler = await buildWithUiBaseUrl('http://127.0.0.1:3000')
    expect(await providerKinds(handler)).toEqual(['credentials'])

    // Every other feature is unaffected — the inbox API still works.
    const res = await handler(
      new Request(`${ORIGIN}/api/v1/conversations`, {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      }),
    )
    expect(res.status).toBe(200)
  })
})
