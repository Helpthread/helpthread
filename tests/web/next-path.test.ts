import { describe, expect, it } from 'vitest'
import { DEFAULT_NEXT_PATH, sanitizeNextPath } from '../../web/src/lib/next-path.js'

describe('sanitizeNextPath', () => {
  it('keeps same-origin paths', () => {
    expect(sanitizeNextPath('/inbox/open')).toBe('/inbox/open')
    expect(sanitizeNextPath('/conversations/abc?x=1#y')).toBe('/conversations/abc?x=1#y')
  })

  it.each([
    ['absolute URL', 'https://evil.example/phish'],
    ['protocol-relative', '//evil.example'],
    ['backslash', '/\\evil.example'],
    ['encoded slashes', '/%2F%2Fevil.example'],
    ['tab before second slash', '/\t/evil.example'],
    ['newline before second slash', '/\n/evil.example'],
    ['CRLF before backslash', '/\r\n\\evil.example'],
    ['encoded tab', '/%09/evil.example'],
    ['no leading slash', 'evil.example'],
  ])('refuses an off-origin target (%s)', (_label, raw) => {
    expect(sanitizeNextPath(raw)).toBe(DEFAULT_NEXT_PATH)
  })
})
