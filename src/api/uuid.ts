/**
 * UUID-shape guard for values that reach a `uuid`-typed SQL column
 * (specs/api/agent-inbox-v1.md §3).
 *
 * Why this exists: a conversation `id` (a path segment) and a cursor's `id`
 * are both compared against `conversations.id uuid` in the store. Postgres
 * (and PGlite) does NOT treat a non-UUID string as "no such row" — it raises
 * `invalid input syntax for type uuid` and rejects the whole query. So an
 * unvalidated `GET /api/v1/conversations/not-a-uuid`, or a forged pagination
 * cursor carrying a non-UUID id, would throw at the database rather than
 * producing the clean `404`/`400` the spec requires. Validating the shape at
 * the API boundary keeps those inputs on the intended, non-throwing path.
 *
 * This checks SHAPE only (canonical 8-4-4-4-12 hex, any case/version) — it is
 * a "could this even be one of our ids" gate, not a claim the id exists.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** True iff `value` is a syntactically well-formed UUID. Never throws. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
