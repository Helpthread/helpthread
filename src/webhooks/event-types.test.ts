import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, isEventType, TEST_PING_EVENT_TYPE } from './event-types.js'

describe('isEventType', () => {
  it('accepts every spec §4 vocabulary entry', () => {
    for (const type of EVENT_TYPES) {
      expect(isEventType(type)).toBe(true)
    }
  })

  it('rejects test.ping — a synthetic type, never a subscribable filter value', () => {
    expect(isEventType(TEST_PING_EVENT_TYPE)).toBe(false)
  })

  it('rejects an unknown string', () => {
    expect(isEventType('conversation.bogus')).toBe(false)
    expect(isEventType('')).toBe(false)
  })
})
