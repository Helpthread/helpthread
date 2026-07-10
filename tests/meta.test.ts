import { describe, expect, it } from 'vitest'
import { describeStack, PROJECT } from '../src/meta.js'

describe('meta', () => {
  it('exposes the project name', () => {
    expect(PROJECT).toBe('helpthread')
  })

  it('describes the stack in one line', () => {
    const description = describeStack()
    expect(description).toContain(PROJECT)
    expect(description.length).toBeGreaterThan(0)
  })
})
