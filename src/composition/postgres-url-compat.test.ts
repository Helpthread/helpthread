import { parse } from 'pg-connection-string'
import { describe, expect, it } from 'vitest'
import { withLibpqSslCompat } from './postgres-url-compat.js'

describe('withLibpqSslCompat', () => {
  it('appends uselibpqcompat=true to an sslmode=require URL', () => {
    const result = withLibpqSslCompat(
      'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x',
    )
    const url = new URL(result)
    expect(url.searchParams.get('sslmode')).toBe('require')
    expect(url.searchParams.get('uselibpqcompat')).toBe('true')
    // Untouched params survive.
    expect(url.searchParams.get('supa')).toBe('base-pooler.x')
  })

  it('makes pg-connection-string parse sslmode=require as libpq-compat (encrypted, chain unverified) instead of verify-full', () => {
    const before = parse(
      'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require',
    )
    // Pre-fix: `require` is treated as an alias for verify-full — `ssl: {}`
    // defaults `rejectUnauthorized` to true, which fails against Supabase's
    // own CA (not in Node's trust store) with SELF_SIGNED_CERT_IN_CHAIN.
    expect(before.ssl).toEqual({})

    const after = parse(
      withLibpqSslCompat(
        'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require',
      ),
    )
    // Post-fix: libpq semantics for `require` — encrypted, chain not verified.
    expect(after.ssl).toEqual({ rejectUnauthorized: false })
  })

  it('leaves a URL with no sslmode unchanged', () => {
    const input = 'postgres://user:pass@db.pooler.supabase.com:6543/postgres'
    expect(withLibpqSslCompat(input)).toBe(input)
  })

  it('leaves a URL that already sets uselibpqcompat unchanged', () => {
    const input =
      'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true'
    expect(withLibpqSslCompat(input)).toBe(input)
  })

  it('leaves a URL with a different sslmode unchanged', () => {
    const input = 'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=verify-full'
    expect(withLibpqSslCompat(input)).toBe(input)
  })

  it('preserves a password with special characters', () => {
    const input =
      'postgres://user:p%40ss%3Aword%23@db.pooler.supabase.com:6543/postgres?sslmode=require'
    const result = withLibpqSslCompat(input)
    const url = new URL(result)
    expect(decodeURIComponent(url.password)).toBe('p@ss:word#')
    expect(url.searchParams.get('uselibpqcompat')).toBe('true')
  })

  it('returns an unparseable string unchanged rather than throwing', () => {
    const input = 'not a url at all'
    expect(withLibpqSslCompat(input)).toBe(input)
  })
})
