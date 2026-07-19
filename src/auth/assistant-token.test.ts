import { describe, expect, it } from 'vitest'
import {
  constantTimeHashEquals,
  hashAssistantSecret,
  mintAssistantToken,
  parseAssistantToken,
} from './assistant-token.js'

const ASSISTANT_ID = '11111111-1111-4111-8111-111111111111'

describe('mintAssistantToken', () => {
  it('mints a token shaped ht_asst_<assistantId>_<secret> that round-trips through parseAssistantToken', () => {
    const minted = mintAssistantToken(ASSISTANT_ID)
    expect(minted.token.startsWith(`ht_asst_${ASSISTANT_ID}_`)).toBe(true)

    const parsed = parseAssistantToken(minted.token)
    expect(parsed).not.toBeNull()
    expect(parsed?.assistantId).toBe(ASSISTANT_ID)
    expect(hashAssistantSecret(parsed?.secret ?? '')).toBe(minted.tokenHash)
  })

  it('mints a different secret (and hash) every call', () => {
    const a = mintAssistantToken(ASSISTANT_ID)
    const b = mintAssistantToken(ASSISTANT_ID)
    expect(a.token).not.toBe(b.token)
    expect(a.tokenHash).not.toBe(b.tokenHash)
  })

  it('throws on a non-uuid assistantId', () => {
    expect(() => mintAssistantToken('not-a-uuid')).toThrow()
    expect(() => mintAssistantToken('')).toThrow()
  })
})

describe('parseAssistantToken', () => {
  it('is total: never throws, returns null for anything not shaped like our token', () => {
    const badInputs = [
      '',
      'ht_asst_',
      `ht_asst_${ASSISTANT_ID}`, // missing the trailing _<secret>
      `ht_asst_${ASSISTANT_ID}_`, // empty secret
      'ht_asst_not-a-uuid_secret',
      'Bearer sometoken',
      `ht_asst_${'1'.repeat(36)}${'X'.repeat(10)}`, // no separator underscore at all
    ]
    for (const input of badInputs) {
      expect(parseAssistantToken(input)).toBeNull()
    }
  })

  it('recovers the assistantId by fixed-length slice even when the secret itself contains underscores', () => {
    const secretWithUnderscores = 'a_b_c_d_e_f'
    const token = `ht_asst_${ASSISTANT_ID}_${secretWithUnderscores}`
    const parsed = parseAssistantToken(token)
    expect(parsed).toEqual({ assistantId: ASSISTANT_ID, secret: secretWithUnderscores })
  })

  it('rejects a token whose id segment is not uuid-shaped even if the overall length matches', () => {
    const bogusId = 'z'.repeat(36)
    const token = `ht_asst_${bogusId}_somesecret`
    expect(parseAssistantToken(token)).toBeNull()
  })
})

describe('constantTimeHashEquals', () => {
  it('true for identical digests, false for a mismatch or a length difference', () => {
    const h1 = hashAssistantSecret('secret-a')
    const h2 = hashAssistantSecret('secret-a')
    const h3 = hashAssistantSecret('secret-b')
    expect(constantTimeHashEquals(h1, h2)).toBe(true)
    expect(constantTimeHashEquals(h1, h3)).toBe(false)
    expect(constantTimeHashEquals(h1, h1.slice(0, -2))).toBe(false)
  })
})
