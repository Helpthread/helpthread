#!/usr/bin/env -S node --import tsx
// Thin launcher: the shebang registers tsx as a --import loader hook so
// main.ts can run directly from TypeScript source (no build step yet).
import '../src/main.ts'
