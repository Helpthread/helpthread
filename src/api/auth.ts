/**
 * Bearer-token authentication for the Agent Inbox API
 * (specs/api/agent-inbox-v1.md §3, §5).
 *
 * v1 has exactly one credential: a single service token
 * (`HELPTHREAD_API_TOKEN`) that authenticates the deployment's one operator
 * — there is no per-agent identity yet (spec §1). Every request must carry
 * `Authorization: Bearer <token>` matching it.
 *
 * The comparison mirrors `src/mail/reply-token.ts`'s constant-time pattern
 * (`timingSafeEqual` with an explicit length guard first): a naive `===`
 * string comparison short-circuits on the first mismatched byte, which
 * leaks a timing signal about how many leading characters of a guess were
 * correct. `timingSafeEqual` itself THROWS on unequal-length buffers rather
 * than returning `false` — so the length check must happen first, both to
 * avoid the throw and because comparing two different-length buffers is
 * unambiguously "no match" without needing constant-time treatment (the
 * lengths are not secret; only the token's content is).
 *
 * TOTAL over `request`: a missing header, a non-Bearer scheme, or a
 * malformed value all resolve to `false`, never throw. Hostile/malformed
 * input on an authentication path must never crash the request — the
 * standard totality bar this codebase holds parsers to (mirrors
 * `verifyReplyMessageId`'s totality note in `reply-token.ts`).
 */

import { timingSafeEqual } from 'node:crypto'

const BEARER_PREFIX = 'Bearer '

/**
 * Extract the bearer credential from `request`'s `Authorization` header and
 * compare it to `token` in constant time. Returns `false` for anything that
 * isn't an exact match against a well-formed `Bearer <token>` header —
 * including a missing header, a different auth scheme (`Basic ...`), or a
 * value of the wrong length. Never throws.
 */
export function authenticateRequest(request: Request, token: string): boolean {
  const header = request.headers.get('authorization')
  if (header === null || !header.startsWith(BEARER_PREFIX)) {
    return false
  }

  const provided = header.slice(BEARER_PREFIX.length)
  return constantTimeEquals(provided, token)
}

/** Constant-time string comparison, length-guarded before `timingSafeEqual` (which throws on a length mismatch). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    return false
  }
  return timingSafeEqual(bufA, bufB)
}
