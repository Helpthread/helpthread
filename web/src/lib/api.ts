/**
 * The Agent Inbox API client — typed 1:1 against `specs/api/agent-inbox-v1.md`
 * (v1.1). SERVER-ONLY by construction: the Bearer token is a service
 * credential that grants the whole inbox (spec §5), so it lives in server
 * env and every call happens from a server component or server action —
 * the `server-only` import makes a client-bundle inclusion a build error,
 * not a leak.
 *
 * The client is a pure API consumer (CHARTER.md's API-first rule): it never
 * composes subjects, recipients, or threading headers, and treats
 * `nextCursor` as an opaque token to echo back (spec §3a).
 */

import 'server-only'
import type {
  ConversationDetail,
  ConversationFolder,
  ConversationListResponse,
  ConversationStatus,
  ConversationSummary,
  ThreadView,
} from './api-types'

export type * from './api-types'

/**
 * A non-2xx API outcome, carrying the spec's machine-readable error `code`
 * (spec §3) so callers can branch precisely — notably `retry_in_progress`
 * (retry the SAME Idempotency-Key later) vs `send_failed` (nothing was
 * delivered; the draft must be preserved).
 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
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
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const { baseUrl, token } = config()
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
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
    // A 401 means the deployment's own Bearer token is missing or wrong —
    // not a user failing to log in (there is no login). A client error
    // boundary (`app/**/error.tsx`) only ever receives `error.message`
    // (everything else is stripped off a thrown error crossing the
    // server/client boundary), so that's the one channel available to tell
    // it to render the AuthFailure screen — hence the `unauthorized:`
    // prefix, detected in `components/AppError.tsx`.
    if (response.status === 401) {
      throw new ApiError(response.status, code, `unauthorized:${message}`)
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

export function putAssignee(id: string, assignee: 'me' | null): Promise<ConversationSummary> {
  return request(`/api/v1/conversations/${id}/assignee`, { method: 'PUT', body: { assignee } })
}

export function deleteConversation(id: string): Promise<void> {
  return request(`/api/v1/conversations/${id}`, { method: 'DELETE' })
}
