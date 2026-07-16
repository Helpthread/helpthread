/**
 * `ThreadAttachmentStore` — persistence for inbound attachment blob-
 * references (HT-46; specs/mail/inbound-ingestion.md §3's closing paragraph,
 * migration 015).
 *
 * A `thread_attachments` row never carries attachment BYTES — only a
 * reference to where the ingest pipeline (`src/mail/ingest.ts`) already
 * wrote them in the `BlobStore` (`blob_key`), namespaced
 * `<mailboxId>/<attachmentId>/<filename>`. This mirrors `src/store/
 * inbound-deliveries.ts`'s style: a small, focused store next to the bigger
 * `ConversationStore`, built on the same `Db`/`Queryable` seam.
 *
 * ## Transaction-scoped insert (the ingest write path)
 *
 * {@link insertThreadAttachmentsInTx} is deliberately NOT a method on
 * {@link ThreadAttachmentStore} — like `markStoredInTx`
 * (`src/store/inbound-deliveries.ts`) it takes an externally-supplied
 * `Queryable` so `src/mail/ingest.ts` can insert these rows inside the SAME
 * step-5 transaction as the thread it references (specs/mail/
 * inbound-ingestion.md §4: the store write and the ledger mark are one
 * atomic unit; the attachment references join that same unit — a
 * `thread_attachments` row can never exist for a thread that didn't survive
 * the transaction, and never point at bytes that weren't durably written to
 * the blob store BEFORE this transaction opened, per that module's doc
 * comment). No-op for an empty array — every message has zero or more
 * attachments, and zero is the common case.
 *
 * ## The read path
 *
 * {@link ThreadAttachmentStore.listByConversationId} is the ONLY read
 * method: a single query joined through `threads` so a caller (the Agent
 * Inbox API's `GET /api/v1/conversations/{id}`, `src/api/conversations.ts`)
 * fetches every attachment for a whole conversation in one round trip,
 * rather than one query per thread. Ordered oldest-first (`created_at, id`),
 * matching every other list order in this codebase's stores.
 */

import type { Db, Queryable } from '../db/client.js'

/** One attachment reference to insert, before its `id`/`createdAt` exist — the ingest pipeline's write shape. */
export interface NewThreadAttachment {
  threadId: string
  /** `null` when the attachment arrived with no filename (e.g. an inline image with only a `Content-Id`) — see `ParsedAttachment.filename`, `src/mail/parse.ts`. */
  filename: string | null
  contentType: string
  /** Size in bytes — `ParsedAttachment.size`. */
  size: number
  /** The mailbox-namespaced `BlobStore` key the bytes were already written to (`src/mail/ingest.ts`). Opaque to this store — never interpreted or reconstructed. */
  blobKey: string
}

/** One `thread_attachments` row as read back from storage — camelCase, timestamps as `Date`. */
export interface StoredThreadAttachment extends NewThreadAttachment {
  id: string
  createdAt: Date
}

/** Persistence operations for inbound attachment blob-references. See the module doc for the write path (a transaction-scoped function, not a method here). */
export interface ThreadAttachmentStore {
  /**
   * List every attachment belonging to any thread of conversation
   * `conversationId`, oldest-first. `[]` if the conversation has none (the
   * common case, or a conversation whose threads carry no attachments) —
   * never throws for a missing/empty conversation, since "no attachments"
   * and "no such conversation" both correctly resolve to the same empty
   * list here (the caller already resolved conversation existence itself).
   */
  listByConversationId(conversationId: string): Promise<StoredThreadAttachment[]>
}

/** `thread_attachments` columns, `ta.`-qualified for {@link createThreadAttachmentStore}'s joined read query. */
const ATTACHMENT_COLUMNS =
  'ta.id, ta.thread_id, ta.filename, ta.content_type, ta.size, ta.blob_key, ta.created_at'

/** Raw `thread_attachments` row shape, before mapping to {@link StoredThreadAttachment}. */
interface ThreadAttachmentRow {
  id: string
  thread_id: string
  filename: string | null
  content_type: string
  size: number
  blob_key: string
  created_at: Date | string
}

/**
 * Transaction-scoped: insert one row per `attachments` entry, all against
 * the caller-supplied `tx` — see the module doc's "Transaction-scoped
 * insert" section for why this composes with `src/mail/ingest.ts`'s step-5
 * transaction rather than opening its own. A no-op for `[]` (most messages
 * have no attachments).
 */
export async function insertThreadAttachmentsInTx(
  tx: Queryable,
  attachments: NewThreadAttachment[],
): Promise<void> {
  for (const attachment of attachments) {
    await tx.query(
      `INSERT INTO thread_attachments (thread_id, filename, content_type, size, blob_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        attachment.threadId,
        attachment.filename,
        attachment.contentType,
        attachment.size,
        attachment.blobKey,
      ],
    )
  }
}

/** Create a {@link ThreadAttachmentStore} backed by `db`. Holds no state of its own. */
export function createThreadAttachmentStore(db: Db): ThreadAttachmentStore {
  return {
    async listByConversationId(conversationId) {
      const rows = await db.query<ThreadAttachmentRow>(
        `SELECT ${ATTACHMENT_COLUMNS}
         FROM thread_attachments ta
         JOIN threads t ON t.id = ta.thread_id
         WHERE t.conversation_id = $1
         ORDER BY ta.created_at, ta.id`,
        [conversationId],
      )
      return rows.map(toStoredThreadAttachment)
    },
  }
}

/** Coerce a `timestamptz` column value into a `Date` — see `conversations.ts`'s `toDate` for the same defensive reasoning. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toStoredThreadAttachment(row: ThreadAttachmentRow): StoredThreadAttachment {
  return {
    id: row.id,
    threadId: row.thread_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    blobKey: row.blob_key,
    createdAt: toDate(row.created_at),
  }
}
