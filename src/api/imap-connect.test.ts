/**
 * `handleImapConnect`/`handleImapCheck` against a FAKE `ImapConnectService`
 * — no real network, no real DB. Exercises the handler-level contract: body
 * validation, `ImapConnectError` → 422 mapping, an unexpected throw → 500,
 * and that the password is never echoed back in any response.
 */

import { describe, expect, it, vi } from 'vitest'
import { ImapConnectError, type ImapConnectService } from '../mail/imap-connect.js'
import { handleImapCheck, handleImapConnect } from './imap-connect.js'

const CONNECT_URL = 'https://desk.example.test/api/v1/inbound/imap/connect'
const CHECK_URL = 'https://desk.example.test/api/v1/inbound/imap/check'

const VALID_BODY = {
  address: 'support@example.test',
  imapHost: 'imap.example.test',
  imapPort: 993,
  smtpHost: 'smtp.example.test',
  smtpPort: 465,
  username: 'support@example.test',
  password: 'super-secret-app-password',
}

function fakeService(overrides: Partial<ImapConnectService> = {}): ImapConnectService {
  return {
    connect:
      overrides.connect ??
      (async () => ({
        id: '11111111-1111-4111-8111-111111111111',
        address: VALID_BODY.address,
        provider: 'imap',
        status: 'active',
      })),
    checkConnection:
      overrides.checkConnection ?? (async () => ({ imap: { ok: true }, smtp: { ok: true } })),
  }
}

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('handleImapConnect', () => {
  it('200s with the persisted mailbox on success', async () => {
    const service = fakeService()
    const res = await handleImapConnect(postJson(CONNECT_URL, VALID_BODY), { service })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      address: VALID_BODY.address,
      provider: 'imap',
      status: 'active',
    })
  })

  it('passes the validated input through to connect() verbatim, including a supplied secure flag', async () => {
    const connect = vi.fn(async () => ({
      id: 'mb-1',
      address: VALID_BODY.address,
      provider: 'imap',
      status: 'active' as const,
    }))
    const service = fakeService({ connect })

    await handleImapConnect(postJson(CONNECT_URL, { ...VALID_BODY, secure: false }), { service })

    expect(connect).toHaveBeenCalledWith({ ...VALID_BODY, secure: false })
  })

  it('never echoes the password in the success response body', async () => {
    const service = fakeService()
    const res = await handleImapConnect(postJson(CONNECT_URL, VALID_BODY), { service })
    const text = await res.text()
    expect(text).not.toContain(VALID_BODY.password)
  })

  it('400s on a non-JSON body, without calling the service', async () => {
    const connect = vi.fn()
    const service = fakeService({ connect: connect as never })
    const res = await handleImapConnect(
      new Request(CONNECT_URL, { method: 'POST', body: 'not json' }),
      { service },
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('validation_failed')
    expect(connect).not.toHaveBeenCalled()
  })

  it.each([
    ['address', { ...VALID_BODY, address: '' }],
    ['imapHost', { ...VALID_BODY, imapHost: '' }],
    ['imapPort', { ...VALID_BODY, imapPort: 0 }],
    ['imapPort (too large)', { ...VALID_BODY, imapPort: 70000 }],
    ['imapPort (non-integer)', { ...VALID_BODY, imapPort: 993.5 }],
    ['smtpHost', { ...VALID_BODY, smtpHost: '' }],
    ['smtpPort', { ...VALID_BODY, smtpPort: -1 }],
    ['username', { ...VALID_BODY, username: '' }],
    ['password', { ...VALID_BODY, password: '' }],
    ['secure (wrong type)', { ...VALID_BODY, secure: 'yes' }],
  ])('400s when %s is invalid, without calling the service', async (_label, body) => {
    const connect = vi.fn()
    const service = fakeService({ connect: connect as never })
    const res = await handleImapConnect(postJson(CONNECT_URL, body), { service })

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('validation_failed')
    expect(connect).not.toHaveBeenCalled()
  })

  it('400s when a required field is missing entirely', async () => {
    const { password: _password, ...withoutPassword } = VALID_BODY
    const service = fakeService()
    const res = await handleImapConnect(postJson(CONNECT_URL, withoutPassword), { service })
    expect(res.status).toBe(400)
  })

  it.each([['imap_failed' as const], ['smtp_failed' as const]])(
    'maps a caught ImapConnectError(%s) to a 422 with the error code and message',
    async (code) => {
      const service = fakeService({
        connect: async () => {
          throw new ImapConnectError(code, `safe message for ${code}`)
        },
      })

      const res = await handleImapConnect(postJson(CONNECT_URL, VALID_BODY), { service })

      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body).toEqual({ error: { code, message: `safe message for ${code}` } })
    },
  )

  it('500s with the standard envelope for an unexpected (non-ImapConnectError) throw, leaking nothing of the original error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = fakeService({
      connect: async () => {
        throw new Error('db connection refused — must never leak to the client')
      },
    })

    const res = await handleImapConnect(postJson(CONNECT_URL, VALID_BODY), { service })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: { code: 'server_error', message: expect.any(String) } })
    expect(JSON.stringify(body)).not.toContain('db connection refused')
    errorSpy.mockRestore()
  })
})

describe('handleImapCheck', () => {
  it('200s with the per-leg result, persisting nothing (the service, not this handler, enforces that)', async () => {
    const checkConnection = vi.fn(async () => ({
      imap: { ok: false as const, error: 'ECONNREFUSED' },
      smtp: { ok: true as const },
    }))
    const service = fakeService({ checkConnection })

    const res = await handleImapCheck(postJson(CHECK_URL, VALID_BODY), { service })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      imap: { ok: false, error: 'ECONNREFUSED' },
      smtp: { ok: true },
    })
  })

  it('never echoes the password in the response body', async () => {
    const service = fakeService()
    const res = await handleImapCheck(postJson(CHECK_URL, VALID_BODY), { service })
    const text = await res.text()
    expect(text).not.toContain(VALID_BODY.password)
  })

  it('400s on an invalid body, without calling the service', async () => {
    const checkConnection = vi.fn()
    const service = fakeService({ checkConnection: checkConnection as never })
    const res = await handleImapCheck(postJson(CHECK_URL, { ...VALID_BODY, imapPort: 0 }), {
      service,
    })

    expect(res.status).toBe(400)
    expect(checkConnection).not.toHaveBeenCalled()
  })

  it('500s with the standard envelope for an unexpected throw', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = fakeService({
      checkConnection: async () => {
        throw new Error('unexpected failure — must never leak')
      },
    })

    const res = await handleImapCheck(postJson(CHECK_URL, VALID_BODY), { service })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('unexpected failure')
    errorSpy.mockRestore()
  })
})
