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
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/providers/**'],
    },
  },
})
