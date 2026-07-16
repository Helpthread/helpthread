/**
 * `src/mail/gmail-connect.ts` — the state-token mint/verify pair,
 * `buildConsentUrl`, `exchangeAuthCode`, and `createGmailConnectService`
 * against REAL PGlite-backed `MailboxStore`/`MailboxTokenStore`/
 * `GmailWatchStateStore` instances (real encryption, real SQL — only
 * Google's token endpoint and the `GmailWatchClient` are faked, matching
 * `gmail-oauth.test.ts`'s convention). No real network call, no real
 * Google credentials.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPgliteDb, type Db } from '../db/client.js'
import { migrate } from '../db/migrate.js'
import type { GmailWatchClient } from '../providers/adapters/gmail/index.js'
import {
  createGmailWatchStateStore,
  type GmailWatchStateStore,
} from '../store/gmail-watch-state.js'
import { createMailboxTokenStore, type MailboxTokenStore } from '../store/mailbox-tokens.js'
import { createMailboxStore, type MailboxStore } from '../store/mailboxes.js'
import { ENCRYPTION_KEY_BYTES } from '../store/token-crypto.js'
import {
  buildConsentUrl,
  createGmailConnectService,
  exchangeAuthCode,
  GmailConnectError,
  type GmailConnectServiceDeps,
  mintConnectState,
  verifyConnectState,
} from './gmail-connect.js'
import type { Keyring } from './reply-token.js'

const KEY = randomBytes(ENCRYPTION_KEY_BYTES)
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-client-secret'
const REDIRECT_URI = 'https://desk.example.test/api/v1/inbound/gmail/callback'
const TOPIC_NAME = 'projects/helpthread-prod/topics/gmail-push'
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]
const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }

interface RecordedCall {
  url: string
  init: RequestInit
}

/** A fake token-endpoint `fetch` that records every call and always resolves with `status`/`body`. Mirrors `gmail-oauth.test.ts`'s helper of the same name. */
function fakeTokenEndpoint(status: number, body: unknown) {
  const calls: RecordedCall[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const DEFAULT_TOKEN_RESPONSE = {
  access_token: 'fresh-access-token',
  refresh_token: 'fresh-refresh-token',
  expires_in: 3600,
  scope:
    'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
}

/** A `GmailWatchClient` fake with sane defaults, overridable per test. */
function fakeWatchClient(overrides: Partial<GmailWatchClient> = {}): GmailWatchClient {
  return {
    getProfile:
      overrides.getProfile ??
      (async () => ({ emailAddress: 'mailbox@example.test', historyId: 'profile-hid-unused' })),
    watch:
      overrides.watch ??
      (async () => ({ historyId: 'watch-hid', expiration: new Date('2026-08-01T00:00:00.000Z') })),
  }
}

describe('buildConsentUrl', () => {
  it('includes access_type=offline, prompt=consent, response_type=code, space-joined scope, and state', () => {
    const url = buildConsentUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: SCOPES,
      state: 'gmc.k1.123.nonce.sig',
    })
    const parsed = new URL(url)

    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('scope')).toBe(SCOPES.join(' '))
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
    expect(parsed.searchParams.get('state')).toBe('gmc.k1.123.nonce.sig')
  })
})

describe('mintConnectState / verifyConnectState', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a freshly minted token verifies', () => {
    const state = mintConnectState(KEYRING)
    expect(verifyConnectState(state, KEYRING)).toBe(true)
  })

  it('is shaped gmc.{keyId}.{issuedAtMs}.{nonce}.{sig} — five dot-separated segments, gmc prefix', () => {
    const state = mintConnectState(KEYRING)
    const segments = state.split('.')
    expect(segments).toHaveLength(5)
    expect(segments[0]).toBe('gmc')
    expect(segments[1]).toBe('k1')
  })

  it('a forged signature does not verify', () => {
    const segments = mintConnectState(KEYRING).split('.')
    segments[4] = 'A'.repeat(segments[4].length) // same length, wrong signature
    expect(verifyConnectState(segments.join('.'), KEYRING)).toBe(false)
  })

  it('a tampered issuedAt does not verify (it is part of the signed canonical string)', () => {
    const segments = mintConnectState(KEYRING).split('.')
    segments[2] = String(Number(segments[2]) - 1000)
    expect(verifyConnectState(segments.join('.'), KEYRING)).toBe(false)
  })

  it('expires past the TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const state = mintConnectState(KEYRING)

    vi.setSystemTime(new Date('2026-01-01T00:09:00.000Z')) // 9 min later — within the default 10 min TTL
    expect(verifyConnectState(state, KEYRING)).toBe(true)

    vi.setSystemTime(new Date('2026-01-01T00:11:00.000Z')) // 11 min later — past it
    expect(verifyConnectState(state, KEYRING)).toBe(false)
  })

  it('respects a custom ttlMs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const state = mintConnectState(KEYRING)

    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z')) // 5s later
    expect(verifyConnectState(state, KEYRING, 1_000)).toBe(false) // 1s TTL
    expect(verifyConnectState(state, KEYRING, 10_000)).toBe(true) // 10s TTL
  })

  it('TOTAL: malformed/garbage inputs return false, never throw', () => {
    for (const bad of [
      '',
      'not-a-token',
      'gmc.only.three',
      'ht.k1.123.nonce.sig',
      'gmc..123.nonce.sig',
    ]) {
      expect(verifyConnectState(bad, KEYRING)).toBe(false)
    }
  })

  it('an unknown keyId does not verify', () => {
    const segments = mintConnectState(KEYRING).split('.')
    segments[1] = 'unknown-key'
    expect(verifyConnectState(segments.join('.'), KEYRING)).toBe(false)
  })

  it('a retired key still verifies (rotation-tolerant); a dropped key no longer does', () => {
    const oldKeyring: Keyring = { current: { keyId: 'k-old', secret: 'b'.repeat(32) } }
    const state = mintConnectState(oldKeyring)

    const rotatedKeyring: Keyring = {
      current: { keyId: 'k-new', secret: 'c'.repeat(32) },
      retired: [{ keyId: 'k-old', secret: 'b'.repeat(32) }],
    }
    expect(verifyConnectState(state, rotatedKeyring)).toBe(true)

    const droppedKeyring: Keyring = { current: { keyId: 'k-new', secret: 'c'.repeat(32) } }
    expect(verifyConnectState(state, droppedKeyring)).toBe(false)
  })

  it('mintConnectState throws on an invalid keyring (STRICT)', () => {
    expect(() => mintConnectState({ current: { keyId: 'k1', secret: 'too-short' } })).toThrow()
  })

  it('verifyConnectState throws on an invalid keyring — trusted config, not the untrusted state', () => {
    expect(() =>
      verifyConnectState('anything', { current: { keyId: 'k1', secret: 'too-short' } }),
    ).toThrow()
  })
})

describe('exchangeAuthCode', () => {
  it('success: returns accessToken/refreshToken/expiresIn/scope and posts the correct request shape', async () => {
    const { fetchImpl, calls } = fakeTokenEndpoint(200, {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    })

    const result = await exchangeAuthCode({
      code: 'auth-code-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetchImpl,
    })

    expect(result).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresIn: 3600,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    })
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe('https://oauth2.googleapis.com/token')
    expect(init.method).toBe('POST')
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(String(init.body))
    expect(params.get('grant_type')).toBe('authorization_code')
    expect(params.get('code')).toBe('auth-code-1')
    expect(params.get('client_id')).toBe(CLIENT_ID)
    expect(params.get('client_secret')).toBe(CLIENT_SECRET)
    expect(params.get('redirect_uri')).toBe(REDIRECT_URI)
  })

  it('omits scope from the result when the response does not include one', async () => {
    const { fetchImpl } = fakeTokenEndpoint(200, {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
    })

    const result = await exchangeAuthCode({
      code: 'c',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      fetchImpl,
    })

    expect(result.scope).toBeUndefined()
  })

  it('non-2xx throws, without leaking client_secret or any token', async () => {
    const { fetchImpl } = fakeTokenEndpoint(400, {
      error: 'invalid_grant',
      error_description: 'Malformed auth code.',
    })

    let caught: unknown
    try {
      await exchangeAuthCode({
        code: 'bad-code',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetchImpl,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('400')
    expect((caught as Error).message).toContain('invalid_grant')
    expect(String(caught)).not.toContain(CLIENT_SECRET)
  })

  it('missing refresh_token throws a GmailConnectError(no_refresh_token), without leaking secrets', async () => {
    const { fetchImpl } = fakeTokenEndpoint(200, { access_token: 'access-1', expires_in: 3600 })

    let caught: unknown
    try {
      await exchangeAuthCode({
        code: 'auth-code-1',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetchImpl,
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(GmailConnectError)
    expect((caught as GmailConnectError).code).toBe('no_refresh_token')
    expect(String(caught)).not.toContain(CLIENT_SECRET)
    expect(String(caught)).not.toContain('access-1')
  })

  it('an EMPTY refresh_token (present but blank) also throws no_refresh_token', async () => {
    const { fetchImpl } = fakeTokenEndpoint(200, {
      access_token: 'access-1',
      expires_in: 3600,
      refresh_token: '',
    })

    await expect(
      exchangeAuthCode({
        code: 'c',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(GmailConnectError)
  })

  it('a malformed 200 (missing access_token) throws', async () => {
    const { fetchImpl } = fakeTokenEndpoint(200, { expires_in: 3600, refresh_token: 'r1' })

    await expect(
      exchangeAuthCode({
        code: 'c',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetchImpl,
      }),
    ).rejects.toThrow(/malformed/)
  })

  it('passes an abort signal to fetch and rejects when the call outlives timeoutMs', async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          expect(signal).toBeDefined()
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    ) as unknown as typeof fetch

    await expect(
      exchangeAuthCode({
        code: 'c',
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        fetchImpl,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/timeout|timed out|aborted/i)
  })
})

describe('createGmailConnectService', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshService(
    overrides: {
      tokenResponse?: { status: number; body: unknown }
      watchClient?: GmailWatchClient
    } = {},
  ): Promise<{
    db: Db
    mailboxStore: MailboxStore
    tokenStore: MailboxTokenStore
    watchStateStore: GmailWatchStateStore
    service: ReturnType<typeof createGmailConnectService>
    createWatchClient: ReturnType<typeof vi.fn>
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const mailboxStore = createMailboxStore(db)
    const tokenStore = createMailboxTokenStore(db, KEY)
    const watchStateStore = createGmailWatchStateStore(db)

    const tokenResp = overrides.tokenResponse ?? { status: 200, body: DEFAULT_TOKEN_RESPONSE }
    const { fetchImpl } = fakeTokenEndpoint(tokenResp.status, tokenResp.body)

    const watchClient = overrides.watchClient ?? fakeWatchClient()
    const createWatchClient = vi.fn(() => watchClient)

    const service = createGmailConnectService({
      db,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      topicName: TOPIC_NAME,
      scopes: SCOPES,
      keyring: KEYRING,
      mailboxStore,
      tokenStore,
      watchStateStore,
      createWatchClient,
      fetchImpl,
    })

    return { db, mailboxStore, tokenStore, watchStateStore, service, createWatchClient }
  }

  /** Mint a state via the service's own `beginConnect` — proves the begin→complete loop, not just the pure function. */
  function stateFrom(service: ReturnType<typeof createGmailConnectService>): string {
    const { consentUrl } = service.beginConnect()
    const state = new URL(consentUrl).searchParams.get('state')
    if (state === null) throw new Error('unreachable: beginConnect always sets state')
    return state
  }

  // --- beginConnect ----------------------------------------------------------

  it('beginConnect mints a state and a consent URL carrying it', async () => {
    const { service } = await freshService()
    const { consentUrl } = service.beginConnect()
    const state = new URL(consentUrl).searchParams.get('state')
    expect(state).not.toBeNull()
    expect(verifyConnectState(state as string, KEYRING)).toBe(true)
  })

  // --- completeConnect: happy path --------------------------------------------

  it('happy path: persists an active mailbox, encrypted tokens, and a watch-state row seeded from watch() (not getProfile)', async () => {
    const expiration = new Date('2026-08-01T00:00:00.000Z')
    const watchClient = fakeWatchClient({
      getProfile: async () => ({
        emailAddress: 'connected@example.test',
        historyId: 'profile-hid-must-not-be-used',
      }),
      watch: async () => ({ historyId: 'baseline-hid', expiration }),
    })
    const { db, tokenStore, watchStateStore, service } = await freshService({ watchClient })
    const state = stateFrom(service)

    const result = await service.completeConnect({ code: 'auth-code-1', state })

    expect(result.address).toBe('connected@example.test')
    expect(typeof result.mailboxId).toBe('string')

    const mailboxRows = await db.query<{ status: string; address: string; provider: string }>(
      'SELECT status, address, provider FROM mailboxes WHERE id = $1',
      [result.mailboxId],
    )
    expect(mailboxRows).toHaveLength(1)
    expect(mailboxRows[0]).toEqual({
      status: 'active',
      address: 'connected@example.test',
      provider: 'gmail',
    })

    // The baseline cursor is watch()'s historyId, NOT getProfile's.
    expect(await watchStateStore.getCursor(result.mailboxId)).toBe('baseline-hid')
    const watchRows = await db.query<{ history_id: string; watch_expiration: Date }>(
      'SELECT history_id, watch_expiration FROM gmail_watch_state WHERE mailbox_id = $1',
      [result.mailboxId],
    )
    expect(watchRows[0].history_id).toBe('baseline-hid')
    expect(watchRows[0].watch_expiration.toISOString()).toBe(expiration.toISOString())

    // --- THE SACRED CHECK: ciphertext at rest never contains the plaintext ---
    const tokenRows = await db.query<{ refresh_token_ciphertext: Uint8Array }>(
      'SELECT refresh_token_ciphertext FROM mailbox_oauth_tokens WHERE mailbox_id = $1',
      [result.mailboxId],
    )
    const rawCiphertext = Buffer.from(tokenRows[0].refresh_token_ciphertext)
    const plaintext = Buffer.from('fresh-refresh-token', 'utf8')
    expect(rawCiphertext.equals(plaintext)).toBe(false)
    expect(rawCiphertext.toString('utf8')).not.toContain('fresh-refresh-token')

    // ...while the store's own decrypt path round-trips the plaintext back.
    const tokens = await tokenStore.getTokens(result.mailboxId)
    expect(tokens?.refreshToken).toBe('fresh-refresh-token')
    expect(tokens?.accessToken).toBe('fresh-access-token')
  })

  it('persist is atomic: a failure in the last write rolls back the mailbox and token rows', async () => {
    // Reuse freshService only for a real db + real mailbox/token stores, then
    // build a service whose watch-state seed (the LAST of the three step-5
    // writes) throws. The mailbox insert and token write happen first, via the
    // same transaction; the seed failure must roll ALL of them back, leaving no
    // partial connect (gmail-connect.md §4 step 5).
    const { db, mailboxStore, tokenStore } = await freshService()
    const throwingWatchState: GmailWatchStateStore = {
      getCursor: async () => null,
      setCursor: async () => {},
      seedBaseline: async () => {
        throw new Error('simulated seedBaseline failure')
      },
      setWatchExpiration: async () => {
        throw new Error('setWatchExpiration: not used by the connect flow')
      },
      claimReconcileLease: async () => {
        throw new Error('claimReconcileLease: not used by the connect flow')
      },
      releaseReconcileLease: async () => {
        throw new Error('releaseReconcileLease: not used by the connect flow')
      },
    }
    const { fetchImpl } = fakeTokenEndpoint(200, DEFAULT_TOKEN_RESPONSE)
    const service = createGmailConnectService({
      db,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: REDIRECT_URI,
      topicName: TOPIC_NAME,
      scopes: SCOPES,
      keyring: KEYRING,
      mailboxStore,
      tokenStore,
      watchStateStore: throwingWatchState,
      createWatchClient: () => fakeWatchClient(),
      fetchImpl,
    })
    const state = stateFrom(service)

    await expect(service.completeConnect({ code: 'auth-code-1', state })).rejects.toThrow(
      'simulated seedBaseline failure',
    )

    // The whole transaction rolled back: neither the mailbox row nor its token
    // row survives, so a retry starts from a clean slate rather than a
    // half-connected mailbox.
    expect(await db.query('SELECT id FROM mailboxes')).toHaveLength(0)
    expect(await db.query('SELECT mailbox_id FROM mailbox_oauth_tokens')).toHaveLength(0)
  })

  it('arms watch() with the configured topicName', async () => {
    const watchSpy = vi.fn(async (_input: { topicName: string }) => ({
      historyId: 'h',
      expiration: new Date('2026-08-01T00:00:00.000Z'),
    }))
    const { service } = await freshService({ watchClient: fakeWatchClient({ watch: watchSpy }) })
    const state = stateFrom(service)

    await service.completeConnect({ code: 'auth-code-1', state })

    expect(watchSpy).toHaveBeenCalledWith({ topicName: TOPIC_NAME })
  })

  it('binds createWatchClient to a getAccessToken that resolves the freshly-exchanged access token', async () => {
    const { service, createWatchClient } = await freshService()
    const state = stateFrom(service)

    await service.completeConnect({ code: 'auth-code-1', state })

    expect(createWatchClient).toHaveBeenCalledTimes(1)
    const getAccessToken = createWatchClient.mock.calls[0][0] as () => Promise<string>
    await expect(getAccessToken()).resolves.toBe('fresh-access-token')
  })

  // --- completeConnect: error paths persist NOTHING ---------------------------

  it('invalid state: throws GmailConnectError(invalid_state), persists nothing', async () => {
    const { db, service } = await freshService()

    await expect(
      service.completeConnect({ code: 'auth-code', state: 'garbage' }),
    ).rejects.toMatchObject({ code: 'invalid_state' })

    expect(await db.query('SELECT id FROM mailboxes')).toHaveLength(0)
  })

  it('a state signed by a different keyring is invalid_state too, nothing persisted', async () => {
    const { db, service } = await freshService()
    const foreignState = mintConnectState({ current: { keyId: 'k1', secret: 'z'.repeat(32) } })

    await expect(
      service.completeConnect({ code: 'auth-code', state: foreignState }),
    ).rejects.toMatchObject({ code: 'invalid_state' })
    expect(await db.query('SELECT id FROM mailboxes')).toHaveLength(0)
  })

  it('exchange failure (non-2xx): throws GmailConnectError(exchange_failed), persists nothing', async () => {
    const { db, service } = await freshService({
      tokenResponse: {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'bad code' },
      },
    })
    const state = stateFrom(service)

    await expect(service.completeConnect({ code: 'auth-code', state })).rejects.toMatchObject({
      code: 'exchange_failed',
    })
    expect(await db.query('SELECT id FROM mailboxes')).toHaveLength(0)
  })

  it('missing refresh_token: throws GmailConnectError(no_refresh_token), persists nothing', async () => {
    const { db, service } = await freshService({
      tokenResponse: { status: 200, body: { access_token: 'a', expires_in: 3600 } },
    })
    const state = stateFrom(service)

    await expect(service.completeConnect({ code: 'auth-code', state })).rejects.toMatchObject({
      code: 'no_refresh_token',
    })
    expect(await db.query('SELECT id FROM mailboxes')).toHaveLength(0)
    expect(await db.query('SELECT mailbox_id FROM mailbox_oauth_tokens')).toHaveLength(0)
  })

  it('watch() failure: throws GmailConnectError(watch_failed), persists nothing (no orphan mailbox or token row)', async () => {
    const watchClient = fakeWatchClient({
      watch: async () => {
        throw new Error('watch endpoint unavailable')
      },
    })
    const { db, service } = await freshService({ watchClient })
    const state = stateFrom(service)

    await expect(service.completeConnect({ code: 'auth-code', state })).rejects.toMatchObject({
      code: 'watch_failed',
    })
    expect(await db.query('SELECT id FROM mailboxes')).toHaveLength(0)
    expect(await db.query('SELECT mailbox_id FROM mailbox_oauth_tokens')).toHaveLength(0)
    expect(await db.query('SELECT mailbox_id FROM gmail_watch_state')).toHaveLength(0)
  })

  it('none of the GmailConnectError messages ever contain client_secret', async () => {
    const cases: Array<{
      tokenResponse?: { status: number; body: unknown }
      watchClient?: GmailWatchClient
    }> = [
      { tokenResponse: { status: 400, body: { error: 'invalid_grant' } } },
      { tokenResponse: { status: 200, body: { access_token: 'a', expires_in: 3600 } } },
      {
        watchClient: fakeWatchClient({
          watch: async () => {
            throw new Error('boom')
          },
        }),
      },
    ]
    for (const testCase of cases) {
      const { service } = await freshService(testCase)
      const state = stateFrom(service)
      let caught: unknown
      try {
        await service.completeConnect({ code: 'auth-code', state })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(GmailConnectError)
      expect(String(caught)).not.toContain(CLIENT_SECRET)
    }
  })

  // --- reconnect: idempotent by address ---------------------------------------

  it('reconnect: two successful completes for the same address → exactly one mailbox row, reactivated, cursor rebaselined to the SECOND watch()', async () => {
    let watchCalls = 0
    const watchClient = fakeWatchClient({
      getProfile: async () => ({
        emailAddress: 'reconnect@example.test',
        historyId: 'profile-hid',
      }),
      watch: async () => {
        watchCalls++
        return {
          historyId: `baseline-${watchCalls}`,
          expiration: new Date(
            watchCalls === 1 ? '2026-08-01T00:00:00.000Z' : '2026-09-01T00:00:00.000Z',
          ),
        }
      },
    })
    const { db, mailboxStore, watchStateStore, service } = await freshService({ watchClient })

    const first = await service.completeConnect({ code: 'code-1', state: stateFrom(service) })
    const second = await service.completeConnect({ code: 'code-2', state: stateFrom(service) })

    expect(second.mailboxId).toBe(first.mailboxId)
    const rows = await db.query('SELECT id FROM mailboxes WHERE address = $1', [
      'reconnect@example.test',
    ])
    expect(rows).toHaveLength(1)

    expect(await watchStateStore.getCursor(first.mailboxId)).toBe('baseline-2')
    const mailbox = await mailboxStore.getMailboxById(first.mailboxId)
    expect(mailbox?.status).toBe('active')
  })

  it('reconnect reactivates a needs_reconnect mailbox to active, replacing its tokens', async () => {
    const watchClient = fakeWatchClient({
      getProfile: async () => ({ emailAddress: 'was-broken@example.test', historyId: 'p' }),
    })
    const { db, mailboxStore, tokenStore, service } = await freshService({ watchClient })
    const existing = await db.query<{ id: string }>(
      "INSERT INTO mailboxes (address, provider, status) VALUES ($1, 'gmail', 'needs_reconnect') RETURNING id",
      ['was-broken@example.test'],
    )

    const result = await service.completeConnect({ code: 'code', state: stateFrom(service) })

    expect(result.mailboxId).toBe(existing[0].id)
    const mailbox = await mailboxStore.getMailboxById(result.mailboxId)
    expect(mailbox?.status).toBe('active')
    const rows = await db.query('SELECT id FROM mailboxes WHERE address = $1', [
      'was-broken@example.test',
    ])
    expect(rows).toHaveLength(1)
    const tokens = await tokenStore.getTokens(result.mailboxId)
    expect(tokens?.refreshToken).toBe('fresh-refresh-token')
  })
})

describe('createGmailConnectService — construction validation', () => {
  const dummyStores = {
    mailboxStore: {} as unknown as MailboxStore,
    tokenStore: {} as unknown as MailboxTokenStore,
    watchStateStore: {} as unknown as GmailWatchStateStore,
    createWatchClient: () => ({}) as unknown as GmailWatchClient,
  }
  const validDeps: GmailConnectServiceDeps = {
    // Construction only validates config strings + the keyring, never touches
    // db/stores — a dummy Db is fine here (no query/transaction is ever run).
    db: {} as unknown as Db,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    topicName: TOPIC_NAME,
    scopes: SCOPES,
    keyring: KEYRING,
    ...dummyStores,
  }

  it('constructs successfully with valid deps', () => {
    expect(() => createGmailConnectService(validDeps)).not.toThrow()
  })

  it('throws on an empty clientId', () => {
    expect(() => createGmailConnectService({ ...validDeps, clientId: '' })).toThrow(/clientId/)
  })

  it('throws on an empty clientSecret', () => {
    expect(() => createGmailConnectService({ ...validDeps, clientSecret: '' })).toThrow(
      /clientSecret/,
    )
  })

  it('throws on an empty redirectUri', () => {
    expect(() => createGmailConnectService({ ...validDeps, redirectUri: '' })).toThrow(
      /redirectUri/,
    )
  })

  it('throws on an empty topicName', () => {
    expect(() => createGmailConnectService({ ...validDeps, topicName: '' })).toThrow(/topicName/)
  })

  it('throws on an empty scopes array', () => {
    expect(() => createGmailConnectService({ ...validDeps, scopes: [] })).toThrow(/scopes/)
  })

  it('throws on an invalid keyring', () => {
    expect(() =>
      createGmailConnectService({
        ...validDeps,
        keyring: { current: { keyId: 'k1', secret: 'too-short' } },
      }),
    ).toThrow()
  })
})
