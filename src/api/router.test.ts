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

  // --- gmail disconnect (HT-47) ---------------------------------------------

  it('matches POST /api/v1/inbound/gmail/disconnect', () => {
    expect(matchRoute('POST', '/api/v1/inbound/gmail/disconnect')).toEqual({
      kind: 'gmail-disconnect',
    })
  })

  it('returns method-not-allowed for a wrong method on the disconnect route, naming POST', () => {
    expect(matchRoute('GET', '/api/v1/inbound/gmail/disconnect')).toEqual({
      kind: 'method-not-allowed',
      allow: ['POST'],
    })
  })

  it('does not confuse disconnect with connect or the push webhook path', () => {
    expect(matchRoute('POST', '/api/v1/inbound/gmail/connect')).toEqual({ kind: 'gmail-connect' })
    expect(matchRoute('POST', '/api/v1/inbound/gmail')).toEqual({ kind: 'not-found' })
  })

  // --- Agents & Authentication (HT-54) ----------------------------------------

  it('matches GET /api/v1/auth/providers', () => {
    expect(matchRoute('GET', '/api/v1/auth/providers')).toEqual({ kind: 'auth-providers' })
    expect(matchRoute('POST', '/api/v1/auth/providers')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET'],
    })
  })

  it('matches POST /api/v1/setup', () => {
    expect(matchRoute('POST', '/api/v1/setup')).toEqual({ kind: 'setup' })
  })

  it('matches POST /api/v1/auth/verify', () => {
    expect(matchRoute('POST', '/api/v1/auth/verify')).toEqual({ kind: 'auth-verify' })
  })

  it('matches GET /api/v1/auth/me', () => {
    expect(matchRoute('GET', '/api/v1/auth/me')).toEqual({ kind: 'auth-me' })
  })

  it('matches POST /api/v1/auth/invite/accept — a distinct prefix (/auth/) from /agents/{id}/invite, never confused', () => {
    expect(matchRoute('POST', '/api/v1/auth/invite/accept')).toEqual({ kind: 'auth-invite-accept' })
  })

  it('matches GET/POST /api/v1/agents as list/create', () => {
    expect(matchRoute('GET', '/api/v1/agents')).toEqual({ kind: 'agents-list' })
    expect(matchRoute('POST', '/api/v1/agents')).toEqual({ kind: 'agents-create' })
    expect(matchRoute('DELETE', '/api/v1/agents')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET', 'POST'],
    })
  })

  it('matches GET/PATCH/DELETE /api/v1/agents/{id}, extracting the id', () => {
    expect(matchRoute('GET', '/api/v1/agents/abc-123')).toEqual({
      kind: 'agent-item',
      id: 'abc-123',
    })
    expect(matchRoute('PATCH', '/api/v1/agents/abc-123')).toEqual({
      kind: 'agent-patch',
      id: 'abc-123',
    })
    expect(matchRoute('DELETE', '/api/v1/agents/abc-123')).toEqual({
      kind: 'agent-delete',
      id: 'abc-123',
    })
    expect(matchRoute('PUT', '/api/v1/agents/abc-123')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET', 'PATCH', 'DELETE'],
    })
  })

  it('matches POST /api/v1/agents/{id}/password, distinct from the item route', () => {
    expect(matchRoute('POST', '/api/v1/agents/abc-123/password')).toEqual({
      kind: 'agent-password',
      id: 'abc-123',
    })
    expect(matchRoute('GET', '/api/v1/agents/abc-123/password')).toEqual({
      kind: 'method-not-allowed',
      allow: ['POST'],
    })
  })

  it('matches POST /api/v1/agents/{id}/invite, distinct from the item route and /password', () => {
    expect(matchRoute('POST', '/api/v1/agents/abc-123/invite')).toEqual({
      kind: 'agent-invite',
      id: 'abc-123',
    })
  })

  it("agent item route never matches a /password or /invite suffix (anchored, mirrors CONVERSATION_ITEM's own anchoring)", () => {
    expect(matchRoute('GET', '/api/v1/agents/abc-123/password')).not.toEqual({
      kind: 'agent-item',
      id: 'abc-123/password',
    })
  })

  // --- Mailbox access (HT-54 follow-up; spec §3.4/§6) -------------------------

  it('matches GET /api/v1/mailboxes', () => {
    expect(matchRoute('GET', '/api/v1/mailboxes')).toEqual({ kind: 'mailboxes-list' })
    expect(matchRoute('POST', '/api/v1/mailboxes')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET'],
    })
  })

  it('matches GET/PUT /api/v1/agents/{id}/mailboxes, extracting the id', () => {
    expect(matchRoute('GET', '/api/v1/agents/abc-123/mailboxes')).toEqual({
      kind: 'agent-mailboxes-get',
      id: 'abc-123',
    })
    expect(matchRoute('PUT', '/api/v1/agents/abc-123/mailboxes')).toEqual({
      kind: 'agent-mailboxes-put',
      id: 'abc-123',
    })
    expect(matchRoute('DELETE', '/api/v1/agents/abc-123/mailboxes')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET', 'PUT'],
    })
  })

  it('agent item route never matches a /mailboxes suffix (anchored, same as /password and /invite)', () => {
    expect(matchRoute('GET', '/api/v1/agents/abc-123/mailboxes')).not.toEqual({
      kind: 'agent-item',
      id: 'abc-123/mailboxes',
    })
  })

  // --- Assistants (HT-70) -----------------------------------------------

  it('matches GET/POST /api/v1/assistants', () => {
    expect(matchRoute('GET', '/api/v1/assistants')).toEqual({ kind: 'assistants-list' })
    expect(matchRoute('POST', '/api/v1/assistants')).toEqual({ kind: 'assistants-create' })
    expect(matchRoute('DELETE', '/api/v1/assistants')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET', 'POST'],
    })
  })

  it('matches PATCH /api/v1/assistants/{id}, extracting the id', () => {
    expect(matchRoute('PATCH', '/api/v1/assistants/abc-123')).toEqual({
      kind: 'assistant-patch',
      id: 'abc-123',
    })
    expect(matchRoute('GET', '/api/v1/assistants/abc-123')).toEqual({
      kind: 'method-not-allowed',
      allow: ['PATCH'],
    })
  })

  it('matches POST /api/v1/assistants/{id}/rotate-token, extracting the id, never falling into assistant-patch', () => {
    expect(matchRoute('POST', '/api/v1/assistants/abc-123/rotate-token')).toEqual({
      kind: 'assistant-rotate-token',
      id: 'abc-123',
    })
    expect(matchRoute('GET', '/api/v1/assistants/abc-123/rotate-token')).toEqual({
      kind: 'method-not-allowed',
      allow: ['POST'],
    })
  })

  // --- Drafts (HT-70) -----------------------------------------------------

  it('matches POST /api/v1/conversations/{id}/drafts, extracting the id', () => {
    expect(matchRoute('POST', '/api/v1/conversations/abc-123/drafts')).toEqual({
      kind: 'conversation-draft-create',
      id: 'abc-123',
    })
    expect(matchRoute('GET', '/api/v1/conversations/abc-123/drafts')).toEqual({
      kind: 'method-not-allowed',
      allow: ['POST'],
    })
  })

  it('conversation item route never matches a /drafts suffix (anchored, same as /replies and /notes)', () => {
    expect(matchRoute('GET', '/api/v1/conversations/abc-123/drafts')).not.toEqual({
      kind: 'conversation-item',
      id: 'abc-123/drafts',
    })
  })

  it('matches GET /api/v1/drafts', () => {
    expect(matchRoute('GET', '/api/v1/drafts')).toEqual({ kind: 'drafts-list' })
    expect(matchRoute('POST', '/api/v1/drafts')).toEqual({
      kind: 'method-not-allowed',
      allow: ['GET'],
    })
  })

  it('matches POST /api/v1/drafts/{threadId}/approve and .../discard, extracting the id', () => {
    expect(matchRoute('POST', '/api/v1/drafts/thread-123/approve')).toEqual({
      kind: 'draft-approve',
      id: 'thread-123',
    })
    expect(matchRoute('POST', '/api/v1/drafts/thread-123/discard')).toEqual({
      kind: 'draft-discard',
      id: 'thread-123',
    })
    expect(matchRoute('GET', '/api/v1/drafts/thread-123/approve')).toEqual({
      kind: 'method-not-allowed',
      allow: ['POST'],
    })
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
