import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_ENTRY_COUNT,
  MAX_GUNZIP_OUTPUT_BYTES,
  MAX_PATH_LENGTH,
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

  it('writes nothing when a LATER entry fails validation, even though earlier entries were individually valid', async () => {
    // The whole archive's entries must be validated before any file is
    // written — otherwise a refusal discovered partway through leaves a
    // half-extracted tree on disk: legitimate-looking files from earlier
    // entries, silently missing whatever came after the bad one.
    const tar = buildTarGz([
      regularFile('good1.txt', 'fine'),
      regularFile('good2.txt', 'also fine'),
      regularFile('../escape.txt', 'evil'),
    ])
    await expect(safeExtract(tar, destDir)).rejects.toThrow(/path-traversal/)
    expect(fs.readdirSync(destDir)).toEqual([])
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

  // The refusals below use small INJECTED caps (see ExtractCaps) rather
  // than the real, much larger compiled-in MAX_* constants. Exercising the
  // real 512 MiB cap would mean allocating hundreds of MiB in a unit test
  // just to prove a refusal message fires — expensive and slow for no
  // extra coverage, since the comparison logic being tested doesn't care
  // what the numbers are.
  const SMALL_CAPS = {
    maxGunzipOutputBytes: 8192,
    maxTotalUncompressedBytes: 2048,
    maxEntryCount: 1000,
    maxSingleFileBytes: 1024,
    maxPathLength: MAX_PATH_LENGTH,
  }

  it('refuses a single file exceeding the maximum single-file size', async () => {
    const oversized = Buffer.alloc(SMALL_CAPS.maxSingleFileBytes + 1)
    const tar = buildTarGz([{ name: 'huge.bin', typeflag: '0', content: oversized }])
    await expect(safeExtract(tar, destDir, SMALL_CAPS)).rejects.toThrow(/maximum single-file size/)
  })

  it('refuses an archive exceeding the maximum total uncompressed size', async () => {
    // Two files right at the single-file cap (not yet over the total), plus
    // a third tiny one to push the running total over the top.
    const entries = [
      {
        name: 'f0.bin',
        typeflag: '0' as const,
        content: Buffer.alloc(SMALL_CAPS.maxSingleFileBytes),
      },
      {
        name: 'f1.bin',
        typeflag: '0' as const,
        content: Buffer.alloc(SMALL_CAPS.maxSingleFileBytes),
      },
      { name: 'f2.bin', typeflag: '0' as const, content: Buffer.alloc(1) },
    ]
    expect(entries.slice(0, 2).reduce((sum, e) => sum + e.content.length, 0)).toBe(
      SMALL_CAPS.maxTotalUncompressedBytes,
    )
    const tar = buildTarGz(entries)
    await expect(safeExtract(tar, destDir, SMALL_CAPS)).rejects.toThrow(
      // The gzip-stream cap is deliberately larger than the total-content
      // cap to absorb tar header/padding overhead, so this
      // content-sized-exactly-over-the-cap archive decompresses fine and is
      // instead refused by the per-entry running-total check.
      /maximum total uncompressed size/,
    )
  })

  it('refuses DURING decompression when the raw stream itself exceeds the gzip-stream cap, before any per-entry size check runs', async () => {
    // Content alone (ignoring header overhead) already exceeds the
    // gzip-stream cap, so zlib's own `maxOutputLength` must refuse this
    // while decompressing — a cap enforced only after allocating the whole
    // thing is not a cap. Uses a fresh, still-tiny cap set so the
    // gzip-stream ceiling is the one actually hit, not the total-content one.
    const gunzipCaps = {
      ...SMALL_CAPS,
      maxGunzipOutputBytes: 512,
      maxTotalUncompressedBytes: 10 * 1024 * 1024, // generous, so this isn't what refuses
    }
    const oversized = Buffer.alloc(gunzipCaps.maxGunzipOutputBytes + 1024)
    const tar = buildTarGz([{ name: 'huge.bin', typeflag: '0', content: oversized }])
    await expect(safeExtract(tar, destDir, gunzipCaps)).rejects.toThrow(/decompresses to more than/)
  })

  it('the real compiled-in caps are consistent: the gzip-stream ceiling is larger than the total-content ceiling', () => {
    // This is the invariant the two-cap split exists to guarantee — if it
    // regresses, a legitimate many-small-files archive right at the
    // content cap would spuriously fail during decompression instead of
    // (correctly) not failing at all.
    expect(MAX_GUNZIP_OUTPUT_BYTES).toBeGreaterThan(MAX_TOTAL_UNCOMPRESSED_BYTES)
  })
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
