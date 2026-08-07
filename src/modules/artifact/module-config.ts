/**
 * `module.config.json`: the small declaration a module ships inside its
 * artifact naming the environment variables its runtime needs (HT-116).
 *
 * ## Why this exists
 *
 * A module's tarball is opaque — the engine and the installer never read
 * its code. `module.config.json` is the one place a module declares, in a
 * form both a human operator and the installer can act on, which env vars
 * it needs, whether each one is a secret, and who is responsible for
 * supplying it: the engine (minted automatically once HT-119 ships) or the
 * operator (typed in by hand, e.g. a third-party API key). Getting the
 * `owner` value wrong in either direction is a real failure mode — an
 * `engine-managed` secret misclassified as `operator-managed` prompts an
 * operator for a value they can't actually produce; the reverse silently
 * skips a value the operator was supposed to provide — so this validator
 * rejects anything that doesn't fit the exact known shape rather than
 * coercing or guessing.
 *
 * The shape here matches the real, live `module.config.json` shipped in
 * the `draft-assistant` 0.3.0 release artifact.
 */

/** The one `module.config.json` schema version this module understands. */
export const MODULE_CONFIG_SCHEMA_VERSION = 1 as const

/** Who is responsible for supplying an env var's value. */
export type EnvVarOwner = 'engine-managed' | 'operator-managed'

const ENV_VAR_OWNERS: ReadonlySet<string> = new Set<EnvVarOwner>([
  'engine-managed',
  'operator-managed',
])

/** One env var a module declares it needs. */
export interface ModuleConfigEnvVar {
  /** The env var's exact name, e.g. `ANTHROPIC_API_KEY`. */
  name: string
  /** Whether the module's runtime fails without this var set. */
  required: boolean
  /** Whether the value is a secret — must never be logged, echoed, or printed back verbatim. */
  sensitive: boolean
  /** Who supplies the value: the engine (minted automatically) or the operator (typed in by hand). */
  owner: EnvVarOwner
  /** Human-readable description shown to the operator, e.g. in the CLI's env-var summary. */
  description: string
}

/** A parsed, validated `module.config.json`. */
export interface ModuleConfigV1 {
  schemaVersion: typeof MODULE_CONFIG_SCHEMA_VERSION
  /** The module's catalog slug, e.g. `draft-assistant`. Should match the release manifest's `module` field, but this validator does not cross-check that — callers who have both should. */
  module: string
  env: ModuleConfigEnvVar[]
}

const CONFIG_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'module', 'env'])
const ENV_VAR_KEYS = new Set(['name', 'required', 'sensitive', 'owner', 'description'])

/** Thrown by {@link parseModuleConfig} — the message names the exact field and problem, same spirit as `ManifestParseError`. */
export class ModuleConfigParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModuleConfigParseError'
  }
}

function fail(message: string): never {
  throw new ModuleConfigParseError(message)
}

function requireNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(
      `module.config.json field '${fieldPath}' must be a non-empty string, got: ${JSON.stringify(value)}`,
    )
  }
  return value as string
}

function requireBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== 'boolean') {
    fail(`module.config.json field '${fieldPath}' must be a boolean, got: ${JSON.stringify(value)}`)
  }
  return value as boolean
}

function parseEnvVar(raw: unknown, index: number): ModuleConfigEnvVar {
  const fieldPrefix = `env[${index}]`
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`module.config.json field '${fieldPrefix}' must be an object, got: ${JSON.stringify(raw)}`)
  }
  const obj = raw as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!ENV_VAR_KEYS.has(key)) {
      fail(`module.config.json field '${fieldPrefix}' has an unknown field: '${key}'`)
    }
  }
  for (const key of ENV_VAR_KEYS) {
    if (!(key in obj)) {
      fail(`module.config.json field '${fieldPrefix}' is missing required field: '${key}'`)
    }
  }

  const name = requireNonEmptyString(obj.name, `${fieldPrefix}.name`)
  const required = requireBoolean(obj.required, `${fieldPrefix}.required`)
  const sensitive = requireBoolean(obj.sensitive, `${fieldPrefix}.sensitive`)
  const description = requireNonEmptyString(obj.description, `${fieldPrefix}.description`)

  if (typeof obj.owner !== 'string' || !ENV_VAR_OWNERS.has(obj.owner)) {
    fail(
      `module.config.json field '${fieldPrefix}.owner' must be one of 'engine-managed' | 'operator-managed', got: ${JSON.stringify(obj.owner)}`,
    )
  }
  const owner = obj.owner as EnvVarOwner

  return { name, required, sensitive, owner, description }
}

/**
 * Parse and validate a `module.config.json` string into a
 * {@link ModuleConfigV1}. Rejects: invalid JSON, a non-object top level, a
 * `schemaVersion` other than {@link MODULE_CONFIG_SCHEMA_VERSION}, any
 * unknown top-level or per-env-var key, a wrong primitive type on any
 * field, an unknown `owner` value, and a duplicate env var `name`.
 */
export function parseModuleConfig(json: string): ModuleConfigV1 {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    fail(
      `module.config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('module.config.json must be a JSON object')
  }
  const obj = raw as Record<string, unknown>

  for (const key of Object.keys(obj)) {
    if (!CONFIG_TOP_LEVEL_KEYS.has(key)) {
      fail(`module.config.json has an unknown field: '${key}'`)
    }
  }
  for (const key of CONFIG_TOP_LEVEL_KEYS) {
    if (!(key in obj)) {
      fail(`module.config.json is missing required field: '${key}'`)
    }
  }

  if (obj.schemaVersion !== MODULE_CONFIG_SCHEMA_VERSION) {
    fail(
      `module.config.json field 'schemaVersion' must be ${MODULE_CONFIG_SCHEMA_VERSION}, got: ${JSON.stringify(obj.schemaVersion)}`,
    )
  }

  const moduleSlug = requireNonEmptyString(obj.module, 'module')

  if (!Array.isArray(obj.env)) {
    fail(`module.config.json field 'env' must be an array, got: ${JSON.stringify(obj.env)}`)
  }

  const env = (obj.env as unknown[]).map((entry, index) => parseEnvVar(entry, index))

  const seenNames = new Set<string>()
  for (const entry of env) {
    if (seenNames.has(entry.name)) {
      fail(`module.config.json declares env var '${entry.name}' more than once`)
    }
    seenNames.add(entry.name)
  }

  return { schemaVersion: MODULE_CONFIG_SCHEMA_VERSION, module: moduleSlug, env }
}
