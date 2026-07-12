/**
 * A minimal method+pathname matcher for the Agent Inbox API's six routes
 * (specs/api/agent-inbox-v1.md §3a, §3b, §4).
 *
 * Deliberately NOT a general-purpose router library: the whole surface is
 * six static-ish paths under `/api/v1`, five with a single `{id}` path
 * param. Spec §3 requires distinguishing "path doesn't match anything" (404)
 * from "path matches, method doesn't" (405 + `Allow` header) — that's the
 * one piece of behavior worth a shared helper, so `index.ts` doesn't have to
 * re-derive it by hand. Everything else (query-string parsing, body
 * parsing) belongs to the individual handlers, not this matcher.
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

/** Every route this API recognizes, checked in order. */
const ROUTES: readonly RouteDef[] = [
  CONVERSATIONS_LIST,
  CONVERSATION_ITEM,
  CONVERSATION_REPLIES,
  CONVERSATION_NOTES,
  CONVERSATION_TAGS,
  CONVERSATION_ASSIGNEE,
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

    // Both CONVERSATION_ITEM and CONVERSATION_REPLIES guarantee a present,
    // non-empty `id` group (per their `[^/]+` pattern) whenever they matched.
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
    // route === CONVERSATION_ITEM: GET reads, PATCH updates status, DELETE
    // soft-deletes (spec §4d, v1.1).
    if (method === 'GET') return { kind: 'conversation-item', id }
    if (method === 'DELETE') return { kind: 'conversation-delete', id }
    return { kind: 'conversation-patch', id }
  }

  return { kind: 'not-found' }
}
