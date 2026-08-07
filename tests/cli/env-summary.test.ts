import { describe, expect, it } from 'vitest'
import { renderEnvSummary } from '../../cli/src/env-summary.js'
import type { ModuleConfigV1 } from '../../src/modules/artifact/index.js'

const CONFIG: ModuleConfigV1 = {
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
      name: 'ANTHROPIC_API_KEY',
      required: true,
      sensitive: true,
      owner: 'operator-managed',
      description: 'Anthropic API key the operator supplies.',
    },
    {
      name: 'DRAFT_MODEL',
      required: false,
      sensitive: false,
      owner: 'operator-managed',
      description: 'Claude model used to draft replies.',
    },
  ],
}

describe('renderEnvSummary', () => {
  const rendered = renderEnvSummary(CONFIG)

  it('splits vars into "you supply" and engine-managed sections', () => {
    const youSupplyIndex = rendered.indexOf('You supply these:')
    const engineIndex = rendered.indexOf('Your Helpthread engine mints these')
    expect(youSupplyIndex).toBeGreaterThanOrEqual(0)
    expect(engineIndex).toBeGreaterThan(youSupplyIndex)

    const youSupplySection = rendered.slice(youSupplyIndex, engineIndex)
    expect(youSupplySection).toContain('ANTHROPIC_API_KEY')
    expect(youSupplySection).toContain('DRAFT_MODEL')
    expect(youSupplySection).not.toContain('HELPDESK_API_URL')

    const engineSection = rendered.slice(engineIndex)
    expect(engineSection).toContain('HELPDESK_API_URL')
    expect(engineSection).not.toContain('ANTHROPIC_API_KEY')
  })

  it('flags required vs optional and secret vs not', () => {
    expect(rendered).toMatch(/ANTHROPIC_API_KEY\s+\(required, secret\)/)
    expect(rendered).toMatch(/DRAFT_MODEL\s+\(optional\)/)
    expect(rendered).toMatch(/HELPDESK_API_URL\s+\(required\)/)
  })

  it('never prints a placeholder value for a sensitive var (there is no value to print)', () => {
    expect(rendered).not.toMatch(/ANTHROPIC_API_KEY\s*=/)
  })

  it('renders "(none)" for an empty side', () => {
    const noOperator: ModuleConfigV1 = {
      schemaVersion: 1,
      module: 'engine-only',
      env: [CONFIG.env[0]],
    }
    const out = renderEnvSummary(noOperator)
    const youSupplyIndex = out.indexOf('You supply these:')
    const engineIndex = out.indexOf('Your Helpthread engine mints these')
    expect(out.slice(youSupplyIndex, engineIndex)).toContain('(none)')
  })
})
