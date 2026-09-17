/**
 * The operator inbox is a client (CHARTER.md): it reaches the engine only over
 * HTTP through `web/src/lib/api.ts`. The one exception is the mount,
 * `web/src/engine/mount.ts`, which hands `/api/**` requests to the engine in
 * a single-project deployment. This test keeps that exception singular — any
 * other file under `web/src` importing the engine fails the suite.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WEB = fileURLToPath(new URL('../web', import.meta.url))
const MOUNT = 'src/engine/mount.ts'
/** Directories under `web/` that are not this package's own source. */
const SKIP = new Set(['node_modules', '.next', '.vercel'])
/**
 * Any mention of the alias the mount uses, or of a relative path that climbs
 * out of `web/` into `dist/` or `src/` — in any position, not only a
 * well-formed import, so quoting style, template literals, comments, and
 * `require()` cannot slip past. A tripwire for honest mistakes: a string
 * assembled at runtime would not match, and nothing here needs to be that
 * clever.
 */
const ENGINE_REF = /@helpthread\/engine|(?:\.\.\/)+(?:dist|src)\//

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : []
  })
}

describe('web → engine import boundary', () => {
  it('only src/engine/mount.ts refers to the engine', () => {
    const offenders = sourceFiles(WEB)
      .map((path) => relative(WEB, path))
      .filter((path) => path !== MOUNT)
      .filter((path) => ENGINE_REF.test(readFileSync(join(WEB, path), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the mount itself still exists and imports the engine', () => {
    expect(ENGINE_REF.test(readFileSync(join(WEB, MOUNT), 'utf8'))).toBe(true)
  })

  it('tsconfig has no other alias that could reach the engine', () => {
    const tsconfig = JSON.parse(readFileSync(join(WEB, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> }
    }
    expect(Object.keys(tsconfig.compilerOptions.paths).sort()).toEqual([
      '@/*',
      '@helpthread/engine',
    ])
  })
})
