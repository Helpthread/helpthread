import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Keyring } from '../mail/reply-token.js'
import {
  mintChallengeToken,
  mintStepUpToken,
  verifyChallengeToken,
  verifyStepUpToken,
} from './webauthn-token.js'

const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const AGENT_ID = '00000000-0000-4000-8000-000000000000'
const OTHER_AGENT_ID = '11111111-1111-4111-8111-111111111111'

describe('mintChallengeToken / verifyChallengeToken', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a freshly minted token verifies and recovers the full payload', () => {
    const minted = mintChallengeToken('registration', AGENT_ID, KEYRING)
    expect(verifyChallengeToken(minted.token, KEYRING)).toEqual({
      ceremony: 'registration',
      challengeB64: minted.challengeB64,
      agentId: AGENT_ID,
      nonce: minted.nonce,
    })
  })

  it('authentication tokens carry a null agentId (pre-identification)', () => {
    const minted = mintChallengeToken('authentication', null, KEYRING)
    const verified = verifyChallengeToken(minted.token, KEYRING)
    expect(verified?.agentId).toBeNull()
  })

  it('is shaped htw.{keyId}.{payload}.{sig} — four dot-separated segments, htw prefix', () => {
    const minted = mintChallengeToken('step-up', AGENT_ID, KEYRING)
    const segments = minted.token.split('.')
    expect(segments).toHaveLength(4)
    expect(segments[0]).toBe('htw')
    expect(segments[1]).toBe('k1')
  })

  it('two mints produce different nonces and different challenges', () => {
    const a = mintChallengeToken('authentication', null, KEYRING)
    const b = mintChallengeToken('authentication', null, KEYRING)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.challengeB64).not.toBe(b.challengeB64)
  })

  it('rejects an expired token (past the TTL)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const minted = mintChallengeToken('authentication', null, KEYRING)
    vi.setSystemTime(new Date('2026-01-01T00:05:01Z')) // TTL is 5 minutes
    expect(verifyChallengeToken(minted.token, KEYRING)).toBeNull()
  })

  it('a forged signature does not verify', () => {
    const minted = mintChallengeToken('authentication', null, KEYRING)
    const segments = minted.token.split('.')
    segments[3] = 'A'.repeat(segments[3].length)
    expect(verifyChallengeToken(segments.join('.'), KEYRING)).toBeNull()
  })

  it('a tampered ceremony field does not verify (the payload is part of the signed canonical string)', () => {
    const registration = mintChallengeToken('registration', AGENT_ID, KEYRING)
    const authentication = mintChallengeToken('authentication', null, KEYRING)
    const segments = registration.token.split('.')
    const otherSegments = authentication.token.split('.')
    segments[2] = otherSegments[2] // splice a different payload onto this token's signature
    expect(verifyChallengeToken(segments.join('.'), KEYRING)).toBeNull()
  })

  it('mintChallengeToken throws for a non-uuid agentId', () => {
    expect(() => mintChallengeToken('registration', 'not-a-uuid', KEYRING)).toThrow()
  })

  it('mintChallengeToken throws for a malformed keyring', () => {
    expect(() =>
      mintChallengeToken('authentication', null, { current: { keyId: 'k1', secret: 'short' } }),
    ).toThrow()
  })

  it('never verifies against a different token type (htsu.)', () => {
    const stepUp = mintStepUpToken(AGENT_ID, KEYRING)
    expect(verifyChallengeToken(stepUp.token, KEYRING)).toBeNull()
  })
})

describe('mintStepUpToken / verifyStepUpToken', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a freshly minted token verifies and recovers the agentId', () => {
    const minted = mintStepUpToken(AGENT_ID, KEYRING)
    expect(verifyStepUpToken(minted.token, KEYRING)).toEqual({
      agentId: AGENT_ID,
      nonce: minted.nonce,
    })
  })

  it('is shaped htsu.{keyId}.{payload}.{sig} — four dot-separated segments, htsu prefix', () => {
    const minted = mintStepUpToken(AGENT_ID, KEYRING)
    const segments = minted.token.split('.')
    expect(segments).toHaveLength(4)
    expect(segments[0]).toBe('htsu')
  })

  it('rejects an expired token (past the TTL)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const minted = mintStepUpToken(AGENT_ID, KEYRING)
    vi.setSystemTime(new Date('2026-01-01T00:05:01Z'))
    expect(verifyStepUpToken(minted.token, KEYRING)).toBeNull()
  })

  it('a tampered agentId does not verify', () => {
    const mine = mintStepUpToken(AGENT_ID, KEYRING)
    const theirs = mintStepUpToken(OTHER_AGENT_ID, KEYRING)
    const segments = mine.token.split('.')
    segments[2] = theirs.token.split('.')[2]
    expect(verifyStepUpToken(segments.join('.'), KEYRING)).toBeNull()
  })

  it('mintStepUpToken throws for a non-uuid agentId', () => {
    expect(() => mintStepUpToken('not-a-uuid', KEYRING)).toThrow()
  })

  it('never verifies against a different token type (htw.)', () => {
    const challenge = mintChallengeToken('registration', AGENT_ID, KEYRING)
    expect(verifyStepUpToken(challenge.token, KEYRING)).toBeNull()
  })
})
