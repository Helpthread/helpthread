/**
 * `handleGmailDisconnect` against a FAKE `GmailDisconnectService` — no real
 * OAuth, no real DB. Exercises the handler-level contract: body validation
 * (missing/invalid JSON, missing/empty `address`), the JSON response shape
 * on success, status-code mapping for `GmailDisconnectError` vs an
 * unexpected throw. Wiring-level concerns (Bearer gating, `deps.
 * gmailDisconnect` absence) live in `src/api/index.test.ts` — this file
 * does not re-derive those, mirroring `gmail-connect.ts`/
 * `gmail-connect.test.ts`'s own split.
 */

import { describe, expect, it, vi } from 'vitest'
import { GmailDisconnectError, type GmailDisconnectService } from '../mail/gmail-disconnect.js'
import { handleGmailDisconnect } from './gmail-disconnect.js'

const DISCONNECT_URL = 'https://desk.example.test/api/v1/inbound/gmail/disconnect'

function fakeService(overrides: Partial<GmailDisconnectService> = {}): GmailDisconnectService {
  return {
    disconnect:
      overrides.disconnect ??
      (async (address: string) => ({
        mailboxId: '11111111-1111-4111-8111-111111111111',
        address,
        alreadyDisconnected: false,
        revoked: true,
        watchStopped: true,
      })),
  }
}

function disconnectRequest(body: unknown): Request {
  return new Request(DISCONNECT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('handleGmailDisconnect', () => {
  it('200s with the disconnect result JSON envelope', async () => {
    const service = fakeService({
      disconnect: async (address) => ({
        mailboxId: 'mb-1',
        address,
        alreadyDisconnected: false,
        revoked: true,
        watchStopped: true,
      }),
    })

    const res = await handleGmailDisconnect(
      disconnectRequest({ address: 'mailbox@example.test' }),
      { service },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({
      mailboxId: 'mb-1',
      address: 'mailbox@example.test',
      alreadyDisconnected: false,
      revoked: true,
      watchStopped: true,
    })
  })

  it('200s with alreadyDisconnected: true and revoked/watchStopped: false on an idempotent no-op', async () => {
    const service = fakeService({
      disconnect: async (address) => ({
        mailboxId: 'mb-1',
        address,
        alreadyDisconnected: true,
        revoked: false,
        watchStopped: false,
      }),
    })

    const res = await handleGmailDisconnect(
      disconnectRequest({ address: 'already-gone@example.test' }),
      { service },
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { alreadyDisconnected: boolean }
    expect(body.alreadyDisconnected).toBe(true)
  })

  it('passes address through to disconnect verbatim', async () => {
    const disconnect = vi.fn(async (address: string) => ({
      mailboxId: 'mb-1',
      address,
      alreadyDisconnected: false,
      revoked: true,
      watchStopped: true,
    }))
    const service = fakeService({ disconnect })

    await handleGmailDisconnect(disconnectRequest({ address: 'exact@example.test' }), { service })

    expect(disconnect).toHaveBeenCalledWith('exact@example.test')
  })

  // --- body validation -----------------------------------------------------

  it('400s validation_failed on a non-JSON body, without calling the service', async () => {
    const disconnect = vi.fn()
    const service = fakeService({ disconnect: disconnect as never })

    const res = await handleGmailDisconnect(disconnectRequest('not json'), { service })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { code: 'validation_failed', message: expect.any(String) },
    })
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('400s validation_failed when address is missing, without calling the service', async () => {
    const disconnect = vi.fn()
    const service = fakeService({ disconnect: disconnect as never })

    const res = await handleGmailDisconnect(disconnectRequest({}), { service })

    expect(res.status).toBe(400)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('400s validation_failed when address is an empty string', async () => {
    const disconnect = vi.fn()
    const service = fakeService({ disconnect: disconnect as never })

    const res = await handleGmailDisconnect(disconnectRequest({ address: '' }), { service })

    expect(res.status).toBe(400)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('400s validation_failed when address is not a string', async () => {
    const disconnect = vi.fn()
    const service = fakeService({ disconnect: disconnect as never })

    const res = await handleGmailDisconnect(disconnectRequest({ address: 42 }), { service })

    expect(res.status).toBe(400)
    expect(disconnect).not.toHaveBeenCalled()
  })

  // --- error mapping ---------------------------------------------------------

  it('maps a caught GmailDisconnectError(not_found) to a 404 with its message', async () => {
    const service = fakeService({
      disconnect: async () => {
        throw new GmailDisconnectError('not_found', 'No mailbox is connected at x@example.test.')
      },
    })

    const res = await handleGmailDisconnect(disconnectRequest({ address: 'x@example.test' }), {
      service,
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'No mailbox is connected at x@example.test.' },
    })
  })

  it('500s with the standard JSON error envelope for an unexpected (non-GmailDisconnectError) throw, leaking nothing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = fakeService({
      disconnect: async () => {
        throw new Error('db connection refused — must never leak to the client')
      },
    })

    const res = await handleGmailDisconnect(disconnectRequest({ address: 'x@example.test' }), {
      service,
    })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: { code: 'server_error', message: expect.any(String) } })
    expect(JSON.stringify(body)).not.toContain('db connection refused')
    errorSpy.mockRestore()
  })
})
