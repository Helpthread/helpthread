import { describe, expect, it } from 'vitest'
import { extractMessageIds } from './message-id.js'

describe('extractMessageIds', () => {
  it('extracts a single bare message-id', () => {
    expect(extractMessageIds('<a@b.test>')).toEqual(['<a@b.test>'])
  })

  it('extracts multiple ids in order', () => {
    expect(extractMessageIds('<a@b.test> <c@d.test> <e@f.test>')).toEqual([
      '<a@b.test>',
      '<c@d.test>',
      '<e@f.test>',
    ])
  })

  it('ignores CFWS/comments BETWEEN ids but keeps the real ids', () => {
    expect(extractMessageIds('(legacy MUA) <a@b.test> (added by relay) <c@d.test>')).toEqual([
      '<a@b.test>',
      '<c@d.test>',
    ])
  })

  it('does NOT extract an angle-bracketed token INSIDE a comment', () => {
    // The whole point: a <...> planted in a comment is not a real reference.
    expect(extractMessageIds('(<evil@planted.test>) <real@b.test>')).toEqual(['<real@b.test>'])
  })

  it('handles nested comments', () => {
    expect(extractMessageIds('( outer (inner <nope@x.test>) ) <real@b.test>')).toEqual([
      '<real@b.test>',
    ])
  })

  it('respects quoted-pair escapes inside comments (escaped close paren)', () => {
    // The \) does not close the comment, so <nope> stays inside it.
    expect(extractMessageIds('(a \\) still comment <nope@x.test>) <real@b.test>')).toEqual([
      '<real@b.test>',
    ])
  })

  it('does NOT extract an angle-bracketed token inside a quoted string', () => {
    expect(extractMessageIds('"<quoted@x.test>" <real@b.test>')).toEqual(['<real@b.test>'])
  })

  it('respects quoted-pair escapes inside quoted strings (escaped quote)', () => {
    // The \" does not close the quoted string, so <nope> stays inside it.
    expect(extractMessageIds('"a \\" still quoted <nope@x.test>" <real@b.test>')).toEqual([
      '<real@b.test>',
    ])
  })

  it('tolerates leading/trailing whitespace', () => {
    expect(extractMessageIds('   <a@b.test>   ')).toEqual(['<a@b.test>'])
  })

  it('returns [] for a value with no message-id', () => {
    expect(extractMessageIds('just some text, no ids')).toEqual([])
  })

  it('returns [] for an empty string', () => {
    expect(extractMessageIds('')).toEqual([])
  })

  it('ignores an unterminated < with no closing >', () => {
    expect(extractMessageIds('<a@b.test> <unterminated')).toEqual(['<a@b.test>'])
  })
})
