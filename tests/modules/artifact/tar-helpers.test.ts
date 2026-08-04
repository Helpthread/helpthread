/**
 * Regression coverage for `./tar-helpers.ts`'s header checksum field —
 * every test in `extract.test.ts` depends on this builder producing a
 * header whose checksum a real tar reader accepts, so a bug here would
 * silently undermine what those tests actually prove.
 */
import { describe, expect, it } from 'vitest'
import { buildTar, regularFile } from './tar-helpers.js'

const BLOCK_SIZE = 512
/** USTAR's checksum field: 8 bytes at offset 148 — 6 octal digits, a NUL, then a space. */
const CHECKSUM_OFFSET = 148

describe('buildTar header checksum field', () => {
  it('writes exactly 6 octal digits followed by NUL then space, and the digits decode to the header sum computed with the checksum field blanked', () => {
    const tar = buildTar([regularFile('hello.txt', 'hello world')])
    const header = tar.subarray(0, BLOCK_SIZE)

    const checksumBytes = header.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + 8)
    const digits = checksumBytes.subarray(0, 6).toString('ascii')
    expect(digits).toMatch(/^[0-7]{6}$/)
    expect(checksumBytes[6]).toBe(0) // NUL
    expect(checksumBytes[7]).toBe(0x20) // space

    // Recompute the checksum the way a real tar reader does: sum every
    // byte with the checksum field itself treated as eight spaces.
    const blanked = Buffer.from(header)
    blanked.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + 8)
    let expected = 0
    for (const byte of blanked) expected += byte

    expect(Number.parseInt(digits, 8)).toBe(expected)
  })

  it('never truncates the least significant octal digit — a header whose true checksum has a non-zero units digit still decodes exactly', () => {
    // A name chosen so the header's byte sum ends in a non-zero octal
    // digit — the exact case a mishandled 7th-digit overwrite would
    // corrupt (see this builder's own doc comment).
    const tar = buildTar([regularFile('a.txt', 'x')])
    const header = tar.subarray(0, BLOCK_SIZE)
    const checksumBytes = header.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + 8)
    const digits = checksumBytes.subarray(0, 6).toString('ascii')

    const blanked = Buffer.from(header)
    blanked.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + 8)
    let expected = 0
    for (const byte of blanked) expected += byte

    // This assertion is the one a "drop the last digit" bug fails: it
    // compares the FULL decoded value, not just a prefix.
    expect(Number.parseInt(digits, 8)).toBe(expected)
  })
})
