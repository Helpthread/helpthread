import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeEncryptionKey, decrypt, ENCRYPTION_KEY_BYTES, encrypt } from './token-crypto.js'

const KEY = randomBytes(ENCRYPTION_KEY_BYTES)
const OTHER_KEY = randomBytes(ENCRYPTION_KEY_BYTES)

describe('encrypt / decrypt round-trip', () => {
  it('decrypts exactly what was encrypted', () => {
    const plaintext = 'a-refresh-token-value-1234567890'
    const ciphertext = encrypt(plaintext, KEY)
    expect(decrypt(ciphertext, KEY)).toBe(plaintext)
  })

  it('round-trips an empty string', () => {
    const ciphertext = encrypt('', KEY)
    expect(decrypt(ciphertext, KEY)).toBe('')
  })

  it('round-trips non-ASCII text', () => {
    const plaintext = 'token-with-unicode-☃-emoji-🔑-and-ünïcödé'
    const ciphertext = encrypt(plaintext, KEY)
    expect(decrypt(ciphertext, KEY)).toBe(plaintext)
  })

  it('round-trips a long value', () => {
    const plaintext = 'x'.repeat(5000)
    const ciphertext = encrypt(plaintext, KEY)
    expect(decrypt(ciphertext, KEY)).toBe(plaintext)
  })

  it('output layout is iv(12) || authTag(16) || ciphertext(N), and length grows with plaintext', () => {
    const short = encrypt('a', KEY)
    const longer = encrypt('a'.repeat(10), KEY)
    expect(short.length).toBe(12 + 16 + 1)
    expect(longer.length).toBe(12 + 16 + 10)
  })
})

describe('random IV per encryption', () => {
  it('encrypting the same plaintext twice produces different bytes each time', () => {
    const a = encrypt('same-value', KEY)
    const b = encrypt('same-value', KEY)
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false)
    // ...but both still decrypt back to the original value.
    expect(decrypt(a, KEY)).toBe('same-value')
    expect(decrypt(b, KEY)).toBe('same-value')
  })

  it('the first 12 bytes (the IV) differ across calls', () => {
    const a = encrypt('value', KEY)
    const b = encrypt('value', KEY)
    expect(Buffer.from(a.slice(0, 12)).equals(Buffer.from(b.slice(0, 12)))).toBe(false)
  })
})

describe('tamper detection', () => {
  function tamperedCopy(bytes: Uint8Array, index: number): Uint8Array {
    const copy = Buffer.from(bytes)
    copy[index] = copy[index] ^ 0xff
    return new Uint8Array(copy)
  }

  it('flipping a ciphertext byte makes decrypt throw', () => {
    const ciphertext = encrypt('sensitive-value', KEY)
    const tampered = tamperedCopy(ciphertext, ciphertext.length - 1)
    expect(() => decrypt(tampered, KEY)).toThrow(/decrypt failed/)
  })

  it('flipping an auth-tag byte makes decrypt throw', () => {
    const ciphertext = encrypt('sensitive-value', KEY)
    // Auth tag occupies bytes [12, 28).
    const tampered = tamperedCopy(ciphertext, 20)
    expect(() => decrypt(tampered, KEY)).toThrow(/decrypt failed/)
  })

  it('flipping an IV byte makes decrypt throw (or at least never returns the original plaintext)', () => {
    const plaintext = 'sensitive-value'
    const ciphertext = encrypt(plaintext, KEY)
    const tampered = tamperedCopy(ciphertext, 0)
    // A corrupted IV changes the keystream, which almost always also fails
    // the auth-tag check (the tag is computed over the real IV) — but the
    // strong, always-true property is simply "never yields the original
    // plaintext silently."
    let decrypted: string | undefined
    try {
      decrypted = decrypt(tampered, KEY)
    } catch {
      // Expected: throwing is correct behavior.
    }
    expect(decrypted).not.toBe(plaintext)
  })

  it('decrypting with the wrong key throws', () => {
    const ciphertext = encrypt('sensitive-value', KEY)
    expect(() => decrypt(ciphertext, OTHER_KEY)).toThrow(/decrypt failed/)
  })

  it('a truncated ciphertext (too short for iv+tag) throws a clear error', () => {
    const tooShort = new Uint8Array(10)
    expect(() => decrypt(tooShort, KEY)).toThrow(/too short/)
  })

  it('an empty byte array throws a clear error', () => {
    expect(() => decrypt(new Uint8Array(0), KEY)).toThrow(/too short/)
  })
})

describe('key validation', () => {
  it('encrypt rejects a key that is not 32 bytes', () => {
    expect(() => encrypt('value', randomBytes(16))).toThrow(/32-byte/)
    expect(() => encrypt('value', randomBytes(33))).toThrow(/32-byte/)
  })

  it('decrypt rejects a key that is not 32 bytes', () => {
    const ciphertext = encrypt('value', KEY)
    expect(() => decrypt(ciphertext, randomBytes(16))).toThrow(/32-byte/)
  })

  it('never includes the plaintext, key, or ciphertext bytes in a thrown error message', () => {
    const secretPlaintext = 'super-secret-refresh-token-do-not-leak'
    const ciphertext = encrypt(secretPlaintext, KEY)
    const tampered = (() => {
      const copy = Buffer.from(ciphertext)
      copy[copy.length - 1] ^= 0xff
      return new Uint8Array(copy)
    })()

    let message = ''
    try {
      decrypt(tampered, KEY)
    } catch (err) {
      message = String(err)
    }
    expect(message).not.toContain(secretPlaintext)
    expect(message).not.toContain(KEY.toString('base64'))
    expect(message).not.toContain(Buffer.from(tampered).toString('base64'))
  })
})

describe('decodeEncryptionKey', () => {
  it('decodes a valid base64-encoded 32-byte key', () => {
    const raw = randomBytes(ENCRYPTION_KEY_BYTES)
    const decoded = decodeEncryptionKey(raw.toString('base64'))
    expect(decoded.equals(raw)).toBe(true)
  })

  it('a decoded key round-trips through encrypt/decrypt', () => {
    const raw = randomBytes(ENCRYPTION_KEY_BYTES)
    const key = decodeEncryptionKey(raw.toString('base64'))
    const ciphertext = encrypt('value', key)
    expect(decrypt(ciphertext, key)).toBe('value')
  })

  it('throws on a key that decodes to the wrong length', () => {
    expect(() => decodeEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/expected 32/)
    expect(() => decodeEncryptionKey(randomBytes(64).toString('base64'))).toThrow(/expected 32/)
  })

  it('throws on an empty string', () => {
    expect(() => decodeEncryptionKey('')).toThrow(/expected 32/)
  })
})
