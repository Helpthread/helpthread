/**
 * Deploy-time environment configuration for the Helpthread engine's
 * composition root (HT-43; specs/deploy/gmail-inbound-runbook.md's env
 * reference). {@link loadConfig} reads the full env contract, validates every
 * value eagerly, and returns a typed {@link AppConfig} — or throws ONE error
 * listing every problem at once, so a misconfigured deploy fails loudly at
 * boot rather than on a mailbox's first push (the same fail-fast discipline
 * `createGmailConnectService`/`createGmailOAuthTokenService` already apply to
 * their own required fields).
 *
 * ## Never leaks a secret value
 *
 * Validation errors name the offending VARIABLE and the nature of the problem
 * ("missing", "must be at least N characters", "must be base64 of a 32-byte
 * key") — never the value itself. A too-short secret's length is a structural
 * fact, not the secret; the bytes never appear in a thrown message or a log
 * line (matching `token-crypto.ts`'s and `gmail-oauth.ts`'s discipline).
 *
 * ## This module reads env; the composition root wires adapters
 *
 * `loadConfig` is pure over its `env` argument (defaulting to `process.env`)
 * and constructs no adapters, opens no connections, and imports no platform
 * SDK — it only parses and validates. Turning an `AppConfig` into concrete
 * providers wired into `createInboxApi` is `./root.ts`'s job.
 */

import { decodeEncryptionKey } from '../store/token-crypto.js'

/**
 * Minimum service Bearer token length — mirrors `createInboxApi`'s own
 * `MIN_API_TOKEN_LENGTH` (`src/api/index.ts`) so a token this module accepts
 * is never one the API then refuses to start with.
 */
const MIN_API_TOKEN_LENGTH = 16

/**
 * Minimum HMAC signing-secret length — mirrors `reply-token.ts`'s
 * `MIN_SECRET_LENGTH` (32), the floor `assertValidKeyring` enforces on the
 * keyring `./root.ts` builds from {@link AppConfig.signingSecret}.
 */
const MIN_SIGNING_SECRET_LENGTH = 32

/**
 * Minimum `CRON_SECRET` length — Vercel's own guidance for the value it
 * auto-attaches as `Authorization: Bearer <CRON_SECRET>` on cron invocations
 * ("a random string of at least 16 characters").
 */
const MIN_CRON_SECRET_LENGTH = 16

/**
 * The fully-validated deploy configuration `./root.ts` builds concrete
 * adapters from. Every field is present and well-formed by construction — a
 * missing or malformed value is a {@link loadConfig} throw, never a
 * `undefined` slot a downstream adapter has to re-check.
 */
export interface AppConfig {
  /** Supabase transaction-mode pooler URI (port 6543) — `PostgresDb`'s connection string. */
  databaseUrl: string
  /** Supabase project URL — the Storage `BlobStore` adapter's base. */
  supabaseUrl: string
  /** Supabase `service_role` key — server-only; grants full Storage access. */
  supabaseServiceRoleKey: string
  /** Private Storage bucket name attachment/oversized-raw blobs are namespaced within. */
  blobBucket: string
  /** The Internal OAuth app's client id (connect flow + token refresh). */
  gmailOAuthClientId: string
  /** The Internal OAuth app's client secret. */
  gmailOAuthClientSecret: string
  /**
   * Gmail push configuration — OPTIONAL as of HT-94.
   *
   * Inbound mail reaches the engine either by push webhook or by the bounded
   * scheduled fetch (CHARTER.md §2, amended 2026-07-20). Push is the
   * lower-latency option; the scheduled sweep is the transport that always
   * runs. An operator who has not stood up a Pub/Sub topic — which is the
   * majority of the Google Cloud setup burden, and the half that fails
   * silently — leaves all three vars unset and the engine runs on the sweep
   * alone.
   *
   * All three travel as ONE object rather than three optional strings so a
   * half-configured push is unrepresentable: you cannot arm `watch()` against
   * a topic without also being able to authenticate the resulting push, and a
   * config that permits that shape invites exactly the silent-failure mode
   * this amendment set out to remove.
   */
  gmailPush?: {
    /** Cloud Pub/Sub topic `watch()` arms notifications to (`projects/{project}/topics/{topic}`). */
    topic: string
    /** The exact push subscription the webhook accepts (`projects/{project}/subscriptions/{name}`). */
    subscription: string
    /** The push subscription's OIDC service-account email (the JWT `email` claim the webhook matches). */
    serviceAccount: string
  }
  /** The 32-byte AES-256 key decoded from `HELPTHREAD_TOKEN_ENC_KEY` — encrypts stored refresh tokens at rest. */
  tokenEncryptionKey: Buffer
  /** The Agent-inbox service Bearer token every API request is checked against. */
  apiToken: string
  /** The HMAC signing secret backing the reply/state/view-token keyring. */
  signingSecret: string
  /** The secret guarding the internal cron/drain endpoints (Vercel Cron's `Authorization: Bearer` value). */
  cronSecret: string
  /** The deployment's public origin, trailing slash stripped — the base for the OAuth redirect, the push `aud`, and any absolute URL. */
  publicBaseUrl: string
  /** Domain minted into outbound `Message-ID`s. */
  mailDomain: string
  /** The connected support mailbox's address — the `from` on every Agent reply, and the mailbox outbound sends resolve their token from. */
  supportAddress: string
  /**
   * The web UI's base origin (HT-54; specs/auth/agents-and-auth.md §8) —
   * invite links are `${uiBaseUrl}/invite/${token}`. OPTIONAL, unlike every
   * other field above: when `HELPTHREAD_UI_BASE_URL` is unset, invite email
   * deps are simply absent — the Agents API still works, `sendInvite`
   * creates `invited` Agents with `inviteSent: false`, and `POST
   * /agents/{id}/invite` refuses with `409 conflict` (the admin-set-password
   * fallback remains the only path that works before a UI origin is known).
   */
  uiBaseUrl?: string
}

/** Accumulates human-readable, secret-free validation problems for a single combined throw. */
class ConfigErrors {
  readonly #problems: string[] = []

  add(message: string): void {
    this.#problems.push(message)
  }

  /** A present, non-empty (after trim) string, or `null` with a recorded "missing" problem. */
  requireString(env: NodeJS.ProcessEnv, name: string): string | null {
    const raw = env[name]
    if (raw === undefined || raw.trim().length === 0) {
      this.add(`${name} is required but missing or empty`)
      return null
    }
    return raw
  }

  /** {@link requireString} plus a minimum-length floor (length only — never the value — is reported). */
  requireMinLength(env: NodeJS.ProcessEnv, name: string, min: number): string | null {
    const value = this.requireString(env, name)
    if (value === null) return null
    if (value.length < min) {
      this.add(`${name} must be at least ${min} characters (got ${value.length})`)
      return null
    }
    return value
  }

  throwIfAny(): void {
    if (this.#problems.length > 0) {
      throw new Error(
        `loadConfig: invalid deployment configuration — fix the following environment ${
          this.#problems.length === 1 ? 'variable' : 'variables'
        } and redeploy:\n  - ${this.#problems.join('\n  - ')}`,
      )
    }
  }
}

/**
 * Read and validate the whole env contract into an {@link AppConfig}. Throws
 * one aggregated, secret-free error (see the module doc) if anything is
 * missing or malformed. `env` defaults to `process.env`; injectable purely
 * for tests.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors = new ConfigErrors()

  const databaseUrl = errors.requireString(env, 'DATABASE_URL')
  const supabaseUrl = errors.requireString(env, 'SUPABASE_URL')
  const supabaseServiceRoleKey = errors.requireString(env, 'SUPABASE_SERVICE_ROLE_KEY')
  const blobBucket = errors.requireString(env, 'HELPTHREAD_BLOB_BUCKET')
  const gmailOAuthClientId = errors.requireString(env, 'GMAIL_OAUTH_CLIENT_ID')
  const gmailOAuthClientSecret = errors.requireString(env, 'GMAIL_OAUTH_CLIENT_SECRET')
  const gmailPush = resolveGmailPush(env, errors)
  const apiToken = errors.requireMinLength(env, 'HELPTHREAD_API_TOKEN', MIN_API_TOKEN_LENGTH)
  const signingSecret = errors.requireMinLength(
    env,
    'HELPTHREAD_SIGNING_SECRET',
    MIN_SIGNING_SECRET_LENGTH,
  )
  const cronSecret = errors.requireMinLength(env, 'CRON_SECRET', MIN_CRON_SECRET_LENGTH)
  const mailDomain = errors.requireString(env, 'HELPTHREAD_MAIL_DOMAIN')
  const supportAddress = errors.requireString(env, 'HELPTHREAD_SUPPORT_ADDRESS')

  const tokenEncryptionKey = resolveEncryptionKey(env, errors)
  const publicBaseUrl = resolvePublicBaseUrl(env, errors)
  const uiBaseUrl = resolveUiBaseUrl(env, errors)

  errors.throwIfAny()

  // Every value above is non-null here: throwIfAny() would have thrown
  // otherwise. The non-null assertions make that guarantee explicit to the
  // type system rather than defeating it with a cast on the whole object.
  return {
    databaseUrl: databaseUrl as string,
    supabaseUrl: supabaseUrl as string,
    supabaseServiceRoleKey: supabaseServiceRoleKey as string,
    blobBucket: blobBucket as string,
    gmailOAuthClientId: gmailOAuthClientId as string,
    gmailOAuthClientSecret: gmailOAuthClientSecret as string,
    ...(gmailPush !== undefined ? { gmailPush } : {}),
    tokenEncryptionKey: tokenEncryptionKey as Buffer,
    apiToken: apiToken as string,
    signingSecret: signingSecret as string,
    cronSecret: cronSecret as string,
    publicBaseUrl: publicBaseUrl as string,
    mailDomain: mailDomain as string,
    supportAddress: supportAddress as string,
    ...(uiBaseUrl !== undefined ? { uiBaseUrl } : {}),
  }
}

/**
 * Decode + length-validate `HELPTHREAD_TOKEN_ENC_KEY` via
 * `decodeEncryptionKey` (`src/store/token-crypto.ts`), folding its throw into
 * the aggregated error set rather than aborting the rest of the validation.
 * Its message names the variable and the required shape, never the bytes.
 */
function resolveEncryptionKey(env: NodeJS.ProcessEnv, errors: ConfigErrors): Buffer | null {
  const raw = errors.requireString(env, 'HELPTHREAD_TOKEN_ENC_KEY')
  if (raw === null) return null
  try {
    return decodeEncryptionKey(raw)
  } catch {
    // decodeEncryptionKey's own message is safe (length-only), but re-phrase
    // for this env var by name; never echo the (secret) raw value.
    errors.add(
      'HELPTHREAD_TOKEN_ENC_KEY must be the base64 encoding of a 32-byte key (e.g. `openssl rand -base64 32`)',
    )
    return null
  }
}

/**
 * Validate `PUBLIC_BASE_URL` as a bare http(s) **origin** and return its
 * canonical form (`URL.origin` — scheme + host + optional port, no trailing
 * slash). It must be origin-ONLY: a path, query, fragment, or embedded
 * credentials are rejected, not silently dropped, because `${publicBaseUrl}` is
 * concatenated with fixed paths (`/api/v1/inbound/gmail`, `.../callback`) to
 * form the OAuth redirect URI and the push `aud` — values Google and the
 * webhook byte-compare. A stray path/query in the base would corrupt those
 * (`https://x/foo` + `/api/...` → `https://x/foo/api/...`, a mismatch), and
 * silently stripping it could hide a real operator misconfiguration.
 */
function resolvePublicBaseUrl(env: NodeJS.ProcessEnv, errors: ConfigErrors): string | null {
  const raw = errors.requireString(env, 'PUBLIC_BASE_URL')
  if (raw === null) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    errors.add(
      `PUBLIC_BASE_URL must be an absolute URL (e.g. https://desk.example.com), got ${JSON.stringify(raw)}`,
    )
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    errors.add(
      `PUBLIC_BASE_URL must be an http(s) URL, got protocol ${JSON.stringify(parsed.protocol)}`,
    )
    return null
  }
  // Origin-only: `new URL('https://x')`/`new URL('https://x/')` both have
  // pathname `/`; anything else (a real path), or a query/fragment/credentials,
  // means the value is not a bare origin.
  if (
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    errors.add(
      'PUBLIC_BASE_URL must be a bare origin with no path, query, fragment, or credentials (e.g. https://desk.example.com)',
    )
    return null
  }
  return parsed.origin
}

/**
 * `HELPTHREAD_UI_BASE_URL` is OPTIONAL (HT-54; unlike every `require*` field
 * above) — absent means "no invite email deps configured" (`AppConfig.uiBaseUrl`'s
 * doc). `undefined` here means "not set, and that's fine, no error." When
 * SET, it must still be a well-formed http(s) origin (same shape as
 * `PUBLIC_BASE_URL`, but a distinct origin — the UI is a separate Vercel
 * project from the engine, `HELPTHREAD_UI_SESSION_SECRET`'s deployment) —
 * a malformed value IS a boot-time error, since a garbage invite link is
 * worse than no invite feature at all.
 */
/** Hosts whose traffic never leaves the machine — the one place plain http is acceptable for invite links. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

/**
 * Resolve the OPTIONAL Gmail push trio, all-or-nothing (HT-94).
 *
 * Three outcomes, and only three:
 * - all three unset  → `undefined`; the engine runs on the scheduled sweep
 *   alone, and nothing in the Google Cloud Pub/Sub setup is required.
 * - all three set    → the configured object; push is armed and the webhook
 *   authenticates against it, exactly as before this change.
 * - some subset set  → a config ERROR naming the missing vars. A partially
 *   configured push is never silently treated as "off": an operator who set a
 *   topic and forgot the service account has a broken push they believe works,
 *   which is the precise failure this amendment exists to eliminate. Failing
 *   at boot is the whole point of this module (see `loadConfig`'s aggregation).
 */
function resolveGmailPush(
  env: NodeJS.ProcessEnv,
  errors: ConfigErrors,
): { topic: string; subscription: string; serviceAccount: string } | undefined {
  const vars = {
    topic: 'GMAIL_PUBSUB_TOPIC',
    subscription: 'GMAIL_PUBSUB_SUBSCRIPTION',
    serviceAccount: 'GMAIL_PUSH_SERVICE_ACCOUNT',
  } as const

  const present: Partial<Record<keyof typeof vars, string>> = {}
  const missing: string[] = []
  for (const [key, name] of Object.entries(vars) as [keyof typeof vars, string][]) {
    const raw = env[name]
    if (raw === undefined || raw.trim().length === 0) missing.push(name)
    else present[key] = raw
  }

  if (missing.length === Object.keys(vars).length) return undefined
  if (missing.length > 0) {
    errors.add(
      `Gmail push is partially configured: ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } unset. Set all of ${Object.values(vars).join(', ')} to enable push, or none of them to run on the scheduled fetch alone.`,
    )
    return undefined
  }

  return {
    topic: present.topic as string,
    subscription: present.subscription as string,
    serviceAccount: present.serviceAccount as string,
  }
}

function resolveUiBaseUrl(env: NodeJS.ProcessEnv, errors: ConfigErrors): string | undefined {
  const raw = env.HELPTHREAD_UI_BASE_URL
  if (raw === undefined || raw.trim().length === 0) return undefined

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    errors.add(
      `HELPTHREAD_UI_BASE_URL must be an absolute URL (e.g. https://desk.example.com), got ${JSON.stringify(raw)}`,
    )
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    errors.add(
      `HELPTHREAD_UI_BASE_URL must be an http(s) URL, got protocol ${JSON.stringify(parsed.protocol)}`,
    )
    return undefined
  }
  // Invite links carry a credential (the signed invite token), so plaintext
  // transport is refused outright — except explicit loopback hosts, where
  // local development genuinely runs over http and the traffic never leaves
  // the machine.
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    errors.add(
      `HELPTHREAD_UI_BASE_URL must use https (invite links carry a signed credential); http is allowed only for loopback hosts, got ${JSON.stringify(raw)}`,
    )
    return undefined
  }
  if (
    (parsed.pathname !== '/' && parsed.pathname !== '') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    errors.add(
      'HELPTHREAD_UI_BASE_URL must be a bare origin with no path, query, fragment, or credentials (e.g. https://desk.example.com)',
    )
    return undefined
  }
  return parsed.origin
}
