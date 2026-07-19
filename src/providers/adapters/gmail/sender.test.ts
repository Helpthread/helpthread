/**
 * `createGmailEmailSender` against a FAKE `fetchImpl` — no real network
 * call, no real Google credentials. Exercises the HTTP-transport contract:
 * correct endpoint/method/headers/body, the raw MIME (with its verbatim
 * `Message-ID`) reaching the request body, success/failure translation, and
 * that the access token is fetched per send and never leaked in errors.
 */

import { describe, expect, it, vi } from 'vitest'
import type { OutboundEmail } from '../../email-sender.js'
import { createGmailEmailSender } from './sender.js'

const email: OutboundEmail = {
  messageId: '<ht.k1.c1.t1.deadbeefsig@mail.example.test>',
  from: 'support@example.test',
  to: ['customer@example.test'],
  subject: 'Re: Help with my order',
  text: 'body text',
}

interface RecordedCall {
  url: string
  init: RequestInit
}

/** A fake `fetch` that records every call and always resolves with `status`/`body`. */
function fakeFetch(status: number, body: unknown) {
  const calls: RecordedCall[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('createGmailEmailSender', () => {
  it('passes an abort signal to fetch and rejects when the call outlives timeoutMs', async () => {
    // A fetch that never resolves on its own — it settles ONLY via the abort
    // signal, exactly like a stalled Gmail API/intermediary would.
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          expect(signal).toBeDefined()
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    ) as unknown as typeof fetch
    const sender = createGmailEmailSender({
      getAccessToken: async () => 'token',
      fetchImpl,
      timeoutMs: 20,
    })

    await expect(sender.send(email)).rejects.toThrow(/timeout|timed out|aborted/i)
  })

  it('declares maxSendMs equal to the timeout it actually enforces (default and custom)', () => {
    // `maxSendMs` is what the engine's retry paths assert against the
    // delivery lease (see EmailSender.maxSendMs's doc) — it must be the SAME
    // number as the AbortSignal.timeout bound, or the assertion checks a
    // fiction. The abort test above proves timeoutMs is really enforced;
    // this pins the declaration to it.
    const { fetchImpl } = fakeFetch(200, { id: 'gmail-123' })
    const getAccessToken = async () => 'token'

    const defaulted = createGmailEmailSender({ getAccessToken, fetchImpl })
    expect(defaulted.maxSendMs).toBe(30_000)

    const custom = createGmailEmailSender({ getAccessToken, fetchImpl, timeoutMs: 5_000 })
    expect(custom.maxSendMs).toBe(5_000)
  })

  it('happy path: POSTs the encoded raw MIME to the send endpoint and returns providerMessageId', async () => {
    const { fetchImpl, calls } = fakeFetch(200, { id: 'gmail-123' })
    const getAccessToken = vi.fn(async () => 'token-abc-123')
    const sender = createGmailEmailSender({ getAccessToken, fetchImpl })

    const result = await sender.send(email)

    expect(result).toEqual({ providerMessageId: 'gmail-123' })
    expect(calls).toHaveLength(1)

    const { url, init } = calls[0]
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    expect(init.method).toBe('POST')

    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer token-abc-123')
    expect(headers.get('Content-Type')).toBe('application/json')

    const parsedBody = JSON.parse(String(init.body)) as { raw: string }
    const decodedRaw = Buffer.from(parsedBody.raw, 'base64url').toString('utf8')
    expect(decodedRaw).toContain(`Message-ID: ${email.messageId}`)
  })

  it('uses the given userId in the endpoint URL instead of the default "me"', async () => {
    const { fetchImpl, calls } = fakeFetch(200, { id: 'gmail-456' })
    const sender = createGmailEmailSender({
      getAccessToken: async () => 'token',
      fetchImpl,
      userId: 'mailbox@example.test',
    })

    await sender.send(email)

    expect(calls[0].url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/mailbox%40example.test/messages/send',
    )
  })

  it('calls getAccessToken for every send (so a refreshed token is used each time)', async () => {
    const { fetchImpl } = fakeFetch(200, { id: 'gmail-1' })
    let n = 0
    const getAccessToken = vi.fn(async () => `token-${++n}`)
    const sender = createGmailEmailSender({ getAccessToken, fetchImpl })

    await sender.send(email)
    await sender.send(email)

    expect(getAccessToken).toHaveBeenCalledTimes(2)
  })

  it.each([401, 500])(
    'throws on a non-2xx (%d) response, and never leaks the access token in the error',
    async (status) => {
      const { fetchImpl } = fakeFetch(status, { error: { message: 'nope, rejected' } })
      const secretToken = 'super-secret-access-token-do-not-leak'
      const getAccessToken = vi.fn(async () => secretToken)
      const sender = createGmailEmailSender({ getAccessToken, fetchImpl })

      let caught: unknown
      try {
        await sender.send(email)
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain(String(status))
      expect(String(caught)).not.toContain(secretToken)
    },
  )

  it('a rejection is a real thrown Error, never mistaken for a resolved send', async () => {
    const { fetchImpl } = fakeFetch(500, {})
    const sender = createGmailEmailSender({ getAccessToken: async () => 'token', fetchImpl })

    await expect(sender.send(email)).rejects.toThrow(/500/)
  })

  it('throws with just the status when the error response body is empty', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 503 }),
    ) as unknown as typeof fetch
    const sender = createGmailEmailSender({ getAccessToken: async () => 'token', fetchImpl })

    await expect(sender.send(email)).rejects.toThrow(/503/)
  })

  it('redacts a reply-token echoed in the error body (never leaks the threading token to logs)', async () => {
    // A bad-request body (from Gmail or an intermediary) that echoes our raw
    // MIME would carry the outbound Message-ID token. It must not reach the
    // thrown error / logs.
    const echoed = `Bad request for message with Message-ID ${email.messageId}`
    const fetchImpl = vi.fn(
      async () => new Response(echoed, { status: 400 }),
    ) as unknown as typeof fetch
    const sender = createGmailEmailSender({ getAccessToken: async () => 'token', fetchImpl })

    const err = await sender.send(email).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).not.toBeNull()
    const message = String(err)
    expect(message).not.toContain(email.messageId)
    expect(message).toContain('<ht.REDACTED>')
  })

  it('redacts an echoed base64url raw body (the token is decodable inside it)', async () => {
    // A bad-request body that echoes our base64url-encoded `raw` request carries
    // the token INSIDE the base64 blob, past the literal-token redaction. The
    // long-base64url-run redaction must catch it.
    // A real echoed `raw` is the whole base64url MIME (thousands of chars); pad
    // so the run exceeds the redaction threshold, as it would in practice.
    const rawEcho = Buffer.from(
      `From: support@example.test\r\nMessage-ID: ${email.messageId}\r\n\r\n${'body '.repeat(40)}`,
      'utf8',
    ).toString('base64url')
    const fetchImpl = vi.fn(
      async () => new Response(`Rejected raw=${rawEcho}`, { status: 400 }),
    ) as unknown as typeof fetch
    const sender = createGmailEmailSender({ getAccessToken: async () => 'token', fetchImpl })

    const err = await sender.send(email).then(
      () => null,
      (e: unknown) => e as Error,
    )
    const message = String(err)
    // Neither the token nor the base64url blob that decodes to it survives.
    expect(message).not.toContain(email.messageId)
    expect(message).not.toContain(rawEcho)
    expect(message).toContain('[REDACTED-BASE64]')
  })
})
