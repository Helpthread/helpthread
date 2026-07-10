/**
 * `createInboxApi` — the Agent Inbox API's whole HTTP pipeline
 * (specs/api/agent-inbox-v1.md), framework-agnostic by construction (spec
 * §6: "handlers are `Request → Response`; a Vercel/Next adapter is a thin
 * deploy-time wrapper, not part of this spec"). No Next.js import anywhere
 * in `src/api/**` — only the web-standard `Request`/`Response` globals, so
 * this same function can sit behind a Vercel Edge Function, a plain Node
 * HTTP server, or a test harness's direct call, unchanged.
 *
 * ## Pipeline (every request, in this exact order)
 *
 * 1. **Authenticate.** A failing check is `401 unauthorized` with a generic
 *    message, returned BEFORE anything about routing is decided — spec §3
 *    is explicit that an unauthenticated caller must learn nothing about
 *    which paths exist or which methods they support ahead of proving who
 *    they are.
 * 2. **Route.** An unmatched path is `404 not_found`; a matched path with an
 *    unsupported method is `405 method_not_allowed` with an `Allow` header
 *    naming the methods that path DOES support.
 * 3. **Dispatch** to the matched handler (`src/api/conversations.ts`).
 */

import type { ConversationStore } from '../store/conversations.js'
import { authenticateRequest } from './auth.js'
import { handleGetConversation, handleListConversations } from './conversations.js'
import type { ApiError } from './responses.js'
import { apiError } from './responses.js'
import { matchRoute } from './router.js'

/**
 * Minimum length for the service Bearer token. A short/empty token is a
 * fail-open hazard: with `apiToken === ''`, `Authorization: Bearer ` (empty
 * credential) would be an exact match and authenticate every caller. This
 * floor forces the operator to configure a real secret; the API refuses to
 * start without one (see {@link createInboxApi}).
 */
const MIN_API_TOKEN_LENGTH = 16

/** Dependencies `createInboxApi` closes over — today just the store and the service token; grows in HT-18 (e.g. a mail sender for replies). */
export interface InboxApiDeps {
  store: ConversationStore
  /** The configured service Bearer token (`HELPTHREAD_API_TOKEN`) every request is checked against. Must be at least {@link MIN_API_TOKEN_LENGTH} chars. */
  apiToken: string
}

/**
 * Build the API's request handler. Returns a plain `(request: Request) =>
 * Promise<Response>` — the entire deploy-time surface a Vercel/Next.js
 * route (or any other host) needs to wire up.
 *
 * FAILS CLOSED at construction: throws if `apiToken` is missing or shorter
 * than {@link MIN_API_TOKEN_LENGTH}, so a misconfigured deployment never
 * comes up with an inbox that any `Bearer` request can open. Better a loud
 * startup crash than a silently unauthenticated API.
 */
export function createInboxApi(deps: InboxApiDeps): (request: Request) => Promise<Response> {
  if (deps.apiToken.length < MIN_API_TOKEN_LENGTH) {
    throw new Error(
      `createInboxApi: apiToken must be at least ${MIN_API_TOKEN_LENGTH} characters — refusing to start with a missing or weak service token (an empty token would authenticate every request).`,
    )
  }

  return async (request: Request): Promise<Response> => {
    if (!authenticateRequest(request, deps.apiToken)) {
      return apiError(401, 'unauthorized', 'Missing or invalid credentials.')
    }

    // Everything past auth runs inside a catch-all so no store/serialization
    // error can escape as an uncontrolled 500 — that would let the host
    // runtime decide the response shape (possibly leaking a stack, omitting
    // `Cache-Control: no-store`, or breaking the error envelope). Every exit
    // from here is a Response this module built.
    try {
      const url = new URL(request.url)
      const route = matchRoute(request.method, url.pathname)

      switch (route.kind) {
        case 'not-found':
          return apiError(404, 'not_found', 'No such route.')

        case 'method-not-allowed': {
          // Not built via `apiError` because this is the one response in the
          // whole API that needs an extra header (`Allow`) alongside the
          // standard envelope + `Cache-Control: no-store` — spec §3 requires
          // the `Allow` header but only enumerates `unauthorized`/`not_found`/
          // `validation_failed`/`server_error` as codes, leaving no explicit
          // slug for 405; `method_not_allowed` is the natural, consistently-
          // shaped name and is used here as the deliberate gap-fill.
          const body: ApiError = {
            error: { code: 'method_not_allowed', message: 'This method is not supported here.' },
          }
          return new Response(JSON.stringify(body), {
            status: 405,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              Allow: route.allow.join(', '),
            },
          })
        }

        // `return await` (not a bare `return` of the promise) is deliberate:
        // a bare `return handler(...)` hands the pending promise back and lets
        // the async function settle to it OUTSIDE this try — so a handler
        // rejection would escape the catch below and surface as an
        // uncontrolled 500. Awaiting here keeps the rejection inside the try.
        case 'conversations-list':
          return await handleListConversations(request, { store: deps.store })

        case 'conversation-item':
          return await handleGetConversation(route.id, { store: deps.store })
      }
    } catch (err) {
      console.error('[inbox-api] unhandled error handling request', err)
      return apiError(500, 'server_error', 'Internal server error.')
    }
  }
}

export type { ConversationStore } from '../store/conversations.js'
export type { ApiError } from './responses.js'
