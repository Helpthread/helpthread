/**
 * `src/mail/gmail-disconnect.ts` — `revokeToken` and
 * `createGmailDisconnectService` against REAL PGlite-backed
 * `MailboxStore`/`MailboxTokenStore`/`GmailWatchStateStore` instances (real
 * encryption, real SQL — only Google's revoke endpoint and the
 * `GmailWatchClient`/`GmailOAuthTokenService` are faked), matching
 * `gmail-connect.test.ts`'s convention. No real network call, no real
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
  createGmailDisconnectService,
  GmailDisconnectError,
  revokeToken,
} from './gmail-disconnect.js'
import type { GmailOAuthTokenService } from './gmail-oauth.js'

const KEY = randomBytes(ENCRYPTION_KEY_BYTES)

interface RecordedCall {
  url: string
  init: RequestInit
}

/** A fake revoke-endpoint `fetch` that records every call and always resolves with `status`/`body`. */
function fakeRevokeEndpoint(status: number, body = '') {
  const calls: RecordedCall[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** A `GmailWatchClient` fake with sane defaults, overridable per test. */
function fakeWatchClient(overrides: Partial<GmailWatchClient> = {}): GmailWatchClient {
  return {
    getProfile:
      overrides.getProfile ??
      (async () => {
        throw new Error('getProfile: not used by the disconnect flow')
      }),
    watch:
      overrides.watch ??
      (async () => {
        throw new Error('watch: not used by the disconnect flow')
      }),
    stop: overrides.stop ?? (async () => {}),
  }
}

/** A `GmailOAuthTokenService` fake — resolves a fixed access token by default, or a caller-supplied failure. */
function fakeTokenService(overrides: Partial<GmailOAuthTokenService> = {}): GmailOAuthTokenService {
  return {
    getAccessToken: overrides.getAccessToken ?? (async () => 'fresh-access-token'),
  }
}

describe('revokeToken', () => {
  it('POSTs token=<value> to the revoke endpoint and resolves on 200', async () => {
    const { fetchImpl, calls } = fakeRevokeEndpoint(200)

    await expect(revokeToken({ token: 'refresh-token-1', fetchImpl })).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/revoke')
    expect(calls[0].init.method).toBe('POST')
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(String(calls[0].init.body))
    expect(params.get('token')).toBe('refresh-token-1')
  })

  it('resolves on 200 even when Google reports the token was already invalid (RFC 7009 §2.2)', async () => {
    const { fetchImpl } = fakeRevokeEndpoint(200)
    await expect(revokeToken({ token: 'already-dead-token', fetchImpl })).resolves.toBeUndefined()
  })

  it('throws on a non-2xx, without leaking the token — even when the error body ECHOES the token back', async () => {
    const secretToken = 'super-secret-refresh-token-do-not-leak'
    // A revocation error body can reflect the submitted request — token
    // included (review fix: bounding the body's length does not redact it).
    // This fixture proves the thrown error is built without reading the
    // body at all.
    const { fetchImpl } = fakeRevokeEndpoint(
      400,
      `{"error":"invalid_request","error_description":"token ${secretToken} is malformed"}`,
    )

    let caught: unknown
    try {
      await revokeToken({ token: secretToken, fetchImpl })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('400')
    expect((caught as Error).message).not.toContain(secretToken)
    expect(String(caught)).not.toContain(secretToken)
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

    await expect(revokeToken({ token: 't', fetchImpl, timeoutMs: 20 })).rejects.toThrow(
      /timeout|timed out|aborted/i,
    )
  })
})

describe('createGmailDisconnectService', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshService(
    overrides: {
      revokeResponse?: { status: number; body?: string }
      watchClient?: GmailWatchClient
      tokenService?: GmailOAuthTokenService
    } = {},
  ): Promise<{
    db: Db
    mailboxStore: MailboxStore
    tokenStore: MailboxTokenStore
    watchStateStore: GmailWatchStateStore
    service: ReturnType<typeof createGmailDisconnectService>
    revokeCalls: RecordedCall[]
    createWatchClient: ReturnType<typeof vi.fn>
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const mailboxStore = createMailboxStore(db)
    const tokenStore = createMailboxTokenStore(db, KEY)
    const watchStateStore = createGmailWatchStateStore(db)

    const revokeResp = overrides.revokeResponse ?? { status: 200 }
    const { fetchImpl, calls: revokeCalls } = fakeRevokeEndpoint(revokeResp.status, revokeResp.body)

    const watchClient = overrides.watchClient ?? fakeWatchClient()
    // Realistically, a `GmailWatchClient.stop()` implementation fetches a
    // live access token internally (see `../providers/adapters/gmail/
    // watch.ts`'s `authedFetch`) — this factory mirrors that by actually
    // calling the injected `getAccessToken` before delegating to the fake's
    // own `stop`, so a failing `getAccessToken` genuinely fails the stop
    // step, matching the real client's behavior.
    const createWatchClient = vi.fn((getAccessToken: () => Promise<string>) => ({
      ...watchClient,
      async stop() {
        await getAccessToken()
        return watchClient.stop()
      },
    }))
    const tokenService = overrides.tokenService ?? fakeTokenService()

    const service = createGmailDisconnectService({
      db,
      mailboxStore,
      tokenStore,
      watchStateStore,
      tokenService,
      createWatchClient,
      fetchImpl,
    })

    return {
      db,
      mailboxStore,
      tokenStore,
      watchStateStore,
      service,
      revokeCalls,
      createWatchClient,
    }
  }

  async function connectedMailbox(
    store: MailboxStore,
    tokenStore: MailboxTokenStore,
    watchStateStore: GmailWatchStateStore,
    address: string,
    status: 'active' | 'paused' | 'needs_reconnect' = 'active',
  ): Promise<string> {
    const mailbox = await store.upsertConnectedMailbox({ address, provider: 'gmail' })
    if (status !== 'active') {
      if (status === 'paused') await store.markPaused(mailbox.id)
      if (status === 'needs_reconnect') await store.markNeedsReconnect(mailbox.id)
    }
    await tokenStore.upsertTokens(mailbox.id, { refreshToken: 'stored-refresh-token' })
    await watchStateStore.seedBaseline(mailbox.id, {
      historyId: 'baseline-hid',
      watchExpiration: new Date('2026-08-01T00:00:00.000Z'),
    })
    return mailbox.id
  }

  // --- not found ---------------------------------------------------------

  it('throws GmailDisconnectError(not_found) for an unknown address', async () => {
    const { service } = await freshService()

    await expect(service.disconnect('nobody@example.test')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  // --- happy path ----------------------------------------------------------

  it('happy path: revokes, stops the watch, marks disconnected, and deletes token + watch-state rows', async () => {
    const { db, mailboxStore, tokenStore, watchStateStore, service, revokeCalls } =
      await freshService()
    const mailboxId = await connectedMailbox(
      mailboxStore,
      tokenStore,
      watchStateStore,
      'connected@example.test',
    )

    const result = await service.disconnect('connected@example.test')

    expect(result).toEqual({
      mailboxId,
      address: 'connected@example.test',
      alreadyDisconnected: false,
      revoked: true,
      watchStopped: true,
    })

    const mailboxRows = await db.query<{ status: string }>(
      'SELECT status FROM mailboxes WHERE id = $1',
      [mailboxId],
    )
    expect(mailboxRows[0].status).toBe('disconnected')

    expect(await tokenStore.getTokens(mailboxId)).toBeNull()
    expect(await watchStateStore.getCursor(mailboxId)).toBeNull()
    const watchRows = await db.query(
      'SELECT mailbox_id FROM gmail_watch_state WHERE mailbox_id = $1',
      [mailboxId],
    )
    expect(watchRows).toHaveLength(0)

    expect(revokeCalls).toHaveLength(1)
    const params = new URLSearchParams(String(revokeCalls[0].init.body))
    expect(params.get('token')).toBe('stored-refresh-token')
  })

  it('calls stop() BEFORE revoke (module doc: revoke can invalidate the token stop() needs)', async () => {
    db = await createPgliteDb()
    await migrate(db)
    const mailboxStore = createMailboxStore(db)
    const tokenStore = createMailboxTokenStore(db, KEY)
    const watchStateStore = createGmailWatchStateStore(db)
    const mailboxId = await connectedMailbox(
      mailboxStore,
      tokenStore,
      watchStateStore,
      'order@example.test',
    )

    const order: string[] = []
    const watchClient = fakeWatchClient({
      stop: async () => {
        order.push('stop')
      },
    })
    const fetchImpl = vi.fn(async () => {
      order.push('revoke')
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const service = createGmailDisconnectService({
      db,
      mailboxStore,
      tokenStore,
      watchStateStore,
      tokenService: fakeTokenService(),
      createWatchClient: () => watchClient,
      fetchImpl,
    })

    await service.disconnect('order@example.test')

    expect(order).toEqual(['stop', 'revoke'])
    expect((await mailboxStore.getMailboxById(mailboxId))?.status).toBe('disconnected')
  })

  it('binds createWatchClient to a getAccessToken backed by the injected tokenService for this mailbox', async () => {
    const getAccessToken = vi.fn(async () => 'live-token')
    const { mailboxStore, tokenStore, watchStateStore, service, createWatchClient } =
      await freshService({ tokenService: fakeTokenService({ getAccessToken }) })
    const mailboxId = await connectedMailbox(
      mailboxStore,
      tokenStore,
      watchStateStore,
      'bound@example.test',
    )

    await service.disconnect('bound@example.test')

    expect(createWatchClient).toHaveBeenCalledTimes(1)
    const boundGetAccessToken = createWatchClient.mock.calls[0][0] as () => Promise<string>
    await expect(boundGetAccessToken()).resolves.toBe('live-token')
    expect(getAccessToken).toHaveBeenCalledWith(mailboxId)
  })

  // --- idempotency: already disconnected --------------------------------

  it('disconnecting an already-disconnected mailbox is a no-op: no remote calls (its own local writes are a no-op re-run)', async () => {
    const { db, mailboxStore, service, revokeCalls, createWatchClient } = await freshService()
    const mailboxId = await mailboxStore
      .upsertConnectedMailbox({ address: 'gone@example.test', provider: 'gmail' })
      .then((m) => m.id)
    await mailboxStore.markDisconnected(mailboxId)

    const result = await service.disconnect('gone@example.test')

    expect(result).toEqual({
      mailboxId,
      address: 'gone@example.test',
      alreadyDisconnected: true,
      revoked: false,
      watchStopped: false,
    })
    expect(revokeCalls).toHaveLength(0)
    expect(createWatchClient).not.toHaveBeenCalled()
    const mailboxRows = await db.query<{ status: string }>(
      'SELECT status FROM mailboxes WHERE id = $1',
      [mailboxId],
    )
    expect(mailboxRows[0].status).toBe('disconnected')
  })

  it('a repeat disconnect on an already-disconnected mailbox cleans up a RESURRECTED token row (review fix: the idempotent no-op path re-runs the step-3 deletes)', async () => {
    const {
      db,
      mailboxStore,
      tokenStore,
      watchStateStore,
      service,
      revokeCalls,
      createWatchClient,
    } = await freshService()
    const mailboxId = await mailboxStore
      .upsertConnectedMailbox({ address: 'resurrected@example.test', provider: 'gmail' })
      .then((m) => m.id)
    await mailboxStore.markDisconnected(mailboxId)
    // Simulates a concurrent refresh (`gmail-oauth.ts`'s `refresh()`) that was
    // already in flight when a FIRST disconnect call committed, upserting a
    // token row for this now-`disconnected` mailbox moments later — the race
    // this fix targets.
    await tokenStore.upsertTokens(mailboxId, { refreshToken: 'resurrected-refresh-token' })
    await watchStateStore.seedBaseline(mailboxId, {
      historyId: 'resurrected-hid',
      watchExpiration: new Date('2026-08-01T00:00:00.000Z'),
    })

    const result = await service.disconnect('resurrected@example.test')

    expect(result).toEqual({
      mailboxId,
      address: 'resurrected@example.test',
      alreadyDisconnected: true,
      revoked: false,
      watchStopped: false,
    })
    // No remote calls attempted, even though a token row existed — see the
    // module doc's rationale (re-revoking on every retry is repeat work with
    // no added safety, since the FIRST disconnect already tried).
    expect(revokeCalls).toHaveLength(0)
    expect(createWatchClient).not.toHaveBeenCalled()
    // The resurrected rows ARE cleaned up.
    expect(await tokenStore.getTokens(mailboxId)).toBeNull()
    expect(await watchStateStore.getCursor(mailboxId)).toBeNull()
    const mailboxRows = await db.query<{ status: string }>(
      'SELECT status FROM mailboxes WHERE id = $1',
      [mailboxId],
    )
    expect(mailboxRows[0].status).toBe('disconnected')
  })

  // --- best-effort ordering: revoke/stop failures never abort local cleanup --

  it('a revoke failure does not abort: mailbox is still marked disconnected and rows still deleted; revoked: false is reported', async () => {
    const { mailboxStore, tokenStore, watchStateStore, service } = await freshService({
      revokeResponse: { status: 400, body: 'invalid_token' },
    })
    const mailboxId = await connectedMailbox(
      mailboxStore,
      tokenStore,
      watchStateStore,
      'revoke-fails@example.test',
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await service.disconnect('revoke-fails@example.test')

    expect(result.revoked).toBe(false)
    expect(result.watchStopped).toBe(true)
    expect((await mailboxStore.getMailboxById(mailboxId))?.status).toBe('disconnected')
    expect(await tokenStore.getTokens(mailboxId)).toBeNull()
    expect(await watchStateStore.getCursor(mailboxId)).toBeNull()
    errorSpy.mockRestore()
  })

  it('a watch stop() failure does not abort: mailbox is still marked disconnected and rows still deleted; watchStopped: false is reported', async () => {
    const watchClient = fakeWatchClient({
      stop: async () => {
        throw new Error('users.stop failed: no active watch')
      },
    })
    const { mailboxStore, tokenStore, watchStateStore, service } = await freshService({
      watchClient,
    })
    const mailboxId = await connectedMailbox(
      mailboxStore,
      tokenStore,
      watchStateStore,
      'stop-fails@example.test',
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await service.disconnect('stop-fails@example.test')

    expect(result.watchStopped).toBe(false)
    expect(result.revoked).toBe(true)
    expect((await mailboxStore.getMailboxById(mailboxId))?.status).toBe('disconnected')
    expect(await tokenStore.getTokens(mailboxId)).toBeNull()
    expect(await watchStateStore.getCursor(mailboxId)).toBeNull()
    errorSpy.mockRestore()
  })

  it('BOTH revoke and stop() failing still deactivates locally (local state always wins)', async () => {
    const watchClient = fakeWatchClient({
      stop: async () => {
        throw new Error('users.stop failed')
      },
    })
    const { mailboxStore, tokenStore, watchStateStore, service } = await freshService({
      watchClient,
      revokeResponse: { status: 500, body: 'server error' },
    })
    const mailboxId = await connectedMailbox(
      mailboxStore,
      tokenStore,
      watchStateStore,
      'both-fail@example.test',
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await service.disconnect('both-fail@example.test')

    expect(result.revoked).toBe(false)
    expect(result.watchStopped).toBe(false)
    expect((await mailboxStore.getMailboxById(mailboxId))?.status).toBe('disconnected')
    expect(await tokenStore.getTokens(mailboxId)).toBeNull()
    errorSpy.mockRestore()
  })

  // --- non-active statuses: paused / needs_reconnect ----------------------

  it('disconnects a paused mailbox the same way as an active one', async () => {
    const { mailboxStore, tokenStore, watchStateStore, service } = await freshService()
    const mailboxId = await connectedMailbox(
      mailboxStore,
      tokenStore,
      watchStateStore,
      'paused@example.test',
      'paused',
    )

    const result = await service.disconnect('paused@example.test')

    expect(result.alreadyDisconnected).toBe(false)
    expect((await mailboxStore.getMailboxById(mailboxId))?.status).toBe('disconnected')
  })

  it('disconnects a needs_reconnect mailbox — a getAccessToken failure only fails the (best-effort) stop step', async () => {
    const getAccessToken = vi.fn(async () => {
      throw new Error('getAccessToken: refresh token invalid_grant')
    })
    const { mailboxStore, tokenStore, watchStateStore, service } = await freshService({
      tokenService: fakeTokenService({ getAccessToken }),
    })
    const mailboxId = await connectedMailbox(
      mailboxStore,
      tokenStore,
      watchStateStore,
      'needs-reconnect@example.test',
      'needs_reconnect',
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await service.disconnect('needs-reconnect@example.test')

    expect(result.watchStopped).toBe(false)
    expect(result.revoked).toBe(true) // revoke uses the stored refresh token directly, not getAccessToken
    expect((await mailboxStore.getMailboxById(mailboxId))?.status).toBe('disconnected')
    errorSpy.mockRestore()
  })

  // --- no stored tokens (edge case) ----------------------------------------

  it('a mailbox with no stored tokens: neither stop() nor revoke is attempted, still deactivates', async () => {
    const { mailboxStore, service, revokeCalls, createWatchClient } = await freshService()
    const mailbox = await mailboxStore.upsertConnectedMailbox({
      address: 'tokenless@example.test',
      provider: 'gmail',
    })

    const result = await service.disconnect('tokenless@example.test')

    expect(result.revoked).toBe(false)
    expect(result.watchStopped).toBe(false)
    expect(revokeCalls).toHaveLength(0)
    expect(createWatchClient).not.toHaveBeenCalled()
    expect((await mailboxStore.getMailboxById(mailbox.id))?.status).toBe('disconnected')
  })

  // --- never leaks the token -------------------------------------------------

  it('none of the console.error logs on a revoke/stop failure ever contain the stored refresh token — even when the revoke error body echoes it', async () => {
    const watchClient = fakeWatchClient({
      stop: async () => {
        throw new Error('stop failed')
      },
    })
    const { mailboxStore, tokenStore, watchStateStore, service } = await freshService({
      watchClient,
      // The revoke endpoint reflecting the submitted token in its error body
      // is exactly the leak vector the review flagged: without structural
      // redaction in revokeToken, this body would ride the thrown error into
      // the console.error below.
      revokeResponse: { status: 400, body: 'invalid token: stored-refresh-token' },
    })
    await connectedMailbox(mailboxStore, tokenStore, watchStateStore, 'leak-check@example.test')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await service.disconnect('leak-check@example.test')

    expect(errorSpy).toHaveBeenCalled()
    for (const call of errorSpy.mock.calls) {
      // Render each logged argument the way a real console would (Error
      // objects JSON.stringify to '{}', which would hide a leaking message
      // from this assertion).
      const rendered = call
        .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : JSON.stringify(arg)))
        .join(' ')
      expect(rendered).not.toContain('stored-refresh-token')
    }
    errorSpy.mockRestore()
  })
})

describe('GmailDisconnectError', () => {
  it('carries its code and a safe message', () => {
    const err = new GmailDisconnectError('not_found', 'No mailbox is connected at x@example.test.')
    expect(err.code).toBe('not_found')
    expect(err.message).toBe('No mailbox is connected at x@example.test.')
    expect(err).toBeInstanceOf(Error)
  })
})
