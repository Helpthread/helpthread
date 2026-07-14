/**
 * Google-signed OIDC JWT verification for the Gmail push webhook (HT-39;
 * specs/mail/gmail-push.md §2).
 *
 * A Cloud Pub/Sub push subscription authenticates itself to our endpoint by
 * attaching a Google-signed OIDC JWT (`Authorization: Bearer <jwt>`) — this
 * is the ONLY credential the webhook receiver has, since Gmail/Pub/Sub
 * cannot present our service Bearer token (`src/api/auth.ts`). This module
 * is that verification, and nothing else: it does not read the push
 * envelope's `subscription` field or `message.data` (gmail-push.md §2's
 * OTHER two required checks) — those are the webhook handler's own job
 * (`src/api/gmail-webhook.ts`), since they are plain JSON body shape, not
 * Google-credential verification.
 *
 * ## Why this lives under `adapters/gmail/`, not `src/api/`
 *
 * `src/providers/README.md`: "Engine modules never import an adapter
 * themselves; they only ever see the interface type." Verifying against
 * Google's live JWKS (a network-fetched, cached credential source) is
 * exactly the kind of platform-specific, credential-touching logic that
 * rule exists to keep out of engine code — the same reasoning that keeps
 * the Gmail `EmailSender`'s OAuth/`googleapis` details out of `src/mail/
 * send.ts` (`src/providers/adapters/gmail/sender.ts`). `src/api/
 * gmail-webhook.ts` therefore never imports this file directly: it takes a
 * `verifySignature: (request: Request) => Promise<boolean>` dependency,
 * and a composition root (or a test) builds it by closing over
 * {@link verifyGmailPushJwt} here, e.g. via {@link createGmailPushSignatureVerifier}.
 *
 * ## Testability
 *
 * {@link verifyGmailPushJwt} takes the key source (a `JWTVerifyGetKey`) as
 * an explicit parameter rather than reaching for Google's JWKS internally —
 * production wires {@link createGooglePushKeySource}'s
 * `createRemoteJWKSet(...)` result (created ONCE at the composition root
 * and reused across requests, so its internal fetch cache actually caches —
 * see that function's doc comment); tests wire jose's `createLocalJWKSet`
 * over a locally-generated RSA keypair (`node:crypto`) and locally-signed
 * JWTs (jose's `SignJWT`), with no network involved at all.
 */

import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'

/**
 * Where a JWT's signature is checked against — jose's `JWTVerifyGetKey`
 * shape, satisfied by both `createRemoteJWKSet(...)` (production, Google's
 * live JWKS) and `createLocalJWKSet(...)` (tests, a fixed local key set).
 */
export type GmailPushKeySource = JWTVerifyGetKey

/**
 * The two identity claims a push JWT must match — the rest of gmail-push.md
 * §2's required checks (`iss`, `email_verified`, `exp`) are enforced by
 * {@link verifyGmailPushJwt} unconditionally, not configured per-deployment.
 */
export interface GmailPushJwtConfig {
  /**
   * Our exact endpoint URL, e.g. `https://desk.example.test/api/v1/inbound/gmail`.
   * MUST equal the JWT's `aud` claim exactly — this is what a Pub/Sub push
   * subscription is configured to request an OIDC token FOR
   * (`--push-auth-token-audience`), and matching it is what stops a
   * validly-signed Google token minted for some OTHER audience (a different
   * endpoint entirely) from being replayed here.
   */
  endpointUrl: string
  /**
   * The push service account's email, e.g.
   * `gmail-api-push@system.gserviceaccount.com` for Gmail's own push
   * mechanism, or a project-specific Pub/Sub service account. MUST equal the
   * JWT's `email` claim exactly.
   */
  serviceAccountEmail: string
}

/**
 * Google's two historically-observed OIDC issuer strings — current
 * discovery metadata (`https://accounts.google.com/.well-known/openid-configuration`)
 * publishes `https://accounts.google.com`, but Google-issued tokens have
 * also been observed carrying the scheme-less legacy form. Both are
 * accepted; gmail-push.md §2 only requires "`iss` is Google," not one exact
 * string.
 */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

const BEARER_PREFIX = 'Bearer '

/** Google's published JWKS endpoint for verifying OIDC ID token signatures. */
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

/**
 * Build the production key source: Google's live JWKS, fetched over HTTPS
 * and cached internally by jose (`createRemoteJWKSet`'s default cooldown/
 * cache-max-age). Call this ONCE at the composition root and reuse the
 * result across every request — a fresh call per request would defeat the
 * cache and hit the network on every single push.
 */
export function createGooglePushKeySource(): GmailPushKeySource {
  return createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))
}

/**
 * Verify that `request` carries a Google-signed OIDC JWT satisfying every
 * one of gmail-push.md §2's identity checks:
 *
 * - Well-formed `Authorization: Bearer <jwt>` header.
 * - Signature valid against `keySource`.
 * - `iss` is one of {@link GOOGLE_ISSUERS}.
 * - `aud` equals `config.endpointUrl` exactly.
 * - `exp` not passed (jose's `jwtVerify` enforces this unconditionally,
 *   using the current time — no separate check needed here).
 * - `email_verified` is `true` — Google's push-auth guidance is explicit
 *   that the signed `email` claim is only trustworthy when this is set; a
 *   valid signature and audience do not by themselves bind the identity.
 * - `email` equals `config.serviceAccountEmail` exactly.
 *
 * TOTAL: never throws, for any `request`/`keySource` combination — mirrors
 * `authenticateRequest`'s contract (`src/api/auth.ts`): hostile/malformed
 * input on an authentication path must never crash the request, and this
 * function FAILS CLOSED (any problem at all — a missing header, a malformed
 * token, a wrong claim, or an infrastructure hiccup fetching Google's live
 * JWKS — resolves `false`, never throws). A caller that needs to
 * distinguish those cases for operational logging should wrap this call,
 * not rely on it to surface the distinction.
 */
export async function verifyGmailPushJwt(
  request: Request,
  config: GmailPushJwtConfig,
  keySource: GmailPushKeySource,
): Promise<boolean> {
  const header = request.headers.get('authorization')
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    return false
  }
  const token = header.slice(BEARER_PREFIX.length)
  if (token.length === 0) {
    return false
  }

  try {
    const { payload } = await jwtVerify(token, keySource, {
      issuer: GOOGLE_ISSUERS,
      audience: config.endpointUrl,
    })
    return payload.email_verified === true && payload.email === config.serviceAccountEmail
  } catch {
    // Any failure — bad signature, wrong iss/aud, expired, malformed
    // compact-JWS, unknown kid, a JWKS fetch error — is "not verified".
    return false
  }
}

/**
 * Convenience factory: close {@link verifyGmailPushJwt} over a fixed
 * `config`/`keySource`, producing the exact
 * `(request: Request) => Promise<boolean>` shape `src/api/gmail-webhook.ts`
 * depends on (and the same shape as `InboundEmailProvider.verifySignature`,
 * `src/providers/inbound-email.ts` — see the module doc). This is the one
 * function a composition root or test typically needs from this module.
 */
export function createGmailPushSignatureVerifier(
  config: GmailPushJwtConfig,
  keySource: GmailPushKeySource,
): (request: Request) => Promise<boolean> {
  return (request) => verifyGmailPushJwt(request, config, keySource)
}
