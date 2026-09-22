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
    expect(config.gmailPush?.topic).toBe('projects/resonantiq-helpthread/topics/gmail-push')
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

  it('treats a whitespace-only GMAIL_PUBSUB_TOPIC as missing — triggers the Gmail-push partial-config error (the other two push vars are still set)', () => {
    // Since HT-94 made the push trio optional-but-all-or-nothing, this is no
    // longer a plain "required var missing" case: validEnv() still has the
    // other two push vars set, so a whitespace-only topic lands in
    // resolveGmailPush's PARTIAL branch, not the "all three unset" happy path.
    let message = ''
    try {
      loadConfig({ ...validEnv(), GMAIL_PUBSUB_TOPIC: '   ' })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('GMAIL_PUBSUB_TOPIC')
    expect(message).toContain('partially configured')
    expect(message).toContain('is unset')
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

describe('loadConfig — gmailPush / GMAIL_PUBSUB_* trio (HT-94, optional-but-all-or-nothing)', () => {
  /** `validEnv()` with all three push vars removed — the push-free base every case here starts from. */
  function envWithoutPush(): Record<string, string> {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).GMAIL_PUBSUB_TOPIC
    delete (env as Record<string, string | undefined>).GMAIL_PUBSUB_SUBSCRIPTION
    delete (env as Record<string, string | undefined>).GMAIL_PUSH_SERVICE_ACCOUNT
    return env
  }

  it('all three unset: config.gmailPush is undefined and loadConfig SUCCEEDS — the push-free happy path', () => {
    const config = loadConfig(envWithoutPush())
    expect(config.gmailPush).toBeUndefined()
  })

  it('only GMAIL_PUBSUB_TOPIC set (two missing): throws naming exactly the two missing vars, plural "are unset"', () => {
    const env = { ...envWithoutPush(), GMAIL_PUBSUB_TOPIC: 'projects/x/topics/y' }
    let message = ''
    try {
      loadConfig(env)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('partially configured')
    expect(message).toContain('GMAIL_PUBSUB_SUBSCRIPTION')
    expect(message).toContain('GMAIL_PUSH_SERVICE_ACCOUNT')
    expect(message).toContain('are unset')
  })

  it('two of three set (GMAIL_PUSH_SERVICE_ACCOUNT missing): throws naming just that one var, singular "is unset"', () => {
    const env = {
      ...envWithoutPush(),
      GMAIL_PUBSUB_TOPIC: 'projects/x/topics/y',
      GMAIL_PUBSUB_SUBSCRIPTION: 'projects/x/subscriptions/y',
    }
    let message = ''
    try {
      loadConfig(env)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('partially configured')
    expect(message).toContain('GMAIL_PUSH_SERVICE_ACCOUNT')
    expect(message).toContain('is unset')
    expect(message).not.toContain('GMAIL_PUBSUB_TOPIC is unset')
    expect(message).not.toContain('GMAIL_PUBSUB_SUBSCRIPTION is unset')
  })

  it('a whitespace-only GMAIL_PUBSUB_SUBSCRIPTION counts as missing, same as unset — throws naming it, others treated present', () => {
    const env = {
      ...envWithoutPush(),
      GMAIL_PUBSUB_TOPIC: 'projects/x/topics/y',
      GMAIL_PUBSUB_SUBSCRIPTION: '   ',
      GMAIL_PUSH_SERVICE_ACCOUNT: 'invoker@x.iam.gserviceaccount.com',
    }
    let message = ''
    try {
      loadConfig(env)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('partially configured')
    expect(message).toContain('GMAIL_PUBSUB_SUBSCRIPTION')
    expect(message).toContain('is unset')
    expect(message).not.toContain('GMAIL_PUBSUB_TOPIC is unset')
    expect(message).not.toContain('GMAIL_PUSH_SERVICE_ACCOUNT is unset')
  })
})

describe('loadConfig — HELPTHREAD_UI_BASE_URL (HT-54, optional; derivable since HT-150)', () => {
  it('is absent from AppConfig when unset — an engine deployed alone assumes no UI origin', () => {
    const config = loadConfig(validEnv())
    expect(config.uiBaseUrl).toBeUndefined()
    expect(config.warnings).toBeUndefined()
  })

  it('is absent when set to whitespace only — treated the same as unset', () => {
    const config = loadConfig({ ...validEnv(), HELPTHREAD_UI_BASE_URL: '   ' })
    expect(config.uiBaseUrl).toBeUndefined()
  })

  it('derives from PUBLIC_BASE_URL when the caller says the UI is served from it', () => {
    const config = loadConfig(validEnv(), { uiAtPublicBaseUrl: true })
    expect(config.uiBaseUrl).toBe('https://desk.resonantiq.app')
    expect(config.warnings).toBeUndefined()
  })

  it('derives a loopback http PUBLIC_BASE_URL (local development)', () => {
    const config = loadConfig(
      { ...validEnv(), PUBLIC_BASE_URL: 'http://localhost:3000' },
      { uiAtPublicBaseUrl: true },
    )
    expect(config.uiBaseUrl).toBe('http://localhost:3000')
    expect(config.warnings).toBeUndefined()
  })

  it('degrades, not fails, when the derived origin would be plain http off loopback', () => {
    const config = loadConfig(
      { ...validEnv(), PUBLIC_BASE_URL: 'http://helpthread.lan' },
      { uiAtPublicBaseUrl: true },
    )
    expect(config.uiBaseUrl).toBeUndefined()
    expect(config.warnings).toEqual([
      expect.stringMatching(/invite links and passkeys are disabled/),
    ])
    expect(config.warnings?.[0]).not.toMatch(/helpthread\.lan/)
  })

  it('an explicit HELPTHREAD_UI_BASE_URL wins over derivation', () => {
    const config = loadConfig(
      { ...validEnv(), HELPTHREAD_UI_BASE_URL: 'https://inbox.example.com' },
      { uiAtPublicBaseUrl: true },
    )
    expect(config.uiBaseUrl).toBe('https://inbox.example.com')
  })

  it('is read and normalized to a bare origin when set', () => {
    const config = loadConfig({
      ...validEnv(),
      HELPTHREAD_UI_BASE_URL: 'https://app.resonantiq.app/',
    })
    expect(config.uiBaseUrl).toBe('https://app.resonantiq.app')
  })

  it('rejects a malformed value at boot rather than silently ignoring it', () => {
    expect(() => loadConfig({ ...validEnv(), HELPTHREAD_UI_BASE_URL: 'not a url' })).toThrow(
      /HELPTHREAD_UI_BASE_URL/,
    )
    expect(() =>
      loadConfig({ ...validEnv(), HELPTHREAD_UI_BASE_URL: 'https://app.example.com/some/path' }),
    ).toThrow(/HELPTHREAD_UI_BASE_URL/)
  })

  it('refuses plain http except for loopback hosts — invite links carry a signed credential', () => {
    expect(() =>
      loadConfig({ ...validEnv(), HELPTHREAD_UI_BASE_URL: 'http://app.example.com' }),
    ).toThrow(/https/)
    expect(
      loadConfig({ ...validEnv(), HELPTHREAD_UI_BASE_URL: 'http://localhost:3000' }).uiBaseUrl,
    ).toBe('http://localhost:3000')
    expect(
      loadConfig({ ...validEnv(), HELPTHREAD_UI_BASE_URL: 'http://127.0.0.1:3000' }).uiBaseUrl,
    ).toBe('http://127.0.0.1:3000')
  })
})

describe('loadConfig — HELPTHREAD_SETUP_SECRET (issue #227, optional)', () => {
  it('is absent from AppConfig when unset — "required" and "removable once an Agent exists" would conflict if boot failed without it', () => {
    const config = loadConfig(validEnv())
    expect(config.setupSecret).toBeUndefined()
  })

  it('is absent when set to whitespace only — treated the same as unset', () => {
    const config = loadConfig({ ...validEnv(), HELPTHREAD_SETUP_SECRET: '   ' })
    expect(config.setupSecret).toBeUndefined()
  })

  it('is read verbatim when set and long enough', () => {
    const config = loadConfig({
      ...validEnv(),
      HELPTHREAD_SETUP_SECRET: 'a-perfectly-fine-setup-secret',
    })
    expect(config.setupSecret).toBe('a-perfectly-fine-setup-secret')
  })

  it('rejects a too-short HELPTHREAD_SETUP_SECRET', () => {
    expect(() => loadConfig({ ...validEnv(), HELPTHREAD_SETUP_SECRET: 'short' })).toThrow(
      /HELPTHREAD_SETUP_SECRET/,
    )
  })
})

describe('loadConfig — Vercel⇄Supabase Marketplace integration fallbacks (issue #151/#153)', () => {
  it('falls back to POSTGRES_URL when DATABASE_URL is unset', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).DATABASE_URL
    const config = loadConfig({ ...env, POSTGRES_URL: 'postgres://integration-pooled-db' })
    expect(config.databaseUrl).toBe('postgres://integration-pooled-db')
  })

  it('an explicit DATABASE_URL wins over POSTGRES_URL', () => {
    const config = loadConfig({ ...validEnv(), POSTGRES_URL: 'postgres://integration-pooled-db' })
    expect(config.databaseUrl).toBe('postgres://user:pass@db.pooler.supabase.com:6543/postgres')
  })

  it('applies the libpq-compat shim to a POSTGRES_URL fallback carrying sslmode=require', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).DATABASE_URL
    const config = loadConfig({
      ...env,
      POSTGRES_URL: 'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require',
    })
    expect(config.databaseUrl).toBe(
      'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require&uselibpqcompat=true',
    )
  })

  it('never touches an explicit DATABASE_URL even when it carries sslmode=require — passed through byte-for-byte', () => {
    const config = loadConfig({
      ...validEnv(),
      DATABASE_URL: 'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require',
      POSTGRES_URL: 'postgres://integration-pooled-db',
    })
    expect(config.databaseUrl).toBe(
      'postgres://user:pass@db.pooler.supabase.com:6543/postgres?sslmode=require',
    )
  })

  it('a blank DATABASE_URL still falls back to POSTGRES_URL', () => {
    const config = loadConfig({
      ...validEnv(),
      DATABASE_URL: '   ',
      POSTGRES_URL: 'postgres://integration-pooled-db',
    })
    expect(config.databaseUrl).toBe('postgres://integration-pooled-db')
  })

  it('falls back to SUPABASE_SECRET_KEY when SUPABASE_SERVICE_ROLE_KEY is unset', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).SUPABASE_SERVICE_ROLE_KEY
    const config = loadConfig({ ...env, SUPABASE_SECRET_KEY: 'sb_secret_from_integration' })
    expect(config.supabaseServiceRoleKey).toBe('sb_secret_from_integration')
  })

  it('an explicit SUPABASE_SERVICE_ROLE_KEY wins over SUPABASE_SECRET_KEY', () => {
    const config = loadConfig({
      ...validEnv(),
      SUPABASE_SECRET_KEY: 'sb_secret_from_integration',
    })
    expect(config.supabaseServiceRoleKey).toBe('service-role-key-value')
  })

  it('neither fallback fires when nothing is set — still reports the primary name missing', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).DATABASE_URL
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/)
  })

  it('derives PUBLIC_BASE_URL from VERCEL_PROJECT_PRODUCTION_URL on a production Vercel build when unset', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).PUBLIC_BASE_URL
    const config = loadConfig({
      ...env,
      VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'my-desk.vercel.app',
    })
    expect(config.publicBaseUrl).toBe('https://my-desk.vercel.app')
  })

  it('an explicit PUBLIC_BASE_URL wins over the VERCEL_PROJECT_PRODUCTION_URL derivation', () => {
    const config = loadConfig({
      ...validEnv(),
      VERCEL_ENV: 'production',
      VERCEL_PROJECT_PRODUCTION_URL: 'my-desk.vercel.app',
    })
    expect(config.publicBaseUrl).toBe('https://desk.resonantiq.app')
  })

  it('never derives PUBLIC_BASE_URL on a preview or unset VERCEL_ENV, even with VERCEL_PROJECT_PRODUCTION_URL set', () => {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).PUBLIC_BASE_URL
    expect(() =>
      loadConfig({
        ...env,
        VERCEL_ENV: 'preview',
        VERCEL_PROJECT_PRODUCTION_URL: 'my-desk.vercel.app',
      }),
    ).toThrow(/PUBLIC_BASE_URL/)
    expect(() =>
      loadConfig({ ...env, VERCEL_PROJECT_PRODUCTION_URL: 'my-desk.vercel.app' }),
    ).toThrow(/PUBLIC_BASE_URL/)
  })
})

describe('loadConfig — Gmail OAuth is optional, both-or-neither (issue #151)', () => {
  function envWithoutGmailOAuth(): Record<string, string> {
    const env = validEnv()
    delete (env as Record<string, string | undefined>).GMAIL_OAUTH_CLIENT_ID
    delete (env as Record<string, string | undefined>).GMAIL_OAUTH_CLIENT_SECRET
    // Gmail push requires Gmail OAuth (config.ts cross-validates), so an
    // IMAP-only env has none of the push trio either.
    delete (env as Record<string, string | undefined>).GMAIL_PUBSUB_TOPIC
    delete (env as Record<string, string | undefined>).GMAIL_PUBSUB_SUBSCRIPTION
    delete (env as Record<string, string | undefined>).GMAIL_PUSH_SERVICE_ACCOUNT
    return env
  }

  it('both unset: loadConfig SUCCEEDS, both fields are absent, and one warning is recorded', () => {
    const config = loadConfig(envWithoutGmailOAuth())
    expect(config.gmailOAuthClientId).toBeUndefined()
    expect(config.gmailOAuthClientSecret).toBeUndefined()
    expect(config.warnings).toEqual([expect.stringMatching(/Gmail connect is disabled/)])
  })

  it('both set: read verbatim, exactly like before Gmail became optional', () => {
    const config = loadConfig(validEnv())
    expect(config.gmailOAuthClientId).toBe('client-id.apps.googleusercontent.com')
    expect(config.gmailOAuthClientSecret).toBe('gmail-oauth-client-secret')
    expect(config.warnings).toBeUndefined()
  })

  it('only GMAIL_OAUTH_CLIENT_ID set: throws naming the missing secret', () => {
    const env = envWithoutGmailOAuth()
    expect(() =>
      loadConfig({ ...env, GMAIL_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com' }),
    ).toThrow(/GMAIL_OAUTH_CLIENT_SECRET/)
  })

  it('only GMAIL_OAUTH_CLIENT_SECRET set: throws naming the missing id', () => {
    const env = envWithoutGmailOAuth()
    expect(() => loadConfig({ ...env, GMAIL_OAUTH_CLIENT_SECRET: 'a-secret' })).toThrow(
      /GMAIL_OAUTH_CLIENT_ID/,
    )
  })

  it('a whitespace-only GMAIL_OAUTH_CLIENT_ID counts as unset, same as absent entirely', () => {
    const env = envWithoutGmailOAuth()
    expect(() =>
      loadConfig({ ...env, GMAIL_OAUTH_CLIENT_ID: '   ', GMAIL_OAUTH_CLIENT_SECRET: 'a-secret' }),
    ).toThrow(/GMAIL_OAUTH_CLIENT_ID/)
  })

  it('Gmail push set without Gmail OAuth: rejected at boot — push has nothing to authenticate against', () => {
    const env = envWithoutGmailOAuth()
    let message = ''
    try {
      loadConfig({
        ...env,
        GMAIL_PUBSUB_TOPIC: 'projects/x/topics/y',
        GMAIL_PUBSUB_SUBSCRIPTION: 'projects/x/subscriptions/y',
        GMAIL_PUSH_SERVICE_ACCOUNT: 'invoker@x.iam.gserviceaccount.com',
      })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('GMAIL_OAUTH_CLIENT_ID')
    expect(message).toContain('GMAIL_PUBSUB_TOPIC')
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

  it('reports a too-short HELPTHREAD_SETUP_SECRET by LENGTH, never echoing the secret value', () => {
    const secretValue = 'sekret'
    let message = ''
    try {
      loadConfig({ ...validEnv(), HELPTHREAD_SETUP_SECRET: secretValue })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('HELPTHREAD_SETUP_SECRET')
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
