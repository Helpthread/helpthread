import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ENTRY_COUNT,
  MAX_SINGLE_FILE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  safeExtract,
  sha256Hex,
  UnsafeArchiveError,
} from '../../../src/modules/artifact/extract.js'
import { buildTar, buildTarGz, regularFile } from './tar-helpers.js'

let destDir: string

beforeEach(() => {
  destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ht116-extract-'))
})

afterEach(() => {
  fs.rmSync(destDir, { recursive: true, force: true })
})

describe('safeExtract: destination preconditions', () => {
  it('refuses a destination that does not exist', async () => {
    await expect(safeExtract(buildTarGz([]), path.join(destDir, 'missing'))).rejects.toThrow(
      /does not exist/,
    )
  })

  it('refuses a non-empty destination', async () => {
    fs.writeFileSync(path.join(destDir, 'already-here.txt'), 'x')
    await expect(safeExtract(buildTarGz([regularFile('a.txt', 'hi')]), destDir)).rejects.toThrow(
      /not empty/,
    )
  })
})

describe('safeExtract: malformed input', () => {
  it('refuses bytes that are not a valid gzip stream', async () => {
    await expect(safeExtract(Buffer.from('not gzip at all'), destDir)).rejects.toThrow(
      /not a valid gzip stream/,
    )
  })

  it('refuses a gzip stream that does not decompress to USTAR (bad magic)', async () => {
    const garbage = gzipSync(Buffer.alloc(512, 0x41)) // 512 bytes of 'A', not a zero block, no ustar magic
    await expect(safeExtract(garbage, destDir)).rejects.toThrow(/USTAR/)
  })

  it('refuses an entry that declares more data than the archive contains', async () => {
    const tar = buildTar([
      { name: 'a.txt', typeflag: '0', content: Buffer.alloc(0), sizeOverride: 999_999 },
    ])
    await expect(safeExtract(gzipSync(tar), destDir)).rejects.toThrow(UnsafeArchiveError)
  })
})

describe('safeExtract: path safety refusals', () => {
  it('refuses path traversal via a ".." segment', async () => {
    const tar = buildTarGz([regularFile('../escape.txt', 'evil')])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/path-traversal/)
  })

  it('refuses an absolute path', async () => {
    const tar = buildTarGz([regularFile('/etc/passwd', 'evil')])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/absolute path/)
  })

  it('refuses a non-normalized path (double slash)', async () => {
    const tar = buildTarGz([regularFile('foo//bar.txt', 'x')])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/non-normalized path/)
  })

  it('refuses an entry with an empty path', async () => {
    const tar = buildTarGz([regularFile('', 'x')])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/empty path/)
  })

  it('refuses a duplicate entry', async () => {
    const tar = buildTarGz([regularFile('a.txt', 'one'), regularFile('a.txt', 'two')])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/duplicate entry/)
  })
})

describe('safeExtract: forbidden entry types', () => {
  it('refuses a symlink entry', async () => {
    const tar = buildTarGz([{ name: 'link', typeflag: '2', linkname: '/etc/passwd' }])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/symlink entry/)
  })

  it('refuses a hard link entry', async () => {
    const tar = buildTarGz([{ name: 'hardlink', typeflag: '1', linkname: 'a.txt' }])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/hard link entry/)
  })

  it('refuses a device entry', async () => {
    const tar = buildTarGz([{ name: 'dev', typeflag: '3' }])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/device\/FIFO entry/)
  })

  it('refuses a FIFO entry', async () => {
    const tar = buildTarGz([{ name: 'fifo', typeflag: '6' }])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/device\/FIFO entry/)
  })

  it('refuses a PAX per-entry extended header', async () => {
    const tar = buildTarGz([{ name: 'pax', typeflag: 'x', content: Buffer.from('x') }])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/PAX extended header/)
  })

  it('refuses a PAX global extended header', async () => {
    const tar = buildTarGz([{ name: 'pax-global', typeflag: 'g', content: Buffer.from('x') }])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/PAX extended header/)
  })
})

describe('safeExtract: caps', () => {
  it('refuses an archive exceeding the maximum entry count', async () => {
    const entries = Array.from({ length: MAX_ENTRY_COUNT + 1 }, (_, i) => ({
      name: `d${i}/`,
      typeflag: '5' as const,
    }))
    const tar = buildTarGz(entries)
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/maximum entry count/)
  }, 30_000)

  it('refuses a single file exceeding the maximum single-file size', async () => {
    const oversized = Buffer.alloc(MAX_SINGLE_FILE_BYTES + 1)
    const tar = buildTarGz([{ name: 'huge.bin', typeflag: '0', content: oversized }])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/maximum single-file size/)
  }, 60_000)

  it('refuses an archive exceeding the maximum total uncompressed size', async () => {
    // Four files right at the single-file cap (536,870,912 bytes total,
    // exactly MAX_TOTAL_UNCOMPRESSED_BYTES — not yet over), plus one more
    // byte to push the running total over the top. Zero-filled buffers so
    // gzip does this in well under a second despite the raw size.
    const entries = [
      { name: 'f0.bin', typeflag: '0' as const, content: Buffer.alloc(MAX_SINGLE_FILE_BYTES) },
      { name: 'f1.bin', typeflag: '0' as const, content: Buffer.alloc(MAX_SINGLE_FILE_BYTES) },
      { name: 'f2.bin', typeflag: '0' as const, content: Buffer.alloc(MAX_SINGLE_FILE_BYTES) },
      { name: 'f3.bin', typeflag: '0' as const, content: Buffer.alloc(MAX_SINGLE_FILE_BYTES) },
      { name: 'f4.bin', typeflag: '0' as const, content: Buffer.alloc(1) },
    ]
    expect(entries.slice(0, 4).reduce((sum, e) => sum + e.content.length, 0)).toBe(
      MAX_TOTAL_UNCOMPRESSED_BYTES,
    )
    const tar = buildTarGz(entries)
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/maximum total uncompressed size/)
  }, 60_000)
})

describe('safeExtract: happy path (control case proving the refusals above are real refusals, not a broken extractor)', () => {
  it('extracts a well-formed archive and returns the written paths', async () => {
    const tar = buildTarGz([
      { name: 'dir/', typeflag: '5' },
      regularFile('dir/hello.txt', 'hello world'),
      regularFile('top.txt', 'top level'),
    ])
    const written = await safeExtract(tar, destDir)
    expect(written.sort()).toEqual(
      [path.join(destDir, 'dir', 'hello.txt'), path.join(destDir, 'top.txt')].sort(),
    )
    expect(fs.readFileSync(path.join(destDir, 'dir', 'hello.txt'), 'utf8')).toBe('hello world')
    expect(fs.readFileSync(path.join(destDir, 'top.txt'), 'utf8')).toBe('top level')
  })
})

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex', () => {
    expect(sha256Hex(Buffer.from(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })
})
