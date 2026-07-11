import { describe, expect, it } from 'vitest'
import { authenticateRequest } from './auth.js'

const TOKEN = 'a-service-token-that-is-reasonably-long'

function requestWithAuth(headerValue?: string): Request {
  const headers: Record<string, string> = {}
  if (headerValue !== undefined) {
    headers.Authorization = headerValue
  }
  return new Request('https://x.example.test/api/v1/conversations', { headers })
}

describe('authenticateRequest', () => {
  it('returns true for the correct Bearer token', () => {
    expect(authenticateRequest(requestWithAuth(`Bearer ${TOKEN}`), TOKEN)).toBe(true)
  })

  it('returns false when the Authorization header is missing', () => {
    expect(authenticateRequest(requestWithAuth(), TOKEN)).toBe(false)
  })

  it('returns false for a non-Bearer scheme', () => {
    expect(authenticateRequest(requestWithAuth(`Basic ${TOKEN}`), TOKEN)).toBe(false)
  })

  it('returns false for a wrong token of the SAME length as the real one', () => {
    const wrongSameLength = TOKEN.slice(0, -1) + (TOKEN.at(-1) === 'x' ? 'y' : 'x')
    expect(wrongSameLength).toHaveLength(TOKEN.length)
    expect(authenticateRequest(requestWithAuth(`Bearer ${wrongSameLength}`), TOKEN)).toBe(false)
  })

  it('returns false for a wrong token of a DIFFERENT length than the real one', () => {
    expect(authenticateRequest(requestWithAuth('Bearer short'), TOKEN)).toBe(false)
    expect(authenticateRequest(requestWithAuth(`Bearer ${TOKEN}-and-then-some`), TOKEN)).toBe(false)
  })

  it('returns false for an empty Authorization header', () => {
    expect(authenticateRequest(requestWithAuth(''), TOKEN)).toBe(false)
  })

  it('returns false for "Bearer" with no token at all', () => {
    expect(authenticateRequest(requestWithAuth('Bearer'), TOKEN)).toBe(false)
    expect(authenticateRequest(requestWithAuth('Bearer '), TOKEN)).toBe(false)
  })

  it('never throws for hostile/malformed headers', () => {
    // Fetch's `Headers` only accepts values in the Latin-1 (ByteString)
    // range, so this uses garbage within that range (a `Headers`
    // constructed with e.g. a snowman would throw before
    // `authenticateRequest` ever ran) — the point of this test is
    // `authenticateRequest`'s own totality over whatever a `Headers` object
    // CAN legally carry, not re-testing the Fetch spec's header-value
    // restrictions.
    const highByteGarbage = String.fromCharCode(200).repeat(50)
    expect(() => authenticateRequest(requestWithAuth(highByteGarbage), TOKEN)).not.toThrow()
    expect(() =>
      authenticateRequest(requestWithAuth(`Bearer ${highByteGarbage}`), TOKEN),
    ).not.toThrow()
    expect(() => authenticateRequest(requestWithAuth('Bearer:::malformed:::'), TOKEN)).not.toThrow()
  })
})
