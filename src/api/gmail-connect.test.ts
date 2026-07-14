/**
 * `handleGmailConnect`/`handleGmailConnectCallback` against a FAKE
 * `GmailConnectService` — no real OAuth, no real DB. Exercises the
 * handler-level contract: JSON vs HTML response shapes, status-code
 * mapping for each `GmailConnectError` code vs an unexpected throw, the
 * missing-`code`/`state` 400, and that nothing secret is ever rendered.
 * Wiring-level concerns (the pre-auth carve-out ordering, `deps.gmailConnect`
 * absence, Bearer gating on the connect POST) live in `src/api/index.test.ts`
 * — this file does not re-derive those, mirroring the
 * `gmail-webhook.ts`/`gmail-webhook.test.ts` vs `index.test.ts` split.
 */

import { describe, expect, it, vi } from 'vitest'
import { GmailConnectError, type GmailConnectService } from '../mail/gmail-connect.js'
import { handleGmailConnect, handleGmailConnectCallback } from './gmail-connect.js'

const CALLBACK_URL = 'https://desk.example.test/api/v1/inbound/gmail/callback'
const CONNECT_URL = 'https://desk.example.test/api/v1/inbound/gmail/connect'

function fakeService(overrides: Partial<GmailConnectService> = {}): GmailConnectService {
  return {
    beginConnect:
      overrides.beginConnect ??
      (() => ({ consentUrl: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1' })),
    completeConnect:
      overrides.completeConnect ??
      (async () => ({
        mailboxId: '11111111-1111-4111-8111-111111111111',
        address: 'mailbox@example.test',
      })),
  }
}

describe('handleGmailConnect', () => {
  it('200s with the consentUrl JSON envelope', async () => {
    const service = fakeService({
      beginConnect: () => ({
        consentUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
      }),
    })
    const res = await handleGmailConnect(new Request(CONNECT_URL, { method: 'POST' }), { service })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({
      consentUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=abc',
    })
  })

  it('calls beginConnect exactly once per request', async () => {
    const beginConnect = vi.fn(() => ({ consentUrl: 'https://accounts.google.com/x' }))
    const service = fakeService({ beginConnect })

    await handleGmailConnect(new Request(CONNECT_URL, { method: 'POST' }), { service })

    expect(beginConnect).toHaveBeenCalledTimes(1)
  })

  it('500s with the standard JSON error envelope when beginConnect throws unexpectedly', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = fakeService({
      beginConnect: () => {
        throw new Error('keyring misconfigured — must never leak to the client')
      },
    })

    const res = await handleGmailConnect(new Request(CONNECT_URL, { method: 'POST' }), { service })

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: { code: 'server_error', message: expect.any(String) } })
    expect(JSON.stringify(body)).not.toContain('keyring misconfigured')
    errorSpy.mockRestore()
  })
})

describe('handleGmailConnectCallback', () => {
  function callbackRequest(query: string): Request {
    return new Request(`${CALLBACK_URL}${query}`)
  }

  it('200s with an HTML success page confirming the connected address', async () => {
    const service = fakeService({
      completeConnect: async () => ({ mailboxId: 'mb-1', address: 'connected@example.test' }),
    })
    const res = await handleGmailConnectCallback(callbackRequest('?code=abc&state=xyz'), {
      service,
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('connected@example.test')
    expect(html).toContain('<html')
  })

  it('passes code and state through to completeConnect verbatim', async () => {
    const completeConnect = vi.fn(async () => ({ mailboxId: 'mb-1', address: 'x@example.test' }))
    const service = fakeService({ completeConnect })

    await handleGmailConnectCallback(callbackRequest('?code=the-code&state=the-state'), { service })

    expect(completeConnect).toHaveBeenCalledWith({ code: 'the-code', state: 'the-state' })
  })

  it('400s when code is missing, without calling the service', async () => {
    const completeConnect = vi.fn()
    const service = fakeService({ completeConnect: completeConnect as never })

    const res = await handleGmailConnectCallback(callbackRequest('?state=xyz'), { service })

    expect(res.status).toBe(400)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(completeConnect).not.toHaveBeenCalled()
  })

  it('400s when state is missing, without calling the service', async () => {
    const completeConnect = vi.fn()
    const service = fakeService({ completeConnect: completeConnect as never })

    const res = await handleGmailConnectCallback(callbackRequest('?code=abc'), { service })

    expect(res.status).toBe(400)
    expect(completeConnect).not.toHaveBeenCalled()
  })

  it('400s when both code and state are missing', async () => {
    const service = fakeService()
    const res = await handleGmailConnectCallback(callbackRequest(''), { service })
    expect(res.status).toBe(400)
  })

  it('400s when code/state are present but empty strings', async () => {
    const service = fakeService()
    const res = await handleGmailConnectCallback(callbackRequest('?code=&state='), { service })
    expect(res.status).toBe(400)
  })

  it.each([
    ['invalid_state' as const],
    ['exchange_failed' as const],
    ['no_refresh_token' as const],
    ['watch_failed' as const],
  ])('maps a caught GmailConnectError(%s) to a 400 HTML page with its message', async (code) => {
    const service = fakeService({
      completeConnect: async () => {
        throw new GmailConnectError(code, `safe message for ${code}`)
      },
    })

    const res = await handleGmailConnectCallback(callbackRequest('?code=abc&state=xyz'), {
      service,
    })

    expect(res.status).toBe(400)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    const html = await res.text()
    expect(html).toContain(`safe message for ${code}`)
  })

  it('500s with a generic HTML page for an unexpected (non-GmailConnectError) throw, leaking nothing of the original error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const service = fakeService({
      completeConnect: async () => {
        throw new Error('db connection refused — must never reach the browser')
      },
    })

    const res = await handleGmailConnectCallback(callbackRequest('?code=abc&state=xyz'), {
      service,
    })

    expect(res.status).toBe(500)
    const html = await res.text()
    expect(html).not.toContain('db connection refused')
    errorSpy.mockRestore()
  })

  it('never renders the code or state query values anywhere in the response body', async () => {
    const service = fakeService({
      completeConnect: async () => {
        throw new GmailConnectError('invalid_state', 'This connect link is invalid or has expired.')
      },
    })

    const res = await handleGmailConnectCallback(
      callbackRequest('?code=super-secret-auth-code&state=super-secret-state-value'),
      { service },
    )

    const html = await res.text()
    expect(html).not.toContain('super-secret-auth-code')
    expect(html).not.toContain('super-secret-state-value')
  })

  it('HTML-escapes a GmailConnectError message before rendering it (defense in depth against markup in an upstream error)', async () => {
    const service = fakeService({
      completeConnect: async () => {
        throw new GmailConnectError(
          'watch_failed',
          'Enabling Gmail push failed: <script>evil()</script>',
        )
      },
    })

    const res = await handleGmailConnectCallback(callbackRequest('?code=abc&state=xyz'), {
      service,
    })

    const html = await res.text()
    expect(html).not.toContain('<script>evil()</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('HTML-escapes the connected address before rendering it on success', async () => {
    const service = fakeService({
      completeConnect: async () => ({
        mailboxId: 'mb-1',
        address: '<script>evil()</script>@example.test',
      }),
    })

    const res = await handleGmailConnectCallback(callbackRequest('?code=abc&state=xyz'), {
      service,
    })

    const html = await res.text()
    expect(html).not.toContain('<script>evil()</script>')
  })
})
