/**
 * `createInboxApi` — the Agent Inbox API's whole HTTP pipeline
 * (specs/api/agent-inbox-v1.md), framework-agnostic by construction (spec
 * §6: "handlers are `Request → Response`; a Vercel/Next adapter is a thin
 * deploy-time wrapper, not part of this spec"). No Next.js import anywhere
 * in `src/api/**` — only the web-standard `Request`/`Response` globals, so
 * this same function can sit behind a Vercel (Node-runtime) Function, a plain
 * Node HTTP server, or a test harness's direct call, unchanged.
 *
 * Runtime: this targets the Node.js runtime, NOT Vercel's Edge runtime. That
 * is not a limitation introduced by `auth.ts`'s `node:crypto` import — the
 * engine's core already requires `node:crypto` (the HMAC reply tokens in
 * `src/mail/reply-token.ts` use `createHmac`, which has no synchronous Web
 * Crypto equivalent), so the whole engine is Node-bound regardless. The
 * framework-agnostic `Request`/`Response` shape keeps it portable across
 * Node hosts (Vercel Node Functions, a bare Node server, tests) — just not
 * the Edge runtime, which lacks `node:crypto`.
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

import { TRANSPARENT_GIF, verifyViewToken } from '../mail/open-tracking.js'
import type { Keyring } from '../mail/reply-token.js'
import type { EmailSender } from '../providers/index.js'
import type { ConversationStore } from '../store/conversations.js'
import { authenticateRequest } from './auth.js'
import {
  handleDeleteConversation,
  handleGetConversation,
  handleListConversations,
  handlePatchConversation,
  handlePostNote,
  handlePutAssignee,
  handlePutTags,
  handleReply,
} from './conversations.js'
import type { ApiError } from './responses.js'
import { apiError } from './responses.js'
import { matchOpenTrackingPixel, matchRoute } from './router.js'

/**
 * Minimum length for the service Bearer token. A short/empty token is a
 * fail-open hazard: with `apiToken === ''`, `Authorization: Bearer ` (empty
 * credential) would be an exact match and authenticate every caller. This
 * floor forces the operator to configure a real secret; the API refuses to
 * start without one (see {@link createInboxApi}).
 */
const MIN_API_TOKEN_LENGTH = 16

/**
 * Dependencies `createInboxApi` closes over: the HT-17 read paths need only
 * `store` + `apiToken`; the HT-18 write paths (specs/api/agent-inbox-v1.md
 * §4a's `POST .../replies`) additionally need everything `sendReply`
 * (`src/mail/send.ts`) requires — `sender`, `keyring`, `mailDomain` — plus
 * `supportAddress`, the deployment's configured `from` address for outgoing
 * replies.
 */
export interface InboxApiDeps {
  store: ConversationStore
  /** The configured service Bearer token (`HELPTHREAD_API_TOKEN`) every request is checked against. Must be at least {@link MIN_API_TOKEN_LENGTH} chars. */
  apiToken: string
  /** The outbound mail transport a reply is sent through (spec §4a). */
  sender: EmailSender
  /** Signing keys for minting the outbound `Message-ID` reply token (spec §4a; `src/mail/reply-token.ts`). */
  keyring: Keyring
  /** Domain minted into the outbound `Message-ID`'s `@domain` part (spec §4a). */
  mailDomain: string
  /** The deployment's configured support address — the `from` on every Agent reply (spec §4a). */
  supportAddress: string
  /**
   * Open tracking (spec §4g, v1.1 — HT-32): ABSENT BY DEFAULT — a deliberate
   * privacy stance, not an unset knob. When present, outbound replies get a
   * signed tracking pixel served from `publicBaseUrl`, and the pixel
   * endpoint records first views. When absent — the shipped default —
   * nothing is injected and nothing is EVER recorded (a pixel from mail sent
   * while the feature was on stops recording the moment it is turned off).
   */
  openTracking?: { publicBaseUrl: string }
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
    // The open-tracking pixel is the API's ONE unauthenticated surface (spec
    // §4g; §3 names it as the deliberate exception) — customer mail clients
    // fetch it, so it is matched BEFORE Bearer auth. Everything about it is
    // deliberately uniform: `200` + the same 1×1 gif + `no-store`, valid
    // token or not, feature on or off — no validity or existence leak, and a
    // pixel baked into old mail keeps rendering harmlessly forever. The
    // recording side effect happens ONLY when the feature is enabled AND the
    // token verifies (first view wins; `recordThreadView` is idempotent and
    // silent on every miss). Its own try/catch keeps even a store failure
    // answering with the gif — the JSON error envelope below must never
    // reach an <img> tag.
    const pixel = matchOpenTrackingPixel(request.method, new URL(request.url).pathname)
    if (pixel !== null) {
      if (deps.openTracking !== undefined) {
        try {
          const verified = verifyViewToken(pixel.token, deps.keyring)
          if (verified !== null) {
            await deps.store.recordThreadView(verified.threadId)
          }
        } catch (err) {
          console.error('[inbox-api] open-tracking record failed (gif still served)', err)
        }
      }
      return new Response(new Uint8Array(TRANSPARENT_GIF), {
        status: 200,
        headers: {
          'Content-Type': 'image/gif',
          'Cache-Control': 'no-store',
          'Content-Length': String(TRANSPARENT_GIF.length),
        },
      })
    }

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

        case 'conversation-patch':
          return await handlePatchConversation(route.id, request, { store: deps.store })

        case 'conversation-delete':
          return await handleDeleteConversation(route.id, { store: deps.store })

        case 'conversation-note':
          return await handlePostNote(route.id, request, {
            store: deps.store,
            supportAddress: deps.supportAddress,
          })

        case 'conversation-tags':
          return await handlePutTags(route.id, request, { store: deps.store })

        case 'conversation-assignee':
          return await handlePutAssignee(route.id, request, { store: deps.store })

        case 'conversation-reply':
          return await handleReply(route.id, request, {
            store: deps.store,
            sender: deps.sender,
            keyring: deps.keyring,
            mailDomain: deps.mailDomain,
            supportAddress: deps.supportAddress,
            ...(deps.openTracking !== undefined ? { openTracking: deps.openTracking } : {}),
          })
      }
    } catch (err) {
      console.error('[inbox-api] unhandled error handling request', err)
      return apiError(500, 'server_error', 'Internal server error.')
    }
  }
}

export type { ConversationStore } from '../store/conversations.js'
export type { ApiError } from './responses.js'
