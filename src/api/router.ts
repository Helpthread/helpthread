/**
 * A minimal method+pathname matcher for the Agent Inbox API's authenticated
 * routes: the six conversation-CRUD routes (specs/api/agent-inbox-v1.md
 * §3a, §3b, §4) plus `POST /api/v1/inbound/gmail/connect` (HT-40,
 * gmail-connect.md §2a).
 *
 * Deliberately NOT a general-purpose router library: the whole surface is a
 * handful of static-ish paths under `/api/v1`, most with a single `{id}`
 * path param. Spec §3 requires distinguishing "path doesn't match anything"
 * (404) from "path matches, method doesn't" (405 + `Allow` header) — that's
 * the one piece of behavior worth a shared helper, so `index.ts` doesn't
 * have to re-derive it by hand. Everything else (query-string parsing, body
 * parsing) belongs to the individual handlers, not this matcher.
 *
 * The API's PRE-AUTH carve-outs (the open-tracking pixel, the Gmail push
 * webhook, and the Gmail connect callback) are matched separately by
 * {@link matchOpenTrackingPixel}/{@link matchGmailPushWebhook}/{@link
 * matchGmailConnectCallback} below, checked by `index.ts` BEFORE this
 * matcher — see each function's own doc for why.
 */

/** One route this API recognizes, in match order. */
interface RouteDef {
  /** `RegExp` over the pathname; a capture group named `id` extracts the path param, if the route has one. */
  pattern: RegExp
  methods: readonly string[]
}

/** `/api/v1/conversations` — list only (spec §3a); no customer-create in v1. */
const CONVERSATIONS_LIST: RouteDef = {
  pattern: /^\/api\/v1\/conversations$/,
  methods: ['GET'],
}

/** `/api/v1/conversations/{id}` — get (spec §3b), status patch (spec §4b), and soft delete (spec §4d, v1.1). */
const CONVERSATION_ITEM: RouteDef = {
  pattern: /^\/api\/v1\/conversations\/(?<id>[^/]+)$/,
  methods: ['GET', 'PATCH', 'DELETE'],
}

/** `/api/v1/conversations/{id}/replies` — the Agent replies (spec §4a), POST only. */
const CONVERSATION_REPLIES: RouteDef = {
  pattern: /^\/api\/v1\/conversations\/(?<id>[^/]+)\/replies$/,
  methods: ['POST'],
}

/** `/api/v1/conversations/{id}/notes` — internal note (spec §4c, v1.1), POST only. */
const CONVERSATION_NOTES: RouteDef = {
  pattern: /^\/api\/v1\/conversations\/(?<id>[^/]+)\/notes$/,
  methods: ['POST'],
}

/** `/api/v1/conversations/{id}/tags` — replace the tag set (spec §4e, v1.1), PUT only. */
const CONVERSATION_TAGS: RouteDef = {
  pattern: /^\/api\/v1\/conversations\/(?<id>[^/]+)\/tags$/,
  methods: ['PUT'],
}

/** `/api/v1/conversations/{id}/assignee` — claim/release (spec §4f, v1.1), PUT only. */
const CONVERSATION_ASSIGNEE: RouteDef = {
  pattern: /^\/api\/v1\/conversations\/(?<id>[^/]+)\/assignee$/,
  methods: ['PUT'],
}

/**
 * `/api/v1/inbound/gmail/connect` — mint the Google consent URL (HT-40;
 * gmail-connect.md §2a), POST only. An ordinary Bearer-gated route, unlike
 * its sibling `/callback` (which is a pre-auth carve-out —
 * {@link matchGmailConnectCallback} — never listed here). Its pattern is
 * anchored (`connect$`) so it can never collide with the webhook's exact
 * `/api/v1/inbound/gmail` match or the callback's `/callback` suffix.
 */
const GMAIL_CONNECT: RouteDef = {
  pattern: /^\/api\/v1\/inbound\/gmail\/connect$/,
  methods: ['POST'],
}

/**
 * `/api/v1/inbound/gmail/disconnect` — the inverse admin action (HT-47;
 * gmail-connect.md's disconnect section), POST only. An ORDINARY
 * Bearer-gated route, same as {@link GMAIL_CONNECT} (disconnect has no
 * pre-auth carve-out — see `src/api/gmail-disconnect.ts`'s module doc). Its
 * pattern is anchored (`disconnect$`) so it can never collide with
 * `GMAIL_CONNECT`'s `connect$` or the push webhook's exact
 * `/api/v1/inbound/gmail` match.
 */
const GMAIL_DISCONNECT: RouteDef = {
  pattern: /^\/api\/v1\/inbound\/gmail\/disconnect$/,
  methods: ['POST'],
}

// --- Agents & Authentication (HT-54; specs/auth/agents-and-auth.md §6) -----
//
// All still Bearer-gated ordinary routes (spec §6: "All under the existing
// service-bearer channel") — the acting-Agent header is a SEPARATE,
// per-endpoint check the handlers perform themselves
// (`src/api/acting-agent.ts`), not something this matcher is aware of.

/** `/api/v1/auth/providers` — GET only, no acting-Agent header (spec §6, §8). */
const AUTH_PROVIDERS: RouteDef = {
  pattern: /^\/api\/v1\/auth\/providers$/,
  methods: ['GET'],
}

/** `/api/v1/setup` — the zero-Agents-gated first-admin bootstrap (spec §6), POST only, no acting-Agent header (spec §8's pre-session carve-out). */
const SETUP: RouteDef = {
  pattern: /^\/api\/v1\/setup$/,
  methods: ['POST'],
}

/** `/api/v1/auth/verify` — dispatch to a registered `AuthProvider` (spec §6), POST only, no acting-Agent header (pre-session). */
const AUTH_VERIFY: RouteDef = {
  pattern: /^\/api\/v1\/auth\/verify$/,
  methods: ['POST'],
}

/** `/api/v1/auth/me` — the acting Agent (spec §6), GET only, acting-Agent header REQUIRED. */
const AUTH_ME: RouteDef = {
  pattern: /^\/api\/v1\/auth\/me$/,
  methods: ['GET'],
}

/** `/api/v1/auth/invite/accept` — validate an invite token and activate (spec §6), POST only, no acting-Agent header (pre-session — no session exists yet). Anchored so it never collides with `AGENT_INVITE`'s `/agents/{id}/invite`. */
const AUTH_INVITE_ACCEPT: RouteDef = {
  pattern: /^\/api\/v1\/auth\/invite\/accept$/,
  methods: ['POST'],
}

/** `/api/v1/agents` — list (any active Agent, per the coordinator's roster-visibility amendment) and create (admin), acting-Agent header REQUIRED on both. */
const AGENTS_LIST: RouteDef = {
  pattern: /^\/api\/v1\/agents$/,
  methods: ['GET', 'POST'],
}

/** `/api/v1/agents/{id}` — get (admin or self), patch (admin for anyone, self for own name/timezone), hard delete (admin) — spec §6. Anchored `[^/]+$` so it never matches a `.../password`, `.../invite`, or `.../mailboxes` suffix, mirroring `CONVERSATION_ITEM`'s own anchoring. */
const AGENT_ITEM: RouteDef = {
  pattern: /^\/api\/v1\/agents\/(?<id>[^/]+)$/,
  methods: ['GET', 'PATCH', 'DELETE'],
}

/** `/api/v1/agents/{id}/password` — set/replace a password (self, or admin reset) — spec §6, POST only. */
const AGENT_PASSWORD: RouteDef = {
  pattern: /^\/api\/v1\/agents\/(?<id>[^/]+)\/password$/,
  methods: ['POST'],
}

/** `/api/v1/agents/{id}/invite` — (re)send an invite (admin) — spec §6, POST only. */
const AGENT_INVITE: RouteDef = {
  pattern: /^\/api\/v1\/agents\/(?<id>[^/]+)\/invite$/,
  methods: ['POST'],
}

// --- Passkeys (WebAuthn) (HT-75; specs/auth/passkeys.md §9) -----------------
//
// The two pre-session rows (`authentication/options`, and `/auth/verify`'s
// existing generic `providerKey: 'webauthn'` dispatch — no new route needed
// for that one) join agents-and-auth.md §8's bootstrap set. Every other row
// below is session-required, joining the "header required" set alongside
// `/agents/*`.

/** `/api/v1/auth/webauthn/authentication/options` — mint a login challenge (spec §6.2, §9), POST only, no acting-Agent header (pre-session). */
const WEBAUTHN_AUTHENTICATION_OPTIONS: RouteDef = {
  pattern: /^\/api\/v1\/auth\/webauthn\/authentication\/options$/,
  methods: ['POST'],
}

/** `/api/v1/auth/step-up/password` — step-up via the acting Agent's own password (spec §5.1, §9), POST only, acting-Agent header REQUIRED. */
const STEP_UP_PASSWORD: RouteDef = {
  pattern: /^\/api\/v1\/auth\/step-up\/password$/,
  methods: ['POST'],
}

/** `/api/v1/auth/step-up/webauthn/options` — mint a step-up challenge against the acting Agent's own credentials (spec §5.1, §9), POST only, acting-Agent header REQUIRED. */
const STEP_UP_WEBAUTHN_OPTIONS: RouteDef = {
  pattern: /^\/api\/v1\/auth\/step-up\/webauthn\/options$/,
  methods: ['POST'],
}

/** `/api/v1/auth/step-up/webauthn/verify` — verify the step-up assertion (spec §5.1, §9), POST only, acting-Agent header REQUIRED. Anchored `verify$` so it never collides with `STEP_UP_WEBAUTHN_OPTIONS`'s `options$`. */
const STEP_UP_WEBAUTHN_VERIFY: RouteDef = {
  pattern: /^\/api\/v1\/auth\/step-up\/webauthn\/verify$/,
  methods: ['POST'],
}

/** `/api/v1/auth/webauthn/registration/options` — mint a registration challenge, step-up-gated (spec §5, §6.1, §9), POST only, acting-Agent header REQUIRED. */
const WEBAUTHN_REGISTRATION_OPTIONS: RouteDef = {
  pattern: /^\/api\/v1\/auth\/webauthn\/registration\/options$/,
  methods: ['POST'],
}

/** `/api/v1/auth/webauthn/registration/verify` — verify + insert the new credential, step-up-gated (spec §5, §6.1, §9), POST only, acting-Agent header REQUIRED. */
const WEBAUTHN_REGISTRATION_VERIFY: RouteDef = {
  pattern: /^\/api\/v1\/auth\/webauthn\/registration\/verify$/,
  methods: ['POST'],
}

/** `/api/v1/agents/{id}/webauthn-credentials` — list (self, or admin) — spec §9, GET only. Anchored (`webauthn-credentials$`) so it never collides with `AGENT_ITEM`'s bare `{id}` pattern, mirroring `AGENT_PASSWORD`/`AGENT_INVITE`/`AGENT_MAILBOXES`. */
const AGENT_WEBAUTHN_CREDENTIALS: RouteDef = {
  pattern: /^\/api\/v1\/agents\/(?<id>[^/]+)\/webauthn-credentials$/,
  methods: ['GET'],
}

/** `/api/v1/agents/{id}/webauthn-credentials/{credentialId}` — rename (PATCH) or revoke (DELETE), self or admin, NOT step-up-gated (spec §5.4, §9). */
const AGENT_WEBAUTHN_CREDENTIAL_ITEM: RouteDef = {
  pattern: /^\/api\/v1\/agents\/(?<id>[^/]+)\/webauthn-credentials\/(?<credentialId>[^/]+)$/,
  methods: ['PATCH', 'DELETE'],
}

// --- Mailbox access (HT-54 follow-up; spec §3.4/§6) -------------------------

/** `/api/v1/mailboxes` — the full mailbox roster (admin only) — spec §3.4/§6, GET only. */
const MAILBOXES_LIST: RouteDef = {
  pattern: /^\/api\/v1\/mailboxes$/,
  methods: ['GET'],
}

/** `/api/v1/agents/{id}/mailboxes` — read (GET) or replace (PUT) an Agent's mailbox grants (admin only) — spec §3.4/§6. Anchored `[^/]+` between `agents/` and `/mailboxes` so it never collides with `AGENT_ITEM`'s bare `{id}` pattern. */
const AGENT_MAILBOXES: RouteDef = {
  pattern: /^\/api\/v1\/agents\/(?<id>[^/]+)\/mailboxes$/,
  methods: ['GET', 'PUT'],
}

// --- Saved replies & macros (HT-76; specs/api/agent-inbox-v1.md's
// saved-replies amendment) ---------------------------------------------------

/** `/api/v1/mailboxes/{id}/saved-replies` — list (any active Agent) and create (admin) — HT-76. Two named groups (`mailboxId`, no bare `id`), so it's matched with its own explicit branch below rather than the generic `id`-group fallback. */
const SAVED_REPLIES_LIST: RouteDef = {
  pattern: /^\/api\/v1\/mailboxes\/(?<mailboxId>[^/]+)\/saved-replies$/,
  methods: ['GET', 'POST'],
}

/** `/api/v1/mailboxes/{id}/saved-replies/{replyId}` — patch/delete (admin only) — HT-76. */
const SAVED_REPLY_ITEM: RouteDef = {
  pattern: /^\/api\/v1\/mailboxes\/(?<mailboxId>[^/]+)\/saved-replies\/(?<replyId>[^/]+)$/,
  methods: ['PATCH', 'DELETE'],
}

// --- Webhooks admin API (HT-69; specs/modules/substrate-v1.md §5) -----------
//
// Admin-only, acting-Agent header REQUIRED on every route (`src/api/
// webhooks.ts`'s module doc) — same Bearer-gated-ordinary-route shape as
// Agents & Authentication above, no pre-auth carve-out.

/** `/api/v1/webhooks` — list (GET) and register (POST), both admin only — spec §5. */
const WEBHOOKS_LIST: RouteDef = {
  pattern: /^\/api\/v1\/webhooks$/,
  methods: ['GET', 'POST'],
}

/** `/api/v1/webhooks/{id}` — patch/delete (admin only) — spec §5. Anchored `[^/]+$` so it never matches a `.../test` suffix, mirroring `AGENT_ITEM`'s own anchoring against `.../password`/`.../invite`/`.../mailboxes`. */
const WEBHOOK_ITEM: RouteDef = {
  pattern: /^\/api\/v1\/webhooks\/(?<id>[^/]+)$/,
  methods: ['PATCH', 'DELETE'],
}

/** `/api/v1/webhooks/{id}/test` — fire a synthetic `test.ping` through the real delivery path (admin only) — spec §5, POST only. */
const WEBHOOK_TEST: RouteDef = {
  pattern: /^\/api\/v1\/webhooks\/(?<id>[^/]+)\/test$/,
  methods: ['POST'],
}

// --- Assistants (HT-70; specs/modules/substrate-v1.md §3) -------------------
//
// Admin-only, acting-Agent header REQUIRED (same conventions as /agents) —
// never reachable by an Assistant's own token (the capability gate in
// `src/api/index.ts` refuses every route not in its allowed set).

/** `/api/v1/assistants` — list (GET) and create (POST), both admin only — spec §3. */
const ASSISTANTS_LIST: RouteDef = {
  pattern: /^\/api\/v1\/assistants$/,
  methods: ['GET', 'POST'],
}

/** `/api/v1/assistants/{id}/rotate-token` — mint a fresh secret for the SAME assistant id (admin only) — spec §3, POST only. Checked before `ASSISTANT_ITEM` per this file's specific-before-generic convention (`AGENT_PASSWORD`/`AGENT_INVITE` before `AGENT_ITEM`), though the two patterns cannot actually collide (`[^/]+` excludes `/`). */
const ASSISTANT_ROTATE_TOKEN: RouteDef = {
  pattern: /^\/api\/v1\/assistants\/(?<id>[^/]+)\/rotate-token$/,
  methods: ['POST'],
}

/** `/api/v1/assistants/{id}` — patch name/status (admin only) — spec §3, PATCH only (no GET-by-id or DELETE in v1). */
const ASSISTANT_ITEM: RouteDef = {
  pattern: /^\/api\/v1\/assistants\/(?<id>[^/]+)$/,
  methods: ['PATCH'],
}

// --- Drafts (HT-70; specs/plugins/substrate-v1.md §6) ------------------------

/** `/api/v1/conversations/{id}/drafts` — an Assistant posts a draft (spec §6), POST only. Anchored like `CONVERSATION_REPLIES`/`CONVERSATION_NOTES` — `CONVERSATION_ITEM`'s `[^/]+$` pattern can never match this `/drafts` suffix. */
const CONVERSATION_DRAFTS: RouteDef = {
  pattern: /^\/api\/v1\/conversations\/(?<id>[^/]+)\/drafts$/,
  methods: ['POST'],
}

/** `/api/v1/drafts` — the cross-conversation `?status=awaiting_review` review queue (spec §6), GET only. */
const DRAFTS_LIST: RouteDef = {
  pattern: /^\/api\/v1\/drafts$/,
  methods: ['GET'],
}

/** `/api/v1/drafts/{threadId}/approve` — approve, optionally with edits (spec §6), POST only. */
const DRAFT_APPROVE: RouteDef = {
  pattern: /^\/api\/v1\/drafts\/(?<id>[^/]+)\/approve$/,
  methods: ['POST'],
}

/** `/api/v1/drafts/{threadId}/discard` — discard (spec §6), POST only. */
const DRAFT_DISCARD: RouteDef = {
  pattern: /^\/api\/v1\/drafts\/(?<id>[^/]+)\/discard$/,
  methods: ['POST'],
}

/** Every route this API recognizes, checked in order. */
const ROUTES: readonly RouteDef[] = [
  CONVERSATIONS_LIST,
  CONVERSATION_ITEM,
  CONVERSATION_REPLIES,
  CONVERSATION_NOTES,
  CONVERSATION_TAGS,
  CONVERSATION_ASSIGNEE,
  CONVERSATION_DRAFTS,
  GMAIL_CONNECT,
  GMAIL_DISCONNECT,
  AUTH_PROVIDERS,
  SETUP,
  AUTH_VERIFY,
  AUTH_ME,
  AUTH_INVITE_ACCEPT,
  AGENTS_LIST,
  AGENT_PASSWORD,
  AGENT_INVITE,
  MAILBOXES_LIST,
  AGENT_MAILBOXES,
  WEBAUTHN_AUTHENTICATION_OPTIONS,
  STEP_UP_PASSWORD,
  STEP_UP_WEBAUTHN_OPTIONS,
  STEP_UP_WEBAUTHN_VERIFY,
  WEBAUTHN_REGISTRATION_OPTIONS,
  WEBAUTHN_REGISTRATION_VERIFY,
  AGENT_WEBAUTHN_CREDENTIAL_ITEM,
  AGENT_WEBAUTHN_CREDENTIALS,
  SAVED_REPLY_ITEM,
  SAVED_REPLIES_LIST,
  AGENT_ITEM,
  WEBHOOKS_LIST,
  WEBHOOK_TEST,
  WEBHOOK_ITEM,
  ASSISTANTS_LIST,
  ASSISTANT_ROTATE_TOKEN,
  ASSISTANT_ITEM,
  DRAFTS_LIST,
  DRAFT_APPROVE,
  DRAFT_DISCARD,
]

/** The outcome of matching a `(method, pathname)` pair against {@link ROUTES}. */
export type RouteMatch =
  | { kind: 'conversations-list' }
  | { kind: 'conversation-item'; id: string }
  | { kind: 'conversation-patch'; id: string }
  | { kind: 'conversation-delete'; id: string }
  | { kind: 'conversation-reply'; id: string }
  | { kind: 'conversation-note'; id: string }
  | { kind: 'conversation-tags'; id: string }
  | { kind: 'conversation-assignee'; id: string }
  | { kind: 'gmail-connect' }
  | { kind: 'gmail-disconnect' }
  | { kind: 'auth-providers' }
  | { kind: 'setup' }
  | { kind: 'auth-verify' }
  | { kind: 'auth-me' }
  | { kind: 'auth-invite-accept' }
  | { kind: 'agents-list' }
  | { kind: 'agents-create' }
  | { kind: 'agent-item'; id: string }
  | { kind: 'agent-patch'; id: string }
  | { kind: 'agent-delete'; id: string }
  | { kind: 'agent-password'; id: string }
  | { kind: 'agent-invite'; id: string }
  | { kind: 'mailboxes-list' }
  | { kind: 'agent-mailboxes-get'; id: string }
  | { kind: 'agent-mailboxes-put'; id: string }
  | { kind: 'webauthn-authentication-options' }
  | { kind: 'step-up-password' }
  | { kind: 'step-up-webauthn-options' }
  | { kind: 'step-up-webauthn-verify' }
  | { kind: 'webauthn-registration-options' }
  | { kind: 'webauthn-registration-verify' }
  | { kind: 'agent-webauthn-credentials-list'; id: string }
  | { kind: 'agent-webauthn-credential-patch'; id: string; credentialId: string }
  | { kind: 'agent-webauthn-credential-delete'; id: string; credentialId: string }
  | { kind: 'saved-replies-list'; mailboxId: string }
  | { kind: 'saved-replies-create'; mailboxId: string }
  | { kind: 'saved-reply-patch'; mailboxId: string; replyId: string }
  | { kind: 'saved-reply-delete'; mailboxId: string; replyId: string }
  | { kind: 'webhooks-list' }
  | { kind: 'webhooks-create' }
  | { kind: 'webhook-patch'; id: string }
  | { kind: 'webhook-delete'; id: string }
  | { kind: 'webhook-test'; id: string }
  | { kind: 'assistants-list' }
  | { kind: 'assistants-create' }
  | { kind: 'assistant-patch'; id: string }
  | { kind: 'assistant-rotate-token'; id: string }
  | { kind: 'conversation-draft-create'; id: string }
  | { kind: 'drafts-list' }
  | { kind: 'draft-approve'; id: string }
  | { kind: 'draft-discard'; id: string }
  | { kind: 'method-not-allowed'; allow: string[] }
  | { kind: 'not-found' }

/**
 * Match `method` + `pathname` against the known routes.
 *
 * Route-shape matches are checked BEFORE method: a path that matches a
 * route's pattern but not its method returns `method-not-allowed` (with the
 * full list of methods that path DOES support, for the `Allow` header) —
 * distinct from a pathname that doesn't match anything at all
 * (`not-found`). This ordering is what makes the two 4xx cases
 * distinguishable per spec §3.
 *
 * `CONVERSATION_ITEM`'s pattern is anchored (`[^/]+$`), so it can never
 * match a `.../replies` suffix — `CONVERSATION_REPLIES` is checked
 * independently, not as a fallback, and the two routes never contend for
 * the same pathname.
 */
/**
 * Match the open-tracking pixel path (spec §4g, v1.1 — HT-32):
 * `GET /api/v1/t/{token}.gif`. Kept SEPARATE from {@link matchRoute} on
 * purpose — the pixel is the API's one UNAUTHENTICATED surface, checked by
 * `index.ts` BEFORE Bearer auth, and giving it its own matcher keeps the
 * authenticated route table free of any pre-auth special case. GET only;
 * any other method on this path simply falls through to the normal
 * authenticated pipeline (and 401s like everything else).
 */
export function matchOpenTrackingPixel(method: string, pathname: string): { token: string } | null {
  if (method !== 'GET') return null
  const match = /^\/api\/v1\/t\/(?<token>[^/]+)\.gif$/.exec(pathname)
  const token = match?.groups?.token
  return token === undefined ? null : { token }
}

/**
 * Match the Gmail push webhook path (HT-39; gmail-push.md §2):
 * `POST /api/v1/inbound/gmail`. Kept SEPARATE from {@link matchRoute} and
 * checked by `index.ts` BEFORE Bearer auth — the SAME pre-auth carve-out
 * pattern as {@link matchOpenTrackingPixel}, for the same reason: Gmail/
 * Pub/Sub cannot present our service Bearer token, so this route
 * authenticates itself (a Google-signed OIDC JWT).
 *
 * Deliberately matches on PATHNAME ONLY, not method — unlike
 * {@link matchOpenTrackingPixel}, which matches GET only and lets any other
 * method fall through to the normal (401/404-shaped) pipeline. This route's
 * spec requires a UNIFORM rejection for every failed check, method
 * included (gmail-push.md §2: "POST + application/json only... a uniform
 * response that does not leak which check failed") — so a wrong method must
 * be rejected the exact same way a bad JWT is, by the handler itself
 * (`handleGmailPushWebhook`, `src/api/gmail-webhook.ts`), rather than
 * falling through to a DIFFERENT status code that would itself be a leak
 * (e.g. revealing this path exists via a 401/404 instead of the uniform
 * `403`).
 */
export function matchGmailPushWebhook(pathname: string): boolean {
  return pathname === '/api/v1/inbound/gmail'
}

/**
 * Match the Gmail connect callback path (HT-40; gmail-connect.md §2b):
 * `GET /api/v1/inbound/gmail/callback`. Kept SEPARATE from {@link
 * matchRoute} and checked by `index.ts` BEFORE Bearer auth — the SAME
 * pre-auth carve-out pattern as {@link matchGmailPushWebhook}/
 * {@link matchOpenTrackingPixel}, for the same reason: Google's redirect
 * cannot present our service Bearer token, so this route authenticates
 * itself (a signed `state` parameter, verified inside
 * `GmailConnectService.completeConnect`).
 *
 * Matches on PATHNAME ONLY, not method, mirroring {@link
 * matchGmailPushWebhook}: the handler itself
 * (`handleGmailConnectCallback`, `src/api/gmail-connect.ts`) is what
 * decides how to respond to a non-GET request on this path, rather than
 * falling through to a route-table 404/405 that would behave differently
 * from a bad `code`/`state` on the same path — one pre-auth surface, one
 * uniform place deciding its own responses.
 *
 * Exact-match, distinct from {@link matchGmailPushWebhook}'s
 * `/api/v1/inbound/gmail` and `GMAIL_CONNECT`'s
 * `/api/v1/inbound/gmail/connect` — the three paths share a prefix but
 * none is a substring match of another's full pattern, so they never
 * contend for the same pathname.
 */
export function matchGmailConnectCallback(pathname: string): boolean {
  return pathname === '/api/v1/inbound/gmail/callback'
}

export function matchRoute(method: string, pathname: string): RouteMatch {
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname)
    if (match === null) continue

    if (!route.methods.includes(method)) {
      return { kind: 'method-not-allowed', allow: [...route.methods] }
    }

    if (route === CONVERSATIONS_LIST) {
      return { kind: 'conversations-list' }
    }
    if (route === GMAIL_CONNECT) {
      return { kind: 'gmail-connect' }
    }
    if (route === GMAIL_DISCONNECT) {
      return { kind: 'gmail-disconnect' }
    }
    if (route === AUTH_PROVIDERS) {
      return { kind: 'auth-providers' }
    }
    if (route === SETUP) {
      return { kind: 'setup' }
    }
    if (route === AUTH_VERIFY) {
      return { kind: 'auth-verify' }
    }
    if (route === AUTH_ME) {
      return { kind: 'auth-me' }
    }
    if (route === AUTH_INVITE_ACCEPT) {
      return { kind: 'auth-invite-accept' }
    }
    if (route === AGENTS_LIST) {
      return method === 'GET' ? { kind: 'agents-list' } : { kind: 'agents-create' }
    }
    if (route === MAILBOXES_LIST) {
      return { kind: 'mailboxes-list' }
    }
    if (route === WEBAUTHN_AUTHENTICATION_OPTIONS) {
      return { kind: 'webauthn-authentication-options' }
    }
    if (route === STEP_UP_PASSWORD) {
      return { kind: 'step-up-password' }
    }
    if (route === STEP_UP_WEBAUTHN_OPTIONS) {
      return { kind: 'step-up-webauthn-options' }
    }
    if (route === STEP_UP_WEBAUTHN_VERIFY) {
      return { kind: 'step-up-webauthn-verify' }
    }
    if (route === WEBAUTHN_REGISTRATION_OPTIONS) {
      return { kind: 'webauthn-registration-options' }
    }
    if (route === WEBAUTHN_REGISTRATION_VERIFY) {
      return { kind: 'webauthn-registration-verify' }
    }
    if (route === AGENT_WEBAUTHN_CREDENTIALS) {
      const id = match.groups?.id as string
      return { kind: 'agent-webauthn-credentials-list', id }
    }
    if (route === AGENT_WEBAUTHN_CREDENTIAL_ITEM) {
      const id = match.groups?.id as string
      const credentialId = match.groups?.credentialId as string
      return method === 'DELETE'
        ? { kind: 'agent-webauthn-credential-delete', id, credentialId }
        : { kind: 'agent-webauthn-credential-patch', id, credentialId }
    }
    if (route === WEBHOOKS_LIST) {
      return method === 'GET' ? { kind: 'webhooks-list' } : { kind: 'webhooks-create' }
    }
    if (route === ASSISTANTS_LIST) {
      return method === 'GET' ? { kind: 'assistants-list' } : { kind: 'assistants-create' }
    }
    if (route === DRAFTS_LIST) {
      return { kind: 'drafts-list' }
    }
    // SAVED_REPLIES_LIST/SAVED_REPLY_ITEM carry `mailboxId`(/`replyId`)
    // named groups, not the generic `id` every other remaining route uses
    // below — matched here, before the generic fallback reads `id`.
    if (route === SAVED_REPLIES_LIST) {
      const mailboxId = match.groups?.mailboxId as string
      return method === 'GET'
        ? { kind: 'saved-replies-list', mailboxId }
        : { kind: 'saved-replies-create', mailboxId }
    }
    if (route === SAVED_REPLY_ITEM) {
      const mailboxId = match.groups?.mailboxId as string
      const replyId = match.groups?.replyId as string
      return method === 'DELETE'
        ? { kind: 'saved-reply-delete', mailboxId, replyId }
        : { kind: 'saved-reply-patch', mailboxId, replyId }
    }

    // Every remaining route guarantees a present, non-empty `id` group (per
    // its `[^/]+` pattern) whenever it matched.
    const id = match.groups?.id as string

    if (route === CONVERSATION_REPLIES) {
      return { kind: 'conversation-reply', id }
    }
    if (route === CONVERSATION_NOTES) {
      return { kind: 'conversation-note', id }
    }
    if (route === CONVERSATION_TAGS) {
      return { kind: 'conversation-tags', id }
    }
    if (route === CONVERSATION_ASSIGNEE) {
      return { kind: 'conversation-assignee', id }
    }
    if (route === AGENT_PASSWORD) {
      return { kind: 'agent-password', id }
    }
    if (route === AGENT_INVITE) {
      return { kind: 'agent-invite', id }
    }
    if (route === AGENT_MAILBOXES) {
      if (method === 'GET') return { kind: 'agent-mailboxes-get', id }
      return { kind: 'agent-mailboxes-put', id }
    }
    if (route === WEBHOOK_TEST) {
      return { kind: 'webhook-test', id }
    }
    if (route === WEBHOOK_ITEM) {
      if (method === 'DELETE') return { kind: 'webhook-delete', id }
      return { kind: 'webhook-patch', id }
    }
    if (route === CONVERSATION_DRAFTS) {
      return { kind: 'conversation-draft-create', id }
    }
    if (route === DRAFT_APPROVE) {
      return { kind: 'draft-approve', id }
    }
    if (route === DRAFT_DISCARD) {
      return { kind: 'draft-discard', id }
    }
    if (route === ASSISTANT_ROTATE_TOKEN) {
      return { kind: 'assistant-rotate-token', id }
    }
    if (route === ASSISTANT_ITEM) {
      return { kind: 'assistant-patch', id }
    }
    if (route === AGENT_ITEM) {
      if (method === 'GET') return { kind: 'agent-item', id }
      if (method === 'DELETE') return { kind: 'agent-delete', id }
      return { kind: 'agent-patch', id }
    }
    // route === CONVERSATION_ITEM: GET reads, PATCH updates status, DELETE
    // soft-deletes (spec §4d, v1.1).
    if (method === 'GET') return { kind: 'conversation-item', id }
    if (method === 'DELETE') return { kind: 'conversation-delete', id }
    return { kind: 'conversation-patch', id }
  }

  return { kind: 'not-found' }
}
