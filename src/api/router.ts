/**
 * A minimal method+pathname matcher for the Agent Inbox API's two (soon
 * three, HT-18) routes.
 *
 * Deliberately NOT a general-purpose router library: the whole surface is
 * two static-ish paths under `/api/v1`, one with a single `{id}` path
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

/** `/api/v1/conversations` — list only (spec §3a); write methods land here in HT-18. */
const CONVERSATIONS_LIST: RouteDef = {
  pattern: /^\/api\/v1\/conversations$/,
  methods: ['GET'],
}

/** `/api/v1/conversations/{id}` — get only (spec §3b); PATCH/replies land here in HT-18. */
const CONVERSATION_ITEM: RouteDef = {
  pattern: /^\/api\/v1\/conversations\/(?<id>[^/]+)$/,
  methods: ['GET'],
}

/** Every route this API recognizes, checked in order. */
const ROUTES: readonly RouteDef[] = [CONVERSATIONS_LIST, CONVERSATION_ITEM]

/** The outcome of matching a `(method, pathname)` pair against {@link ROUTES}. */
export type RouteMatch =
  | { kind: 'conversations-list' }
  | { kind: 'conversation-item'; id: string }
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
    // route === CONVERSATION_ITEM: the pattern's `id` group is guaranteed
    // present (and non-empty, per the `[^/]+` pattern) whenever the pattern
    // matched at all.
    const id = match.groups?.id as string
    return { kind: 'conversation-item', id }
  }

  return { kind: 'not-found' }
}
