/**
 * Pure rendering of a module's `module.config.json` into the
 * copy-pasteable env-var summary `install` prints (HT-116). No I/O — takes
 * a parsed config, returns a string — so it's testable without touching a
 * terminal.
 */
import type { ModuleConfigV1 } from '../../src/modules/artifact/index.js'

function renderVar(v: ModuleConfigV1['env'][number]): string {
  const flags = [v.required ? 'required' : 'optional', v.sensitive ? 'secret' : null]
    .filter(Boolean)
    .join(', ')
  return `  ${v.name}  (${flags})\n    ${v.description}`
}

/**
 * Render the env-var summary shown after extraction, split by who is
 * responsible for supplying each value.
 */
export function renderEnvSummary(config: ModuleConfigV1): string {
  const operatorManaged = config.env.filter((v) => v.owner === 'operator-managed')
  const engineManaged = config.env.filter((v) => v.owner === 'engine-managed')

  const lines: string[] = []
  lines.push(`Environment variables for '${config.module}':`)
  lines.push('')

  lines.push('You supply these:')
  if (operatorManaged.length === 0) {
    lines.push('  (none)')
  } else {
    for (const v of operatorManaged) lines.push(renderVar(v))
  }
  lines.push('')

  lines.push(
    'Your Helpthread engine mints these; the in-product installer will set them automatically once it ships:',
  )
  if (engineManaged.length === 0) {
    lines.push('  (none)')
  } else {
    for (const v of engineManaged) lines.push(renderVar(v))
  }

  return lines.join('\n')
}
