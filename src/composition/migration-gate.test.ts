import { describe, expect, it } from 'vitest'
import { decideMigrationGate } from './migration-gate.js'

describe('decideMigrationGate', () => {
  it('skips when VERCEL_ENV is unset (a local/non-Vercel build)', () => {
    const decision = decideMigrationGate({})
    expect(decision.action).toBe('skip')
    expect(decision).toMatchObject({ reason: expect.stringContaining('VERCEL_ENV is unset') })
  })

  it('skips a preview build, even with DATABASE_URL set', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'preview',
      DATABASE_URL: 'postgres://preview-db',
    })
    expect(decision.action).toBe('skip')
    expect(decision).toMatchObject({ reason: expect.stringContaining("'preview'") })
  })

  it('skips a development build, even with DATABASE_URL set', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'development',
      DATABASE_URL: 'postgres://dev-db',
    })
    expect(decision.action).toBe('skip')
    expect(decision).toMatchObject({ reason: expect.stringContaining("'development'") })
  })

  it('fails a production build with no DATABASE_URL — never silently skips the database a production deploy needs', () => {
    const decision = decideMigrationGate({ VERCEL_ENV: 'production' })
    expect(decision.action).toBe('fail')
    expect(decision).toMatchObject({ reason: expect.stringContaining('DATABASE_URL') })
  })

  it('fails a production build with a blank DATABASE_URL', () => {
    const decision = decideMigrationGate({ VERCEL_ENV: 'production', DATABASE_URL: '   ' })
    expect(decision.action).toBe('fail')
  })

  it('migrates a production build with DATABASE_URL set', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'production',
      DATABASE_URL: 'postgres://prod-db',
    })
    expect(decision).toEqual({ action: 'migrate', databaseUrl: 'postgres://prod-db' })
  })

  it('migrates using POSTGRES_URL (the Vercel Supabase integration name) when DATABASE_URL is unset', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'production',
      POSTGRES_URL: 'postgres://integration-pooled-db',
    })
    expect(decision).toEqual({ action: 'migrate', databaseUrl: 'postgres://integration-pooled-db' })
  })

  it('an explicit DATABASE_URL wins over POSTGRES_URL when both are set', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'production',
      DATABASE_URL: 'postgres://explicit-db',
      POSTGRES_URL: 'postgres://integration-pooled-db',
    })
    expect(decision).toEqual({ action: 'migrate', databaseUrl: 'postgres://explicit-db' })
  })

  it('applies the libpq-compat shim to a POSTGRES_URL fallback carrying sslmode=require', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'production',
      POSTGRES_URL: 'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require',
    })
    expect(decision).toEqual({
      action: 'migrate',
      databaseUrl:
        'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true',
    })
  })

  it('never touches an explicit DATABASE_URL even when it carries sslmode=require — passed through byte-for-byte', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require',
      POSTGRES_URL: 'postgres://integration-pooled-db',
    })
    expect(decision).toEqual({
      action: 'migrate',
      databaseUrl: 'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require',
    })
  })

  it('treats a blank DATABASE_URL as unset and still falls back to POSTGRES_URL', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'production',
      DATABASE_URL: '   ',
      POSTGRES_URL: 'postgres://integration-pooled-db',
    })
    expect(decision).toEqual({ action: 'migrate', databaseUrl: 'postgres://integration-pooled-db' })
  })

  it('fails a production build when both DATABASE_URL and POSTGRES_URL are unset', () => {
    const decision = decideMigrationGate({ VERCEL_ENV: 'production' })
    expect(decision.action).toBe('fail')
    expect(decision).toMatchObject({ reason: expect.stringContaining('POSTGRES_URL') })
  })

  it('skips a production build for the split deployment (HELPTHREAD_API_URL set) — it does not host the engine, so it does not own the database', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'production',
      HELPTHREAD_API_URL: 'https://engine.example.test',
    })
    expect(decision.action).toBe('skip')
    expect(decision).toMatchObject({
      reason: expect.stringContaining('HELPTHREAD_API_URL'),
    })
  })

  it('skips the split deployment even when DATABASE_URL is ALSO set — HELPTHREAD_API_URL wins outright', () => {
    const decision = decideMigrationGate({
      VERCEL_ENV: 'production',
      HELPTHREAD_API_URL: 'https://engine.example.test',
      DATABASE_URL: 'postgres://coincidentally-set',
    })
    expect(decision.action).toBe('skip')
  })

  it("treats a blank HELPTHREAD_API_URL as unset — still fails without DATABASE_URL, doesn't skip", () => {
    const decision = decideMigrationGate({ VERCEL_ENV: 'production', HELPTHREAD_API_URL: '   ' })
    expect(decision.action).toBe('fail')
  })

  it('never echoes DATABASE_URL itself in any reason string', () => {
    const secretUrl = 'postgres://user:supersecret@host/db'
    const decisions = [
      decideMigrationGate({ VERCEL_ENV: 'preview', DATABASE_URL: secretUrl }),
      decideMigrationGate({ VERCEL_ENV: 'production', DATABASE_URL: '' }),
    ]
    for (const decision of decisions) {
      if ('reason' in decision) {
        expect(decision.reason).not.toContain(secretUrl)
        expect(decision.reason).not.toContain('supersecret')
      }
    }
  })
})
