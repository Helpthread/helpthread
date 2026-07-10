import { describe, expect, it } from 'vitest'
import {
  assertValidKeyring,
  isReplyTokenShaped,
  type Keyring,
  mintReplyMessageId,
  type SigningKey,
  verifyReplyMessageId,
} from './reply-token.js'

// --- fixtures -------------------------------------------------------------

/** A generic valid (≥32-char) secret for tests not exercising secret strength. */
const VALID_SECRET = 'valid-secret-0123456789abcdefghijklmno'

const KEY_A: SigningKey = { keyId: 'k1', secret: 'secret-A-high-entropy-0123456789abcdef' }
const KEY_B: SigningKey = { keyId: 'k2', secret: 'secret-B-high-entropy-fedcba9876543210' }

const ringA: Keyring = { current: KEY_A }
const ringB: Keyring = { current: KEY_B }

const PAYLOAD = { conversationId: 'c42', threadId: 't7', mailDomain: 'mail.example.test' }

/** Flip one character in a string at `index` (deterministically, to a different char). */
function flipChar(s: string, index: number): string {
  const c = s[index]
  const replacement = c === 'A' ? 'B' : 'A'
  return s.slice(0, index) + replacement + s.slice(index + 1)
}

/** Pull the five local-part segments out of a minted `<ht...@domain>` id. */
function segments(messageId: string): { local: string; domain: string; parts: string[] } {
  const inner = messageId.slice(1, -1)
  const [local, domain] = inner.split('@')
  return { local, domain, parts: local.split('.') }
}

/** Reassemble a Message-ID from five segments + domain. */
function reassemble(parts: string[], domain: string): string {
  return `<${parts.join('.')}@${domain}>`
}

// --- round-trip -----------------------------------------------------------

describe('round-trip', () => {
  it('mint → verify recovers the exact payload', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    expect(verifyReplyMessageId(id, ringA)).toEqual({
      keyId: 'k1',
      conversationId: 'c42',
      threadId: 't7',
    })
  })

  it('minted id has angle brackets and the ht. prefix', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    expect(id.startsWith('<ht.')).toBe(true)
    expect(id.endsWith('@mail.example.test>')).toBe(true)
  })

  it('matches the documented shape regex and still round-trips', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    expect(id).toMatch(/^<ht\.[^.]+\.[^.]+\.[^.]+\.[^.]+@[^>]+>$/)
    expect(verifyReplyMessageId(id, ringA)).not.toBeNull()
  })

  it('signature is full 32-byte HMAC → 43-char unpadded base64url', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts } = segments(id)
    const sig = parts[4]
    expect(sig).toHaveLength(43)
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/) // base64url alphabet, no padding
  })
})

// --- tampering: each segment independently --------------------------------

describe('tampering returns null', () => {
  it('tampered keyId → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[1] = `${parts[1]}x` // k1 → k1x (unknown key), signature no longer matches
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('tampered conversationId → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[2] = 'c99'
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('tampered threadId → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[3] = 't8'
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('tampered sig (flip one char) → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[4] = flipChar(parts[4], 0)
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('a same-length garbage sig → null (length guard path exercised on equal lengths)', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[4] = 'A'.repeat(parts[4].length)
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('a wrong-LENGTH sig with a known keyId → null (timingSafeEqual length guard)', () => {
    // keyId still matches KEY_A, so signatureMatches IS reached — but the sig
    // is short, so the length guard must reject instead of letting
    // timingSafeEqual throw on unequal-length buffers.
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[4] = 'AAA'
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })
})

// --- wrong / unknown / rotated keys --------------------------------------

describe('key handling', () => {
  it('wrong secret (same keyId, different secret) → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const imposter: Keyring = {
      current: { keyId: 'k1', secret: 'a-completely-different-secret-0123456789' },
    }
    expect(verifyReplyMessageId(id, imposter)).toBeNull()
  })

  it("unknown keyId (token's key not in ring) → null", () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    expect(verifyReplyMessageId(id, ringB)).toBeNull()
  })

  it('rotation: mint with A, then A retired + B current → still verifies', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const rotated: Keyring = { current: KEY_B, retired: [KEY_A] }
    expect(verifyReplyMessageId(id, rotated)).toEqual({
      keyId: 'k1',
      conversationId: 'c42',
      threadId: 't7',
    })
  })

  it('rotation: after A is dropped from the ring entirely → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const droppedA: Keyring = { current: KEY_B, retired: [] }
    expect(verifyReplyMessageId(id, droppedA)).toBeNull()
  })

  it('verifies against a retired key even when current has a different secret for reuse of keyId', () => {
    // Defensive: multiple keys may match a keyId; the matching secret wins.
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const ring: Keyring = {
      current: { keyId: 'k9', secret: 'k9-current-secret-0123456789abcdefghij' },
      retired: [KEY_A],
    }
    expect(verifyReplyMessageId(id, ring)).not.toBeNull()
  })
})

// --- non-token Message-IDs → null ----------------------------------------

describe('non-token Message-IDs → null', () => {
  it('a Gmail-style Message-ID → null', () => {
    expect(
      verifyReplyMessageId('<CABc123def456ghi789jkl0mn=someone@mail.gmail.com>', ringA),
    ).toBeNull()
  })

  it('empty string → null', () => {
    expect(verifyReplyMessageId('', ringA)).toBeNull()
  })

  it('<> → null', () => {
    expect(verifyReplyMessageId('<>', ringA)).toBeNull()
  })

  it('4 segments → null', () => {
    expect(verifyReplyMessageId('<ht.k1.c42.t7@mail.example.test>', ringA)).toBeNull()
  })

  it('6 segments → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts.splice(3, 0, 'extra') // inject a sixth segment
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('missing ht. prefix → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[0] = 'xx'
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('a . injected into the conversationId position → null (becomes 6 segments)', () => {
    // A hostile token trying to smuggle a dot into an id splits into too many parts.
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[2] = 'c4.2'
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('no @domain → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { local } = segments(id)
    expect(verifyReplyMessageId(`<${local}>`, ringA)).toBeNull()
  })

  it('empty domain (trailing @) → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { local } = segments(id)
    expect(verifyReplyMessageId(`<${local}@>`, ringA)).toBeNull()
  })

  it('multiple @ → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { local, domain } = segments(id)
    expect(verifyReplyMessageId(`<${local}@evil@${domain}>`, ringA)).toBeNull()
  })

  it('no angle brackets → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    expect(verifyReplyMessageId(id.slice(1, -1), ringA)).toBeNull()
  })

  it('missing opening bracket → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    expect(verifyReplyMessageId(id.slice(1), ringA)).toBeNull()
  })

  it('missing closing bracket → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    expect(verifyReplyMessageId(id.slice(0, -1), ringA)).toBeNull()
  })

  it('empty keyId segment (ht..c.t.sig) → null', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[1] = ''
    expect(verifyReplyMessageId(reassemble(parts, domain), ringA)).toBeNull()
  })

  it('a plain bare word → null', () => {
    expect(verifyReplyMessageId('not-a-message-id', ringA)).toBeNull()
  })
})

// --- mint input validation → throws --------------------------------------

describe('mint input validation throws', () => {
  it('conversationId containing . → throws', () => {
    expect(() => mintReplyMessageId({ ...PAYLOAD, conversationId: 'c.42' }, ringA)).toThrow(
      /conversationId/,
    )
  })

  it('conversationId containing @ → throws', () => {
    expect(() => mintReplyMessageId({ ...PAYLOAD, conversationId: 'c@42' }, ringA)).toThrow(
      /conversationId/,
    )
  })

  it('empty conversationId → throws', () => {
    expect(() => mintReplyMessageId({ ...PAYLOAD, conversationId: '' }, ringA)).toThrow(
      /conversationId/,
    )
  })

  it('threadId containing . → throws', () => {
    expect(() => mintReplyMessageId({ ...PAYLOAD, threadId: 't.7' }, ringA)).toThrow(/threadId/)
  })

  it('empty threadId → throws', () => {
    expect(() => mintReplyMessageId({ ...PAYLOAD, threadId: '' }, ringA)).toThrow(/threadId/)
  })

  it('threadId containing angle bracket → throws', () => {
    expect(() => mintReplyMessageId({ ...PAYLOAD, threadId: 't<7' }, ringA)).toThrow(/threadId/)
  })

  it('keyId containing . → throws', () => {
    const badRing: Keyring = { current: { keyId: 'k.1', secret: VALID_SECRET } }
    expect(() => mintReplyMessageId(PAYLOAD, badRing)).toThrow(/keyId/)
  })

  it('empty keyId → throws', () => {
    const badRing: Keyring = { current: { keyId: '', secret: VALID_SECRET } }
    expect(() => mintReplyMessageId(PAYLOAD, badRing)).toThrow(/keyId/)
  })

  it('invalid mailDomain (@) → throws', () => {
    expect(() => mintReplyMessageId({ ...PAYLOAD, mailDomain: 'a@b' }, ringA)).toThrow(/mailDomain/)
  })

  it('empty mailDomain → throws', () => {
    expect(() => mintReplyMessageId({ ...PAYLOAD, mailDomain: '' }, ringA)).toThrow(/mailDomain/)
  })
})

// --- determinism & distinctness ------------------------------------------

describe('determinism & distinctness', () => {
  it('minting the same payload+key twice is identical (HMAC is deterministic)', () => {
    expect(mintReplyMessageId(PAYLOAD, ringA)).toBe(mintReplyMessageId(PAYLOAD, ringA))
  })

  it('different conversationId → different sig', () => {
    const a = mintReplyMessageId(PAYLOAD, ringA)
    const b = mintReplyMessageId({ ...PAYLOAD, conversationId: 'c43' }, ringA)
    expect(segments(a).parts[4]).not.toBe(segments(b).parts[4])
  })

  it('different threadId → different sig', () => {
    const a = mintReplyMessageId(PAYLOAD, ringA)
    const b = mintReplyMessageId({ ...PAYLOAD, threadId: 't8' }, ringA)
    expect(segments(a).parts[4]).not.toBe(segments(b).parts[4])
  })

  it('different key → different sig for the same payload', () => {
    const a = mintReplyMessageId(
      { ...PAYLOAD },
      { current: { keyId: 'k1', secret: 'secret-one-0123456789abcdefghijklmno' } },
    )
    const b = mintReplyMessageId(
      { ...PAYLOAD },
      { current: { keyId: 'k1', secret: 'secret-two-0123456789abcdefghijklmno' } },
    )
    expect(segments(a).parts[4]).not.toBe(segments(b).parts[4])
  })

  it('mailDomain is not signed: same payload, different domain → same sig', () => {
    const a = mintReplyMessageId(PAYLOAD, ringA)
    const b = mintReplyMessageId({ ...PAYLOAD, mailDomain: 'other.example.test' }, ringA)
    expect(segments(a).parts[4]).toBe(segments(b).parts[4])
  })
})

// --- keyring validation (Codex/CodeRabbit adversarial findings) -----------

describe('keyring validation', () => {
  it('duplicate keyId in the ring → throws (rotation must use a new keyId)', () => {
    const ring: Keyring = {
      current: { keyId: 'k1', secret: VALID_SECRET },
      retired: [{ keyId: 'k1', secret: 'a-different-old-secret-0123456789abcd' }],
    }
    expect(() => assertValidKeyring(ring)).toThrow(/duplicate keyId/)
    // and the entry points that consume a keyring reject it too
    expect(() => mintReplyMessageId(PAYLOAD, ring)).toThrow(/duplicate keyId/)
    expect(() => verifyReplyMessageId('<ht.k1.c.t.AAA@x.test>', ring)).toThrow(/duplicate keyId/)
  })

  it('empty secret → throws (HMAC key must be strong)', () => {
    const ring: Keyring = { current: { keyId: 'k1', secret: '' } }
    expect(() => mintReplyMessageId(PAYLOAD, ring)).toThrow(/secret/)
  })

  it('short secret (< 32 chars) → throws', () => {
    const ring: Keyring = { current: { keyId: 'k1', secret: 'too-short' } }
    expect(() => mintReplyMessageId(PAYLOAD, ring)).toThrow(/secret/)
  })

  it('a leaked old secret cannot be revived under a live keyId', () => {
    // Rotating correctly (new keyId) means a token forged with the old, leaked
    // secret carries the OLD keyId — which is no longer in the ring → null.
    const leaked: Keyring = {
      current: { keyId: 'old', secret: 'leaked-secret-0123456789abcdefghijkl' },
    }
    const forged = mintReplyMessageId(PAYLOAD, leaked)
    const rotated: Keyring = {
      current: { keyId: 'new', secret: 'fresh-secret-0123456789abcdefghijklmn' },
    }
    expect(verifyReplyMessageId(forged, rotated)).toBeNull()
  })

  it('retired is not an array → throws', () => {
    // Deliberately malformed config (simulating an untyped source / bad JSON).
    const ring = { current: KEY_A, retired: {} as unknown as SigningKey[] }
    expect(() => assertValidKeyring(ring)).toThrow(/retired/)
  })
})

// --- isReplyTokenShaped: structural check, no signature verification ------

describe('isReplyTokenShaped', () => {
  it('a genuine, verifiable token → true', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    expect(isReplyTokenShaped(id)).toBe(true)
  })

  it('a shaped-but-forged token (tampered sig) → still true (shape only, no sig check)', () => {
    const id = mintReplyMessageId(PAYLOAD, ringA)
    const { parts, domain } = segments(id)
    parts[4] = flipChar(parts[4], 0)
    const forged = reassemble(parts, domain)
    expect(isReplyTokenShaped(forged)).toBe(true)
    expect(verifyReplyMessageId(forged, ringA)).toBeNull()
  })

  it('a Gmail-style Message-ID → false', () => {
    expect(isReplyTokenShaped('<CABc123def456ghi789jkl0mn=someone@mail.gmail.com>')).toBe(false)
  })

  it('junk / non-token strings → false', () => {
    expect(isReplyTokenShaped('not-a-message-id')).toBe(false)
    expect(isReplyTokenShaped('')).toBe(false)
    expect(isReplyTokenShaped('<>')).toBe(false)
    expect(isReplyTokenShaped('<ht.k1.c42.t7@mail.example.test>')).toBe(false) // 4 segments
  })
})

// --- non-string mint inputs (CodeRabbit: RegExp.test coerces) -------------

describe('non-string mint inputs are rejected', () => {
  it('non-string conversationId → throws (not silently coerced)', () => {
    // Simulate an untyped JS caller passing a non-string id.
    expect(() =>
      mintReplyMessageId({ ...PAYLOAD, conversationId: undefined as unknown as string }, ringA),
    ).toThrow(/conversationId/)
    expect(() =>
      mintReplyMessageId({ ...PAYLOAD, threadId: 42 as unknown as string }, ringA),
    ).toThrow(/threadId/)
  })
})

// --- malformed mail domains (Codex/CodeRabbit) ---------------------------

describe('malformed mail domains → throw', () => {
  for (const bad of ['..', '.', 'a..b', '-x.test', 'x-.test', 'a.', '.a']) {
    it(`rejects mailDomain ${JSON.stringify(bad)}`, () => {
      expect(() => mintReplyMessageId({ ...PAYLOAD, mailDomain: bad }, ringA)).toThrow(/mailDomain/)
    })
  }

  it('accepts a normal domain', () => {
    expect(() =>
      mintReplyMessageId({ ...PAYLOAD, mailDomain: 'mail.helpthread.dev' }, ringA),
    ).not.toThrow()
  })
})
