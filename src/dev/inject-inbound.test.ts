/**
 * `buildRawMessage` / `injectInboundMessage` (src/dev/inject-inbound.ts).
 *
 * Two properties are worth holding even in dev tooling: a header value
 * cannot rewrite the message around it, and the transport message id is
 * the caller's to control when they want to replay a delivery.
 */

import { describe, expect, it } from 'vitest'
import { buildRawMessage } from './inject-inbound.js'

const BASE = {
  mailboxId: 'mailbox-1',
  from: 'customer@example.test',
  to: 'support@example.test',
  subject: 'Hello',
  text: 'Body text.',
}

describe('buildRawMessage', () => {
  it('separates headers from the body with exactly one blank line', () => {
    const raw = buildRawMessage(BASE, 'id-1@example.test')
    const [headers, ...rest] = raw.split('\r\n\r\n')

    expect(headers).toContain('From: customer@example.test')
    expect(headers).toContain('Subject: Hello')
    expect(rest.join('\r\n\r\n')).toBe('Body text.\r\n')
  })

  it('threads a reply with In-Reply-To and References', () => {
    const raw = buildRawMessage({ ...BASE, inReplyTo: 'parent@example.test' }, 'id-2@example.test')

    expect(raw).toContain('In-Reply-To: <parent@example.test>')
    expect(raw).toContain('References: <parent@example.test>')
  })

  // A bare CR or LF ends a header; two end the header block. Interpolating
  // one unescaped lets a "subject" append its own headers, or terminate the
  // block early and turn the real headers into body text.
  it.each([
    ['subject', { subject: 'Hi\r\nBcc: attacker@example.test' }],
    ['from', { from: 'a@example.test\r\nX-Injected: yes' }],
    ['to', { to: 'b@example.test\nX-Injected: yes' }],
    ['inReplyTo', { inReplyTo: 'p@example.test>\r\nX-Injected: yes' }],
  ])('refuses a line break in %s', (_name, override) => {
    expect(() => buildRawMessage({ ...BASE, ...override }, 'id@example.test')).toThrow(
      /must not contain a line break/,
    )
  })

  it('refuses a line break in the generated message id', () => {
    expect(() => buildRawMessage(BASE, 'id\r\nX-Injected: yes')).toThrow(
      /must not contain a line break/,
    )
  })

  it('leaves line breaks in the body alone — they are not header injection', () => {
    const raw = buildRawMessage({ ...BASE, text: 'line one\r\nline two' }, 'id@example.test')

    expect(raw.endsWith('line one\r\nline two\r\n')).toBe(true)
  })
})
