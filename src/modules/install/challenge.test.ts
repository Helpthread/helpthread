import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signWebhookPayload } from '../../webhooks/delivery.js'
import {
  CHALLENGE_EVENT_TYPE,
  generateChallengeNonce,
  type SendChallengeFn,
  verifyEndpointPossession,
} from './challenge.js'

const SECRET = 'a-secret-only-the-module-and-engine-know'

function correctSend(secret: string): SendChallengeFn {
  return async (_url, body) => {
    const { nonce } = JSON.parse(body) as { nonce: string }
    const signature = createHmac('sha256', secret).update(nonce).digest('hex')
    return { status: 200, body: JSON.stringify({ signature }) }
  }
}

describe('verifyEndpointPossession', () => {
  it('succeeds when the response carries the correct HMAC over the nonce', async () => {
    const result = await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send: correctSend(SECRET), nonce: 'fixed-nonce-for-test' },
    )
    expect(result).toEqual({ ok: true })
  })

  it('sends the SAME envelope/signature scheme real deliveries use', async () => {
    let capturedBody = ''
    let capturedHeaders: Record<string, string> = {}
    const send: SendChallengeFn = async (_url, body, headers) => {
      capturedBody = body
      capturedHeaders = headers
      const { nonce } = JSON.parse(body) as { nonce: string }
      const signature = createHmac('sha256', SECRET).update(nonce).digest('hex')
      return { status: 200, body: JSON.stringify({ signature }) }
    }

    await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send, nonce: 'fixed-nonce' },
    )

    expect(JSON.parse(capturedBody)).toEqual({ nonce: 'fixed-nonce' })
    expect(capturedHeaders['X-Helpthread-Event']).toBe(CHALLENGE_EVENT_TYPE)
    expect(capturedHeaders['X-Helpthread-Delivery']).toBeTruthy()
    expect(capturedHeaders['X-Helpthread-Signature']).toBeTruthy()

    // The signature is exactly what `../../webhooks/delivery.ts` would
    // compute for the same body/secret at the same timestamp — reusing
    // the scheme, not inventing a new one.
    const [, tsPart] = capturedHeaders['X-Helpthread-Signature'].split('t=')
    const timestamp = Number(tsPart.split(',')[0])
    expect(capturedHeaders['X-Helpthread-Signature']).toBe(
      signWebhookPayload(SECRET, capturedBody, timestamp),
    )
  })

  it('fails with signature-mismatch when the response HMAC is wrong', async () => {
    const send: SendChallengeFn = async () => ({
      status: 200,
      body: JSON.stringify({ signature: 'not-the-right-signature' }),
    })
    const result = await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send, nonce: 'n' },
    )
    expect(result).toEqual({
      ok: false,
      reason: 'signature-mismatch',
      message: expect.stringContaining('does not match'),
    })
  })

  it('fails with signature-mismatch when signed under the WRONG secret', async () => {
    const result = await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send: correctSend('a-different-secret-entirely'), nonce: 'n' },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('signature-mismatch')
  })

  it('fails with http-error on a non-2xx response', async () => {
    const send: SendChallengeFn = async () => ({ status: 500, body: '' })
    const result = await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send, nonce: 'n' },
    )
    expect(result).toEqual({
      ok: false,
      reason: 'http-error',
      message: expect.stringContaining('HTTP 500'),
    })
  })

  it('fails with invalid-response on a non-JSON body', async () => {
    const send: SendChallengeFn = async () => ({ status: 200, body: 'not json' })
    const result = await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send, nonce: 'n' },
    )
    expect(result).toEqual({ ok: false, reason: 'invalid-response', message: expect.any(String) })
  })

  it('fails with invalid-response when the signature field is missing', async () => {
    const send: SendChallengeFn = async () => ({ status: 200, body: JSON.stringify({}) })
    const result = await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send, nonce: 'n' },
    )
    expect(result).toEqual({
      ok: false,
      reason: 'invalid-response',
      message: expect.stringContaining('signature'),
    })
  })

  it('fails with network-error when the transport throws', async () => {
    const send: SendChallengeFn = async () => {
      throw new Error('connection refused')
    }
    const result = await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send, nonce: 'n' },
    )
    expect(result).toEqual({ ok: false, reason: 'network-error', message: 'connection refused' })
  })

  it('generates a fresh nonce per call when none is supplied', async () => {
    const seen: string[] = []
    const send: SendChallengeFn = async (_url, body) => {
      const { nonce } = JSON.parse(body) as { nonce: string }
      seen.push(nonce)
      const signature = createHmac('sha256', SECRET).update(nonce).digest('hex')
      return { status: 200, body: JSON.stringify({ signature }) }
    }
    await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send },
    )
    await verifyEndpointPossession(
      { challengeUrl: 'https://module.example.test/webhook', secret: SECRET },
      { send },
    )
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })
})

describe('generateChallengeNonce', () => {
  it('produces distinct, non-empty hex strings', () => {
    const a = generateChallengeNonce()
    const b = generateChallengeNonce()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]+$/)
    expect(a.length).toBeGreaterThan(32)
  })
})
