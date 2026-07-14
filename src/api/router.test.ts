import { describe, expect, it } from 'vitest'
import { matchGmailPushWebhook, matchRoute } from './router.js'

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

  it('matches PATCH /api/v1/conversations/{id}, extracting the id', () => {
    expect(matchRoute('PATCH', '/api/v1/conversations/abc-123')).toEqual({
      kind: 'conversation-patch',
      id: 'abc-123',
    })
  })

  it('matches POST /api/v1/conversations/{id}/replies, extracting the id', () => {
    expect(matchRoute('POST', '/api/v1/conversations/abc-123/replies')).toEqual({
      kind: 'conversation-reply',
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
    expect(matchRoute('PATCH', '/api/v1/conversations')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET'],
    })
  })

  it('matches DELETE /api/v1/conversations/{id}, extracting the id (spec §4d, v1.1)', () => {
    expect(matchRoute('DELETE', '/api/v1/conversations/abc-123')).toEqual({
      kind: 'conversation-delete',
      id: 'abc-123',
    })
  })

  it('returns method-not-allowed for a wrong method on the item route, naming GET, PATCH and DELETE', () => {
    expect(matchRoute('PUT', '/api/v1/conversations/abc-123')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET', 'PATCH', 'DELETE'],
    })
  })

  it('returns method-not-allowed for a wrong method on the replies route, naming POST', () => {
    expect(matchRoute('GET', '/api/v1/conversations/abc-123/replies')).toEqual({
      kind: 'method-not-allowed',
      allow: ['POST'],
    })
    expect(matchRoute('DELETE', '/api/v1/conversations/abc-123/replies')).toEqual({
      kind: 'method-not-allowed',
      allow: ['POST'],
    })
  })

  it('returns not-found for an unmatched path', () => {
    expect(matchRoute('GET', '/api/v1/nope')).toEqual({ kind: 'not-found' })
    expect(matchRoute('GET', '/')).toEqual({ kind: 'not-found' })
  })

  it('does not match a conversation item path with an unrecognized trailing segment', () => {
    expect(matchRoute('GET', '/api/v1/conversations/abc-123/nope')).toEqual({
      kind: 'not-found',
    })
  })

  it('does not match the list route with a trailing slash', () => {
    expect(matchRoute('GET', '/api/v1/conversations/')).toEqual({ kind: 'not-found' })
  })
})

describe('matchGmailPushWebhook', () => {
  it('matches the exact Gmail push path', () => {
    expect(matchGmailPushWebhook('/api/v1/inbound/gmail')).toBe(true)
  })

  it('matches regardless of method — the handler itself enforces POST, uniformly (gmail-push.md §2)', () => {
    // matchGmailPushWebhook only takes a pathname; verifying "any method"
    // just means the boolean doesn't depend on one at all.
    expect(matchGmailPushWebhook('/api/v1/inbound/gmail')).toBe(true)
  })

  it('does not match an unrelated or near-miss path', () => {
    expect(matchGmailPushWebhook('/api/v1/inbound')).toBe(false)
    expect(matchGmailPushWebhook('/api/v1/inbound/gmail/')).toBe(false)
    expect(matchGmailPushWebhook('/api/v1/inbound/postmark')).toBe(false)
    expect(matchGmailPushWebhook('/api/v1/conversations')).toBe(false)
    expect(matchGmailPushWebhook('/')).toBe(false)
  })
})
