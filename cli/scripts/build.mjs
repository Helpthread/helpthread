#!/usr/bin/env node
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Bundles `cli/src/main.ts` — and everything it imports, including the
// shared verifier at `src/modules/artifact/**` — into a single
// package-contained `cli/dist/main.js` (HT-121).
//
// This is what makes the package installable outside the monorepo: the
// source imports the verifier by repo-relative path (`../../src/modules/
// artifact/index.js`), which only resolves inside this checkout. Bundling
// copies those bytes into the artifact at publish time, so a published
// tarball containing only `cli/**` is self-contained. The CLI's compiled-in
// trust store (`cli/src/trust-store.ts`) travels the same way — see the
// comment there, and the test at `tests/cli/build.test.ts`, for why copying
// bytes here is safe while forking the verifier's *source* would not be.
//
// Run via `npm run build` (from `cli/`) or `npm run build -w cli` (from the
// repo root); `prepack`/`prepublishOnly` call this automatically so the
// published bundle can never go stale relative to source.
import { build } from 'esbuild'

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = join(cliRoot, 'dist', 'main.js')

mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [join(cliRoot, 'src', 'main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Readable output is a trust property here, not a nicety: this tool's
  // whole job is verifying signed artifacts, and an operator (or a
  // reviewer of a fork) auditing what they installed should be able to
  // read the bundle directly rather than take minified output on faith.
  minify: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
})

// The bin entry (`cli/package.json`'s `bin.helpthread-module`) points
// straight at this file — npm requires the target to be executable.
chmodSync(outfile, 0o755)
