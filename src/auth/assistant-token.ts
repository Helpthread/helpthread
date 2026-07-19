/**
 * Assistant bearer tokens (HT-70; specs/plugins/substrate-v1.md §3) —
 * `ht_asst_<assistantId>_<secret>`, minted once at creation or rotation and
 * shown to the caller exactly that one time. Only a SHA-256 digest of the
 * secret part is ever persisted (`AssistantStore.create`/`updateTokenHash`,
 * `src/store/assistants.ts`) — this module never hands the plaintext token
 * to storage. Verifying a PRESENTED token at request time (parse + row
 * lookup + constant-time digest compare) is a separate concern —
 * `src/api/assistant-auth.ts`.
 *
 * ## Why SHA-256, not scrypt
 *
 * `src/auth/password-hash.ts` uses scrypt for Agent passwords because
 * CodeQL's `js/insufficient-password-hash` (and the real threat model)
 * rejects a fast hash for a LOW-ENTROPY, human-chosen secret — an offline
 * attacker with the hash can brute-force a weak password quickly. An
 * Assistant's secret is the opposite case: server-generated, 256 bits of
 * CSPRNG entropy, never typed by a human, never reused. A fast digest is
 * the right tool here — the spec's own pinned design (§3): "constant-time
 * comparison of SHA-256 digests of the secret part." Slowing this down
 * with scrypt would only add needless CPU to every authenticated request an
 * Assistant makes, for no security benefit a high-entropy secret doesn't
 * already have.
 *
 * ## The id/token knot
 *
 * Same shape as `src/mail/send.ts`'s `threadId`/`messageId` pair: the token
 * embeds the assistant's id, so the id must exist BEFORE the token can be
 * minted, but the assistant ROW doesn't exist until it's inserted. The
 * caller (`src/api/assistants.ts`) breaks the knot exactly as `sendReply`
 * does — generate the id first (`crypto.randomUUID()`), mint the token
 * against it, then insert the row with that id explicit
 * (`AssistantStore.create`'s optional `id`, `src/store/assistants.ts`).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Fixed literal prefix marking a token as one of this module's Assistant tokens. */
const TOKEN_PREFIX = 'ht_asst_'

/** Random secret size, in bytes — 256 bits, the module doc's "why SHA-256" rationale rests on this being high-entropy. */
const SECRET_BYTES = 32

/** The uuid-shape check for `assistantId` — mirrors `src/api/uuid.ts`, duplicated locally so this module has no dependency on `src/api/**` (an auth seam should not depend on the HTTP layer; same convention as `src/auth/invite-token.ts`). */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The canonical uuid string length (`8-4-4-4-12` plus four hyphens) — used to recover the id by FIXED-LENGTH slice, not by splitting on `_` (see {@link parseAssistantToken}'s doc comment). */
const UUID_LENGTH = 36

/** The result of {@link mintAssistantToken}. */
export interface MintedAssistantToken {
  /** The full token, shown to the caller ONCE — never stored, never logged. */
  token: string
  /** SHA-256 digest (hex) of the secret part — what actually gets persisted (`AssistantStore.create`/`updateTokenHash`). */
  tokenHash: string
}

/**
 * Mint a fresh token for `assistantId` (creation or rotation). STRICT:
 * throws if `assistantId` is not uuid-shaped — a caller bug (see the module
 * doc's "id/token knot"), not something to silently tolerate, mirroring
 * `mintReplyMessageId`/`mintInviteToken`'s "emitting an unverifiable token
 * is our bug, fail loud" posture.
 */
export function mintAssistantToken(assistantId: string): MintedAssistantToken {
  if (typeof assistantId !== 'string' || !UUID_PATTERN.test(assistantId)) {
    throw new Error(
      `mintAssistantToken: assistantId must be a uuid (got ${JSON.stringify(assistantId)})`,
    )
  }
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return {
    token: `${TOKEN_PREFIX}${assistantId}_${secret}`,
    tokenHash: hashAssistantSecret(secret),
  }
}

/** SHA-256 digest (hex) of a token's secret part — the one-way function whose output is what {@link AssistantStore} persists and {@link constantTimeHashEquals} compares. */
export function hashAssistantSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** A token's parsed segments — see {@link parseAssistantToken}. */
export interface ParsedAssistantToken {
  assistantId: string
  secret: string
}

/**
 * Structurally parse `token` into its assistantId/secret parts. TOTAL —
 * never throws; `null` for anything not shaped like
 * `ht_asst_<uuid>_<secret>` (a hostile or malformed `Authorization` header
 * is untrusted input reaching this on every request, so this mirrors
 * `parseToken`'s totality bar in `src/mail/reply-token.ts`).
 *
 * The assistantId is recovered by a FIXED-LENGTH slice (the canonical
 * uuid's 36 characters), not by splitting on `_` — a base64url secret can
 * itself contain `_`, so a naive split would misparse. A well-formed token
 * therefore always has exactly one interpretation: prefix, 36 uuid chars,
 * a literal `_`, then the secret (whatever is left, non-empty).
 */
export function parseAssistantToken(token: string): ParsedAssistantToken | null {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null
  const rest = token.slice(TOKEN_PREFIX.length)
  if (rest.length <= UUID_LENGTH + 1) return null

  const assistantId = rest.slice(0, UUID_LENGTH)
  if (!UUID_PATTERN.test(assistantId)) return null
  if (rest[UUID_LENGTH] !== '_') return null

  const secret = rest.slice(UUID_LENGTH + 1)
  if (secret.length === 0) return null

  return { assistantId, secret }
}

/**
 * Constant-time compare of two SHA-256 hex digests. Length-guarded before
 * `timingSafeEqual` (which throws on a length mismatch) — same pattern
 * `src/api/auth.ts`'s `constantTimeEquals` uses for the service Bearer
 * token.
 */
export function constantTimeHashEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
