import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // PGlite (src/db/**) spins up a real WASM Postgres per test file; under
    // v8 coverage instrumentation plus several test files doing this in
    // parallel, that startup alone can exceed Vitest's 5s default —
    // observed, not hypothetical (a coverage run flaked on the first
    // PGlite-backed test in a file). 20s gives real headroom without
    // masking an actually-hung test.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**'],
      // `src/providers/*.ts` (top-level only, NOT `/**`) are pure interface/
      // type files with no runtime code to instrument — excluded so they
      // don't dilute the report with meaningless 0-statement entries. Real
      // adapters under `src/providers/adapters/**` (e.g. the Gmail
      // `EmailSender`, HT-19) DO have executable logic and must stay covered
      // — a narrower `**` glob here would silently hide them from every
      // future coverage report.
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/**/*.md', 'src/providers/*.ts'],
    },
  },
})
