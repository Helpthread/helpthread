/**
 * Tiny, stable project metadata module.
 *
 * Its purpose is narrow: give the CI pipeline a real (if minimal) unit of
 * source to typecheck, lint, test, and measure coverage against, proving the
 * whole toolchain works end to end before any engine code lands.
 */

export const PROJECT = 'helpthread'

/** One-line description of the toolchain this repo runs on. */
export function describeStack(): string {
  return `${PROJECT}: TypeScript, strict, NodeNext`
}
