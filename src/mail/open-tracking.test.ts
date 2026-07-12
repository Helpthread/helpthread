import { describe, expect, it } from 'vitest'
import {
  injectTrackingPixel,
  mintViewToken,
  pixelPathFor,
  pixelUrlFor,
  TRANSPARENT_GIF,
  verifyViewToken,
} from './open-tracking.js'
import { type Keyring, mintReplyMessageId } from './reply-token.js'

const KEYRING: Keyring = { current: { keyId: 'k1', secret: 'a'.repeat(32) } }
const THREAD_ID = '9f000000-0000-4000-8000-000000000001'

describe('view tokens', () => {
  it('mint → verify round-trips the threadId', () => {
    const token = mintViewToken(THREAD_ID, KEYRING)
    expect(verifyViewToken(token, KEYRING)).toEqual({ threadId: THREAD_ID })
  })

  it('is total over hostile input: garbage, wrong shape, and empty segments all return null, never throw', () => {
    for (const bad of [
      '',
      'not-a-token',
      'v.k1.only-three',
      'v.k1.thread.sig.extra',
      'x.k1.thread.sig',
      'v..thread.sig',
      `v.k1.${THREAD_ID}.`,
      '<script>alert(1)</script>',
    ]) {
      expect(verifyViewToken(bad, KEYRING)).toBeNull()
    }
  })

  it('a tampered threadId, keyId, or signature is rejected', () => {
    const token = mintViewToken(THREAD_ID, KEYRING)
    const [prefix, keyId, threadId, sig] = token.split('.')
    expect(
      verifyViewToken(`${prefix}.${keyId}.9f000000-0000-4000-8000-000000000002.${sig}`, KEYRING),
    ).toBeNull()
    expect(verifyViewToken(`${prefix}.k2.${threadId}.${sig}`, KEYRING)).toBeNull()
    expect(
      verifyViewToken(`${prefix}.${keyId}.${threadId}.${'A'.repeat(sig.length)}`, KEYRING),
    ).toBeNull()
  })

  it('domain separation: a reply-token signature over the same ids can never verify as a view token', () => {
    // Mint a REPLY token for a conversation/thread pair, lift its signature,
    // and try to pass it off as a view token for the same threadId. The
    // `view.` canonical prefix makes the signatures disjoint by construction.
    const conversationId = '9f000000-0000-4000-8000-00000000000c'
    const replyMessageId = mintReplyMessageId(
      { conversationId, threadId: THREAD_ID, mailDomain: 'mail.example.test' },
      KEYRING,
    )
    const replySig = replyMessageId.slice(1, -1).split('@')[0].split('.')[4]
    expect(verifyViewToken(`v.k1.${THREAD_ID}.${replySig}`, KEYRING)).toBeNull()
  })

  it('rotation: a retired key still verifies; a dropped key does not', () => {
    const token = mintViewToken(THREAD_ID, KEYRING)
    const rotated: Keyring = {
      current: { keyId: 'k2', secret: 'b'.repeat(32) },
      retired: [KEYRING.current],
    }
    expect(verifyViewToken(token, rotated)).toEqual({ threadId: THREAD_ID })
    const dropped: Keyring = { current: { keyId: 'k2', secret: 'b'.repeat(32) } }
    expect(verifyViewToken(token, dropped)).toBeNull()
  })

  it('minting is strict: a malformed threadId throws', () => {
    expect(() => mintViewToken('has.a.dot', KEYRING)).toThrow()
    expect(() => mintViewToken('', KEYRING)).toThrow()
  })
})

describe('pixel injection & url', () => {
  it('injects immediately before the last </body> when present, preserving everything else', () => {
    const html = '<html><body><p>Hi</p></body></html>'
    const out = injectTrackingPixel(html, 'https://x.test/api/v1/t/tok.gif')
    expect(out).toBe(
      '<html><body><p>Hi</p><img src="https://x.test/api/v1/t/tok.gif" width="1" height="1" alt="" style="display:none"></body></html>',
    )
  })

  it('appends when there is no closing body tag; matches </BODY> case-insensitively', () => {
    expect(injectTrackingPixel('<p>Hi</p>', 'u')).toBe(
      '<p>Hi</p><img src="u" width="1" height="1" alt="" style="display:none">',
    )
    const upper = injectTrackingPixel('<BODY>x</BODY>', 'u')
    expect(upper).toBe(
      '<BODY>x<img src="u" width="1" height="1" alt="" style="display:none"></BODY>',
    )
  })

  it('pixelUrlFor tolerates a trailing slash on the base url', () => {
    expect(pixelUrlFor('https://x.test/', 'tok')).toBe('https://x.test/api/v1/t/tok.gif')
    expect(pixelUrlFor('https://x.test', 'tok')).toBe('https://x.test/api/v1/t/tok.gif')
    expect(pixelPathFor('tok')).toBe('/api/v1/t/tok.gif')
  })
})

describe('the gif', () => {
  it('is a real 1×1 GIF89a payload', () => {
    expect(TRANSPARENT_GIF.length).toBe(42)
    expect(TRANSPARENT_GIF.subarray(0, 6).toString('ascii')).toBe('GIF89a')
    // 1×1 dimensions, little-endian, immediately after the signature.
    expect(TRANSPARENT_GIF.readUInt16LE(6)).toBe(1)
    expect(TRANSPARENT_GIF.readUInt16LE(8)).toBe(1)
  })
})
