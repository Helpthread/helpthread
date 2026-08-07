/**
 * Endpoint-possession challenge (HT-119) — the last gate before a
 * newly-deployed module's webhook endpoint is ever activated (non-negotiable
 * condition 5, candidate-then-cutover: "never activate a webhook endpoint
 * until the deployed module proves possession via a signed challenge").
 *
 * ## Why this exists
 *
 * By the time `../install/installer.ts` reaches this check, the module's
 * deployment is `'ready'` (`../deploy/provider.ts`'s
 * `DeployProvider.getDeploymentState`) and has already been handed the
 * webhook signing secret the installer minted at its `credentials_issued`
 * step, as an engine-managed env var. Neither of those facts proves
 * anything about what is actually LIVE and answering at the deployment's
 * URL: a build can succeed while serving stale or wrong code, a DNS/proxy
 * misconfiguration can point the URL somewhere else entirely, and — the
 * case this module exists specifically to close — a mistyped or
 * adversarial URL would otherwise start receiving another customer's
 * conversation events the moment the installer registers it as a webhook
 * endpoint. If the installer activated delivery on "the deployment record
 * says ready" alone, none of those cases would ever be caught.
 *
 * {@link verifyEndpointPossession} closes it: it sends a fresh, single-use
 * nonce, signed the SAME way `../../webhooks/delivery.ts` signs every real
 * delivery, and only a caller that can present the correct HMAC over that
 * exact nonce — i.e., something that already holds the secret the
 * installer minted for THIS deployment — passes. Only after this call
 * succeeds does the installer create the real `webhook_endpoints` row
 * (`../install/installer.ts`'s `bootstrap_pending` step) — before that,
 * there is no row for `../../webhooks/outbox-drain.ts` to ever fan events
 * out to, so a failed or not-yet-attempted challenge cannot leak anything
 * by construction, not merely by this module's own refusal.
 *
 * ## Wire contract
 *
 * No prior contract for this exchange exists elsewhere in this codebase —
 * this module defines it, deliberately reusing an already-reviewed shape
 * rather than inventing a new one: the SAME envelope/signature scheme
 * `../../webhooks/delivery.ts` uses for a real delivery (`X-Helpthread-
 * Event`, `X-Helpthread-Delivery`, `X-Helpthread-Signature` — see
 * {@link signWebhookPayload}), with `type: 'module.challenge'` and a body
 * of `{ nonce }`. The deployed module is expected to verify that inbound
 * signature exactly as a real delivery's signature is verified, then
 * respond `200` with a JSON body `{ signature: <hex HMAC-SHA256(secret,
 * nonce)> }`. {@link verifyEndpointPossession} recomputes that same HMAC
 * locally and compares it to the response with `timingSafeEqual` — never a
 * plain `===`, since a byte-by-byte comparison against a secret-derived
 * value can leak timing information a probing attacker could exploit to
 * forge a response one byte at a time.
 *
 * A later ticket that formalizes the module-authoring contract (e.g. an
 * SDK a module imports) should treat this file's wire shape as the source
 * of truth to implement against — it is not currently pinned in any
 * `specs/` document.
 *
 * ## SSRF posture
 *
 * {@link sendChallengeRequest}, this module's default transport, reuses
 * `../../webhooks/ssrf.ts`'s `resolveSafeAddress` — the exact
 * resolve-then-connect pinning `../../webhooks/delivery.ts`'s
 * `sendWebhookRequest` already applies to webhook egress. A deployment's
 * URL is provider-returned rather than operator-typed, but it is still an
 * outbound request this engine makes to a host it does not control, to
 * which the module doc's own threat model above explicitly applies (a
 * misdirected or adversarial URL) — so it gets the same treatment as any
 * other egress this codebase already refuses to trust blindly, never a
 * carve-out for "this one came from our own deploy provider."
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { signWebhookPayload } from '../../webhooks/delivery.js'
import { resolveSafeAddress, SsrfRefusedError } from '../../webhooks/ssrf.js'

export { SsrfRefusedError }

/** Nonce size, bytes — 256 bits, matching the entropy `../../auth/assistant-token.ts` uses for its own server-generated secrets. */
const NONCE_BYTES = 32

/** Hard cap on the challenge response body — a JSON object with one hex string field, never plausibly large. A module that returns more than this is refused outright rather than partially read. */
export const MAX_CHALLENGE_RESPONSE_BYTES = 8 * 1024

/** Hard deadline for the whole challenge exchange — shorter than `../../webhooks/delivery.ts`'s own delivery timeout: a freshly-deployed module answering its OWN possession check has no legitimate reason to be slow, and a stuck bootstrap should fail fast rather than tie up the queue worker. */
export const CHALLENGE_TIMEOUT_MS = 5_000

/** The event `type` carried on every challenge request — distinct from any real delivery type (`../../webhooks/event-types.ts`) so a module can tell a possession check apart from a real event by inspecting the body alone, without needing to special-case the endpoint URL. */
export const CHALLENGE_EVENT_TYPE = 'module.challenge'

/** Generate a fresh challenge nonce (hex). Exported so a caller can record it in an audit event before sending, and so a test can supply a deterministic one via {@link VerifyEndpointPossessionDeps.nonce}. */
export function generateChallengeNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex')
}

/** Why {@link verifyEndpointPossession} failed. Never `'ok'` — see {@link ChallengeResult}. */
export type ChallengeFailureReason =
  | 'network-error'
  | 'http-error'
  | 'invalid-response'
  | 'signature-mismatch'

/** The outcome of {@link verifyEndpointPossession}. Modeled as a typed result, not a throw — a failed challenge is an ordinary, expected outcome (a not-yet-ready deployment, a module that hasn't implemented the contract yet), not a caller bug. */
export type ChallengeResult =
  | { ok: true }
  | { ok: false; reason: ChallengeFailureReason; message: string }

/** One raw HTTP response as {@link SendChallengeFn} returns it. */
export interface ChallengeHttpResponse {
  status: number
  body: string
}

/** The transport seam {@link verifyEndpointPossession} calls through — injectable so tests exercise the signing/verification logic against a canned response with zero real sockets, DNS, or TLS. */
export type SendChallengeFn = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<ChallengeHttpResponse>

async function readBoundedBody(response: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_CHALLENGE_RESPONSE_BYTES) {
      response.destroy()
      throw new Error(`challenge response exceeded the ${MAX_CHALLENGE_RESPONSE_BYTES}-byte cap`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Default {@link SendChallengeFn}: resolve-then-connect SSRF pinning
 * (module doc), `https:` only, `POST`, bounded response body. Mirrors
 * `../../webhooks/delivery.ts`'s `sendWebhookRequest` transport, except
 * this one reads (a capped amount of) the response body instead of
 * discarding it — the challenge's whole point is the module's signed
 * answer, unlike a real delivery where only the status matters.
 */
async function sendChallengeRequest(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<ChallengeHttpResponse> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') {
    throw new SsrfRefusedError(`challenge url must be https: — got '${parsed.protocol}//...'`)
  }
  const pinned = await resolveSafeAddress(parsed.hostname)
  const bodyBuffer = Buffer.from(body, 'utf8')

  return new Promise<ChallengeHttpResponse>((resolve, reject) => {
    const req = httpsRequest(
      parsed,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': bodyBuffer.length,
        },
        signal: AbortSignal.timeout(CHALLENGE_TIMEOUT_MS),
        // Resolve-then-connect pinning — see module doc and
        // `../../webhooks/delivery.ts`'s `sendWebhookRequest`, which this
        // mirrors verbatim.
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === 'function') {
            ;(lookupOptions as unknown as (err: null, address: string, family: number) => void)(
              null,
              pinned.address,
              pinned.family,
            )
            return
          }
          if (lookupOptions.all) {
            callback(null, [{ address: pinned.address, family: pinned.family }])
            return
          }
          callback(null, pinned.address, pinned.family)
        },
      },
      (res) => {
        readBoundedBody(res)
          .then((text) => resolve({ status: res.statusCode ?? 0, body: text }))
          .catch(reject)
      },
    )
    req.on('error', reject)
    req.end(bodyBuffer)
  })
}

/** Dependencies for {@link verifyEndpointPossession}. */
export interface VerifyEndpointPossessionDeps {
  /** Overrides the default transport — tests inject a fake here (module doc's "injectable" note). */
  send?: SendChallengeFn
  /** Overrides the generated nonce — tests only; production always generates a fresh one. */
  nonce?: string
}

/**
 * Send a signed possession challenge to `challengeUrl` and verify the
 * response proves the caller holds `secret`. See the module doc for the
 * full wire contract and threat model. Never throws for an ordinary
 * failure (a non-2xx response, a malformed body, a wrong signature, a
 * network error) — those are all reported as `{ ok: false }` with a typed
 * `reason`, matching this codebase's "typed result over throw/catch for
 * expected-in-normal-operation outcomes" convention (see e.g.
 * `../../store/module-installs.ts`'s `TransitionResult`).
 */
export async function verifyEndpointPossession(
  params: { challengeUrl: string; secret: string },
  deps: VerifyEndpointPossessionDeps = {},
): Promise<ChallengeResult> {
  const send = deps.send ?? sendChallengeRequest
  const nonce = deps.nonce ?? generateChallengeNonce()

  const body = JSON.stringify({ nonce })
  const timestampSeconds = Math.floor(Date.now() / 1000)
  const headers = {
    'X-Helpthread-Event': CHALLENGE_EVENT_TYPE,
    'X-Helpthread-Delivery': randomUUID(),
    'X-Helpthread-Signature': signWebhookPayload(params.secret, body, timestampSeconds),
  }

  let response: ChallengeHttpResponse
  try {
    response = await send(params.challengeUrl, body, headers)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'network-error', message }
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      reason: 'http-error',
      message: `challenge request to ${params.challengeUrl} failed with HTTP ${response.status}`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    return {
      ok: false,
      reason: 'invalid-response',
      message: 'challenge response was not valid JSON',
    }
  }
  const signature =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).signature
      : undefined
  if (typeof signature !== 'string' || signature.length === 0) {
    return {
      ok: false,
      reason: 'invalid-response',
      message: "challenge response is missing a string 'signature' field",
    }
  }

  const expected = createHmac('sha256', params.secret).update(nonce).digest('hex')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signature, 'utf8')
  const matches = expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf)

  if (!matches) {
    return {
      ok: false,
      reason: 'signature-mismatch',
      message: 'challenge response signature does not match the expected HMAC for this nonce',
    }
  }

  return { ok: true }
}
