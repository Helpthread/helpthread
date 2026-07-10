import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from './cursor.js'

const UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a cursor position', () => {
    const original = { updatedAt: new Date('2026-03-14T12:00:00.000Z'), id: UUID }
    const encoded = encodeCursor(original)
    const decoded = decodeCursor(encoded)
    expect(decoded).not.toBeNull()
    expect(decoded?.id).toBe(original.id)
    expect(decoded?.updatedAt.toISOString()).toBe(original.updatedAt.toISOString())
  })

  it('is opaque base64url — not plain JSON text', () => {
    const encoded = encodeCursor({ updatedAt: new Date(), id: UUID })
    expect(encoded).not.toContain('{')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
  })

  it('rejects a structurally-valid cursor whose id is not a UUID (would throw at the uuid column)', () => {
    // Regression: a forged cursor with a non-UUID id decodes cleanly but would
    // make Postgres throw `invalid input syntax for type uuid` — so it must be
    // rejected here (→ becomes a clean 400), not passed to the store.
    const nonUuidId = Buffer.from(
      JSON.stringify({ u: '2026-01-01T00:00:00.000Z', i: 'not-a-uuid' }),
      'utf8',
    ).toString('base64url')
    expect(decodeCursor(nonUuidId)).toBeNull()
  })

  it('decodeCursor never throws and returns null for garbage input', () => {
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor('not-valid-base64url!!!')).toBeNull()
    expect(decodeCursor('%%%')).toBeNull()
    expect(() => decodeCursor('☃'.repeat(20))).not.toThrow()
  })

  it('decodeCursor rejects well-formed base64url that decodes to the wrong JSON shape', () => {
    const wrongShape = Buffer.from(JSON.stringify({ notACursor: true }), 'utf8').toString(
      'base64url',
    )
    expect(decodeCursor(wrongShape)).toBeNull()

    const missingId = Buffer.from(JSON.stringify({ u: new Date().toISOString() }), 'utf8').toString(
      'base64url',
    )
    expect(decodeCursor(missingId)).toBeNull()

    const badDate = Buffer.from(JSON.stringify({ u: 'not-a-date', i: 'conv-1' }), 'utf8').toString(
      'base64url',
    )
    expect(decodeCursor(badDate)).toBeNull()
  })

  it('decodeCursor rejects a JSON array or primitive (valid JSON, wrong top-level shape)', () => {
    expect(decodeCursor(Buffer.from('[]', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('"hello"', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('null', 'utf8').toString('base64url'))).toBeNull()
  })
})
