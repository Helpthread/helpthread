/**
 * `createGmailOAuthTokenService` against REAL PGlite-backed
 * `MailboxTokenStore`/`MailboxStore` instances (real encryption, real SQL —
 * only Google's token endpoint is faked, via an injected `fetchImpl`, the
 * same convention `sender.test.ts` uses for `createGmailEmailSender`). No
 * real network call, no real Google credentials.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import { createMailboxTokenStore, type MailboxTokenStore } from '../store/mailbox-tokens.js'
import { createMailboxStore, type MailboxStore } from '../store/mailboxes.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import { createGmailOAuthTokenService } from './gmail-oauth.js'

const KEY = randomBytes(ENCRYPTION_KEY_BYTES)
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-client-secret'

interface RecordedCall {
  url: string
  init: RequestInit
}

/** A fake token-endpoint `fetch` that records every call and always resolves with `status`/`body`. */
function fakeTokenEndpoint(status: number, body: unknown) {
  const calls: RecordedCall[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

async function insertMailbox(db: Db, address = 'mailbox@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    "INSERT INTO mailboxes (address, provider) VALUES ($1, 'gmail') RETURNING id",
    [address],
  )
  return rows[0].id
}

async function mailboxStatus(db: Db, mailboxId: string): Promise<string> {
  const rows = await db.query<{ status: string }>('SELECT status FROM mailboxes WHERE id = $1', [
    mailboxId,
  ])
  return rows[0].status
}

describe('createGmailOAuthTokenService', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshStores(): Promise<{
    db: Db
    tokenStore: MailboxTokenStore
    mailboxStore: MailboxStore
  }> {
    db = await createPgliteDb()
    await migrate(db)
    return {
      db,
      tokenStore: createMailboxTokenStore(db, KEY),
      mailboxStore: createMailboxStore(db),
    }
  }

  // --- construction validation --------------------------------------------

  it('throws at construction on an empty clientId or clientSecret', async () => {
    const { tokenStore, mailboxStore } = await freshStores()
    expect(() =>
      createGmailOAuthTokenService({ tokenStore, mailboxStore, clientId: '', clientSecret: 'x' }),
    ).toThrow(/clientId/)
    expect(() =>
      createGmailOAuthTokenService({ tokenStore, mailboxStore, clientId: 'x', clientSecret: '' }),
    ).toThrow(/clientSecret/)
  })

  // --- no stored tokens ----------------------------------------------------

  it('throws when no tokens are stored for the mailbox, without calling the token endpoint', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    const { fetchImpl } = fakeTokenEndpoint(200, {})
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    await expect(service.getAccessToken(mailboxId)).rejects.toThrow(/no stored OAuth tokens/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // --- cache hit -------------------------------------------------------------

  it('returns the cached access token without refreshing when it is well within its expiry', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, {
      refreshToken: 'refresh-token',
      accessToken: 'cached-access-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h out
    })
    const { fetchImpl } = fakeTokenEndpoint(200, {})
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    const token = await service.getAccessToken(mailboxId)

    expect(token).toBe('cached-access-token')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // --- refresh: cache miss / near-expiry ------------------------------------

  it('refreshes when no access token has ever been cached, and persists the result', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'refresh-token' })
    const { fetchImpl, calls } = fakeTokenEndpoint(200, {
      access_token: 'fresh-access-token',
      expires_in: 3600,
      token_type: 'Bearer',
    })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    const token = await service.getAccessToken(mailboxId)

    expect(token).toBe('fresh-access-token')
    expect(calls).toHaveLength(1)

    const stored = await tokenStore.getTokens(mailboxId)
    expect(stored?.accessToken).toBe('fresh-access-token')
    expect(stored?.accessTokenExpiresAt).not.toBeNull()
    expect(stored?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 3_500_000)
  })

  it('refreshes when the cached token is within the expiry skew, and posts the correct request shape', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, {
      refreshToken: 'refresh-token-value',
      accessToken: 'stale-access-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 1000), // 1 min out — inside the default 5 min skew
    })
    const { fetchImpl, calls } = fakeTokenEndpoint(200, {
      access_token: 'fresh-access-token',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/gmail.send',
      token_type: 'Bearer',
    })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    const token = await service.getAccessToken(mailboxId)
    expect(token).toBe('fresh-access-token')

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')

    const params = new URLSearchParams(String(init.body))
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('client_id')).toBe(CLIENT_ID)
    expect(params.get('client_secret')).toBe(CLIENT_SECRET)
    expect(params.get('refresh_token')).toBe('refresh-token-value')

    const stored = await tokenStore.getTokens(mailboxId)
    expect(stored?.accessToken).toBe('fresh-access-token')
    // No refresh_token in the response → the original is kept, not cleared.
    expect(stored?.refreshToken).toBe('refresh-token-value')
    expect(stored?.scopes).toBe('https://www.googleapis.com/auth/gmail.send')
  })

  it('does not refresh when the cached token is fresh enough to clear a custom expirySkewMs', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, {
      refreshToken: 'refresh-token',
      accessToken: 'cached-access-token',
      accessTokenExpiresAt: new Date(Date.now() + 30 * 1000), // 30s out
    })
    const { fetchImpl } = fakeTokenEndpoint(200, {})
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
      expirySkewMs: 5_000, // much smaller than the 30s remaining
    })

    const token = await service.getAccessToken(mailboxId)
    expect(token).toBe('cached-access-token')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('persists a NEW refresh token when the response includes one (RFC 6749 §6 rotation)', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'old-refresh-token' })
    const { fetchImpl } = fakeTokenEndpoint(200, {
      access_token: 'fresh-access-token',
      expires_in: 3600,
      refresh_token: 'rotated-refresh-token',
    })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    await service.getAccessToken(mailboxId)

    const stored = await tokenStore.getTokens(mailboxId)
    expect(stored?.refreshToken).toBe('rotated-refresh-token')
  })

  it('carries forward the existing scopes when the refresh response omits `scope`', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, {
      refreshToken: 'refresh-token',
      scopes: 'https://www.googleapis.com/auth/gmail.send',
    })
    const { fetchImpl } = fakeTokenEndpoint(200, { access_token: 'fresh', expires_in: 3600 })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    await service.getAccessToken(mailboxId)

    const stored = await tokenStore.getTokens(mailboxId)
    expect(stored?.scopes).toBe('https://www.googleapis.com/auth/gmail.send')
  })

  // --- HT-47: never resurrect a disconnected mailbox's token row -------------

  it('a refresh that completes after the mailbox is disconnected still returns the fresh token, but does not persist it', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, {
      refreshToken: 'refresh-token',
      accessToken: 'stale-access-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 1000), // inside the default skew -> refresh fires
    })
    // Simulates gmail-disconnect.ts's step-3 transaction having committed
    // (mailbox flipped to `disconnected`) WHILE this refresh's Google
    // round-trip was already in flight — the exact race the module doc's
    // "Never resurrect a disconnected mailbox's token row" section
    // describes.
    await mailboxStore.markDisconnected(mailboxId)
    const { fetchImpl } = fakeTokenEndpoint(200, {
      access_token: 'fresh-access-token',
      expires_in: 3600,
    })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    const token = await service.getAccessToken(mailboxId)

    // The in-flight caller still gets its token — that HTTP call already
    // happened and cannot be un-requested.
    expect(token).toBe('fresh-access-token')
    // But nothing was written back: the store still holds the STALE
    // pre-refresh value, proving the fresh token was never persisted for a
    // mailbox that is now disconnected.
    const stored = await tokenStore.getTokens(mailboxId)
    expect(stored?.accessToken).toBe('stale-access-token')
  })

  // --- invalid_grant → needs_reconnect ----------------------------------------

  it('on invalid_grant: marks the mailbox needs_reconnect, throws a clear error, and never leaks secrets', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    const secretRefreshToken = 'super-secret-refresh-token-do-not-leak'
    await tokenStore.upsertTokens(mailboxId, { refreshToken: secretRefreshToken })
    const { fetchImpl } = fakeTokenEndpoint(400, {
      error: 'invalid_grant',
      error_description: 'Token has been expired or revoked.',
    })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    let caught: unknown
    try {
      await service.getAccessToken(mailboxId)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('invalid_grant')
    expect((caught as Error).message).toContain('needs_reconnect')
    expect(String(caught)).not.toContain(secretRefreshToken)
    expect(String(caught)).not.toContain(CLIENT_SECRET)

    expect(await mailboxStatus(db, mailboxId)).toBe('needs_reconnect')
  })

  it('a mailbox marked needs_reconnect via invalid_grant keeps its (still-encrypted) stored tokens untouched', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'refresh-token' })
    const { fetchImpl } = fakeTokenEndpoint(400, { error: 'invalid_grant' })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    await expect(service.getAccessToken(mailboxId)).rejects.toThrow()

    // The row is left alone — needs_reconnect is a mailbox-level flag, not a
    // token deletion; reconnecting overwrites it via upsertTokens later.
    const stored = await tokenStore.getTokens(mailboxId)
    expect(stored?.refreshToken).toBe('refresh-token')
  })

  // --- other refresh failures: throw, but do NOT mark needs_reconnect --------

  it('on a non-invalid_grant error (e.g. server_error): throws WITHOUT marking needs_reconnect', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'refresh-token' })
    const { fetchImpl } = fakeTokenEndpoint(500, { error: 'server_error' })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    await expect(service.getAccessToken(mailboxId)).rejects.toThrow(/500/)
    expect(await mailboxStatus(db, mailboxId)).toBe('active')
  })

  it('on invalid_client: throws WITHOUT marking needs_reconnect (it is a config error, not a dead grant)', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'refresh-token' })
    const { fetchImpl } = fakeTokenEndpoint(401, { error: 'invalid_client' })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    await expect(service.getAccessToken(mailboxId)).rejects.toThrow(/invalid_client/)
    expect(await mailboxStatus(db, mailboxId)).toBe('active')
  })

  it('on a malformed success response (missing access_token): throws a clear error', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'refresh-token' })
    const { fetchImpl } = fakeTokenEndpoint(200, { token_type: 'Bearer' })
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    await expect(service.getAccessToken(mailboxId)).rejects.toThrow(/malformed/)
    expect(await mailboxStatus(db, mailboxId)).toBe('active')
  })

  it('on a non-JSON error body: throws with just the status, without crashing on parse', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'refresh-token' })
    const fetchImpl = vi.fn(
      async () => new Response('not json', { status: 502 }),
    ) as unknown as typeof fetch
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
    })

    await expect(service.getAccessToken(mailboxId)).rejects.toThrow(/502/)
  })

  // --- timeout ---------------------------------------------------------------

  it('passes an abort signal to fetch and rejects when the refresh call outlives timeoutMs', async () => {
    const { db, tokenStore, mailboxStore } = await freshStores()
    const mailboxId = await insertMailbox(db)
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'refresh-token' })

    // A fetch that never resolves on its own — it settles ONLY via the abort
    // signal, exactly like a stalled token endpoint would (same pattern as
    // sender.test.ts's identical timeout test).
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          expect(signal).toBeDefined()
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    ) as unknown as typeof fetch
    const service = createGmailOAuthTokenService({
      tokenStore,
      mailboxStore,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl,
      timeoutMs: 20,
    })

    await expect(service.getAccessToken(mailboxId)).rejects.toThrow(/timeout|timed out|aborted/i)
    expect(await mailboxStatus(db, mailboxId)).toBe('active')
  })
})
