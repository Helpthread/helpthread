import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { createLocalJWKSet, exportJWK, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import {
  createGmailPushSignatureVerifier,
  type GmailPushJwtConfig,
  type GmailPushKeySource,
  verifyGmailPushJwt,
} from './push-auth.js'

const ENDPOINT_URL = 'https://desk.example.test/api/v1/inbound/gmail'
const SERVICE_ACCOUNT_EMAIL = 'gmail-api-push@system.gserviceaccount.com'
const CONFIG: GmailPushJwtConfig = {
  endpointUrl: ENDPOINT_URL,
  serviceAccountEmail: SERVICE_ACCOUNT_EMAIL,
}
const KID = 'test-kid-1'

/** Build a `Request` carrying `Authorization: Bearer <token>` (or no header at all, or a raw override). */
function requestWith(authorization: string | undefined): Request {
  return new Request('https://x.example.test/api/v1/inbound/gmail', {
    method: 'POST',
    headers: authorization !== undefined ? { Authorization: authorization } : {},
  })
}

/** Claims a well-formed Google push JWT carries, overridable per test. */
interface TestClaims {
  iss?: string
  aud?: string
  email?: string
  email_verified?: boolean
  expiresInSeconds?: number
}

async function setUpKeys(): Promise<{
  trustedKeySource: GmailPushKeySource
  signWith: (privateKey: KeyObject, claims: TestClaims, kid?: string) => Promise<string>
  trustedPrivateKey: KeyObject
}> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicJwk = await exportJWK(publicKey)
  const trustedKeySource = createLocalJWKSet({
    keys: [{ ...publicJwk, kid: KID, alg: 'RS256', use: 'sig' }],
  })

  const signWith = async (
    signingKey: KeyObject,
    claims: TestClaims,
    kid: string = KID,
  ): Promise<string> => {
    const {
      iss = 'https://accounts.google.com',
      aud = ENDPOINT_URL,
      email = SERVICE_ACCOUNT_EMAIL,
      email_verified = true,
      expiresInSeconds = 3600,
    } = claims
    return new SignJWT({ email, email_verified })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setIssuer(iss)
      .setAudience(aud)
      .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
      .sign(signingKey)
  }

  return { trustedKeySource, signWith, trustedPrivateKey: privateKey }
}

describe('verifyGmailPushJwt', () => {
  it('accepts a valid Google-shaped JWT: correct iss, aud, email, email_verified, not expired', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, {})
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(true)
  })

  it('rejects a JWT signed by a DIFFERENT key than the trusted JWKS (forged)', async () => {
    const { trustedKeySource, signWith } = await setUpKeys()
    const { privateKey: forgedPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwt = await signWith(forgedPrivateKey, {})
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects a wrong `aud`', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, {
      aud: 'https://someone-else.example.test/webhook',
    })
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects a wrong `email` (not the configured service account)', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, { email: 'someone-else@gserviceaccount.com' })
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects `email_verified: false` even with every other claim correct', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, { email_verified: false })
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects a JWT with no `email_verified` claim at all', async () => {
    const { trustedKeySource, trustedPrivateKey } = await setUpKeys()
    const jwt = await new SignJWT({ email: SERVICE_ACCOUNT_EMAIL })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuedAt()
      .setIssuer('https://accounts.google.com')
      .setAudience(ENDPOINT_URL)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(trustedPrivateKey)
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects an expired JWT', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, { expiresInSeconds: -3600 })
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects a wrong issuer', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, { iss: 'https://not-google.example.test' })
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('accepts the legacy scheme-less Google issuer form', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, { iss: 'accounts.google.com' })
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(true)
  })

  it('rejects a missing Authorization header — never throws', async () => {
    const { trustedKeySource } = await setUpKeys()
    const ok = await verifyGmailPushJwt(requestWith(undefined), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects a non-Bearer scheme', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, {})
    const ok = await verifyGmailPushJwt(requestWith(`Basic ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects an empty Bearer credential', async () => {
    const { trustedKeySource } = await setUpKeys()
    const ok = await verifyGmailPushJwt(requestWith('Bearer '), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })

  it('rejects a garbage/malformed token string — TOTAL, never throws', async () => {
    const { trustedKeySource } = await setUpKeys()
    const ok = await verifyGmailPushJwt(
      requestWith('Bearer not.a.real.jwt.at-all'),
      CONFIG,
      trustedKeySource,
    )
    expect(ok).toBe(false)
  })

  it('rejects a JWT with an unknown `kid` not present in the trusted JWKS', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const jwt = await signWith(trustedPrivateKey, {}, 'some-other-kid')
    const ok = await verifyGmailPushJwt(requestWith(`Bearer ${jwt}`), CONFIG, trustedKeySource)
    expect(ok).toBe(false)
  })
})

describe('createGmailPushSignatureVerifier', () => {
  it('produces a (request) => Promise<boolean> closure equivalent to calling verifyGmailPushJwt directly', async () => {
    const { trustedKeySource, signWith, trustedPrivateKey } = await setUpKeys()
    const verifySignature = createGmailPushSignatureVerifier(CONFIG, trustedKeySource)

    const validJwt = await signWith(trustedPrivateKey, {})
    expect(await verifySignature(requestWith(`Bearer ${validJwt}`))).toBe(true)

    const wrongAudJwt = await signWith(trustedPrivateKey, { aud: 'https://nope.example.test' })
    expect(await verifySignature(requestWith(`Bearer ${wrongAudJwt}`))).toBe(false)
  })
})
