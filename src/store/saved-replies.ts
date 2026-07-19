/**
 * `SavedReplyStore` — persistence for `saved_replies` (migration 024,
 * `src/db/migrate.ts`; HT-76, specs/api/agent-inbox-v1.md's saved-replies
 * amendment).
 *
 * A saved reply is a per-mailbox reusable message definition — a "macro"
 * when it carries `actions`. This store persists DEFINITIONS ONLY: it has
 * no knowledge of conversations, replies, or status — applying a saved
 * reply's `actions` is the API/client's job, composing this deployment's
 * existing `POST .../replies`, `PATCH .../status`, `PUT .../tags`, and
 * `PUT .../assignee` endpoints (`src/api/saved-replies.ts`'s module doc).
 * Mirrors `src/store/webhook-endpoints.ts`'s shape: a plain CRUD store over
 * one table, no cross-table joins.
 */

import type { Db, SqlValue } from '../db/client.js'

/**
 * A macro's optional side effects, applied by the CLIENT after posting the
 * saved reply's body (this store/the engine never applies them itself —
 * see the module doc). Validated against exactly this shape at the API
 * layer (`src/api/saved-replies.ts`); persisted here as opaque `jsonb`,
 * the same "caller-serialized JSON, store does not validate" convention
 * `conversations.tags`/`webhook_endpoints.events` already use.
 */
export interface SavedReplyActions {
  setStatus?: 'closed' | 'pending'
  addTags?: string[]
  assignToSelf?: boolean
}

/** A saved reply as read back from storage — camelCase, timestamps as `Date`. */
export interface SavedReplyRecord {
  id: string
  mailboxId: string
  name: string
  bodyText: string
  bodyHtml: string | null
  actions: SavedReplyActions
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

/** Input to {@link SavedReplyStore.createSavedReply}. */
export interface NewSavedReply {
  mailboxId: string
  name: string
  bodyText: string
  bodyHtml?: string | null
  /** Omitted means `{}` (no macro side effects — a plain saved reply). */
  actions?: SavedReplyActions
  /** Omitted means `0`. */
  sortOrder?: number
}

/** Fields {@link SavedReplyStore.updateSavedReply} may change — every field independently optional (a PATCH, not a PUT-style full replace). */
export interface SavedReplyPatch {
  name?: string
  bodyText?: string
  bodyHtml?: string | null
  actions?: SavedReplyActions
  sortOrder?: number
}

/** Persistence operations for `saved_replies`. See the module doc for the definitions-only boundary. */
export interface SavedReplyStore {
  /**
   * List every saved reply for `mailboxId`, ordered `sort_order, created_at`
   * — the display order within the mailbox's saved-replies picker. Returns
   * `[]` when the mailbox has none (including when `mailboxId` names no
   * mailbox at all — the caller, `src/api/saved-replies.ts`, is what checks
   * mailbox existence via `MailboxStore` before calling this).
   */
  listByMailbox(mailboxId: string): Promise<SavedReplyRecord[]>

  /** Look up one saved reply by id. `null` if it doesn't exist. */
  getSavedReply(id: string): Promise<SavedReplyRecord | null>

  /**
   * Insert a new saved reply. Throws (the schema's `mailbox_id` FK) if
   * `input.mailboxId` names no mailbox — the caller is expected to check
   * mailbox existence first (see {@link listByMailbox}'s doc), so this is a
   * defensive invariant, not a routine outcome this store translates.
   */
  createSavedReply(input: NewSavedReply): Promise<SavedReplyRecord>

  /**
   * Apply `patch` to saved reply `id` — only the fields present are
   * changed; an empty patch is a harmless no-op read. Returns the updated
   * record, or `null` if `id` doesn't exist.
   */
  updateSavedReply(id: string, patch: SavedReplyPatch): Promise<SavedReplyRecord | null>

  /** Hard delete saved reply `id`. Returns `true` if a row was deleted, `false` if `id` didn't exist. */
  deleteSavedReply(id: string): Promise<boolean>
}

/** Raw `saved_replies` row shape, before mapping to {@link SavedReplyRecord}. */
interface SavedReplyRow {
  id: string
  mailbox_id: string
  name: string
  body_text: string
  body_html: string | null
  /** jsonb — arrives already-decoded, same driver behavior as `conversations.tags`. */
  actions: unknown
  sort_order: number
  created_at: Date | string
  updated_at: Date | string
}

const SAVED_REPLY_COLUMNS =
  'id, mailbox_id, name, body_text, body_html, actions, sort_order, created_at, updated_at'

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toSavedReplyRecord(row: SavedReplyRow): SavedReplyRecord {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    name: row.name,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    // Cast, not parsed: this codebase is the only writer of `actions`
    // (always via JSON.stringify of a SavedReplyActions), and the jsonb
    // column already arrives decoded — same reasoning as
    // `conversations.ts`'s `send_envelope`/`tags` casts.
    actions: row.actions as SavedReplyActions,
    sortOrder: row.sort_order,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

/** Create a {@link SavedReplyStore} backed by `db`. */
export function createSavedReplyStore(db: Db): SavedReplyStore {
  return {
    async listByMailbox(mailboxId) {
      const rows = await db.query<SavedReplyRow>(
        `SELECT ${SAVED_REPLY_COLUMNS} FROM saved_replies WHERE mailbox_id = $1 ORDER BY sort_order, created_at`,
        [mailboxId],
      )
      return rows.map(toSavedReplyRecord)
    },

    async getSavedReply(id) {
      const rows = await db.query<SavedReplyRow>(
        `SELECT ${SAVED_REPLY_COLUMNS} FROM saved_replies WHERE id = $1`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? null : toSavedReplyRecord(row)
    },

    async createSavedReply(input) {
      const rows = await db.query<SavedReplyRow>(
        `INSERT INTO saved_replies (mailbox_id, name, body_text, body_html, actions, sort_order)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING ${SAVED_REPLY_COLUMNS}`,
        [
          input.mailboxId,
          input.name,
          input.bodyText,
          input.bodyHtml ?? null,
          JSON.stringify(input.actions ?? {}),
          input.sortOrder ?? 0,
        ],
      )
      return toSavedReplyRecord(rows[0])
    },

    async updateSavedReply(id, patch) {
      const sets: string[] = []
      const params: SqlValue[] = []
      if (patch.name !== undefined) {
        params.push(patch.name)
        sets.push(`name = $${params.length}`)
      }
      if (patch.bodyText !== undefined) {
        params.push(patch.bodyText)
        sets.push(`body_text = $${params.length}`)
      }
      if (patch.bodyHtml !== undefined) {
        params.push(patch.bodyHtml)
        sets.push(`body_html = $${params.length}`)
      }
      if (patch.actions !== undefined) {
        params.push(JSON.stringify(patch.actions))
        sets.push(`actions = $${params.length}::jsonb`)
      }
      if (patch.sortOrder !== undefined) {
        params.push(patch.sortOrder)
        sets.push(`sort_order = $${params.length}`)
      }

      if (sets.length === 0) {
        const rows = await db.query<SavedReplyRow>(
          `SELECT ${SAVED_REPLY_COLUMNS} FROM saved_replies WHERE id = $1`,
          [id],
        )
        const row = rows[0]
        return row === undefined ? null : toSavedReplyRecord(row)
      }

      params.push(id)
      const rows = await db.query<SavedReplyRow>(
        `UPDATE saved_replies SET ${sets.join(', ')}, updated_at = now()
         WHERE id = $${params.length}
         RETURNING ${SAVED_REPLY_COLUMNS}`,
        params,
      )
      const row = rows[0]
      return row === undefined ? null : toSavedReplyRecord(row)
    },

    async deleteSavedReply(id) {
      const rows = await db.query<{ id: string }>(
        'DELETE FROM saved_replies WHERE id = $1 RETURNING id',
        [id],
      )
      return rows.length === 1
    },
  }
}
