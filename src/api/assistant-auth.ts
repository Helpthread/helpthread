/**
 * Assistant bearer-token request authentication (HT-70; specs/plugins/
 * substrate-v1.md §3, amending agent-inbox-v1.md §3/§7) — the SECOND
 * credential class alongside the service Bearer token (`src/api/auth.ts`),
 * checked ALONGSIDE it, never replacing it: `src/api/index.ts`'s pipeline
 * tries the service token first, and only on a miss tries this.
 *
 * Verification sequence, exactly as spec §3 states it: parse the embedded
 * assistantId out of the presented token → single-row lookup (no hash
 * scan) → constant-time digest compare — before routing, so an Assistant's
 * identity is resolved (or rejected) the same place/time the service token
 * is.
 */

import {
  constantTimeHashEquals,
  hashAssistantSecret,
  parseAssistantToken,
} from '../auth/assistant-token.js'
import type { AssistantRecord, AssistantStore } from '../store/assistants.js'

const BEARER_PREFIX = 'Bearer '

/**
 * Resolve `request`'s Assistant, or `null` for anything that isn't a valid,
 * active Assistant's token: a missing/malformed `Authorization` header, a
 * value not shaped like `ht_asst_<id>_<secret>`, an unknown assistantId, a
 * `disabled` Assistant, or a secret whose digest doesn't match the stored
 * hash. Every rejection reason collapses to the same `null` — the caller
 * (`src/api/index.ts`) maps it to the SAME generic `401` the service-token
 * miss gets, never a more specific message that would distinguish "unknown
 * id" from "wrong secret" from "disabled." Never throws.
 */
export async function authenticateAssistantRequest(
  request: Request,
  store: AssistantStore,
): Promise<AssistantRecord | null> {
  const header = request.headers.get('authorization')
  if (header === null || !header.startsWith(BEARER_PREFIX)) return null
  const token = header.slice(BEARER_PREFIX.length)

  const parsed = parseAssistantToken(token)
  if (parsed === null) return null

  // One-snapshot read (CodeRabbit #80): status and token_hash come from the
  // SAME row read, so a disable or rotation can never be interleaved between
  // separate status/hash queries and validate stale credentials.
  const auth = await store.getForAuth(parsed.assistantId)
  if (auth === null || auth.record.status !== 'active') return null

  const providedHash = hashAssistantSecret(parsed.secret)
  if (!constantTimeHashEquals(providedHash, auth.tokenHash)) return null

  return auth.record
}
