import { describe, expect, it } from 'vitest'
import { resolveWebAuthnRp } from './webauthn-rp.js'

describe('resolveWebAuthnRp', () => {
  it('resolves a normal https origin to its hostname', () => {
    expect(resolveWebAuthnRp('https://inbox.resonantiq.app')).toEqual({
      rpId: 'inbox.resonantiq.app',
      expectedOrigin: 'https://inbox.resonantiq.app',
    })
  })

  it('accepts localhost (a valid domain-form hostname) for dev', () => {
    expect(resolveWebAuthnRp('http://localhost:3000')).toEqual({
      rpId: 'localhost',
      expectedOrigin: 'http://localhost:3000',
    })
  })

  it('rejects an IPv4 loopback literal even though config.ts accepts it as a UI base URL generally', () => {
    expect(() => resolveWebAuthnRp('http://127.0.0.1:3000')).toThrow(/domain name/)
  })

  it('rejects a bracketed IPv6 loopback literal', () => {
    expect(() => resolveWebAuthnRp('http://[::1]:3000')).toThrow(/domain name/)
  })

  it('rejects a non-loopback IPv4 literal too (not just loopback)', () => {
    expect(() => resolveWebAuthnRp('https://93.184.216.34')).toThrow(/domain name/)
  })

  it('rejects a malformed URL', () => {
    expect(() => resolveWebAuthnRp('not a url')).toThrow()
  })

  it('preserves the exact origin verbatim, including a non-default port', () => {
    const resolved = resolveWebAuthnRp('https://inbox.example.test:8443')
    expect(resolved.expectedOrigin).toBe('https://inbox.example.test:8443')
    expect(resolved.rpId).toBe('inbox.example.test')
  })
})
