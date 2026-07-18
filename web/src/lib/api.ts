/**
 * The Agent Inbox API client — typed 1:1 against `specs/api/agent-inbox-v1.md`
 * (v1.1) and, for Agents & Authentication (HT-54), against the engine
 * branch's `src/api/agents.ts` handlers. SERVER-ONLY by construction: the
 * Bearer token is a service credential that grants the whole inbox (spec
 * §5), so it lives in server env and every call happens from a server
 * component or server action — the `server-only` import makes a
 * client-bundle inclusion a build error, not a leak.
 *
 * The client is a pure API consumer (CHARTER.md's API-first rule): it never
 * composes subjects, recipients, or threading headers, and treats
 * `nextCursor` as an opaque token to echo back (spec §3a).
 *
 * ## The acting-Agent header (HT-54; specs/auth/agents-and-auth.md §8)
 *
 * `request()` gains an internal `actingAgent: true` option: it reads and
 * verifies the session cookie (via `next/headers` `cookies()`), and attaches
 * `X-Helpthread-Agent-Id: <sub>` to the outgoing call. No valid session
 * where required → an `ApiError` (session-expired) is thrown WITHOUT ever
 * calling the engine — there is nothing honest to assert. The header name is
 * a literal copy of the engine's own `ACTING_AGENT_HEADER`
 * (`src/api/acting-agent.ts`) — web and engine are separate packages
 * (CHARTER.md: web has no engine-internals access, API-first only), so this
 * constant is kept in sync by hand, not by import.
 *
 * Per-endpoint rule (spec §8, pinned): attached on every `/agents/*` call,
 * `/auth/me`, and `putAssignee` — NOT attached on `/setup`, `/auth/verify`,
 * `/auth/invite/accept`, `/auth/providers` (all pre-session), nor the other
 * existing conversation calls (unchanged this increment, spec §8's own
 * scoping note).
 */

import 'server-only'
import { cookies } from 'next/headers'
import type {
  Agent,
  AgentRole,
  AuthProviderDescriptor,
  ConversationDetail,
  ConversationFolder,
  ConversationListResponse,
  ConversationStatus,
  ConversationSummary,
  SelfAgent,
  ThreadView,
} from './api-types'
import { AUTH_ERROR_DIGEST, SESSION_ERROR_DIGEST } from './auth-error'
import { SESSION_COOKIE_NAME, verifySessionCookie } from './session'

export type * from './api-types'

/** Mirrors `src/api/acting-agent.ts`'s `ACTING_AGENT_HEADER` — kept in sync by hand (see module doc). */
const ACTING_AGENT_HEADER = 'X-Helpthread-Agent-Id'

/**
 * A non-2xx API outcome, carrying the spec's machine-readable error `code`
 * (spec §3) so callers can branch precisely — notably `retry_in_progress`
 * (retry the SAME Idempotency-Key later) vs `send_failed` (nothing was
 * delivered; the draft must be preserved).
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  // Optional Next.js error digest. Set to AUTH_ERROR_DIGEST on a 401 so the
  // client error boundary can route to AuthFailure even in production, where
  // Server Component error *messages* are stripped and only `digest` survives.
  readonly digest?: string

  constructor(status: number, code: string, message: string, digest?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.digest = digest
  }
}

/** Upstream fetch timeout — a hung API must fail fast, not hang the render. */
const REQUEST_TIMEOUT_MS = 15_000

function config(): { baseUrl: string; token: string } {
  const baseUrl = process.env.HELPTHREAD_API_URL
  const token = process.env.HELPTHREAD_API_TOKEN
  // A deployment MUST set both. Falling back to the dev harness's values in
  // production would silently point the app at localhost with a well-known
  // token — fail loud at the first RUNTIME request instead. Skipped during
  // `next build` (NEXT_PHASE), where prerendering runs in production mode
  // without the runtime env and dev defaults are harmless.
  const isBuild = process.env.NEXT_PHASE === 'phase-production-build'
  if (
    process.env.NODE_ENV === 'production' &&
    !isBuild &&
    (baseUrl === undefined || token === undefined)
  ) {
    throw new Error(
      'HELPTHREAD_API_URL and HELPTHREAD_API_TOKEN must be set in production — refusing to fall back to dev defaults.',
    )
  }
  // Dev defaults match the HT-24 harness (`npm run dev:api`); the default
  // token is the harness's clearly-dev-only value.
  return {
    baseUrl: (baseUrl ?? 'http://localhost:8787').replace(/\/+$/, ''),
    token: token ?? 'helpthread-dev-token',
  }
}

async function request<T>(
  path: string,
  init: {
    method?: string
    body?: unknown
    headers?: Record<string, string>
    /** Attach `X-Helpthread-Agent-Id` from the verified session cookie — see the module doc. */
    actingAgent?: boolean
  } = {},
): Promise<T> {
  const { baseUrl, token } = config()

  let headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...init.headers,
  }

  if (init.actingAgent === true) {
    const cookieStore = await cookies()
    const session = await verifySessionCookie(cookieStore.get(SESSION_COOKIE_NAME)?.value)
    // No valid session where one is required → the engine is never called;
    // there is no honest acting-Agent id to assert (spec §8).
    if (session === null) {
      throw new ApiError(401, 'unauthorized', 'session_expired', SESSION_ERROR_DIGEST)
    }
    headers = { ...headers, [ACTING_AGENT_HEADER]: session.payload.sub }
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    // Authenticated support data: the API says no-store (spec §3) and the
    // client agrees — every render sees current truth.
    cache: 'no-store',
    // Bound every call so a hung upstream fails fast (→ error boundary /
    // action network-error) rather than hanging the server render.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (response.status === 204) {
    return undefined as T
  }

  if (!response.ok) {
    // The spec's error envelope is `{ error: { code, message } }` on every
    // non-2xx; anything else (a proxy error page, a network hiccup mid-body)
    // still becomes a typed ApiError rather than an unhandled throw.
    let code = 'server_error'
    let message = `Request failed with status ${response.status}.`
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      if (body.error?.code) code = body.error.code
      if (body.error?.message) message = body.error.message
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    if (response.status === 401) {
      // Two DIFFERENT 401 causes (spec §8) — see `auth-error.ts`'s module doc.
      if (init.actingAgent === true) {
        // The call CARRIED the acting-Agent header and still got a 401: the
        // Agent it names is gone/disabled, or the session is otherwise
        // stale. This is "log in again," not a deployment misconfig.
        throw new ApiError(response.status, code, message, SESSION_ERROR_DIGEST)
      }
      // No acting-Agent header on this call — a 401 here means the
      // deployment's own Bearer token is missing or wrong. It must route to
      // the AuthFailure screen via a client error boundary
      // (`app/**/error.tsx`). In production Next.js strips a Server
      // Component error's `message` and forwards only `error.digest`, so the
      // digest — not the message — is what `components/AppError.tsx`
      // matches on. The `unauthorized:` message prefix is kept for
      // dev/server logs and as a belt-and-suspenders fallback.
      throw new ApiError(response.status, code, `unauthorized:${message}`, AUTH_ERROR_DIGEST)
    }
    throw new ApiError(response.status, code, message)
  }

  return (await response.json()) as T
}

export function listConversations(options: {
  folder: ConversationFolder
  cursor?: string
  limit?: number
}): Promise<ConversationListResponse> {
  const params = new URLSearchParams({ status: options.folder })
  if (options.cursor !== undefined) params.set('cursor', options.cursor)
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  return request(`/api/v1/conversations?${params}`)
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return request(`/api/v1/conversations/${id}`)
}

/**
 * Send a reply. `idempotencyKey` is REQUIRED by the API (spec §4a) and must
 * be reused verbatim when retrying the same logical send — a 409
 * `retry_in_progress` means retry LATER with the SAME key, never a new one.
 */
export function postReply(
  id: string,
  input: { text: string; html?: string },
  idempotencyKey: string,
): Promise<ThreadView> {
  return request(`/api/v1/conversations/${id}/replies`, {
    method: 'POST',
    body: input,
    headers: { 'Idempotency-Key': idempotencyKey },
  })
}

export function setStatus(id: string, status: ConversationStatus): Promise<ConversationSummary> {
  return request(`/api/v1/conversations/${id}`, { method: 'PATCH', body: { status } })
}

export function postNote(id: string, text: string): Promise<ThreadView> {
  return request(`/api/v1/conversations/${id}/notes`, { method: 'POST', body: { text } })
}

export function putTags(id: string, tags: string[]): Promise<ConversationSummary> {
  return request(`/api/v1/conversations/${id}/tags`, { method: 'PUT', body: { tags } })
}

/** HT-54 breaking change (spec §3.3, §10): body is `{ assigneeAgentId }` (was `{ assignee: 'me' | null }`). Header-required (spec §8) — this is the one existing inbox op that now records an Agent. */
export function putAssignee(
  id: string,
  assigneeAgentId: string | null,
): Promise<ConversationSummary> {
  return request(`/api/v1/conversations/${id}/assignee`, {
    method: 'PUT',
    body: { assigneeAgentId },
    actingAgent: true,
  })
}

export function deleteConversation(id: string): Promise<void> {
  return request(`/api/v1/conversations/${id}`, { method: 'DELETE' })
}

// --- Agents & Authentication (HT-54; specs/auth/agents-and-auth.md §6) -----

/** `GET /api/v1/auth/providers` — no acting-Agent header (pre-session). */
export function getAuthProviders(): Promise<{
  providers: AuthProviderDescriptor[]
  needsSetup: boolean
}> {
  return request('/api/v1/auth/providers')
}

/** `POST /api/v1/setup` — creates the first admin. No acting-Agent header (pre-session). */
export function postSetup(input: {
  name: string
  email: string
  password: string
}): Promise<{ agent: Agent }> {
  return request('/api/v1/setup', { method: 'POST', body: input })
}

/** `POST /api/v1/auth/verify` — dispatches to the named provider. No acting-Agent header (pre-session). */
export function postVerify(input: {
  providerKey: string
  email: string
  password: string
}): Promise<{ agent: Agent }> {
  return request('/api/v1/auth/verify', { method: 'POST', body: input })
}

/** `GET /api/v1/auth/me` — acting-Agent header REQUIRED. Narrower shape than {@link Agent} — see `SelfAgent`'s doc. */
export function getMe(): Promise<SelfAgent> {
  return request('/api/v1/auth/me', { actingAgent: true })
}

/** `GET /api/v1/agents` — any ACTIVE acting Agent (the assignee UI's roster, per the coordinator's amendment — see `src/api/agents.ts`'s module doc). Acting-Agent header REQUIRED. */
export async function listAgents(): Promise<Agent[]> {
  const { agents } = await request<{ agents: Agent[] }>('/api/v1/agents', { actingAgent: true })
  return agents
}

/** `POST /api/v1/agents` (admin) — exactly one of `sendInvite: true` or `password` (engine-validated). */
export function createAgent(input: {
  name: string
  email: string
  role: AgentRole
  sendInvite: boolean
  password?: string
}): Promise<{ agent: Agent; inviteSent: boolean }> {
  return request('/api/v1/agents', { method: 'POST', body: input, actingAgent: true })
}

/** `GET /api/v1/agents/{id}` — admin, or self. */
export async function getAgent(id: string): Promise<Agent> {
  const { agent } = await request<{ agent: Agent }>(`/api/v1/agents/${id}`, { actingAgent: true })
  return agent
}

/** `PATCH /api/v1/agents/{id}` — admin for anyone; self for own `name`/`timezone`. No `email` (immutable in v1). */
export async function patchAgent(
  id: string,
  input: { name?: string; timezone?: string; role?: AgentRole; status?: 'active' | 'disabled' },
): Promise<Agent> {
  const { agent } = await request<{ agent: Agent }>(`/api/v1/agents/${id}`, {
    method: 'PATCH',
    body: input,
    actingAgent: true,
  })
  return agent
}

/** `DELETE /api/v1/agents/{id}` (admin) — hard delete. Blocked for the last active admin (`409`). */
export function deleteAgent(id: string): Promise<void> {
  return request(`/api/v1/agents/${id}`, { method: 'DELETE', actingAgent: true })
}

/** `POST /api/v1/agents/{id}/password` (self, or admin reset). `409` for an `invited` target. */
export function setAgentPassword(id: string, password: string): Promise<void> {
  return request(`/api/v1/agents/${id}/password`, {
    method: 'POST',
    body: { password },
    actingAgent: true,
  })
}

/** `POST /api/v1/agents/{id}/invite` (admin) — (re)send an invite. */
export function resendInvite(id: string): Promise<void> {
  return request(`/api/v1/agents/${id}/invite`, { method: 'POST', actingAgent: true })
}

/** `POST /api/v1/auth/invite/accept` — validates the token, sets the password, activates. No acting-Agent header (pre-session — no session exists yet). */
export function acceptInvite(token: string, password: string): Promise<{ agent: Agent }> {
  return request('/api/v1/auth/invite/accept', { method: 'POST', body: { token, password } })
}
