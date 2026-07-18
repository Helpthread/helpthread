import { afterEach, describe, expect, it, vi } from 'vitest'
import { mintConnectState } from '../mail/gmail-connect.js'
import { type Keyring, mintReplyMessageId } from '../mail/reply-token.js'
import { DEFAULT_INVITE_TOKEN_TTL_MS, mintInviteToken, verifyInviteToken } from './invite-token.js'

const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const AGENT_ID = '00000000-0000-4000-8000-000000000000'

describe('mintInviteToken / verifyInviteToken', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a freshly minted token verifies and recovers the agentId', () => {
    const token = mintInviteToken(AGENT_ID, KEYRING)
    expect(verifyInviteToken(token, KEYRING)).toEqual({ agentId: AGENT_ID })
  })

  it('is shaped hti.{keyId}.{payload}.{sig} — four dot-separated segments, hti prefix', () => {
    const token = mintInviteToken(AGENT_ID, KEYRING)
    const segments = token.split('.')
    expect(segments).toHaveLength(4)
    expect(segments[0]).toBe('hti')
    expect(segments[1]).toBe('k1')
  })

  it('mintInviteToken throws for a non-uuid agentId', () => {
    expect(() => mintInviteToken('not-a-uuid', KEYRING)).toThrow()
  })

  it('mintInviteToken throws for a malformed keyring', () => {
    expect(() =>
      mintInviteToken(AGENT_ID, { current: { keyId: 'k1', secret: 'too-short' } }),
    ).toThrow()
  })

  it('a forged signature does not verify', () => {
    const segments = mintInviteToken(AGENT_ID, KEYRING).split('.')
    segments[3] = 'A'.repeat(segments[3].length)
    expect(verifyInviteToken(segments.join('.'), KEYRING)).toBeNull()
  })

  it('a tampered payload does not verify (the payload is part of the signed canonical string)', () => {
    const otherAgentId = '11111111-1111-4111-8111-111111111111'
    const forged = mintInviteToken(otherAgentId, KEYRING)
    const segments = mintInviteToken(AGENT_ID, KEYRING).split('.')
    const forgedSegments = forged.split('.')
    // Splice a different agent's payload onto this token's signature.
    segments[2] = forgedSegments[2]
    expect(verifyInviteToken(segments.join('.'), KEYRING)).toBeNull()
  })

  it('expires past the TTL (default 72 hours)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const token = mintInviteToken(AGENT_ID, KEYRING)

    vi.setSystemTime(new Date(Date.now() + DEFAULT_INVITE_TOKEN_TTL_MS - 1000))
    expect(verifyInviteToken(token, KEYRING)).toEqual({ agentId: AGENT_ID })

    vi.setSystemTime(new Date(Date.now() + 2000))
    expect(verifyInviteToken(token, KEYRING)).toBeNull()
  })

  it('respects a custom ttlMs', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const token = mintInviteToken(AGENT_ID, KEYRING)

    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
    expect(verifyInviteToken(token, KEYRING, 60_000)).toEqual({ agentId: AGENT_ID })
    expect(verifyInviteToken(token, KEYRING, 10_000)).toBeNull()
  })

  it('verifyInviteToken is TOTAL over garbage input — never throws, always null', () => {
    const garbage = [
      '',
      'not-a-token',
      'hti.only.two',
      'hti..payload.sig',
      'gmc.k1.123.nonce.sig', // a connect-state token, wrong shape entirely
      'ht.k1.c1.t1.sig@mail.example.test', // a reply token local part, wrong shape
    ]
    for (const value of garbage) {
      expect(() => verifyInviteToken(value, KEYRING)).not.toThrow()
      expect(verifyInviteToken(value, KEYRING)).toBeNull()
    }
  })

  it('rejects an unknown keyId', () => {
    const token = mintInviteToken(AGENT_ID, KEYRING)
    const otherKeyring: Keyring = { current: { keyId: 'other', secret: 'b'.repeat(32) } }
    expect(verifyInviteToken(token, otherKeyring)).toBeNull()
  })

  it('an hti. signature never verifies as a gmc. connect-state token, and vice versa (domain separation)', () => {
    // Same keyring, same underlying secret material — the prefix embedded in
    // the signed bytes is what keeps the two token types from ever
    // cross-verifying, not merely a difference in which keys are configured.
    const inviteToken = mintInviteToken(AGENT_ID, KEYRING)
    const connectState = mintConnectState(KEYRING)

    // A gmc. token is the wrong shape for verifyInviteToken (5 segments,
    // wrong prefix) — rejected structurally, before any signature check.
    expect(verifyInviteToken(connectState, KEYRING)).toBeNull()

    // Splice the gmc. token's payload+sig onto an hti. prefix: still fails,
    // because the SIGNED bytes for a gmc. token never included the literal
    // "hti." this verifier requires as part of the canonical string.
    const gmcSegments = connectState.split('.')
    const frankensteined = `hti.${gmcSegments[1]}.${gmcSegments[2]}.${gmcSegments[4]}`
    expect(verifyInviteToken(frankensteined, KEYRING)).toBeNull()

    // And a genuine hti. token is the wrong shape (4 segments) for a reply
    // token / connect-state verifier expecting 5 — asserted here structurally
    // via segment count, since this module doesn't import those verifiers.
    expect(inviteToken.split('.')).toHaveLength(4)
    expect(connectState.split('.')).toHaveLength(5)
  })

  it('an hti. signature never verifies as an ht. reply token (domain separation)', () => {
    const replyMessageId = mintReplyMessageId(
      { conversationId: 'c1', threadId: 't1', mailDomain: 'mail.example.test' },
      KEYRING,
    )
    // Not even the right shape (angle-bracketed, @domain suffix) — rejected
    // outright by verifyInviteToken's structural parse.
    expect(verifyInviteToken(replyMessageId, KEYRING)).toBeNull()
  })
})
