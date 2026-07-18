/**
 * Resolve the acting Agent from `X-Helpthread-Agent-Id` (HT-54;
 * specs/auth/agents-and-auth.md §8) — the one place every handler that needs
 * the acting Agent goes through, so the "load the row, re-check status"
 * policy lives in exactly one function rather than being re-implemented per
 * handler.
 *
 * The web derives this header ONLY from the verified session `sub`, never
 * from client input (spec §5's guardrail) — the engine trusts it because the
 * caller already holds the service Bearer token (`src/api/auth.ts`); this
 * function's job is the engine-side half of that trust model: even a
 * genuinely web-asserted header must be re-checked against the CURRENT row,
 * since a signed session cookie can outlive an Agent being disabled or
 * deleted (spec §8's "bounding a disabled Agent whose cookie is still
 * valid" point — Edge middleware verifies the cookie but never touches the
 * Agent store, so this engine-side check is the only place that can).
 *
 * `null` covers every failure uniformly (missing header, malformed/non-uuid
 * value, no such Agent, or a non-`active` status) — callers map `null` to a
 * generic `401`, never a more specific message that would leak which case
 * applied.
 */

import type { AgentRecord, AgentStore } from '../store/agents.js'
import { isUuid } from './uuid.js'

/** The header the web asserts the session's verified `sub` under (spec §8). `Request.headers.get` is case-insensitive, so the exact casing here is cosmetic. */
export const ACTING_AGENT_HEADER = 'X-Helpthread-Agent-Id'

/**
 * Resolve `request`'s acting Agent, or `null` if the header is absent,
 * malformed, or names an Agent that is missing or not `status: 'active'`
 * (an `invited` Agent is treated the same as `disabled` for acting
 * purposes — spec: "only `active` can act"). Never throws.
 */
export async function resolveActingAgent(
  request: Request,
  store: AgentStore,
): Promise<AgentRecord | null> {
  const header = request.headers.get(ACTING_AGENT_HEADER)
  if (header === null) return null
  const id = header.trim()
  if (id.length === 0 || !isUuid(id)) return null

  const agent = await store.getAgent(id)
  if (agent === null || agent.status !== 'active') return null
  return agent
}
