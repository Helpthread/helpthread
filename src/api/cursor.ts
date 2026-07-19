/**
 * Opaque keyset pagination cursor for `GET /api/v1/conversations`
 * (specs/api/agent-inbox-v1.md §3a).
 *
 * The cursor encodes the `(updatedAt, id)` of the last conversation a page
 * returned — exactly the {@link ConversationListCursor} shape
 * `ConversationStore.listConversations` (`src/store/conversations.ts`)
 * consumes. It is base64url(JSON), which makes it URL-safe to place in a
 * query string with no additional escaping, and self-evidently opaque: spec
 * §3a is explicit that the client only ever echoes it back, never parses
 * it, so there is no wire-format commitment beyond "round-trips through
 * `encodeCursor`/`decodeCursor`."
 *
 * `decodeCursor` is TOTAL over its string input: malformed base64, invalid
 * JSON, a wrong shape, or an unparseable date all return `null`, never
 * throw. A cursor is client-supplied (a query-string value), so it must be
 * treated as hostile input on the way in — the API layer turns a `null`
 * decode into `400 validation_failed`, not a crash (spec §3, §3a).
 */

import type { ConversationListCursor, ListAwaitingDraftsCursor } from '../store/conversations.js'
import { isUuid } from './uuid.js'

/** The JSON shape actually encoded — short keys since it travels in a URL. `u` = updatedAt (ISO string), `i` = id. */
interface CursorPayload {
  u: string
  i: string
}

/** Encode a cursor position as an opaque base64url string. */
export function encodeCursor(cursor: ConversationListCursor): string {
  const payload: CursorPayload = { u: cursor.updatedAt.toISOString(), i: cursor.id }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/**
 * Decode a cursor string produced by {@link encodeCursor}. Returns `null` —
 * never throws — for anything that isn't a well-formed cursor: invalid
 * base64url, invalid JSON, a wrong/missing field, or an unparseable date.
 */
export function decodeCursor(value: string): ConversationListCursor | null {
  let json: unknown
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    json = JSON.parse(decoded)
  } catch {
    return null
  }

  if (typeof json !== 'object' || json === null) {
    return null
  }
  const payload = json as Partial<CursorPayload>
  if (typeof payload.u !== 'string' || typeof payload.i !== 'string') {
    return null
  }
  // `i` is compared against `conversations.id uuid` in the store; a non-UUID
  // value would make Postgres throw `invalid input syntax for type uuid`
  // rather than the store simply matching no row. Reject it here so a forged
  // cursor becomes a clean `400`, never an uncaught 500 (see uuid.ts).
  if (!isUuid(payload.i)) {
    return null
  }

  const updatedAt = new Date(payload.u)
  if (Number.isNaN(updatedAt.getTime())) {
    return null
  }

  return { updatedAt, id: payload.i }
}

/**
 * The `GET /api/v1/drafts` (HT-70) sibling of {@link encodeCursor}/
 * {@link decodeCursor} — same opaque base64url(JSON) shape and the same `u`/
 * `i` short keys, scoped to {@link ListAwaitingDraftsCursor}'s
 * `(createdAt, id)` instead of a conversation's `(updatedAt, id)`. Kept as
 * separate functions rather than a generic pair: the two cursor types are
 * unrelated wire contracts that happen to share a shape today, and this
 * codebase's convention (see `src/store/conversations.ts`'s draft-aware
 * queries) is to accept that duplication rather than couple two independent
 * endpoints through a shared abstraction.
 */
export function encodeDraftCursor(cursor: ListAwaitingDraftsCursor): string {
  const payload: CursorPayload = { u: cursor.createdAt.toISOString(), i: cursor.id }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode a cursor string produced by {@link encodeDraftCursor}. Same totality contract as {@link decodeCursor} — never throws, `null` on anything malformed. */
export function decodeDraftCursor(value: string): ListAwaitingDraftsCursor | null {
  let json: unknown
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    json = JSON.parse(decoded)
  } catch {
    return null
  }

  if (typeof json !== 'object' || json === null) {
    return null
  }
  const payload = json as Partial<CursorPayload>
  if (typeof payload.u !== 'string' || typeof payload.i !== 'string') {
    return null
  }
  if (!isUuid(payload.i)) {
    return null
  }

  const createdAt = new Date(payload.u)
  if (Number.isNaN(createdAt.getTime())) {
    return null
  }

  return { createdAt, id: payload.i }
}
