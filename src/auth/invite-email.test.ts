import { describe, expect, it } from 'vitest'
import { buildInviteEmail } from './invite-email.js'

describe('buildInviteEmail', () => {
  it('builds an email to the invitee, from the support address, with the accept link', () => {
    const email = buildInviteEmail({
      to: 'invitee@example.test',
      token: 'hti.k1.payload.sig',
      uiBaseUrl: 'https://desk.example.test',
      supportAddress: 'support@example.test',
      mailDomain: 'mail.example.test',
    })
    expect(email.to).toEqual(['invitee@example.test'])
    expect(email.from).toBe('support@example.test')
    expect(email.subject).toContain("You're invited")
    expect(email.text).toContain('https://desk.example.test/invite/hti.k1.payload.sig')
  })

  it('mints a bare, non-reply-token messageId, scoped to mailDomain', () => {
    const email = buildInviteEmail({
      to: 'invitee@example.test',
      token: 'hti.k1.payload.sig',
      uiBaseUrl: 'https://desk.example.test',
      supportAddress: 'support@example.test',
      mailDomain: 'mail.example.test',
    })
    expect(email.messageId).toMatch(/^<invite-[0-9a-f-]+@mail\.example\.test>$/)
    // Never shaped like a reply token (ht.-prefixed local part).
    expect(email.messageId.includes('ht.')).toBe(false)
  })

  it('two builds for the same invite mint DIFFERENT messageIds (fresh uuid per call)', () => {
    const input = {
      to: 'invitee@example.test',
      token: 'hti.k1.payload.sig',
      uiBaseUrl: 'https://desk.example.test',
      supportAddress: 'support@example.test',
      mailDomain: 'mail.example.test',
    }
    const a = buildInviteEmail(input)
    const b = buildInviteEmail(input)
    expect(a.messageId).not.toBe(b.messageId)
  })

  it('never sets inReplyTo/references — this is not a reply', () => {
    const email = buildInviteEmail({
      to: 'invitee@example.test',
      token: 'hti.k1.payload.sig',
      uiBaseUrl: 'https://desk.example.test',
      supportAddress: 'support@example.test',
      mailDomain: 'mail.example.test',
    })
    expect(email.inReplyTo).toBeUndefined()
    expect(email.references).toBeUndefined()
  })
})
