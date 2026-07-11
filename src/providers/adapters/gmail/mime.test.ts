/**
 * The wire-level `Message-ID` contract test `specs/mail/sending.md` §4
 * requires of every real `EmailSender` adapter — see `mime.ts`'s module doc
 * for exactly which mimetext API makes this hold. `messageId` here is a
 * REAL token minted by `mintReplyMessageId` (the same function
 * `src/mail/send.ts` calls on the write path), not a hand-rolled
 * look-alike, so this test proves the actual production token format
 * survives `buildRawMessage` unaltered.
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Keyring, mintReplyMessageId } from '../../../mail/reply-token.js'
import type { OutboundEmail } from '../../email-sender.js'
import { buildRawMessage } from './mime.js'

const keyring: Keyring = {
  current: { keyId: 'k1', secret: 'a-high-entropy-test-secret-0123456789' },
}

const messageId = mintReplyMessageId(
  { conversationId: randomUUID(), threadId: randomUUID(), mailDomain: 'mail.example.test' },
  keyring,
)

/** Shared minimal fields; each test adds the body/headers it's exercising. */
const base: OutboundEmail = {
  messageId,
  from: 'support@example.test',
  to: ['customer@example.test'],
  subject: 'Re: Help with my order',
}

/** Strip RFC 5322 header folding (a CRLF immediately before folding WSP) to recover the logical value. */
function unfold(raw: string): string {
  return raw.replace(/\r\n(?=[ \t])/g, '')
}

/** base64 of a UTF-8 string — how `buildRawMessage` encodes short bodies (single line, so it appears verbatim). */
function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

/** The longest physical line (RFC 5322 §2.1.1 caps this at 998 octets, excluding the CRLF). */
function maxLineLength(raw: string): number {
  return Math.max(...raw.split('\r\n').map((l) => l.length))
}

describe('buildRawMessage', () => {
  it('embeds the engine-minted Message-ID byte-for-byte, exactly once', () => {
    const raw = buildRawMessage({ ...base, text: 'body' })

    expect(raw).toContain(`Message-ID: ${messageId}`)
    expect(raw.match(/Message-ID:/g)).toHaveLength(1)
  })

  it('embeds In-Reply-To verbatim; References (possibly folded) unfolds to the space-joined chain', () => {
    const inReplyTo = '<inbound-1@customer.example.test>'
    const references = ['<inbound-0@customer.example.test>', inReplyTo]

    const raw = buildRawMessage({ ...base, text: 'body', inReplyTo, references })

    expect(raw).toContain(`In-Reply-To: ${inReplyTo}`)
    // References may be folded across continuation lines (CRLF + WSP); RFC
    // unfolding (strip the CRLF before folding WSP) must recover exactly the
    // space-joined chain.
    expect(unfold(raw)).toContain(`References: ${references.join(' ')}`)
  })

  it('omits In-Reply-To and References entirely when not supplied', () => {
    const raw = buildRawMessage({ ...base, text: 'body' })

    expect(raw).not.toContain('In-Reply-To:')
    expect(raw).not.toContain('References:')
  })

  it('includes a Cc header with the given addresses when cc is supplied', () => {
    const raw = buildRawMessage({
      ...base,
      text: 'body',
      cc: ['cc1@example.test', 'cc2@example.test'],
    })

    expect(raw).toContain('Cc:')
    expect(raw).toContain('cc1@example.test')
    expect(raw).toContain('cc2@example.test')
  })

  it('omits the Cc header entirely when cc is not supplied', () => {
    const raw = buildRawMessage({ ...base, text: 'body' })

    expect(raw).not.toContain('Cc:')
  })

  it('produces multipart/alternative with both parts, each base64-encoded', () => {
    const raw = buildRawMessage({ ...base, text: 'plain body', html: '<p>html body</p>' })

    expect(raw).toContain('Content-Type: multipart/alternative')
    expect(raw).toContain('Content-Type: text/plain')
    expect(raw).toContain('Content-Type: text/html')
    expect(raw).toContain('Content-Transfer-Encoding: base64')
    // Bodies are base64-encoded (line-safe), not written as literal text.
    expect(raw).not.toContain('plain body')
    expect(raw).not.toContain('<p>html body</p>')
    expect(raw).toContain(b64('plain body'))
    expect(raw).toContain(b64('<p>html body</p>'))
  })

  it('produces a single base64 text/plain part (no multipart) when only text is given', () => {
    const raw = buildRawMessage({ ...base, text: 'plain only, no html' })

    expect(raw).not.toContain('multipart/alternative')
    expect(raw).toContain('Content-Type: text/plain')
    expect(raw).toContain('Content-Transfer-Encoding: base64')
    expect(raw).toContain(b64('plain only, no html'))
  })

  it('produces a single base64 text/html part (no multipart) when only html is given', () => {
    const raw = buildRawMessage({ ...base, html: '<p>html only, no text</p>' })

    expect(raw).not.toContain('multipart/alternative')
    expect(raw).toContain('Content-Type: text/html')
    expect(raw).toContain(b64('<p>html only, no text</p>'))
  })

  it('throws when neither text nor html is provided', () => {
    expect(() => buildRawMessage({ ...base })).toThrow(/text\/html/)
  })

  it('RFC-2047 encodes a non-ASCII subject as an encoded-word, not literal UTF-8', () => {
    const subject = 'Re: café ☕ update'
    const raw = buildRawMessage({ ...base, subject, text: 'body' })

    // The raw header line must NOT contain the literal UTF-8 subject...
    expect(raw).not.toContain(subject)
    // ...it must instead be a base64 encoded-word...
    const match = raw.match(/Subject: (=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=)/i)
    expect(match).not.toBeNull()
    // ...that decodes back to the exact original subject.
    const encodedWord = match?.[1] ?? ''
    const b64 = encodedWord.replace(/^=\?utf-8\?B\?/i, '').replace(/\?=$/i, '')
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(subject)
  })

  it('base64url round-trips to the exact raw string (the encoding Gmail requires)', () => {
    const raw = buildRawMessage({ ...base, text: 'hello world' })

    const encoded = Buffer.from(raw, 'utf8').toString('base64url')
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')

    expect(decoded).toBe(raw)
  })

  it('uses CRLF line endings throughout, regardless of host OS', () => {
    // See mime.ts's module doc: mimetext's default Node entrypoint ties EOL
    // to node:os's EOL (LF on Linux/macOS), which would silently violate
    // RFC 5322 in production (Vercel runs Linux). We import mimetext/browser
    // specifically to avoid that; this test guards the choice.
    const raw = buildRawMessage({ ...base, text: 'hello' })

    expect(raw).toContain('\r\n')
    expect(raw).not.toMatch(/(?<!\r)\n/)
  })

  // --- header-injection guard (CR/LF in a header value would forge extra header lines) -------------------------------

  describe('header-injection guard', () => {
    const CRLF_INJECTION = 'x@example.test\r\nBcc: attacker@evil.test'

    const MSGID_INJECTION = '<a@x.test>\r\nBcc: attacker@evil.test'

    // REQUIRED headers (from/to/cc/messageId) THROW on a CR/LF — a malformed one
    // of these is a genuine can't-send.
    it.each([
      ['from', { from: CRLF_INJECTION }],
      ['to', { to: [CRLF_INJECTION] }],
      ['cc', { cc: [CRLF_INJECTION] }],
      ['messageId', { messageId: MSGID_INJECTION }],
    ])('throws when a REQUIRED header (%s) carries a CR/LF', (_label, override) => {
      expect(() => buildRawMessage({ ...base, text: 'body', ...override })).toThrow(/injection/i)
    })

    // ADVISORY headers (In-Reply-To/References) DROP a poisoned atom instead of
    // throwing — throwing would let one crafted stored msg-id DoS every reply to
    // that conversation. The header is omitted; nothing injects onto the wire.
    it('drops (does not throw on) an In-Reply-To with a CR/LF; injects nothing', () => {
      const raw = buildRawMessage({ ...base, text: 'body', inReplyTo: MSGID_INJECTION })
      expect(raw).not.toContain('In-Reply-To:')
      expect(raw).not.toContain('Bcc:')
    })

    it('drops only the poisoned References atom, keeps the clean one, injects nothing', () => {
      const good = '<clean@customer.example.test>'
      const raw = buildRawMessage({ ...base, text: 'body', references: [good, MSGID_INJECTION] })
      expect(raw).not.toContain('Bcc:')
      expect(raw).not.toContain('attacker@evil.test')
      expect(unfold(raw)).toContain(`References: ${good}`)
    })

    it('also rejects a bare control character (e.g. NUL) in a header atom', () => {
      expect(() =>
        buildRawMessage({ ...base, text: 'body', from: 'x@example.test\u0000' }),
      ).toThrow(/injection/i)
    })

    // SUBJECT is attacker-influenced (derived from the inbound Subject), so it
    // is SANITIZED (control chars stripped to spaces), never thrown on — a
    // throw would let one crafted subject block every reply to its
    // conversation. Defense in depth: mimetext also RFC-2047-encodes EVERY
    // subject (ASCII included) into a single base64 encoded-word, which this
    // test locks — if a mimetext upgrade ever stops encoding ASCII subjects,
    // the encoded-word assertion below fails and flags the changed behavior.
    it('sanitizes (does not throw on) a subject with CR/LF; injects nothing', () => {
      const subject = 'evil\r\nBcc: attacker@evil.test'
      const raw = buildRawMessage({ ...base, text: 'body', subject })

      // No forged header line anywhere in the output...
      expect(raw).not.toContain('Bcc:')
      // ...the Subject went out as a single RFC-2047 encoded-word...
      const match = raw.match(/^Subject: =\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=$/m)
      expect(match).not.toBeNull()
      // ...whose decoded content carries spaces where the CR/LF was — the
      // attack text survives only as inert literal characters INSIDE the
      // encoded subject, never as wire-level structure.
      const decoded = Buffer.from((match as RegExpMatchArray)[1], 'base64').toString('utf8')
      expect(decoded).toBe('evil  Bcc: attacker@evil.test')
    })
  })

  // --- msg-id length bound (an overlong atom cannot be folded under the 998-octet line limit) --

  it('drops an absurdly long In-Reply-To / References atom so no line exceeds 998', () => {
    const huge = `<${'a'.repeat(5000)}@x.test>`
    const raw = buildRawMessage({
      ...base,
      text: 'body',
      inReplyTo: huge,
      references: [huge, '<ok@x.test>'],
    })
    expect(maxLineLength(raw)).toBeLessThanOrEqual(998)
    expect(raw).not.toContain('In-Reply-To:') // the huge inReplyTo was dropped
    expect(unfold(raw)).toContain('References: <ok@x.test>') // only the sane ref survives
  })

  it('throws on an absurdly long messageId (our own token — over-long is an internal bug)', () => {
    const huge = `<${'a'.repeat(5000)}@x.test>`
    expect(() => buildRawMessage({ ...base, text: 'body', messageId: huge })).toThrow(/octet/i)
  })

  it('throws when a required address (to/from) exceeds the octet bound', () => {
    const hugeAddr = `${'a'.repeat(600)}@x.test`
    expect(() => buildRawMessage({ ...base, text: 'body', to: [hugeAddr] })).toThrow(/octet/i)
  })

  it('bounds atoms in OCTETS, not JS chars: a multibyte References atom over 512 bytes is dropped', () => {
    // 300 × the 3-byte "☕" is ~908 octets but only ~309 JS chars — a char-based
    // bound (<= 512) would wrongly admit it and blow the 998-OCTET line limit.
    const multibyte = `<${'☕'.repeat(300)}@x.test>`
    expect(multibyte.length).toBeLessThanOrEqual(512)
    const raw = buildRawMessage({ ...base, text: 'body', references: [multibyte, '<ok@x.test>'] })

    const maxOctets = Math.max(...raw.split('\r\n').map((l) => Buffer.byteLength(l, 'utf8')))
    expect(maxOctets).toBeLessThanOrEqual(998)
    expect(unfold(raw)).toContain('References: <ok@x.test>') // multibyte dropped, clean kept
  })

  it('truncates a pathologically long subject so its (single, unfolded) line stays within 998 octets', () => {
    const raw = buildRawMessage({ ...base, subject: 'A'.repeat(5000), text: 'body' })

    const subjectLine = raw.split('\r\n').find((l) => l.startsWith('Subject:')) ?? ''
    expect(subjectLine).not.toBe('')
    expect(Buffer.byteLength(subjectLine, 'utf8')).toBeLessThanOrEqual(998)
  })

  // --- line-length safety (RFC 5322 998-octet line limit) ---------------------------------------

  it('a very long body line stays within the RFC 5322 998-octet limit (base64 wraps it)', () => {
    const longLine = `https://example.test/${'a'.repeat(3000)}`
    const raw = buildRawMessage({ ...base, html: `<a href="${longLine}">x</a>` })

    expect(maxLineLength(raw)).toBeLessThanOrEqual(998)
    // base64 body lines are wrapped at 76.
    const bodyMax = Math.max(
      ...raw
        .split('\r\n\r\n')[1]
        .split('\r\n')
        .map((l) => l.length),
    )
    expect(bodyMax).toBeLessThanOrEqual(76)
  })

  it('a long References chain is folded, stays within 998, and unfolds to the space-joined chain', () => {
    const references = Array.from(
      { length: 40 },
      (_, i) => `<msg-${i}-${'a'.repeat(20)}@example.test>`,
    )
    const raw = buildRawMessage({ ...base, text: 'body', references })

    expect(maxLineLength(raw)).toBeLessThanOrEqual(998)
    expect(unfold(raw)).toContain(`References: ${references.join(' ')}`)
  })
})
