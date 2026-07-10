import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseInboundEmail } from './parse.js'

const fixturesDir = fileURLToPath(new URL('../../tests/mail/fixtures/', import.meta.url))

function loadFixture(name: string): string {
  return readFileSync(`${fixturesDir}${name}.eml`, 'utf8')
}

describe('parseInboundEmail', () => {
  // (a) plain-text simple: From/To/Subject/Message-ID/Date + body.
  it('parses a simple plain-text message', async () => {
    const parsed = await parseInboundEmail(loadFixture('plain-text-simple'))

    expect(parsed.messageId).toBe('<msg-a-0001@example.test>')
    expect(parsed.inReplyTo).toBeNull()
    expect(parsed.references).toEqual([])
    expect(parsed.from).toEqual({ address: 'alice@example.test', name: 'Alice Sender' })
    expect(parsed.to).toEqual([{ address: 'bob@example.test', name: 'Bob Receiver' }])
    expect(parsed.cc).toEqual([])
    expect(parsed.subject).toBe('Plain text simple message')
    expect(parsed.date).toBeInstanceOf(Date)
    expect(parsed.date?.toISOString()).toBe('2026-06-01T12:00:00.000Z')
    expect(parsed.text).toContain('This is a simple plain-text message body.')
    expect(parsed.html).toBeNull()
    expect(parsed.attachments).toEqual([])
    expect(parsed.headers.from).toBe('Alice Sender <alice@example.test>')
    expect(parsed.headers['message-id']).toBe('<msg-a-0001@example.test>')
  })

  // (b) multipart/alternative with BOTH text and html parts.
  it('parses multipart/alternative, capturing both text and html', async () => {
    const parsed = await parseInboundEmail(loadFixture('multipart-alternative'))

    expect(parsed.text).toContain('This is the plain text alternative.')
    expect(parsed.html).toContain('This is the <strong>HTML</strong> alternative.')
  })

  // (c) html body containing <script>alert(1)</script> — must be captured
  // verbatim; sanitization is explicitly NOT this parser's job.
  it('captures a <script> tag in the html body verbatim, unsanitized', async () => {
    const parsed = await parseInboundEmail(loadFixture('html-script-body'))

    expect(parsed.html).toContain('<script>alert(1)</script>')
  })

  // (d) In-Reply-To + a multi-id References header (whitespace/newline
  // separated) — the threading-critical fields.
  it('surfaces inReplyTo verbatim and references as an ordered array', async () => {
    const parsed = await parseInboundEmail(loadFixture('threading-headers'))

    expect(parsed.messageId).toBe('<msg-d-0004@example.test>')
    expect(parsed.inReplyTo).toBe('<msg-d-0003@example.test>')
    expect(parsed.references).toEqual([
      '<msg-d-0001@example.test>',
      '<msg-d-0002@example.test>',
      '<msg-d-0003@example.test>',
    ])
  })

  // (e) a base64 attachment — filename, contentType, size, and byte
  // round-trip.
  it('parses a base64 attachment with byte-exact round-trip', async () => {
    const parsed = await parseInboundEmail(loadFixture('attachment'))

    expect(parsed.attachments).toHaveLength(1)
    const [attachment] = parsed.attachments
    expect(attachment.filename).toBe('hello.txt')
    expect(attachment.contentType).toBe('text/plain')
    expect(attachment.disposition).toBe('attachment')
    expect(attachment.contentId).toBeNull()
    expect(attachment.size).toBe(13)
    expect(attachment.content).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(attachment.content)).toBe('Hello, world!')
    expect(attachment.content.byteLength).toBe(attachment.size)
  })

  // (f) an encoded-word Subject (=?UTF-8?B?...?=) decodes.
  it('decodes an encoded-word subject', async () => {
    const parsed = await parseInboundEmail(loadFixture('encoded-word-subject'))

    expect(parsed.subject).toBe('Hello, World!')
  })

  // (g) a quoted-printable text body decodes (encoded octet + soft line
  // break join).
  it('decodes a quoted-printable text body', async () => {
    const parsed = await parseInboundEmail(loadFixture('quoted-printable-body'))

    expect(parsed.text).toContain(
      'This body has an € euro sign and a soft line break that should join.',
    )
    expect(parsed.text).not.toContain('=E2=82=AC')
    expect(parsed.text).not.toContain('=\n')
  })

  // (h) missing optional headers (no In-Reply-To, no References, no Cc) —
  // must not throw, and must normalize to the documented absent values.
  it('normalizes missing optional headers without throwing', async () => {
    const parsed = await parseInboundEmail(loadFixture('missing-optional-headers'))

    expect(parsed.inReplyTo).toBeNull()
    expect(parsed.references).toEqual([])
    expect(parsed.cc).toEqual([])
  })

  // Supplementary: postal-mime's own multi-value header convention (no
  // per-field record built in) means this module's Record<string,string>
  // join is our own choice — verify it explicitly.
  it('joins repeated header names with ", " in the headers record', async () => {
    const raw = [
      'From: Dup Sender <dup@example.test>',
      'To: rcpt@example.test',
      'Subject: Dup header test',
      'Message-ID: <msg-dup-0001@example.test>',
      'X-Custom: first',
      'X-Custom: second',
      'Date: Mon, 01 Jun 2026 12:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '',
    ].join('\n')

    const parsed = await parseInboundEmail(raw)

    expect(parsed.headers['x-custom']).toBe('first, second')
  })

  // Supplementary: an RFC 5322 address GROUP in To/Cc (e.g.
  // "undisclosed-recipients:;"-style syntax) is flattened into its member
  // mailboxes rather than dropped — covers both a named and an unnamed
  // group member.
  it('flattens an RFC 5322 address group in To into its member mailboxes', async () => {
    const raw = [
      'From: Group Sender <sender@example.test>',
      'To: A Group:Alice Alpha <alice@example.test>,bob@example.test;',
      'Subject: Group address test',
      'Message-ID: <msg-group-0001@example.test>',
      'Date: Mon, 01 Jun 2026 12:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '',
    ].join('\n')

    const parsed = await parseInboundEmail(raw)

    expect(parsed.to).toEqual([
      { address: 'alice@example.test', name: 'Alice Alpha' },
      { address: 'bob@example.test' },
    ])
  })

  // Supplementary: a message with no From header at all — from must be
  // null, not throw.
  it('maps a missing From header to null', async () => {
    const raw = [
      'To: rcpt@example.test',
      'Subject: No from header',
      'Message-ID: <msg-nofrom-0001@example.test>',
      'Date: Mon, 01 Jun 2026 12:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '',
    ].join('\n')

    const parsed = await parseInboundEmail(raw)

    expect(parsed.from).toBeNull()
  })

  // Supplementary: a bare From address with no display name — name is
  // omitted from the result rather than carried as an empty string.
  it('maps a From header with no display name to an address-only ParsedAddress', async () => {
    const raw = [
      'From: bare@example.test',
      'To: rcpt@example.test',
      'Subject: Bare from address',
      'Message-ID: <msg-bare-0001@example.test>',
      'Date: Mon, 01 Jun 2026 12:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '',
    ].join('\n')

    const parsed = await parseInboundEmail(raw)

    expect(parsed.from).toEqual({ address: 'bare@example.test' })
  })

  // Supplementary: a message with no Message-ID header at all — must be
  // null, not throw.
  it('maps a missing Message-ID header to null', async () => {
    const raw = [
      'From: sender@example.test',
      'To: rcpt@example.test',
      'Subject: No message id',
      'Date: Mon, 01 Jun 2026 12:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '',
    ].join('\n')

    const parsed = await parseInboundEmail(raw)

    expect(parsed.messageId).toBeNull()
  })

  // Supplementary: a Date header that fails to parse maps to null, not a
  // throw or an Invalid Date.
  it('maps an unparseable Date header to null', async () => {
    const raw = [
      'From: Bad Date <bad@example.test>',
      'To: rcpt@example.test',
      'Subject: Bad date test',
      'Message-ID: <msg-baddate-0001@example.test>',
      'Date: not-a-real-date',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '',
    ].join('\n')

    const parsed = await parseInboundEmail(raw)

    expect(parsed.date).toBeNull()
  })

  // Supplementary: a message with no Subject and no Date header at all —
  // subject normalizes to '', date to null.
  it('normalizes an absent Subject to empty string and absent Date to null', async () => {
    const raw = [
      'From: No Subject <nosubject@example.test>',
      'To: rcpt@example.test',
      'Message-ID: <msg-nosubject-0001@example.test>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
      '',
    ].join('\n')

    const parsed = await parseInboundEmail(raw)

    expect(parsed.subject).toBe('')
    expect(parsed.date).toBeNull()
  })
})
