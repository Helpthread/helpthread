/**
 * Safe extraction of a module release's `.tar.gz` artifact (HT-116).
 *
 * ## Threat model
 *
 * A module tarball is a proprietary paid artifact whose *contents* this
 * repo never controls — only its manifest signature is verified before
 * extraction (`./manifest.ts`). A signed-but-malicious or simply corrupt
 * tarball can still try to write outside the target directory (path
 * traversal via `..`, an absolute path, or a symlink planted first and
 * walked through second), exhaust disk via a decompression bomb, or
 * overwrite files the operator did not expect via a duplicate entry. This
 * module refuses all of that, with a precise, named error per refusal
 * kind — "refused: symlink entry" is actionable; "extraction failed" is
 * not.
 *
 * ## No third-party tar dependency
 *
 * This package (`src/modules/artifact`) is the shared verifier the engine
 * itself will import (HT-119) — CLAUDE.md's "no new runtime dependencies
 * in the engine core" rule means it cannot pull in the `tar` npm package.
 * Only the USTAR format (POSIX.1-1988) is implemented — the subset every
 * modern archiver (GNU tar, BSD tar, Vercel's build output tooling) writes
 * for archives without exotic content. PAX extended headers (typeflag `x`/
 * `g`, used for e.g. paths over 100 bytes or high-resolution mtimes) are
 * refused outright rather than partially honored — an unparsed PAX record
 * silently ignored is exactly the kind of gap a crafted archive would
 * exploit to smuggle a path past the checks below.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'

/** Thrown for every refusal below — always carries a precise, specific reason. */
export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeArchiveError'
  }
}

// --- caps -------------------------------------------------------------------
// A module tarball is a UI + a small serverless bundle (Vercel Build Output
// API v3 under `.vercel/output/`), not a general-purpose payload — these
// caps are generous for that shape while still bounding a decompression
// bomb or a runaway entry count to something that fails fast instead of
// exhausting disk or memory.

/** Total uncompressed bytes across every entry's DATA (file contents only, not tar headers/padding). 512 MiB comfortably covers a serverless bundle plus static assets with headroom, while still refusing a bomb that expands orders of magnitude past a plausible module. */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
/**
 * Ceiling on the raw decompressed TAR byte stream handed to `gunzipSync`,
 * kept as its own constant rather than reusing {@link MAX_TOTAL_UNCOMPRESSED_BYTES}
 * directly. The two caps measure different things: this one bounds the
 * full stream — every 512-byte USTAR header plus padding, for every entry,
 * on top of file data — while the total-uncompressed cap bounds only file
 * *content* bytes, checked entry-by-entry below. Sharing one constant
 * between them means an archive with many small files could be refused for
 * exceeding a "content" cap it never actually reached, purely because
 * header/padding overhead pushed the raw stream over it — a spurious
 * refusal with a misleading "decompresses to more than" message. The
 * 32 MiB of headroom comfortably covers header overhead even at
 * {@link MAX_ENTRY_COUNT} entries (20,000 × up to 1,023 bytes of
 * header+padding ≈ 20 MiB) while remaining a hard, bounded ceiling — not a
 * loophole for a decompression bomb.
 */
export const MAX_GUNZIP_OUTPUT_BYTES = MAX_TOTAL_UNCOMPRESSED_BYTES + 32 * 1024 * 1024
/** Total number of entries (files + directories). 20,000 covers even a `node_modules`-heavy bundle; archives with more are refused rather than iterated indefinitely. */
export const MAX_ENTRY_COUNT = 20_000
/** Bytes for any single file. 128 MiB — larger than any plausible individual asset in a serverless module bundle. */
export const MAX_SINGLE_FILE_BYTES = 128 * 1024 * 1024
/** Characters in any entry path (the USTAR `prefix`+`name` joined). POSIX `PATH_MAX` is commonly 4096; this matches that ceiling rather than inventing a stricter one. */
export const MAX_PATH_LENGTH = 4096

const BLOCK_SIZE = 512

type TarTypeflag =
  | '0' // regular file (also '\0', the pre-POSIX default)
  | '1' // hard link
  | '2' // symlink
  | '3' // character device
  | '4' // block device
  | '5' // directory
  | '6' // FIFO
  | '7' // contiguous file (treated as regular)
  | 'g' // PAX global extended header
  | 'x' // PAX per-entry extended header

interface TarEntry {
  name: string
  size: number
  typeflag: TarTypeflag
}

function readOctalField(block: Buffer, offset: number, length: number): number {
  const raw = block.subarray(offset, offset + length)
  // Fields are ASCII octal, NUL- or space-terminated/padded.
  const text = raw.toString('latin1').replace(/\0/g, ' ').trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) {
    throw new UnsafeArchiveError(`tar entry has a malformed numeric header field: '${text}'`)
  }
  return value
}

function readStringField(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const nul = raw.indexOf(0)
  return (nul === -1 ? raw : raw.subarray(0, nul)).toString('utf8')
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

/** Parse a USTAR byte stream into `{ entry, data }` pairs. Throws {@link UnsafeArchiveError} on anything not plain USTAR (bad magic, PAX headers, unsupported typeflags handled by the caller). */
function* readTarEntries(tar: Buffer): Generator<{ entry: TarEntry; data: Buffer }> {
  let offset = 0
  while (offset + BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) {
      // A zero block marks end-of-archive (conventionally followed by a
      // second zero block); nothing after it is trusted.
      return
    }

    const magic = header.subarray(257, 263).toString('latin1')
    if (magic !== 'ustar\0' && magic !== 'ustar ') {
      throw new UnsafeArchiveError(
        `not a USTAR tar archive (unrecognized magic at offset ${offset})`,
      )
    }

    const name = readStringField(header, 0, 100)
    const prefix = readStringField(header, 345, 155)
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name
    const size = readOctalField(header, 124, 12)
    const typeflagRaw = header.subarray(156, 157).toString('latin1')
    const typeflag = (typeflagRaw === '\0' ? '0' : typeflagRaw) as TarTypeflag

    offset += BLOCK_SIZE

    const dataBlocks = Math.ceil(size / BLOCK_SIZE)
    const dataEnd = offset + dataBlocks * BLOCK_SIZE
    if (dataEnd > tar.length) {
      throw new UnsafeArchiveError(
        `tar entry '${fullName}' declares more data than the archive contains`,
      )
    }
    const data = tar.subarray(offset, offset + size)
    offset = dataEnd

    yield { entry: { name: fullName, size, typeflag }, data }
  }
}

/** The size/count ceilings {@link safeExtract} enforces, injectable so tests can exercise a refusal without actually allocating hundreds of MiB. Production callers never pass this — the exported `MAX_*` constants above are the real, compiled-in defaults. */
export interface ExtractCaps {
  maxGunzipOutputBytes: number
  maxTotalUncompressedBytes: number
  maxEntryCount: number
  maxSingleFileBytes: number
  maxPathLength: number
}

const DEFAULT_CAPS: ExtractCaps = {
  maxGunzipOutputBytes: MAX_GUNZIP_OUTPUT_BYTES,
  maxTotalUncompressedBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
  maxEntryCount: MAX_ENTRY_COUNT,
  maxSingleFileBytes: MAX_SINGLE_FILE_BYTES,
  maxPathLength: MAX_PATH_LENGTH,
}

/**
 * Extract a `.tar.gz` module release into `destDir`. Rejects, each with a
 * distinct message: absolute paths, `..` traversal, non-normalized paths,
 * symlinks, hardlinks, devices/FIFOs, PAX extended headers, duplicate
 * entries, and any entry that would resolve outside `destDir`. Enforces
 * the caps above (or `caps`, when a caller supplies smaller ones — see
 * {@link ExtractCaps}). `destDir` must already exist and be empty (a
 * non-empty destination could mean a partially-extracted or hostile
 * pre-seeded directory — the caller decides whether to create/clear it
 * first, this function never does).
 */
export async function safeExtract(
  tarballBytes: Buffer,
  destDir: string,
  caps: ExtractCaps = DEFAULT_CAPS,
): Promise<string[]> {
  // `lstat`, not `stat`: a symlinked destination passes an `isDirectory()`
  // check while every containment check below reasons about the LINK's
  // path, so writes land wherever the link points — outside the boundary
  // this function exists to enforce. Refusing the link outright is the
  // cheap, complete answer; a caller wanting to extract into a symlinked
  // location can resolve it themselves and pass the real path, which makes
  // the containment checks true again.
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(destDir)
  } catch {
    throw new UnsafeArchiveError(`extraction target does not exist: ${destDir}`)
  }
  if (stat.isSymbolicLink()) {
    throw new UnsafeArchiveError(
      `extraction target is a symlink, which would place files outside it: ${destDir}`,
    )
  }
  if (!stat.isDirectory()) {
    throw new UnsafeArchiveError(`extraction target is not a directory: ${destDir}`)
  }
  if (fs.readdirSync(destDir).length > 0) {
    throw new UnsafeArchiveError(`extraction target is not empty: ${destDir}`)
  }

  let tar: Buffer
  try {
    // `maxOutputLength` makes zlib itself refuse past the cap instead of
    // allocating first and letting us check afterwards. Without it a small,
    // highly-compressible archive — a few KB of zeros expands to gigabytes —
    // exhausts memory during decompression, i.e. BEFORE any size check
    // could run. A cap that is only enforced after allocation is not a cap.
    tar = gunzipSync(tarballBytes, { maxOutputLength: caps.maxGunzipOutputBytes })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // zlib signals the cap as a buffer-size error; say what actually happened.
    if (/maxOutputLength|buffer/i.test(message)) {
      throw new UnsafeArchiveError(
        `refusing the archive: it decompresses to more than ${caps.maxGunzipOutputBytes} bytes`,
      )
    }
    throw new UnsafeArchiveError(`not a valid gzip stream: ${message}`)
  }

  const resolvedDest = path.resolve(destDir)
  const seenNames = new Set<string>()
  const written: string[] = []
  let totalBytes = 0
  let entryCount = 0
  // Entries are validated in full before anything is written, so a
  // refusal partway through the archive never leaves a partially-written
  // tree behind.
  const toWrite: { fullPath: string; data: Buffer }[] = []

  for (const { entry, data } of readTarEntries(tar)) {
    entryCount += 1
    if (entryCount > caps.maxEntryCount) {
      throw new UnsafeArchiveError(
        `archive exceeds the maximum entry count (${caps.maxEntryCount})`,
      )
    }

    const { name, size, typeflag } = entry

    if (name.length === 0) {
      throw new UnsafeArchiveError('archive contains an entry with an empty path')
    }
    if (name.length > caps.maxPathLength) {
      throw new UnsafeArchiveError(
        `archive entry path exceeds ${caps.maxPathLength} characters: '${name.slice(0, 80)}...'`,
      )
    }
    if (typeflag === 'g' || typeflag === 'x') {
      throw new UnsafeArchiveError(
        `archive uses an unsupported PAX extended header (entry '${name}')`,
      )
    }
    if (typeflag === '2') {
      throw new UnsafeArchiveError(`archive contains a symlink entry, refused: '${name}'`)
    }
    if (typeflag === '1') {
      throw new UnsafeArchiveError(`archive contains a hard link entry, refused: '${name}'`)
    }
    if (typeflag === '3' || typeflag === '4' || typeflag === '6') {
      throw new UnsafeArchiveError(`archive contains a device/FIFO entry, refused: '${name}'`)
    }
    if (typeflag !== '0' && typeflag !== '5' && typeflag !== '7') {
      throw new UnsafeArchiveError(
        `archive contains an unsupported entry type ('${typeflag}') for '${name}'`,
      )
    }

    // Directory entries carry no useful bytes and are not extracted as
    // files, but their path still needs every safety check above/below —
    // a directory entry is just as capable of encoding `../../etc` as a
    // file entry is.
    const isDirectory = typeflag === '5'

    if (path.isAbsolute(name) || name.startsWith('/')) {
      throw new UnsafeArchiveError(`archive contains an absolute path, refused: '${name}'`)
    }
    const segments = name.split('/')
    if (segments.some((s) => s === '..')) {
      throw new UnsafeArchiveError(`archive contains a path-traversal entry, refused: '${name}'`)
    }
    const nameNoTrailingSlash = name.replace(/\/+$/, '')
    const normalizedNoTrailingSlash = path.normalize(name).replace(/\/+$/, '')
    if (nameNoTrailingSlash !== normalizedNoTrailingSlash) {
      throw new UnsafeArchiveError(`archive contains a non-normalized path, refused: '${name}'`)
    }

    const resolved = path.resolve(resolvedDest, name)
    if (resolved !== resolvedDest && !resolved.startsWith(resolvedDest + path.sep)) {
      throw new UnsafeArchiveError(
        `archive entry resolves outside the extraction target, refused: '${name}'`,
      )
    }

    const dedupeKey = name.replace(/\/+$/, '')
    if (seenNames.has(dedupeKey)) {
      throw new UnsafeArchiveError(`archive contains a duplicate entry, refused: '${name}'`)
    }
    seenNames.add(dedupeKey)

    if (isDirectory) continue

    if (size > caps.maxSingleFileBytes) {
      throw new UnsafeArchiveError(
        `archive entry '${name}' (${size} bytes) exceeds the maximum single-file size (${caps.maxSingleFileBytes})`,
      )
    }
    totalBytes += size
    if (totalBytes > caps.maxTotalUncompressedBytes) {
      throw new UnsafeArchiveError(
        `archive exceeds the maximum total uncompressed size (${caps.maxTotalUncompressedBytes})`,
      )
    }

    toWrite.push({ fullPath: resolved, data })
  }

  for (const { fullPath, data } of toWrite) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, data)
    written.push(fullPath)
  }

  return written
}

/** SHA-256 of `bytes`, lowercase hex — the exact hash form {@link import('./manifest.js').ManifestV1.artifactSha256} uses. */
export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
