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

const WEB_SRC = fileURLToPath(new URL('../web/src', import.meta.url))
const MOUNT = 'engine/mount.ts'
/** The alias the mount uses, or any relative path that climbs out of `web/` into `dist/` or `src/`. */
const ENGINE_IMPORT = /from\s+['"](?:@helpthread\/engine|(?:\.\.\/)+(?:dist|src)\/)/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

describe('web → engine import boundary', () => {
  it('only engine/mount.ts imports the engine', () => {
    const offenders = sourceFiles(WEB_SRC)
      .map((path) => relative(WEB_SRC, path))
      .filter((path) => path !== MOUNT)
      .filter((path) => ENGINE_IMPORT.test(readFileSync(join(WEB_SRC, path), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the mount itself still exists and imports the engine', () => {
    expect(ENGINE_IMPORT.test(readFileSync(join(WEB_SRC, MOUNT), 'utf8'))).toBe(true)
  })
})
