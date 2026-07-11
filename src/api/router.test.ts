import { describe, expect, it } from 'vitest'
import { matchRoute } from './router.js'

describe('matchRoute', () => {
  it('matches GET /api/v1/conversations', () => {
    expect(matchRoute('GET', '/api/v1/conversations')).toEqual({ kind: 'conversations-list' })
  })

  it('matches GET /api/v1/conversations/{id}, extracting the id', () => {
    expect(matchRoute('GET', '/api/v1/conversations/abc-123')).toEqual({
      kind: 'conversation-item',
      id: 'abc-123',
    })
  })

  it('returns method-not-allowed for a wrong method on the list route, naming its supported methods', () => {
    expect(matchRoute('DELETE', '/api/v1/conversations')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET'],
    })
    expect(matchRoute('POST', '/api/v1/conversations')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET'],
    })
  })

  it('returns method-not-allowed for a wrong method on the item route', () => {
    expect(matchRoute('DELETE', '/api/v1/conversations/abc-123')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET'],
    })
  })

  it('returns not-found for an unmatched path', () => {
    expect(matchRoute('GET', '/api/v1/nope')).toEqual({ kind: 'not-found' })
    expect(matchRoute('GET', '/')).toEqual({ kind: 'not-found' })
  })

  it('does not match a conversation item path with a trailing segment', () => {
    expect(matchRoute('GET', '/api/v1/conversations/abc-123/replies')).toEqual({
      kind: 'not-found',
    })
  })

  it('does not match the list route with a trailing slash', () => {
    expect(matchRoute('GET', '/api/v1/conversations/')).toEqual({ kind: 'not-found' })
  })
})
