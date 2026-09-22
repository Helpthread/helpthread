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
import { withLibpqSslCompat } from './postgres-url-compat.js'

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
 * Minimum `HELPTHREAD_SETUP_SECRET` length (issue #227) — mirrors
 * `MIN_API_TOKEN_LENGTH`: like the API token, it is a bearer-style credential
 * a human pastes into a form rather than an HMAC key, so it shares that
 * floor rather than `MIN_SIGNING_SECRET_LENGTH`'s 32.
 */
const MIN_SETUP_SECRET_LENGTH = 16

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
  /**
   * The Internal OAuth app's client id (connect flow + token refresh).
   * OPTIONAL as of the Vercel Deploy Button path (issue #151): unlike every
   * `require*` field above, `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET`
   * are BOTH-OR-NEITHER (see {@link resolveGmailOAuth}) — a deployment that
   * only ever connects IMAP/SMTP mailboxes no longer needs a placeholder
   * Google Cloud OAuth app just to boot. Absent, `./root.ts` never
   * constructs the Gmail token service, connect/disconnect services, or the
   * push webhook deps: Gmail connect/OAuth routes refuse (existing
   * degrade-by-omission convention, matching `gmailPush`/`gmailConnect`
   * being absent-by-default in `src/api/index.ts`), and one warning is
   * logged at boot (`warnings` below). IMAP/SMTP mailboxes are unaffected.
   */
  gmailOAuthClientId?: string
  /** The Internal OAuth app's client secret. OPTIONAL — see {@link gmailOAuthClientId}. */
  gmailOAuthClientSecret?: string
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
   * invite links are `${uiBaseUrl}/invite/${token}` and passkeys bind to it.
   * When the caller says the UI is served from `PUBLIC_BASE_URL`
   * (`LoadConfigOptions.uiAtPublicBaseUrl` — the single-project deployment),
   * this is `publicBaseUrl` unless `HELPTHREAD_UI_BASE_URL` overrides it.
   * OPTIONAL, unlike every other field above: absent — not set, not derived,
   * or derived from a plain-http origin off loopback — means invite email
   * deps are simply absent and passkeys are off; the Agents API still works,
   * `sendInvite` creates
   * `invited` Agents with `inviteSent: false`, and `POST /agents/{id}/invite`
   * refuses with `409 conflict` (the admin-set-password fallback remains).
   */
  uiBaseUrl?: string
  /**
   * The bootstrap secret `POST /api/v1/setup` requires alongside the
   * existing zero-Agents guard (issue #227; specs/auth/agents-and-auth.md
   * §6) — closes the window where whoever first opens a public `/setup` URL
   * becomes the permanent admin. OPTIONAL, unlike every other field above:
   * "required" (the issue's word) and "may be removed once an Agent exists"
   * would conflict if `loadConfig` failed boot without it, so unset is a
   * valid (if less safe) state and `handleSetup` (`src/api/agents.ts`)
   * refuses every request while it's absent. When SET, {@link
   * MIN_SETUP_SECRET_LENGTH} is enforced, same discipline as every other
   * secret here — never logged.
   */
  setupSecret?: string
  /** Secret-free notes about features this configuration turned off, for the composition root to log once at boot. */
  warnings?: readonly string[]
}

/** Accumulates human-readable, secret-free validation problems for a single combined throw. */
class ConfigErrors {
  readonly #problems: string[] = []

  add(message: string): void {
    this.#problems.push(message)
  }

  /** A present, non-empty (after trim) string, or `null` with a recorded "missing" problem. */
  requireString(env: NodeJS.ProcessEnv, name: string): string | null {
    return this.requireStringValue(name, env[name])
  }

  /**
   * {@link requireString}'s check, given the value directly rather than an
   * `env` + name pair — for a field whose value may already be a resolved
   * platform-integration fallback (`resolvePlatformIntegrationOverrides`)
   * rather than a bare `env[name]` read.
   */
  requireStringValue(name: string, raw: string | undefined): string | null {
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

  /**
   * {@link requireMinLength}'s check for an OPTIONAL variable: absent (or
   * whitespace-only) is a valid state — `undefined`, no problem recorded —
   * but present-but-short IS one, same message shape as
   * {@link requireMinLength}.
   */
  optionalMinLength(env: NodeJS.ProcessEnv, name: string, min: number): string | undefined {
    const raw = env[name]
    if (raw === undefined || raw.trim().length === 0) return undefined
    if (raw.length < min) {
      this.add(`${name} must be at least ${min} characters (got ${raw.length})`)
      return undefined
    }
    return raw
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
/** How the deployment is shaped — what the env alone cannot say. */
export interface LoadConfigOptions {
  /**
   * The operator UI is served from `PUBLIC_BASE_URL` itself (the single-project
   * deployment, where `web/src/engine/mount.ts` hosts this engine). Only that
   * caller knows this, so only it may say so; the UI origin then derives from
   * `PUBLIC_BASE_URL` unless `HELPTHREAD_UI_BASE_URL` overrides it. An engine
   * deployed on its own (`api/index.ts`) never derives — unset means absent.
   */
  uiAtPublicBaseUrl?: boolean
}

export function loadConfig(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  const overrides = resolvePlatformIntegrationOverrides(rawEnv)
  const errors = new ConfigErrors()

  const databaseUrl = errors.requireStringValue(
    'DATABASE_URL',
    overrides.databaseUrl ?? rawEnv.DATABASE_URL,
  )
  const supabaseUrl = errors.requireString(rawEnv, 'SUPABASE_URL')
  const supabaseServiceRoleKey = errors.requireStringValue(
    'SUPABASE_SERVICE_ROLE_KEY',
    overrides.supabaseServiceRoleKey ?? rawEnv.SUPABASE_SERVICE_ROLE_KEY,
  )
  const blobBucket = errors.requireString(rawEnv, 'HELPTHREAD_BLOB_BUCKET')
  const gmailOAuth = resolveGmailOAuth(rawEnv, errors)
  const gmailPush = resolveGmailPush(rawEnv, errors)
  if (
    gmailPush !== undefined &&
    (gmailOAuth.clientId === undefined || gmailOAuth.clientSecret === undefined)
  ) {
    errors.add(
      'GMAIL_PUBSUB_TOPIC/GMAIL_PUBSUB_SUBSCRIPTION/GMAIL_PUSH_SERVICE_ACCOUNT are set, but ' +
        'GMAIL_OAUTH_CLIENT_ID/GMAIL_OAUTH_CLIENT_SECRET are not — Gmail push has nothing to ' +
        'authenticate against without Gmail OAuth configured. Set both Gmail OAuth variables, ' +
        'or remove the three push variables to run on IMAP/SMTP alone.',
    )
  }
  const apiToken = errors.requireMinLength(rawEnv, 'HELPTHREAD_API_TOKEN', MIN_API_TOKEN_LENGTH)
  const signingSecret = errors.requireMinLength(
    rawEnv,
    'HELPTHREAD_SIGNING_SECRET',
    MIN_SIGNING_SECRET_LENGTH,
  )
  const cronSecret = errors.requireMinLength(rawEnv, 'CRON_SECRET', MIN_CRON_SECRET_LENGTH)
  const setupSecret = resolveSetupSecret(rawEnv, errors)
  const mailDomain = errors.requireString(rawEnv, 'HELPTHREAD_MAIL_DOMAIN')
  const supportAddress = errors.requireString(rawEnv, 'HELPTHREAD_SUPPORT_ADDRESS')

  const tokenEncryptionKey = resolveEncryptionKey(rawEnv, errors)
  const publicBaseUrl = resolvePublicBaseUrl(
    overrides.publicBaseUrl ?? rawEnv.PUBLIC_BASE_URL,
    errors,
  )
  const ui = resolveUiBaseUrl(
    rawEnv,
    errors,
    options.uiAtPublicBaseUrl === true ? publicBaseUrl : null,
  )

  errors.throwIfAny()

  // Secret-free notes for `./root.ts` to log once at boot — collected from
  // every resolver above that can degrade instead of failing (gmailOAuth,
  // ui), rather than one field per warning source.
  const warnings = [gmailOAuth.warning, ui.warning].filter(
    (warning): warning is string => warning !== undefined,
  )

  // Every value above is non-null here: throwIfAny() would have thrown
  // otherwise. The non-null assertions make that guarantee explicit to the
  // type system rather than defeating it with a cast on the whole object.
  return {
    databaseUrl: databaseUrl as string,
    supabaseUrl: supabaseUrl as string,
    supabaseServiceRoleKey: supabaseServiceRoleKey as string,
    blobBucket: blobBucket as string,
    ...(gmailOAuth.clientId !== undefined && gmailOAuth.clientSecret !== undefined
      ? { gmailOAuthClientId: gmailOAuth.clientId, gmailOAuthClientSecret: gmailOAuth.clientSecret }
      : {}),
    ...(gmailPush !== undefined ? { gmailPush } : {}),
    tokenEncryptionKey: tokenEncryptionKey as Buffer,
    apiToken: apiToken as string,
    signingSecret: signingSecret as string,
    cronSecret: cronSecret as string,
    ...(setupSecret !== undefined ? { setupSecret } : {}),
    publicBaseUrl: publicBaseUrl as string,
    mailDomain: mailDomain as string,
    supportAddress: supportAddress as string,
    ...(ui.uiBaseUrl !== undefined ? { uiBaseUrl: ui.uiBaseUrl } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
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
 * Resolve the OPTIONAL `HELPTHREAD_SETUP_SECRET` (issue #227; see
 * {@link AppConfig.setupSecret}). Unset (or whitespace-only) yields
 * `undefined` — a valid state, not an error. Present-but-short IS an error
 * (a trivially guessable value would defeat the whole point of gating
 * `/setup`). Not trimmed, matching {@link ConfigErrors.requireString}'s own
 * convention for every other secret in this module.
 */
function resolveSetupSecret(env: NodeJS.ProcessEnv, errors: ConfigErrors): string | undefined {
  return errors.optionalMinLength(env, 'HELPTHREAD_SETUP_SECRET', MIN_SETUP_SECRET_LENGTH)
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
function resolvePublicBaseUrl(rawValue: string | undefined, errors: ConfigErrors): string | null {
  const raw = errors.requireStringValue('PUBLIC_BASE_URL', rawValue)
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
 * The UI origin (`AppConfig.uiBaseUrl`). `HELPTHREAD_UI_BASE_URL` is OPTIONAL
 * (HT-54; unlike every `require*` field above). Unset, and the caller has
 * said the UI is served from `PUBLIC_BASE_URL` (`derivedFrom`), the origin is
 * that one; the derived value keeps this validator's plaintext rule (invite
 * links carry a signed credential) but degrades instead of failing: plain
 * http off loopback yields no UI origin plus a warning, so a LAN or bare-IP
 * install still boots with invites and passkeys off. Unset with no
 * `derivedFrom` means absent — an engine deployed on its own has no UI
 * origin to assume. When SET, the value must be a well-formed http(s) origin
 * — a malformed value IS a boot-time error, since a garbage invite link is
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
 * Resolve the BOTH-OR-NEITHER `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET`
 * pair (issue #151 — the Deploy with Vercel path makes Gmail optional for
 * installs that only ever connect IMAP/SMTP mailboxes). Three outcomes:
 *
 * - both unset  → `{ warning }`; Gmail connect is disabled for this
 *   deployment (`./root.ts` never builds the Gmail token/connect/disconnect
 *   services), IMAP/SMTP is unaffected, and one secret-free line is logged
 *   at boot.
 * - both set    → `{ clientId, clientSecret }`, exactly the pre-#151 shape.
 * - one set     → a config ERROR naming the missing one. Half a Gmail OAuth
 *   app is not a usable Gmail OAuth app, and a deployment that believes
 *   Gmail is configured because ONE var is present is the same silent-half-
 *   config failure {@link resolveGmailPush} already refuses for the push trio.
 */
function resolveGmailOAuth(
  env: NodeJS.ProcessEnv,
  errors: ConfigErrors,
): { clientId?: string; clientSecret?: string; warning?: string } {
  const clientIdRaw = env.GMAIL_OAUTH_CLIENT_ID
  const clientSecretRaw = env.GMAIL_OAUTH_CLIENT_SECRET
  const clientId =
    clientIdRaw !== undefined && clientIdRaw.trim().length > 0 ? clientIdRaw : undefined
  const clientSecret =
    clientSecretRaw !== undefined && clientSecretRaw.trim().length > 0 ? clientSecretRaw : undefined

  if (clientId === undefined && clientSecret === undefined) {
    return {
      warning:
        'GMAIL_OAUTH_CLIENT_ID/GMAIL_OAUTH_CLIENT_SECRET are unset — Gmail connect is disabled ' +
        'for this deployment (the Gmail connect/OAuth routes refuse); IMAP/SMTP mailboxes are unaffected.',
    }
  }
  if (clientId === undefined || clientSecret === undefined) {
    errors.add(
      `GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set together — ${
        clientId === undefined ? 'GMAIL_OAUTH_CLIENT_ID' : 'GMAIL_OAUTH_CLIENT_SECRET'
      } is unset. Set both to enable Gmail, or unset both to run on IMAP/SMTP alone.`,
    )
    return {}
  }
  return { clientId, clientSecret }
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

function resolveUiBaseUrl(
  env: NodeJS.ProcessEnv,
  errors: ConfigErrors,
  derivedFrom: string | null,
): { uiBaseUrl?: string; warning?: string } {
  const raw = env.HELPTHREAD_UI_BASE_URL
  if (raw === undefined || raw.trim().length === 0) {
    if (derivedFrom === null) return {}
    const derived = new URL(derivedFrom)
    if (derived.protocol === 'http:' && !isLoopbackHost(derived.hostname)) {
      return {
        warning:
          'HELPTHREAD_UI_BASE_URL is unset and PUBLIC_BASE_URL is plain http on a non-loopback host — invite links and passkeys are disabled for this deployment (both need https); every other feature is unaffected',
      }
    }
    return { uiBaseUrl: derivedFrom }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    errors.add(
      `HELPTHREAD_UI_BASE_URL must be an absolute URL (e.g. https://desk.example.com), got ${JSON.stringify(raw)}`,
    )
    return {}
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    errors.add(
      `HELPTHREAD_UI_BASE_URL must be an http(s) URL, got protocol ${JSON.stringify(parsed.protocol)}`,
    )
    return {}
  }
  // Invite links carry a credential (the signed invite token), so plaintext
  // transport is refused outright — except explicit loopback hosts, where
  // local development genuinely runs over http and the traffic never leaves
  // the machine.
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    errors.add(
      `HELPTHREAD_UI_BASE_URL must use https (invite links carry a signed credential); http is allowed only for loopback hosts, got ${JSON.stringify(raw)}`,
    )
    return {}
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
    return {}
  }
  return { uiBaseUrl: parsed.origin }
}

/** `env[name]`, treating unset OR whitespace-only as absent — the convention every resolver above already uses. */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0
}

/** The handful of fields {@link resolvePlatformIntegrationOverrides} can supply in place of their primary env var. */
interface PlatformIntegrationOverrides {
  databaseUrl?: string
  supabaseServiceRoleKey?: string
  publicBaseUrl?: string
}

/**
 * Platform-integration variable aliases (issue #151/#153, the Deploy with
 * Vercel path), resolved by reading each named var straight off `rawEnv`
 * into a small overrides object — NOT by copying the whole of `rawEnv`
 * (typically `process.env`, which can hold arbitrary secrets Helpthread
 * never needs to touch as a value; a bulk copy of it is exactly the kind of
 * flow CodeQL's clear-text-logging query flags, even though nothing here
 * ever logs a raw value). Every field {@link loadConfig} doesn't override
 * here is read directly off `rawEnv` at its own call site, same as before;
 * an explicit value under the primary name always wins over its alias (only
 * a missing/blank primary falls back).
 *
 * - `DATABASE_URL` ← `POSTGRES_URL`, with {@link withLibpqSslCompat} applied
 *   ONLY on this fallback path: the Vercel⇄Supabase Marketplace integration
 *   writes the transaction-mode pooler connection string (Supabase's own
 *   Vercel-integration docs) under this name, with `sslmode=require` — see
 *   `./postgres-url-compat.ts` for why that needs the libpq-compat shim. An
 *   explicit `DATABASE_URL` is never touched.
 * - `SUPABASE_SERVICE_ROLE_KEY` ← `SUPABASE_SECRET_KEY`: the integration's
 *   current name for the same server-only key. `SUPABASE_URL` needs no
 *   alias — the integration already writes that exact name.
 * - `PUBLIC_BASE_URL` ← `https://${VERCEL_PROJECT_PRODUCTION_URL}`, but ONLY
 *   on a Production build (`VERCEL_ENV === 'production'`; Vercel's own
 *   stable per-project system env var, present on every environment, unlike
 *   the per-deployment `VERCEL_URL`): a button-installed deployment gets a
 *   working origin before anyone has set a custom domain. See
 *   `specs/deploy/deploy-with-vercel.md` for the passkey caveat this creates
 *   (passkeys bind to whichever host was current when one was registered).
 */
function resolvePlatformIntegrationOverrides(
  rawEnv: NodeJS.ProcessEnv,
): PlatformIntegrationOverrides {
  const overrides: PlatformIntegrationOverrides = {}
  if (isBlank(rawEnv.DATABASE_URL) && !isBlank(rawEnv.POSTGRES_URL)) {
    overrides.databaseUrl = withLibpqSslCompat(rawEnv.POSTGRES_URL as string)
  }
  if (isBlank(rawEnv.SUPABASE_SERVICE_ROLE_KEY) && !isBlank(rawEnv.SUPABASE_SECRET_KEY)) {
    overrides.supabaseServiceRoleKey = rawEnv.SUPABASE_SECRET_KEY
  }
  if (
    isBlank(rawEnv.PUBLIC_BASE_URL) &&
    rawEnv.VERCEL_ENV === 'production' &&
    !isBlank(rawEnv.VERCEL_PROJECT_PRODUCTION_URL)
  ) {
    overrides.publicBaseUrl = `https://${rawEnv.VERCEL_PROJECT_PRODUCTION_URL}`
  }
  return overrides
}
