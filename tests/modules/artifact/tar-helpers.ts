/**
 * Minimal in-test USTAR tarball builder for `extract.test.ts` — deliberately
 * independent of `safeExtract`'s own parser, so the tests exercise a real
 * byte-level archive rather than round-tripping through the code under
 * test. Only what the refusal tests need: regular files, directories,
 * symlinks, hardlinks, a device entry, and controllable raw header bytes
 * for the "field says one thing, entry contains another" cases.
 */
import { gzipSync } from 'node:zlib'

const BLOCK_SIZE = 512

export type BuilderTypeflag = '0' | '1' | '2' | '3' | '5' | '6' | 'x' | 'g'

export interface BuilderEntry {
  name: string
  typeflag: BuilderTypeflag
  content?: Buffer
  /** Overrides the header's size field independent of `content.length`, for "declares more data than present" style tests. */
  sizeOverride?: number
  linkname?: string
}

function padBlock(buf: Buffer): Buffer {
  const remainder = buf.length % BLOCK_SIZE
  if (remainder === 0) return buf
  return Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - remainder)])
}

function writeOctalField(block: Buffer, offset: number, length: number, value: number): void {
  const octal = value.toString(8).padStart(length - 1, '0')
  block.write(octal, offset, length - 1, 'ascii')
  block[offset + length - 1] = 0
}

function writeStringField(block: Buffer, offset: number, length: number, value: string): void {
  block.write(value, offset, length, 'utf8')
}

function buildHeader(entry: BuilderEntry): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE)
  writeStringField(header, 0, 100, entry.name)
  writeOctalField(header, 100, 8, 0o644) // mode
  writeOctalField(header, 108, 8, 0) // uid
  writeOctalField(header, 116, 8, 0) // gid
  const size = entry.sizeOverride ?? entry.content?.length ?? 0
  writeOctalField(header, 124, 12, size)
  writeOctalField(header, 136, 12, 0) // mtime
  header.write('        ', 148, 8, 'ascii') // checksum placeholder (spaces)
  header[156] = entry.typeflag.charCodeAt(0)
  if (entry.linkname) writeStringField(header, 157, 100, entry.linkname)
  writeStringField(header, 257, 6, 'ustar\0')
  header.write('00', 263, 2, 'ascii') // ustar version

  let checksum = 0
  for (let i = 0; i < BLOCK_SIZE; i++) checksum += header[i]
  writeOctalField(header, 148, 8, checksum)
  header[148 + 6] = 0 // octal field null terminator per spec (space then NUL, but a lone NUL is accepted)
  header[148 + 7] = 0x20

  return header
}

/** Build a raw (uncompressed) USTAR byte stream from `entries`, terminated by two zero blocks. */
export function buildTar(entries: BuilderEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    parts.push(buildHeader(entry))
    if (entry.content && entry.content.length > 0) {
      parts.push(padBlock(entry.content))
    }
  }
  parts.push(Buffer.alloc(BLOCK_SIZE * 2))
  return Buffer.concat(parts)
}

/** Build and gzip a USTAR archive — what `safeExtract` actually accepts. */
export function buildTarGz(entries: BuilderEntry[]): Buffer {
  return gzipSync(buildTar(entries))
}

export function regularFile(name: string, content: string): BuilderEntry {
  return { name, typeflag: '0', content: Buffer.from(content, 'utf8') }
}
