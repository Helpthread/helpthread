import { describe, expect, it } from 'vitest'
import {
  MODULE_CONFIG_SCHEMA_VERSION,
  ModuleConfigParseError,
  parseModuleConfig,
} from '../../../src/modules/artifact/module-config.js'

/** The REAL module.config.json shipped in the draft-assistant 0.3.0 release artifact, byte-for-byte. */
const REAL_DRAFT_ASSISTANT_CONFIG = JSON.stringify({
  schemaVersion: 1,
  module: 'draft-assistant',
  env: [
    {
      name: 'HELPDESK_API_URL',
      required: true,
      sensitive: false,
      owner: 'engine-managed',
      description: 'Base URL of the Helpthread deployment this module talks to.',
    },
    {
      name: 'HELPDESK_ASSISTANT_TOKEN',
      required: true,
      sensitive: true,
      owner: 'engine-managed',
      description:
        'Assistant bearer token the engine mints for this module (POST /api/v1/assistants).',
    },
    {
      name: 'WEBHOOK_SIGNING_SECRET',
      required: true,
      sensitive: true,
      owner: 'engine-managed',
      description: "Secret the engine issues when registering this module's webhook endpoint.",
    },
    {
      name: 'ANTHROPIC_API_KEY',
      required: true,
      sensitive: true,
      owner: 'operator-managed',
      description: 'Anthropic API key the operator supplies, used to draft replies.',
    },
    {
      name: 'DRAFT_MODEL',
      required: false,
      sensitive: false,
      owner: 'operator-managed',
      description: 'Claude model used to draft replies. Defaults to claude-sonnet-5 when unset.',
    },
    {
      name: 'DRAFT_SYSTEM_PROMPT_APPEND',
      required: false,
      sensitive: false,
      owner: 'operator-managed',
      description:
        'Extra instructions appended to the drafting system prompt (tone, escalation rules, house style).',
    },
  ],
})

describe('parseModuleConfig: the real draft-assistant 0.3.0 module.config.json', () => {
  it('parses successfully', () => {
    const parsed = parseModuleConfig(REAL_DRAFT_ASSISTANT_CONFIG)
    expect(parsed.schemaVersion).toBe(MODULE_CONFIG_SCHEMA_VERSION)
    expect(parsed.module).toBe('draft-assistant')
    expect(parsed.env).toHaveLength(6)
  })

  it('splits declared env vars by owner correctly', () => {
    const parsed = parseModuleConfig(REAL_DRAFT_ASSISTANT_CONFIG)
    const engineManaged = parsed.env.filter((e) => e.owner === 'engine-managed').map((e) => e.name)
    const operatorManaged = parsed.env
      .filter((e) => e.owner === 'operator-managed')
      .map((e) => e.name)
    expect(engineManaged).toEqual([
      'HELPDESK_API_URL',
      'HELPDESK_ASSISTANT_TOKEN',
      'WEBHOOK_SIGNING_SECRET',
    ])
    expect(operatorManaged).toEqual([
      'ANTHROPIC_API_KEY',
      'DRAFT_MODEL',
      'DRAFT_SYSTEM_PROMPT_APPEND',
    ])
  })

  it('marks the sensitive engine-managed and API-key vars as sensitive', () => {
    const parsed = parseModuleConfig(REAL_DRAFT_ASSISTANT_CONFIG)
    const sensitive = parsed.env.filter((e) => e.sensitive).map((e) => e.name)
    expect(sensitive).toEqual([
      'HELPDESK_ASSISTANT_TOKEN',
      'WEBHOOK_SIGNING_SECRET',
      'ANTHROPIC_API_KEY',
    ])
  })
})

describe('parseModuleConfig: validation failures', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseModuleConfig('{not json')).toThrow(ModuleConfigParseError)
  })

  it('rejects a non-object top level', () => {
    expect(() => parseModuleConfig('[1,2,3]')).toThrow(/must be a JSON object/)
  })

  it('rejects a missing schemaVersion', () => {
    const { schemaVersion, ...rest } = JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG)
    expect(() => parseModuleConfig(JSON.stringify(rest))).toThrow(
      /missing required field: 'schemaVersion'/,
    )
  })

  it('rejects a wrong schemaVersion', () => {
    const config = { ...JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG), schemaVersion: 2 }
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(/schemaVersion' must be 1/)
  })

  it('rejects an unknown top-level key', () => {
    const config = { ...JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG), extra: true }
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(/unknown field: 'extra'/)
  })

  it('rejects env as a non-array', () => {
    const config = { ...JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG), env: {} }
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(/'env' must be an array/)
  })

  it('rejects an unknown owner value', () => {
    const config = JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG)
    config.env[0].owner = 'admin-managed'
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(
      /owner' must be one of 'engine-managed' \| 'operator-managed'/,
    )
  })

  it('rejects a wrong type for required', () => {
    const config = JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG)
    config.env[0].required = 'yes'
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(
      /'env\[0\].required' must be a boolean/,
    )
  })

  it('rejects a wrong type for sensitive', () => {
    const config = JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG)
    config.env[0].sensitive = 1
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(
      /'env\[0\].sensitive' must be a boolean/,
    )
  })

  it('rejects an empty description', () => {
    const config = JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG)
    config.env[0].description = ''
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(
      /'env\[0\].description' must be a non-empty string/,
    )
  })

  it('rejects an unknown field inside an env var entry', () => {
    const config = JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG)
    config.env[0].defaultValue = 'x'
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(
      /env\[0\]' has an unknown field: 'defaultValue'/,
    )
  })

  it('rejects a missing field inside an env var entry', () => {
    const config = JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG)
    delete config.env[0].description
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(
      /env\[0\]' is missing required field: 'description'/,
    )
  })

  it('rejects a duplicate env var name', () => {
    const config = JSON.parse(REAL_DRAFT_ASSISTANT_CONFIG)
    config.env.push({ ...config.env[0] })
    expect(() => parseModuleConfig(JSON.stringify(config))).toThrow(
      /declares env var 'HELPDESK_API_URL' more than once/,
    )
  })
})
