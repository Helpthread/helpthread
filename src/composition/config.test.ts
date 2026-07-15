import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

/** A complete, valid env for the whole contract; individual cases override/delete one key. */
function validEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://user:pass@db.pooler.supabase.com:6543/postgres',
    SUPABASE_URL: 'https://abcdefgh.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
    HELPTHREAD_BLOB_BUCKET: 'helpthread-blobs',
    GMAIL_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GMAIL_OAUTH_CLIENT_SECRET: 'gmail-oauth-client-secret',
    GMAIL_PUBSUB_TOPIC: 'projects/resonantiq-helpthread/topics/gmail-push',
    GMAIL_PUBSUB_SUBSCRIPTION: 'projects/resonantiq-helpthread/subscriptions/gmail-push-sub',
    GMAIL_PUSH_SERVICE_ACCOUNT: 'gmail-push-invoker@resonantiq-helpthread.iam.gserviceaccount.com',
    // base64 of exactly 32 bytes.
    HELPTHREAD_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
    HELPTHREAD_API_TOKEN: 'api-token-at-least-16-chars',
    HELPTHREAD_SIGNING_SECRET: 'signing-secret-at-least-32-characters-long',
    CRON_SECRET: 'cron-secret-at-least-16',
    PUBLIC_BASE_URL: 'https://desk.resonantiq.app',
    HELPTHREAD_MAIL_DOMAIN: 'mail.resonantiq.app',
    HELPTHREAD_SUPPORT_ADDRESS: 'support@resonantiq.app',
  }
}

describe('loadConfig — happy path', () => {
  it('parses a complete valid env into an AppConfig', () => {
    const config = loadConfig(validEnv())

    expect(config.databaseUrl).toBe('postgres://user:pass@db.pooler.supabase.com:6543/postgres')
    expect(config.gmailPubsubTopic).toBe('projects/resonantiq-helpthread/topics/gmail-push')
    expect(config.supportAddress).toBe('support@resonantiq.app')
    expect(config.mailDomain).toBe('mail.resonantiq.app')
  })

  it('decodes HELPTHREAD_TOKEN_ENC_KEY to a 32-byte Buffer', () => {
    const config = loadConfig(validEnv())
    expect(Buffer.isBuffer(config.tokenEncryptionKey)).toBe(true)
    expect(config.tokenEncryptionKey.length).toBe(32)
  })

  it('strips a trailing slash from PUBLIC_BASE_URL so URL concatenation never double-slashes', () => {
    const config = loadConfig({ ...validEnv(), PUBLIC_BASE_URL: 'https://desk.resonantiq.app/' })
    expect(config.publicBaseUrl).toBe('https://desk.resonantiq.app')
  })
})

describe('loadConfig — missing / malformed values', () => {
  it('throws naming a single missing required variable', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).DATABASE_URL
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/)
  })

  it('treats a whitespace-only value as missing', () => {
    expect(() => loadConfig({ ...validEnv(), GMAIL_PUBSUB_TOPIC: '   ' })).toThrow(
      /GMAIL_PUBSUB_TOPIC/,
    )
  })

  it('aggregates ALL problems into one error, not just the first', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).DATABASE_URL
    delete (env as Record<string, string | undefined>).SUPABASE_URL
    delete (env as Record<string, string | undefined>).HELPTHREAD_MAIL_DOMAIN

    let message = ''
    try {
      loadConfig(env)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('SUPABASE_URL')
    expect(message).toContain('HELPTHREAD_MAIL_DOMAIN')
  })

  it('rejects a too-short HELPTHREAD_API_TOKEN', () => {
    expect(() => loadConfig({ ...validEnv(), HELPTHREAD_API_TOKEN: 'short' })).toThrow(
      /HELPTHREAD_API_TOKEN/,
    )
  })

  it('rejects a too-short HELPTHREAD_SIGNING_SECRET (below the 32-char keyring floor)', () => {
    expect(() => loadConfig({ ...validEnv(), HELPTHREAD_SIGNING_SECRET: 'too-short' })).toThrow(
      /HELPTHREAD_SIGNING_SECRET/,
    )
  })

  it('rejects a too-short CRON_SECRET', () => {
    expect(() => loadConfig({ ...validEnv(), CRON_SECRET: 'short' })).toThrow(/CRON_SECRET/)
  })

  it('rejects a HELPTHREAD_TOKEN_ENC_KEY that is not base64 of 32 bytes', () => {
    // base64 of 16 bytes — decodes fine, wrong length.
    const shortKey = Buffer.alloc(16, 1).toString('base64')
    expect(() => loadConfig({ ...validEnv(), HELPTHREAD_TOKEN_ENC_KEY: shortKey })).toThrow(
      /HELPTHREAD_TOKEN_ENC_KEY/,
    )
  })

  it('rejects a PUBLIC_BASE_URL that is not an absolute http(s) URL', () => {
    expect(() => loadConfig({ ...validEnv(), PUBLIC_BASE_URL: 'not a url' })).toThrow(
      /PUBLIC_BASE_URL/,
    )
    expect(() => loadConfig({ ...validEnv(), PUBLIC_BASE_URL: 'ftp://desk.example.com' })).toThrow(
      /PUBLIC_BASE_URL/,
    )
  })

  it('rejects a PUBLIC_BASE_URL that is not a bare origin (path/query/fragment/credentials)', () => {
    for (const bad of [
      'https://desk.example.com/base', // path
      'https://desk.example.com/api/v1', // deeper path
      'https://desk.example.com?x=1', // query
      'https://desk.example.com/#frag', // fragment
      'https://user:pass@desk.example.com', // credentials
    ]) {
      expect(() => loadConfig({ ...validEnv(), PUBLIC_BASE_URL: bad })).toThrow(/PUBLIC_BASE_URL/)
    }
  })

  it('returns the canonical origin (bare host, no trailing slash) for a valid origin with a port', () => {
    const config = loadConfig({ ...validEnv(), PUBLIC_BASE_URL: 'https://desk.example.com:8443/' })
    expect(config.publicBaseUrl).toBe('https://desk.example.com:8443')
  })
})

describe('loadConfig — never leaks a secret value', () => {
  it('reports a too-short token by LENGTH, never echoing the secret value', () => {
    const secretValue = 'sekret'
    let message = ''
    try {
      loadConfig({ ...validEnv(), HELPTHREAD_API_TOKEN: secretValue })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('HELPTHREAD_API_TOKEN')
    expect(message).not.toContain(secretValue)
  })

  it('reports a bad encryption key without echoing the (secret) raw value', () => {
    const badKey = 'this-is-not-a-valid-key-value-at-all'
    let message = ''
    try {
      loadConfig({ ...validEnv(), HELPTHREAD_TOKEN_ENC_KEY: badKey })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('HELPTHREAD_TOKEN_ENC_KEY')
    expect(message).not.toContain(badKey)
  })
})
