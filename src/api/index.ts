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
import type { SelfEchoGuardDeps } from '../mail/send.js'
import type { BlobStore, EmailSender } from '../providers/index.js'
import type { ThreadAttachmentStore } from '../store/attachments.js'
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
import {
  type GmailConnectDeps,
  handleGmailConnect,
  handleGmailConnectCallback,
} from './gmail-connect.js'
import { type GmailDisconnectDeps, handleGmailDisconnect } from './gmail-disconnect.js'
import { type GmailPushDeps, gmailPushRejected, handleGmailPushWebhook } from './gmail-webhook.js'
import type { ApiError } from './responses.js'
import { apiError } from './responses.js'
import {
  matchGmailConnectCallback,
  matchGmailPushWebhook,
  matchOpenTrackingPixel,
  matchRoute,
} from './router.js'

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
  /**
   * The Gmail push webhook (HT-39; gmail-push.md §2): ABSENT BY DEFAULT — a
   * deployment that hasn't provisioned Gmail push yet (HT-43) simply never
   * configures this. When present, `POST /api/v1/inbound/gmail` verifies,
   * resolves, and enqueues (see `src/api/gmail-webhook.ts`). When absent,
   * every request to that path gets the SAME uniform rejection it would if
   * the feature WERE configured but the request failed a check — see
   * `gmailPushRejected` — never a different response that would leak
   * whether this deployment has Gmail push configured at all.
   */
  gmailPush?: GmailPushDeps
  /**
   * The Gmail connect/consent flow (HT-40; gmail-connect.md §2): ABSENT BY
   * DEFAULT — a deployment that hasn't provisioned its Internal OAuth app
   * yet (HT-43) simply never configures this. When present, `POST
   * /api/v1/inbound/gmail/connect` (Bearer-gated) mints the consent URL and
   * `GET /api/v1/inbound/gmail/callback` (pre-auth) completes the grant —
   * see `src/api/gmail-connect.ts`. When absent, both routes 404 — the
   * connect POST through the normal authenticated dispatch (no route-table
   * special-casing needed, since it's Bearer-gated either way), and the
   * callback through its own pre-auth branch below (never the DIFFERENT
   * "uniform rejection" shape the Gmail push webhook uses, since the
   * callback has no equivalent no-oracle requirement — a caller either
   * knows this deployment supports Gmail connect or doesn't, and 404 is the
   * ordinary "no such route" answer either way).
   */
  gmailConnect?: GmailConnectDeps
  /**
   * The Gmail disconnect admin action (HT-47; gmail-connect.md's disconnect
   * section): ABSENT BY DEFAULT — same "a deployment that hasn't
   * provisioned Gmail OAuth yet simply never configures this" stance as
   * `gmailConnect`. When present, `POST /api/v1/inbound/gmail/disconnect`
   * (Bearer-gated — an ORDINARY route, unlike the pre-auth `/callback`; see
   * `src/api/gmail-disconnect.ts`) revokes the mailbox's OAuth grant, stops
   * its Gmail push watch, and deactivates it locally. When absent, the
   * route 404s exactly like `gmailConnect`'s own absent-case (no
   * route-table special-casing needed, since it's Bearer-gated either way).
   */
  gmailDisconnect?: GmailDisconnectDeps
  /**
   * Attachment read-path deps (HT-46; specs/api/agent-inbox-v1.md §2's
   * `ThreadView.attachments`): ABSENT BY DEFAULT — a deployment that hasn't
   * wired a `ThreadAttachmentStore` + `BlobStore` here simply never surfaces
   * attachments, and `GET /api/v1/conversations/{id}` returns `[]` for every
   * thread's `attachments`, exactly like `openTracking`'s absent-by-default
   * posture above.
   */
  attachments?: { store: ThreadAttachmentStore; blobStore: BlobStore }
  /**
   * The self-echo guard `sendReply` accepts (HT-49 review fix; `src/mail/
   * send.ts`'s `SelfEchoGuardDeps`): ABSENT BY DEFAULT — a deployment with no
   * self-reflecting transport configured (no Gmail mailbox connected) simply
   * never sets this, and reply-sending behaves exactly as before this guard
   * existed. When present, a successful reply's own sent-message echo is
   * best-effort pre-suppressed in the inbound delivery ledger so a transport
   * that delivers sent mail back into its own mailbox (Gmail, confirmed
   * live) normally does not re-ingest it as a phantom inbound message.
   * Best-effort, not a guarantee: the pre-seed runs only AFTER the provider
   * send succeeds, so an unusually fast reconcile can claim `(mailboxId,
   * providerMessageId)` first and ingest that one echo before the pre-seed
   * lands — reproducing the pre-guard failure mode (a visible phantom
   * inbound message in that conversation) for that single send, never a new
   * one. See `inbound-ingestion.md` §5's HT-49 amendment ("Known residual")
   * for the conceded race.
   */
  selfEchoGuard?: SelfEchoGuardDeps
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

    // The Gmail push webhook is the API's SECOND unauthenticated surface
    // (HT-39; gmail-push.md §2): Gmail/Pub/Sub cannot present our service
    // Bearer token, so — exactly like the pixel above — it is matched and
    // handled BEFORE the Bearer-auth gate, authenticated instead by its own
    // mechanism (a Google-signed OIDC JWT, checked inside
    // `handleGmailPushWebhook`). When `deps.gmailPush` is unset, this
    // deployment hasn't configured Gmail push at all — the SAME uniform
    // rejection is returned as `handleGmailPushWebhook` would give a
    // configured-but-failing request, so a caller can't distinguish "not
    // configured" from "configured, but you failed a check" (see
    // `gmail-webhook.ts`'s module doc).
    if (matchGmailPushWebhook(new URL(request.url).pathname)) {
      return deps.gmailPush !== undefined
        ? await handleGmailPushWebhook(request, deps.gmailPush)
        : gmailPushRejected()
    }

    // The Gmail connect callback is the API's THIRD unauthenticated surface
    // (HT-40; gmail-connect.md §2b): Google's redirect carries no service
    // Bearer token, so — exactly like the pixel and the push webhook above —
    // it is matched and handled BEFORE the Bearer-auth gate, authenticated
    // instead by its own mechanism (the signed `state` parameter, verified
    // inside `GmailConnectService.completeConnect`). Unlike the push
    // webhook, a not-configured deployment answers plain `404 not_found`
    // here rather than a uniform reject shape — see `gmailConnect`'s own doc
    // above for why that asymmetry is fine on this surface.
    if (matchGmailConnectCallback(new URL(request.url).pathname)) {
      return deps.gmailConnect !== undefined
        ? await handleGmailConnectCallback(request, deps.gmailConnect)
        : apiError(404, 'not_found', 'No such route.')
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
          return await handleGetConversation(route.id, {
            store: deps.store,
            ...(deps.attachments !== undefined ? { attachments: deps.attachments } : {}),
          })

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
            ...(deps.selfEchoGuard !== undefined ? { selfEchoGuard: deps.selfEchoGuard } : {}),
          })

        case 'gmail-connect':
          return deps.gmailConnect !== undefined
            ? await handleGmailConnect(request, deps.gmailConnect)
            : apiError(404, 'not_found', 'No such route.')

        case 'gmail-disconnect':
          return deps.gmailDisconnect !== undefined
            ? await handleGmailDisconnect(request, deps.gmailDisconnect)
            : apiError(404, 'not_found', 'No such route.')
      }
    } catch (err) {
      console.error('[inbox-api] unhandled error handling request', err)
      return apiError(500, 'server_error', 'Internal server error.')
    }
  }
}

export type { ConversationStore } from '../store/conversations.js'
export type { ApiError } from './responses.js'
