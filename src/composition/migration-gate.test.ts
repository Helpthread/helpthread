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
    expect(decision).toEqual({ action: 'migrate' })
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
