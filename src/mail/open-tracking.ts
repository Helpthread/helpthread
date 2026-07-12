/**
 * Open tracking — the config-gated, DEFAULT-OFF read-receipt feature
 * (specs/api/agent-inbox-v1.md §4g, v1.1; HT-32).
 *
 * When (and only when) the operator enables it, every outbound reply's HTML
 * body gets a 1×1 tracking pixel whose URL carries a SIGNED view token bound
 * to the outbound thread. A customer's mail client fetching that pixel is
 * recorded — first view only — as the thread's `customerViewedAt`.
 *
 * **Off by default is a product stance, not a config accident** (spec §4g):
 * open-tracking pixels are telemetry on customers. While disabled nothing is
 * injected and nothing is recorded; enabling it is an explicit deployment
 * decision (`openTracking: { publicBaseUrl }` in the API/send deps).
 *
 * ## The view token
 *
 * ```
 * v.{keyId}.{threadId}.{sig}
 * ```
 *
 * - `sig = base64url( HMAC-SHA256( secret, `view.${keyId}.${threadId}` ) )` —
 *   the same full-HMAC, base64url, keyring-and-rotation model as reply
 *   tokens (`src/mail/reply-token.ts`), reusing the SAME {@link Keyring}.
 * - The canonical string is prefixed `view.` — deliberate DOMAIN SEPARATION
 *   from reply tokens (whose canonical is `${keyId}.${conversationId}.${threadId}`):
 *   a signature minted for one purpose can never verify for the other, even
 *   over the same ids.
 * - The spec's security requirement (§4g): the pixel URL must carry an
 *   unguessable signed credential, NEVER the bare thread uuid — a guessable
 *   identifier would let anyone forge a "customer viewed" signal. This token
 *   is that credential.
 *
 * Like reply tokens: minting is STRICT (a malformed token is our bug — throw
 * loudly), verification is TOTAL over the token string (hostile input must
 * never throw — the pixel endpoint answers the public internet).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { assertValidKeyring, type Keyring, type SigningKey } from './reply-token.js'

/** Fixed literal prefix marking a view token (vs. reply tokens' `ht`). */
const VIEW_TOKEN_PREFIX = 'v'

/** Number of dot-separated segments in a well-formed view token: `v`, keyId, threadId, sig. */
const SEGMENT_COUNT = 4

/** Same id charset as reply tokens: base64url-compatible, excludes the `.` delimiter. */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * The exact bytes signed: `view.${keyId}.${threadId}`. The `view.` prefix is
 * the domain separator — see the module doc.
 */
function canonicalString(keyId: string, threadId: string): string {
  return `view.${keyId}.${threadId}`
}

function sign(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('base64url')
}

/**
 * Mint a view token for `threadId`, signing with `keyring.current`. STRICT:
 * throws on a malformed threadId or keyring — emitting an unverifiable token
 * would silently break the feature for that message.
 */
export function mintViewToken(threadId: string, keyring: Keyring): string {
  assertValidKeyring(keyring)
  const { keyId, secret } = keyring.current
  if (typeof threadId !== 'string' || !ID_PATTERN.test(threadId)) {
    throw new Error(
      `mintViewToken: threadId must be a string matching ${ID_PATTERN} (got ${JSON.stringify(threadId)})`,
    )
  }
  const sig = sign(secret, canonicalString(keyId, threadId))
  return `${VIEW_TOKEN_PREFIX}.${keyId}.${threadId}.${sig}`
}

/**
 * Verify a candidate view token and return the thread it is bound to, or
 * `null`. TOTAL over `token` — the pixel endpoint feeds this raw path
 * segments from the public internet, and every rejection (wrong shape, wrong
 * prefix, unknown keyId, tampered field) is the same silent `null` (the
 * endpoint responds identically either way — spec §4g's no-validity-leak).
 * Same constant-time comparison + rotation model as reply-token verification.
 */
export function verifyViewToken(token: string, keyring: Keyring): { threadId: string } | null {
  assertValidKeyring(keyring)

  if (typeof token !== 'string') return null
  const segments = token.split('.')
  if (segments.length !== SEGMENT_COUNT) return null
  const [prefix, keyId, threadId, sig] = segments
  if (prefix !== VIEW_TOKEN_PREFIX) return null
  if (keyId.length === 0 || threadId.length === 0 || sig.length === 0) return null

  const canonical = canonicalString(keyId, threadId)
  for (const key of candidateKeys(keyring, keyId)) {
    if (signatureMatches(key.secret, canonical, sig)) {
      return { threadId }
    }
  }
  return null
}

/** Keys in the ring (current first, then retired) whose keyId matches the token's. */
function candidateKeys(keyring: Keyring, keyId: string): SigningKey[] {
  const all = keyring.retired ? [keyring.current, ...keyring.retired] : [keyring.current]
  return all.filter((key) => key.keyId === keyId)
}

/** Constant-time signature check — same length-guarded pattern as reply-token's. */
function signatureMatches(secret: string, canonical: string, providedSig: string): boolean {
  const expected = Buffer.from(sign(secret, canonical))
  const provided = Buffer.from(providedSig)
  if (expected.length !== provided.length) return false
  return timingSafeEqual(expected, provided)
}

/**
 * The pixel endpoint's path for a token, under the API base path. `.gif` is
 * part of the route shape (mail clients and proxies treat an image-looking
 * URL more kindly than a bare API path).
 */
export function pixelPathFor(token: string): string {
  return `/api/v1/t/${token}.gif`
}

/** Absolute pixel URL for a token — `publicBaseUrl` with any trailing `/` tolerated. */
export function pixelUrlFor(publicBaseUrl: string, token: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${pixelPathFor(token)}`
}

/**
 * Inject the tracking pixel into an outbound HTML body — the HTML body ONLY
 * (spec §4g: a text-only reply gets no pixel; an HTML part is never
 * fabricated just to track). Inserted immediately before the LAST
 * `</body>` (case-insensitive) when one exists, appended otherwise — either
 * way the visible content is untouched.
 */
export function injectTrackingPixel(html: string, pixelUrl: string): string {
  const img = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none">`
  // The last </body> is located with a case-insensitive regex over the
  // ORIGINAL string — never via toLowerCase(), whose Unicode case folds can
  // CHANGE THE STRING LENGTH (e.g. 'İ' lowercases to two code units) and
  // shift the splice offset into the middle of unrelated markup.
  let lastIndex = -1
  for (const match of html.matchAll(/<\/body>/gi)) {
    lastIndex = match.index
  }
  if (lastIndex !== -1) {
    return `${html.slice(0, lastIndex)}${img}${html.slice(lastIndex)}`
  }
  return `${html}${img}`
}

/**
 * The literal bytes of a transparent 1×1 GIF — the pixel endpoint's ONLY
 * response body, valid token or not (spec §4g: identical either way; no
 * existence or validity leak). A constant, not generated: 42 bytes of
 * GIF89a, the classic tracking-pixel payload.
 */
export const TRANSPARENT_GIF: Buffer = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
)
