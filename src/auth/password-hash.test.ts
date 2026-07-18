import { describe, expect, it } from 'vitest'
import { DUMMY_HASH, hashPassword, verifyPassword } from './password-hash.js'

describe('hashPassword / verifyPassword', () => {
  it('round-trips: the correct password verifies', () => {
    const encoded = hashPassword('correct horse battery staple')
    expect(verifyPassword('correct horse battery staple', encoded)).toBe(true)
  })

  it('rejects the wrong password', () => {
    const encoded = hashPassword('correct horse battery staple')
    expect(verifyPassword('wrong password', encoded)).toBe(false)
  })

  it('is encoded as scrypt$N=16384,r=8,p=1$<salt>$<hash> — four $-separated segments', () => {
    const encoded = hashPassword('hunter2')
    const segments = encoded.split('$')
    expect(segments).toHaveLength(4)
    expect(segments[0]).toBe('scrypt')
    expect(segments[1]).toBe('N=16384,r=8,p=1')
    expect(segments[2].length).toBeGreaterThan(0)
    expect(segments[3].length).toBeGreaterThan(0)
  })

  it('two hashes of the SAME password never match byte-for-byte (random salt per call)', () => {
    const a = hashPassword('same password')
    const b = hashPassword('same password')
    expect(a).not.toBe(b)
    expect(verifyPassword('same password', a)).toBe(true)
    expect(verifyPassword('same password', b)).toBe(true)
  })

  it('verifyPassword is TOTAL over a malformed encoded value — never throws, always false', () => {
    const malformed = [
      '',
      'not-our-format',
      'scrypt$onlytwo$segments',
      'scrypt$N=16384,r=8,p=1$$', // empty salt and hash
      'scrypt$N=16384,r=8,p=1$onlysalt$',
      'bcrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA', // wrong prefix
      'scrypt$bogus-params$c2FsdA$aGFzaA',
      'scrypt$N=0,r=8,p=1$c2FsdA$aGFzaA', // N must be positive
      'scrypt$N=16384,r=8,p=1$not!!valid!!base64url$aGFzaA',
      // Decode-time cost ceilings: a syntactically valid tuple must not be
      // able to buy unbounded scrypt work (attacker/corruption-controlled
      // stored value) — capped params or oversized digests fail fast.
      'scrypt$N=2097152,r=8,p=1$c2FsdA$aGFzaA', // N over the 2^20 ceiling
      'scrypt$N=16384,r=64,p=1$c2FsdA$aGFzaA', // r over ceiling
      'scrypt$N=16384,r=8,p=32$c2FsdA$aGFzaA', // p over ceiling
      `scrypt$N=16384,r=8,p=1$c2FsdA$${Buffer.alloc(256).toString('base64url')}`, // hash over 128 bytes
      `scrypt$N=16384,r=8,p=1$${Buffer.alloc(96).toString('base64url')}$aGFzaA`, // salt over 64 bytes
    ]
    for (const value of malformed) {
      expect(() => verifyPassword('anything', value)).not.toThrow()
      expect(verifyPassword('anything', value)).toBe(false)
    }
  })

  it('DUMMY_HASH is a real, verifiable hash — used for timing-comparable rejection of unknown emails', () => {
    expect(DUMMY_HASH.split('$')).toHaveLength(4)
    expect(DUMMY_HASH.startsWith('scrypt$')).toBe(true)
    // Nobody knows the random string it was hashed from — verifying any
    // guess against it must fail, exercising the SAME scrypt cost as a real
    // verification (that's the whole point: comparable timing).
    expect(verifyPassword('whatever an attacker might guess', DUMMY_HASH)).toBe(false)
  })
})
