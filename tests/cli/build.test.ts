import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { TRUST_STORE } from '../../cli/src/trust-store.js'

const execFileAsync = promisify(execFile)

// HT-121: `cli/` is meant to be publishable on its own — a package
// containing only `cli/**` must install and run with no repo-relative
// imports and no dev tooling (`tsx`, TypeScript) at runtime. These tests
// exercise the two mechanisms that make that true (the esbuild bundle, and
// the `files` allowlist) so a regression here — a stale `dist/`, a new
// source file the build doesn't pick up, an accidental widening of `files`
// — fails a fast unit test instead of only surfacing when someone next
// tries to actually publish.
//
// This is a REPO-LEVEL regression guard, not a substitute for packing and
// installing the tarball in a real isolated directory outside the
// monorepo, which is what actually proves publishability (see HT-121's
// verification notes).

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const cliDir = path.join(repoRoot, 'cli')
const distEntry = path.join(cliDir, 'dist', 'main.js')

describe('cli bundle (HT-121)', () => {
  it('builds cleanly via `node scripts/build.mjs` and produces a runnable dist/main.js', () => {
    execFileSync('node', ['scripts/build.mjs'], { cwd: cliDir, stdio: 'pipe' })
    expect(existsSync(distEntry)).toBe(true)

    const helpOutput = execFileSync('node', [distEntry, 'verify', '--help'], {
      encoding: 'utf8',
    })
    expect(helpOutput).toContain('Usage: helpthread-module verify')
  })

  it('has exactly one shebang line, at the top, not two', () => {
    // `cli/src/main.ts` deliberately carries no shebang of its own — see
    // its top-of-file comment — because esbuild's `banner` option adds
    // one. A shebang reintroduced in the source would land as an invalid
    // *second* line-1-only construct and fail at import time with a
    // SyntaxError; this caught exactly that regression once already.
    const bundle = readFileSync(distEntry, 'utf8')
    const lines = bundle.split('\n')
    expect(lines[0]).toBe('#!/usr/bin/env node')
    expect(lines.slice(1).some((line) => line.startsWith('#!'))).toBe(false)
  })

  it('carries the compiled-in trust store as a literal, byte-copied at build time', () => {
    // This is the safety argument from `cli/src/trust-store.ts` and
    // `cli/scripts/build.mjs`, checked mechanically: bundling copies BYTES
    // at publish time (this test), which is fine, precisely because there
    // is exactly one verifier implementation
    // (`src/modules/artifact/**`) and the CLI never forks it into a
    // second, divergent copy of verification policy.
    const bundle = readFileSync(distEntry, 'utf8')
    for (const [keyId, publicKey] of Object.entries(TRUST_STORE)) {
      expect(bundle).toContain(keyId)
      expect(bundle).toContain(publicKey)
    }
  })

  it('the trust store is not reachable from any env var, CLI flag, or catalog field', () => {
    // Grep the CLI's own source (not the bundle, which would also contain
    // this text as literal strings inside comments/help text) for the
    // patterns that would indicate a runtime override path: reading
    // process.env for anything trust/key-shaped, or a parsed CLI flag
    // that does the same. `install.ts`'s `trustStore` override exists
    // ONLY as a test-only dependency-injection seam (see its doc comment)
    // and is never wired from `main.ts`, args, or env — asserted here by
    // checking that `main.ts` never passes a `trustStore` option through.
    const mainTs = readFileSync(path.join(cliDir, 'src', 'main.ts'), 'utf8')
    expect(mainTs).not.toMatch(/trustStore/)
    expect(mainTs).not.toMatch(/TRUST_STORE_OVERRIDE|HELPTHREAD_TRUST/)

    const argsTs = readFileSync(path.join(cliDir, 'src', 'args.ts'), 'utf8')
    expect(argsTs).not.toMatch(/trust-store|trustKey|--key\b/)

    const catalogTs = readFileSync(path.join(cliDir, 'src', 'catalog.ts'), 'utf8')
    // The catalog module carries `manifestKeyId` (which key the ARTIFACT
    // claims to be signed with — an untrusted, attacker-controlled input
    // that verification checks against the trust store) but must never
    // define or assign the trusted key material itself.
    expect(catalogTs).not.toMatch(/TRUST_STORE\s*[:=]/)
  })

  it('a `npm pack --dry-run` from the cli workspace stays within the files allowlist', () => {
    const output = execFileSync('npm', ['pack', '-w', 'cli', '--dry-run', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const [entry] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
    const packedPaths = entry.files.map((f) => f.path).sort()

    expect(packedPaths).toEqual(['LICENSE', 'README.md', 'dist/main.js', 'package.json'])
    for (const p of packedPaths) {
      expect(p).not.toMatch(/\.ts$/)
      expect(p).not.toMatch(/^src\//)
      expect(p).not.toMatch(/\.test\./)
    }
  })
})

describe('the build starts from an empty dist/', () => {
  /**
   * `files` in cli/package.json admits the whole `dist/` directory, and
   * `npm publish` runs no tests — so anything that ever lands there ships
   * silently. The build must therefore wipe the directory rather than
   * overwrite one file inside it, making the published contents a function
   * of the build script alone.
   */
  it('removes a stray file left in dist/ instead of publishing it', async () => {
    const distDir = path.join(cliDir, 'dist')
    const stray = path.join(distDir, 'stray-do-not-ship.js')

    mkdirSync(distDir, { recursive: true })
    writeFileSync(stray, '// left behind by an earlier build or by hand\n')
    expect(existsSync(stray)).toBe(true)

    await execFileAsync(process.execPath, [path.join(cliDir, 'scripts', 'build.mjs')], {
      cwd: repoRoot,
    })

    expect(existsSync(stray)).toBe(false)
    // ...and the real bundle is still there afterwards.
    expect(existsSync(path.join(distDir, 'main.js'))).toBe(true)
  }, 60_000)
})
