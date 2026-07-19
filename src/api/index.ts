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
import type { AssistantRecord } from '../store/assistants.js'
import type { ThreadAttachmentStore } from '../store/attachments.js'
import type { ConversationStore } from '../store/conversations.js'
import { resolveActingAgent } from './acting-agent.js'
import {
  type AgentsApiDeps,
  type AgentsHandlerDeps,
  handleAuthMe,
  handleAuthProviders,
  handleAuthVerify,
  handleCreateAgent,
  handleDeleteAgent,
  handleGetAgent,
  handleGetAgentMailboxes,
  handleInviteAccept,
  handleListAgents,
  handleListMailboxes,
  handlePatchAgent,
  handlePutAgentMailboxes,
  handleResendInvite,
  handleSetAgentPassword,
  handleSetup,
} from './agents.js'
import { authenticateAssistantRequest } from './assistant-auth.js'
import {
  type AssistantsApiDeps,
  handleCreateAssistant,
  handleListAssistants,
  handlePatchAssistant,
  handleRotateAssistantToken,
} from './assistants.js'
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
  type DraftsHandlerDeps,
  handleApproveDraft,
  handleCreateDraft,
  handleDiscardDraft,
  handleListDrafts,
} from './drafts.js'
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
  type RouteMatch,
} from './router.js'
import {
  handleCreateSavedReply,
  handleDeleteSavedReply,
  handleListSavedReplies,
  handlePatchSavedReply,
  type SavedRepliesApiDeps,
} from './saved-replies.js'
import {
  handleAuthenticationOptions,
  handleDeleteCredential,
  handleListCredentials,
  handlePatchCredential,
  handleRegistrationOptions,
  handleRegistrationVerify,
  handleStepUpPassword,
  handleStepUpWebAuthnOptions,
  handleStepUpWebAuthnVerify,
  type WebAuthnApiDeps,
} from './webauthn.js'
import {
  handleCreateWebhook,
  handleDeleteWebhook,
  handleListWebhooks,
  handlePatchWebhook,
  handleTestWebhook,
  type WebhooksApiDeps,
} from './webhooks.js'

/**
 * Minimum length for the service Bearer token. A short/empty token is a
 * fail-open hazard: with `apiToken === ''`, `Authorization: Bearer ` (empty
 * credential) would be an exact match and authenticate every caller. This
 * floor forces the operator to configure a real secret; the API refuses to
 * start without one (see {@link createInboxApi}).
 */
const MIN_API_TOKEN_LENGTH = 16

/**
 * The Assistant capability gate (HT-70; specs/plugins/substrate-v1.md §3):
 * "an assistant may read conversations/threads, create drafts, and create
 * notes. It may not send, approve, change status/tags/assignee, touch
 * admin surfaces, or read soft-deleted conversations." Enforced at ONE
 * point (spec §1's additive-forward rule: "a future scopes system swaps in
 * behind the same gate") — a `RouteMatch['kind']` not in this set is
 * refused for an Assistant caller, checked once right after routing,
 * before any handler runs. Never consulted for a service-Bearer caller
 * (unrestricted, as before this feature).
 */
const ASSISTANT_ALLOWED_ROUTE_KINDS: ReadonlySet<RouteMatch['kind']> = new Set([
  'conversations-list',
  'conversation-item',
  'conversation-note',
  'conversation-draft-create',
])

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
   * Agents & Authentication (HT-54; specs/auth/agents-and-auth.md) — REQUIRED,
   * unlike every `?`-suffixed field below: this is core product surface, not
   * an absent-by-default feature. See `src/api/agents.ts`'s `AgentsApiDeps`
   * doc for why this is deliberately narrow (the invite path reuses this
   * interface's own `keyring`/`sender`/`mailDomain`/`supportAddress` rather
   * than duplicating them here).
   */
  agents: AgentsApiDeps
  /**
   * Assistants (HT-70; specs/plugins/substrate-v1.md §1, §3) — REQUIRED,
   * same posture as `agents` above: the module substrate is core AGPL
   * surface, free forever, not an absent-by-default feature. Backs the
   * Assistants admin API (`src/api/assistants.ts`) AND the second,
   * per-Assistant-token credential class the main pipeline below checks
   * alongside the service Bearer token (`authenticateAssistantRequest`,
   * `src/api/assistant-auth.ts`).
   */
  assistants: AssistantsApiDeps
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
  /**
   * The webhooks admin API (HT-69; specs/modules/substrate-v1.md §5) —
   * REQUIRED, like `agents`: this is core substrate ("free forever", spec
   * §1), not a deployment-specific optional feature like `openTracking`/
   * `gmailPush`. See `src/api/webhooks.ts`'s module doc for the full
   * `POST`/`GET`/`PATCH`/`DELETE`/`.../test` surface this wires up.
   */
  webhooks: WebhooksApiDeps
  /**
   * Saved replies & macros (HT-76; specs/api/agent-inbox-v1.md's
   * saved-replies amendment) — REQUIRED, like `agents`/`webhooks`: this is
   * core, free-forever product surface (the "inbox basics" wave), not a
   * deployment-specific optional feature like `openTracking`/`gmailPush`.
   * `mailboxStore` may be (and, in practice, is) the SAME `MailboxStore`
   * instance `deps.agents.mailboxStore` already carries — no second store
   * is required.
   */
  savedReplies: SavedRepliesApiDeps
  /**
   * Passkey (WebAuthn) login (HT-75; specs/auth/passkeys.md) — ABSENT BY
   * DEFAULT, like `openTracking`/`gmailPush`: a deployment with no known UI
   * origin (`config.uiBaseUrl` unset) has no safe origin to bind WebAuthn
   * ceremonies to (spec §3), so the composition root simply never
   * configures this and every route below 404s / `GET /auth/providers`
   * omits the `webauthn` descriptor — the exact degrade-by-omission shape
   * `agents.uiBaseUrl` already uses for invites.
   */
  webauthn?: WebAuthnApiDeps
}

/**
 * Merge `deps.agents` with the top-level `keyring`/`sender`/`mailDomain`/
 * `supportAddress` fields every `InboxApiDeps` already carries, into the
 * combined shape `src/api/agents.ts`'s handlers accept — see
 * `AgentsHandlerDeps`'s doc for why `deps.agents` itself doesn't duplicate
 * those fields. Called once per request, only by the two dispatch cases
 * (`auth-invite-accept`'s success path needs `store`+`keyring`;
 * `agents-create`/`agent-invite` need the full set for the invite-email
 * path) that need more than `deps.agents` alone provides.
 */
function agentsHandlerDeps(deps: InboxApiDeps): AgentsHandlerDeps {
  return {
    ...deps.agents,
    keyring: deps.keyring,
    sender: deps.sender,
    mailDomain: deps.mailDomain,
    supportAddress: deps.supportAddress,
  }
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

    // HT-70 (spec §3): a SECOND credential class, checked ALONGSIDE the
    // service Bearer token, never replacing it — the service token is tried
    // FIRST (unchanged order/behavior for every existing caller), and only
    // on a miss is the Authorization header re-parsed as an Assistant
    // token. Either success authenticates the request; both misses are the
    // SAME generic 401 a caller cannot use to distinguish "no such
    // Assistant" from "wrong service token" from "malformed header".
    let caller: { kind: 'service' } | { kind: 'assistant'; assistant: AssistantRecord }
    if (authenticateRequest(request, deps.apiToken)) {
      caller = { kind: 'service' }
    } else {
      // This await runs BEFORE the response-shaping try below, so a store
      // failure here must be contained locally or it escapes as an
      // uncontrolled 500 (CodeRabbit #80) — same controlled shape as the
      // catch-all, never the host runtime's.
      let assistant: Awaited<ReturnType<typeof authenticateAssistantRequest>>
      try {
        assistant = await authenticateAssistantRequest(request, deps.assistants.store)
      } catch (err) {
        console.error('[inbox-api] assistant auth store failure', err)
        return apiError(500, 'server_error', 'Internal server error.')
      }
      if (assistant === null) {
        return apiError(401, 'unauthorized', 'Missing or invalid credentials.')
      }
      caller = { kind: 'assistant', assistant }
    }

    // Everything past auth runs inside a catch-all so no store/serialization
    // error can escape as an uncontrolled 500 — that would let the host
    // runtime decide the response shape (possibly leaking a stack, omitting
    // `Cache-Control: no-store`, or breaking the error envelope). Every exit
    // from here is a Response this module built.
    try {
      const url = new URL(request.url)
      const route = matchRoute(request.method, url.pathname)

      // HT-70's ONE capability-enforcement point (spec §3, §1's
      // additive-forward rule) — checked AFTER routing (so `not-found`/
      // `method-not-allowed` behave identically for every caller, exactly
      // as they did before Assistants existed) but BEFORE any handler runs.
      // Never consulted for a service-Bearer caller.
      if (
        caller.kind === 'assistant' &&
        route.kind !== 'not-found' &&
        route.kind !== 'method-not-allowed' &&
        !ASSISTANT_ALLOWED_ROUTE_KINDS.has(route.kind)
      ) {
        return apiError(
          403,
          'forbidden',
          'This Assistant is not permitted to access this endpoint.',
        )
      }

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
          // HT-70 (spec §6): now legal for an Assistant too — the SAME
          // route serves both credential classes, distinguished by which
          // one actually authenticated this request (the capability gate
          // above already refused any OTHER route for an assistant caller,
          // so `caller.kind` alone decides the author here).
          return await handlePostNote(route.id, request, {
            store: deps.store,
            supportAddress: deps.supportAddress,
            author:
              caller.kind === 'assistant'
                ? { kind: 'assistant', assistantId: caller.assistant.id }
                : {
                    kind: 'agent',
                    agentId: (await resolveActingAgent(request, deps.agents.store))?.id ?? null,
                  },
          })

        case 'conversation-tags':
          return await handlePutTags(route.id, request, { store: deps.store })

        case 'conversation-assignee':
          // The one existing inbox endpoint that now requires the
          // acting-Agent header (spec §8) — any ACTIVE Agent may assign any
          // Agent (spec §5), so resolveActingAgent's null → 401 is the whole
          // authz check here; no role gate.
          return await handlePutAssignee(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            request,
            { store: deps.store, agentStore: deps.agents.store },
          )

        case 'conversation-reply':
          // Never reachable by an assistant caller (the capability gate
          // above already refused it), so this is always a service caller —
          // resolveActingAgent's result (possibly null) is HT-70's
          // author-identity forward-carry (spec §3), threaded to sendReply.
          return await handleReply(route.id, request, {
            store: deps.store,
            sender: deps.sender,
            keyring: deps.keyring,
            mailDomain: deps.mailDomain,
            supportAddress: deps.supportAddress,
            authorAgentId: (await resolveActingAgent(request, deps.agents.store))?.id ?? null,
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

        // --- Agents & Authentication (HT-54) --------------------------------
        //
        // agentsDeps merges InboxApiDeps.agents (store/providers/uiBaseUrl)
        // with the top-level keyring/sender/mailDomain/supportAddress every
        // request already carries — see AgentsHandlerDeps's doc for why
        // those aren't duplicated onto `deps.agents` itself.

        case 'auth-providers':
          return await handleAuthProviders(deps.agents)

        case 'setup':
          return await handleSetup(request, deps.agents)

        case 'auth-verify':
          return await handleAuthVerify(request, deps.agents)

        case 'auth-me':
          return handleAuthMe(await resolveActingAgent(request, deps.agents.store))

        case 'auth-invite-accept':
          return await handleInviteAccept(request, agentsHandlerDeps(deps))

        case 'agents-list':
          return await handleListAgents(
            await resolveActingAgent(request, deps.agents.store),
            deps.agents,
          )

        case 'agents-create':
          return await handleCreateAgent(
            await resolveActingAgent(request, deps.agents.store),
            request,
            agentsHandlerDeps(deps),
          )

        case 'agent-item':
          return await handleGetAgent(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            deps.agents,
          )

        case 'agent-patch':
          return await handlePatchAgent(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.agents,
          )

        case 'agent-delete':
          return await handleDeleteAgent(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            deps.agents,
          )

        case 'agent-password':
          return await handleSetAgentPassword(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.agents,
          )

        case 'agent-invite':
          return await handleResendInvite(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            agentsHandlerDeps(deps),
          )

        // --- Mailbox access (HT-54 follow-up; spec §3.4/§6) -----------------

        case 'mailboxes-list':
          return await handleListMailboxes(
            await resolveActingAgent(request, deps.agents.store),
            deps.agents,
          )

        case 'agent-mailboxes-get':
          return await handleGetAgentMailboxes(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            deps.agents,
          )

        case 'agent-mailboxes-put':
          return await handlePutAgentMailboxes(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.agents,
          )

        // --- Passkeys (WebAuthn) (HT-75; specs/auth/passkeys.md) ------------
        //
        // Every route here 404s when deps.webauthn is absent (config.uiBaseUrl
        // unset) — the same absent-by-default degrade `gmailConnect`/
        // `gmailDisconnect` above use.

        case 'webauthn-authentication-options':
          return deps.webauthn !== undefined
            ? await handleAuthenticationOptions(deps.webauthn)
            : apiError(404, 'not_found', 'No such route.')

        case 'step-up-password':
          return deps.webauthn !== undefined
            ? await handleStepUpPassword(
                await resolveActingAgent(request, deps.agents.store),
                request,
                deps.webauthn,
              )
            : apiError(404, 'not_found', 'No such route.')

        case 'step-up-webauthn-options':
          return deps.webauthn !== undefined
            ? await handleStepUpWebAuthnOptions(
                await resolveActingAgent(request, deps.agents.store),
                deps.webauthn,
              )
            : apiError(404, 'not_found', 'No such route.')

        case 'step-up-webauthn-verify':
          return deps.webauthn !== undefined
            ? await handleStepUpWebAuthnVerify(
                await resolveActingAgent(request, deps.agents.store),
                request,
                deps.webauthn,
              )
            : apiError(404, 'not_found', 'No such route.')

        case 'webauthn-registration-options':
          return deps.webauthn !== undefined
            ? await handleRegistrationOptions(
                await resolveActingAgent(request, deps.agents.store),
                request,
                deps.webauthn,
              )
            : apiError(404, 'not_found', 'No such route.')

        case 'webauthn-registration-verify':
          return deps.webauthn !== undefined
            ? await handleRegistrationVerify(
                await resolveActingAgent(request, deps.agents.store),
                request,
                deps.webauthn,
              )
            : apiError(404, 'not_found', 'No such route.')

        case 'agent-webauthn-credentials-list':
          return deps.webauthn !== undefined
            ? await handleListCredentials(
                route.id,
                await resolveActingAgent(request, deps.agents.store),
                deps.webauthn,
              )
            : apiError(404, 'not_found', 'No such route.')

        case 'agent-webauthn-credential-patch':
          return deps.webauthn !== undefined
            ? await handlePatchCredential(
                route.id,
                route.credentialId,
                await resolveActingAgent(request, deps.agents.store),
                request,
                deps.webauthn,
              )
            : apiError(404, 'not_found', 'No such route.')

        case 'agent-webauthn-credential-delete':
          return deps.webauthn !== undefined
            ? await handleDeleteCredential(
                route.id,
                route.credentialId,
                await resolveActingAgent(request, deps.agents.store),
                deps.webauthn,
              )
            : apiError(404, 'not_found', 'No such route.')

        // --- Saved replies & macros (HT-76) ---------------------------------

        case 'saved-replies-list':
          return await handleListSavedReplies(
            route.mailboxId,
            await resolveActingAgent(request, deps.agents.store),
            deps.savedReplies,
          )

        case 'saved-replies-create':
          return await handleCreateSavedReply(
            route.mailboxId,
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.savedReplies,
          )

        case 'saved-reply-patch':
          return await handlePatchSavedReply(
            route.mailboxId,
            route.replyId,
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.savedReplies,
          )

        case 'saved-reply-delete':
          return await handleDeleteSavedReply(
            route.mailboxId,
            route.replyId,
            await resolveActingAgent(request, deps.agents.store),
            deps.savedReplies,
          )

        // --- Webhooks admin API (HT-69; specs/modules/substrate-v1.md §5) ---

        case 'webhooks-list':
          return await handleListWebhooks(
            await resolveActingAgent(request, deps.agents.store),
            deps.webhooks,
          )

        case 'webhooks-create':
          return await handleCreateWebhook(
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.webhooks,
          )

        case 'webhook-patch':
          return await handlePatchWebhook(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.webhooks,
          )

        case 'webhook-delete':
          return await handleDeleteWebhook(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            deps.webhooks,
          )

        case 'webhook-test':
          return await handleTestWebhook(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            deps.webhooks,
          )

        // --- Assistants (HT-70; specs/modules/substrate-v1.md §3) ----------

        case 'assistants-list':
          return await handleListAssistants(
            await resolveActingAgent(request, deps.agents.store),
            deps.assistants,
          )

        case 'assistants-create':
          return await handleCreateAssistant(
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.assistants,
          )

        case 'assistant-patch':
          return await handlePatchAssistant(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            request,
            deps.assistants,
          )

        case 'assistant-rotate-token':
          return await handleRotateAssistantToken(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            deps.assistants,
          )

        // --- Drafts (HT-70; specs/modules/substrate-v1.md §6) ---------------

        case 'conversation-draft-create': {
          const draftsDeps: DraftsHandlerDeps = {
            store: deps.store,
            sender: deps.sender,
            keyring: deps.keyring,
            mailDomain: deps.mailDomain,
            supportAddress: deps.supportAddress,
            ...(deps.openTracking !== undefined ? { openTracking: deps.openTracking } : {}),
            ...(deps.selfEchoGuard !== undefined ? { selfEchoGuard: deps.selfEchoGuard } : {}),
          }
          // Assistant-auth ONLY (spec §6) — a service-Bearer caller reaching
          // this route (the capability gate allows it through, since a
          // service token is unrestricted) has no Assistant identity to
          // attribute the draft to.
          if (caller.kind !== 'assistant') {
            return apiError(403, 'forbidden', 'Only an Assistant may create a draft.')
          }
          return await handleCreateDraft(route.id, caller.assistant, request, draftsDeps)
        }

        case 'drafts-list':
          return await handleListDrafts(request, { store: deps.store })

        case 'draft-approve':
          return await handleApproveDraft(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            request,
            {
              store: deps.store,
              sender: deps.sender,
              keyring: deps.keyring,
              mailDomain: deps.mailDomain,
              supportAddress: deps.supportAddress,
              ...(deps.openTracking !== undefined ? { openTracking: deps.openTracking } : {}),
              ...(deps.selfEchoGuard !== undefined ? { selfEchoGuard: deps.selfEchoGuard } : {}),
            },
          )

        case 'draft-discard':
          return await handleDiscardDraft(
            route.id,
            await resolveActingAgent(request, deps.agents.store),
            { store: deps.store },
          )
      }
    } catch (err) {
      console.error('[inbox-api] unhandled error handling request', err)
      return apiError(500, 'server_error', 'Internal server error.')
    }
  }
}

export type { ConversationStore } from '../store/conversations.js'
export type { ApiError } from './responses.js'
