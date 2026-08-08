/**
 * The customer-side conversations API (specs/api/customer-conversations-v1.md).
 *
 * Implements §6a create, §6b list, §6c get, and §6d reply — everything an
 * integrating product needs to offer support inside its own interface.
 * `Idempotency-Key` on create (§6a) is specified and not yet built; a create
 * without one behaves as documented.
 *
 * Two properties this module is responsible for, both from the spec:
 * - **Identity comes from the header, never the body** (§5). The integrator
 *   authenticated the user; the body is user-influenced and must not be able
 *   to name a different customer.
 * - **Attachments are all-or-nothing** (§6a). Blobs are written before the
 *   store transaction opens; a blob failure aborts with `502` and no
 *   conversation exists.
 */

import { randomUUID } from 'node:crypto'

import type { BlobStore } from '../providers/blob.js'
import type {
  ConversationStore,
  CustomerConversationSummary,
  StoredThread,
} from '../store/conversations.js'
import type { MailboxStore } from '../store/mailboxes.js'
import { apiError, json } from './responses.js'

/** Local mirror of the same helper in `conversations.ts`, which keeps it private. */
async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

/** Spec §3b's accepted local part: printable ASCII minus the specials that need quoting, and no leading/trailing/consecutive dots. */
const LOCAL_PART = /^(?!\.)(?!.*\.\.)[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+(?<!\.)$/
/** Spec §3b's accepted domain: dot-separated LDH labels, all ASCII. */
const DOMAIN = /^(?!-)[A-Za-z0-9-]+(?<!-)(?:\.(?!-)[A-Za-z0-9-]+(?<!-))+$/

const MAX_EMAIL_LENGTH = 254
const MAX_SUBJECT_LENGTH = 500
const MAX_BODY_LENGTH = 100_000
const MAX_ATTACHMENTS = 10
/** Spec §6a: measured on the DECODED bytes, not the base64 text. */
const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_FILENAME_LENGTH = 255
const MAX_CONTENT_TYPE_LENGTH = 255

/** Blob keys are restricted-ASCII (`src/mail/ingest.ts`); anything else collapses to `_`. */
function sanitizeAttachmentFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9_.-]/g, '_')
  return cleaned === '' ? 'attachment' : cleaned.slice(0, MAX_FILENAME_LENGTH)
}

/**
 * Spec §3b: trim → NFC → lowercase, then validate against the narrow v1
 * grammar. Returns `null` for anything outside it — quoted local parts,
 * comments, domain literals, non-ASCII in either part, more or fewer than one
 * `@` — which the caller turns into `400`, never a guess.
 *
 * Lowercasing the local part treats it as case-insensitive. Deliberate: RFC
 * 5321 permits case-sensitive local parts, effectively no operator implements
 * them, and matching case-sensitively would strand a customer whose client
 * varied capitalization between messages.
 */
export function normalizeCustomerEmail(raw: string): string | null {
  const normalized = raw.trim().normalize('NFC').toLowerCase()
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) return null
  const at = normalized.indexOf('@')
  if (at === -1 || at !== normalized.lastIndexOf('@')) return null

  const local = normalized.slice(0, at)
  const domain = normalized.slice(at + 1)
  if (!LOCAL_PART.test(local) || !DOMAIN.test(domain)) return null

  return normalized
}

/** The validated §6a request body. */
interface CreateBody {
  subject: string
  bodyText: string
  mailboxId: string
  attachments: { filename: string; contentType: string; bytes: Uint8Array }[]
}

type ParseFailure = { field: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Trim, then require 1..max characters. */
function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

/**
 * Decode one base64 attachment payload, rejecting anything that is not valid
 * base64. `Buffer.from(…, 'base64')` is famously lenient — it silently drops
 * invalid characters rather than throwing — so the input is shape-checked
 * first and the decode is confirmed by re-encoding.
 */
function decodeBase64(data: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) return null
  return new Uint8Array(bytes)
}

/** Validate the §6a body. Returns the parsed value or the first failure, never both. */
function parseCreateBody(
  value: unknown,
): { ok: true; body: CreateBody } | { ok: false; failure: ParseFailure } {
  if (!isRecord(value)) {
    return { ok: false, failure: { field: 'body', message: 'Request body must be a JSON object.' } }
  }

  const subject = boundedString(value.subject, MAX_SUBJECT_LENGTH)
  if (subject === null) {
    return {
      ok: false,
      failure: {
        field: 'subject',
        message: `subject is required and must be 1-${MAX_SUBJECT_LENGTH} characters.`,
      },
    }
  }

  const bodyText = boundedString(value.bodyText, MAX_BODY_LENGTH)
  if (bodyText === null) {
    return {
      ok: false,
      failure: {
        field: 'bodyText',
        message: `bodyText is required and must be 1-${MAX_BODY_LENGTH} characters.`,
      },
    }
  }

  const mailboxId = typeof value.mailboxId === 'string' ? value.mailboxId.trim() : ''
  if (mailboxId === '') {
    return { ok: false, failure: { field: 'mailboxId', message: 'mailboxId is required.' } }
  }

  const rawAttachments = value.attachments ?? []
  if (!Array.isArray(rawAttachments)) {
    return {
      ok: false,
      failure: { field: 'attachments', message: 'attachments must be an array.' },
    }
  }
  if (rawAttachments.length > MAX_ATTACHMENTS) {
    return {
      ok: false,
      failure: {
        field: 'attachments',
        message: `attachments must contain at most ${MAX_ATTACHMENTS} entries.`,
      },
    }
  }

  const attachments: CreateBody['attachments'] = []
  let totalBytes = 0
  for (const entry of rawAttachments) {
    if (!isRecord(entry)) {
      return {
        ok: false,
        failure: { field: 'attachments', message: 'Each attachment must be an object.' },
      }
    }
    const filename = boundedString(entry.filename, MAX_FILENAME_LENGTH)
    const contentType = boundedString(entry.contentType, MAX_CONTENT_TYPE_LENGTH)
    if (filename === null || contentType === null) {
      return {
        ok: false,
        failure: {
          field: 'attachments',
          message: 'Each attachment needs a filename and a contentType.',
        },
      }
    }
    if (typeof entry.data !== 'string') {
      return {
        ok: false,
        failure: { field: 'attachments', message: 'Each attachment needs base64 data.' },
      }
    }
    // Reject on the ENCODED length first. Decoding allocates a Buffer, and
    // verifying the decode allocates a second copy of the same size, so a
    // post-decode size check lets one oversized string drive peak memory
    // regardless of the cap. Base64 expands by 4/3, so the encoded form of an
    // allowed payload can never exceed the cap by more than that ratio.
    const encodedCap = Math.ceil((MAX_ATTACHMENTS_TOTAL_BYTES * 4) / 3) + 4
    if (entry.data.length > encodedCap) {
      return {
        ok: false,
        failure: {
          field: 'attachments',
          message: `Attachments must total at most ${MAX_ATTACHMENTS_TOTAL_BYTES} bytes once decoded.`,
        },
      }
    }
    const bytes = decodeBase64(entry.data)
    if (bytes === null) {
      return {
        ok: false,
        failure: { field: 'attachments', message: 'Attachment data must be valid base64.' },
      }
    }
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_ATTACHMENTS_TOTAL_BYTES) {
      return {
        ok: false,
        failure: {
          field: 'attachments',
          message: `Attachments must total at most ${MAX_ATTACHMENTS_TOTAL_BYTES} bytes once decoded.`,
        },
      }
    }
    attachments.push({ filename, contentType, bytes })
  }

  return { ok: true, body: { subject, bodyText, mailboxId, attachments } }
}

/**
 * Handle `POST /api/v1/customer/conversations` (spec §6a).
 *
 * `customerEmail` is the already-normalized address the caller resolved from
 * the `X-Helpthread-Customer-Email` header — this handler never reads it from
 * the body (§5).
 *
 * Outcomes: `201` with `{ id, number, subject, status, createdAt }`;
 * `400 validation_failed` for a bad body or an unknown/inactive mailbox;
 * `502 send_failed` when an attachment blob write fails, in which case no
 * conversation exists (§6a's all-or-nothing rule).
 */
export async function handleCustomerCreateConversation(
  customerEmail: string,
  request: Request,
  deps: { store: ConversationStore; mailboxes: MailboxStore; blobStore: BlobStore | null },
): Promise<Response> {
  const parsedBody = await parseJsonBody(request)
  if (!parsedBody.ok) {
    return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  }

  const parsed = parseCreateBody(parsedBody.value)
  if (!parsed.ok) {
    return apiError(400, 'validation_failed', parsed.failure.message)
  }
  const { subject, bodyText, mailboxId, attachments } = parsed.body

  // The mailbox is named by the integrator, so an unknown or non-active id is
  // caller error, not a server fault. Checked before any blob is written.
  // `getMailboxById` returns a row whatever its status — applying the active
  // policy is the caller's job, per that store's documented split — and both
  // cases collapse to one message so the API never reports on the operator's
  // mailbox health to an integrator.
  const mailbox = await deps.mailboxes.getMailboxById(mailboxId)
  if (mailbox === null || mailbox.status !== 'active') {
    return apiError(400, 'validation_failed', 'mailboxId does not name an active mailbox.')
  }

  // Blobs first, outside the transaction — mirroring `src/mail/ingest.ts`.
  // A failure here aborts before any conversation exists, which is what makes
  // §6a's all-or-nothing promise true; the reverse order could not.
  const attachmentRefs: { filename: string; contentType: string; size: number; blobKey: string }[] =
    []
  try {
    if (attachments.length > 0) {
      const { blobStore } = deps
      if (blobStore === null) {
        return apiError(400, 'validation_failed', 'This deployment does not accept attachments.')
      }
      for (const attachment of attachments) {
        const blobKey = `${mailboxId}/${randomUUID()}/${sanitizeAttachmentFilename(attachment.filename)}`
        await blobStore.put(blobKey, attachment.bytes, {
          contentType: attachment.contentType,
          contentLength: attachment.bytes.byteLength,
        })
        attachmentRefs.push({
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.bytes.byteLength,
          blobKey,
        })
      }
    }
  } catch {
    // Blobs already written are orphaned, which is tolerable and matches the
    // ingest path's posture; what must NOT happen is a conversation that
    // claims attachments it does not have.
    return apiError(502, 'send_failed', 'Could not store attachments.')
  }

  const created = await deps.store.createCustomerConversation({
    subject,
    customerEmail,
    mailboxId,
    firstMessage: {
      direction: 'inbound',
      messageId: null,
      fromAddress: customerEmail,
      bodyText,
    },
    attachments: attachmentRefs,
  })

  return json(201, {
    id: created.conversationId,
    number: created.number,
    subject,
    status: 'active',
    createdAt: created.createdAt.toISOString(),
  })
}

/* ------------------------------------------------------------------ *
 * Reads and replies (§6b–§6d)
 * ------------------------------------------------------------------ */

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 50

interface CustomerCursorPayload {
  /** Newest visible activity of the last row returned (§4b's derived value). */
  u: string
  i: string
  /** §3d: the cursor binds the customer and the folder it was minted under. */
  e: string
  f: 'open' | 'closed'
}

/**
 * §3d: an opaque keyset cursor that carries its own scope.
 *
 * Binding the customer and folder is not decoration — a cursor is a bare
 * `(timestamp, id)` pair otherwise, and replaying one across customers or
 * folders would silently traverse a different result set. Rejecting the
 * mismatch turns a whole class of caller bug into a `400`.
 */
function encodeCustomerCursor(p: CustomerCursorPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')
}

function decodeCustomerCursor(
  value: string,
  email: string,
  folder: 'open' | 'closed',
): { updatedAt: Date; id: string } | null {
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!isRecord(json)) return null
  const { u, i, e, f } = json as Partial<CustomerCursorPayload>
  if (typeof u !== 'string' || typeof i !== 'string') return null
  if (e !== email || (f !== 'open' && f !== 'closed')) return null
  if (f !== folder) return null
  // A non-uuid `i` would make Postgres throw rather than match no row.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i)) return null
  const updatedAt = new Date(u)
  if (Number.isNaN(updatedAt.getTime())) return null
  return { updatedAt, id: i }
}

/** §2's `CustomerThreadView` — the operator-only fields are absent, not nulled. */
function toCustomerThreadJson(thread: StoredThread): Record<string, unknown> {
  return {
    id: thread.id,
    direction: thread.direction,
    from: thread.fromAddress,
    bodyText: thread.bodyText,
    bodyHtml: thread.bodyHtml,
    createdAt: thread.createdAt.toISOString(),
    // §4d, resolved: authorship is reported as persisted. Collapsing an
    // assistant to 'agent' would report an AI as human staff, which
    // CHARTER.md's actor model forbids.
    authorKind: thread.authorKind,
  }
}

function toCustomerSummaryJson(summary: CustomerConversationSummary): Record<string, unknown> {
  return {
    id: summary.id,
    number: summary.number,
    subject: summary.subject,
    status: summary.status,
    threadCount: summary.threadCount,
    preview: summary.preview,
    previewAuthorKind: summary.previewAuthorKind,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  }
}

/**
 * Handle `GET /api/v1/customer/conversations` (spec §6b) — the customer's own
 * list, newest visible activity first.
 */
export async function handleCustomerListConversations(
  customerEmail: string,
  request: Request,
  deps: { store: ConversationStore },
): Promise<Response> {
  const url = new URL(request.url)

  const rawStatus = url.searchParams.get('status') ?? 'open'
  if (rawStatus !== 'open' && rawStatus !== 'closed') {
    return apiError(400, 'validation_failed', "status must be 'open' or 'closed'.")
  }

  const rawLimit = url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (rawLimit !== null) {
    const parsed = Number(rawLimit)
    if (!Number.isInteger(parsed) || parsed < 1) {
      return apiError(400, 'validation_failed', 'limit must be a positive integer.')
    }
    limit = Math.min(parsed, MAX_LIMIT) // §6b: clamped, not rejected.
  }

  const rawCursor = url.searchParams.get('cursor')
  let cursor: { updatedAt: Date; id: string } | undefined
  if (rawCursor !== null) {
    const decoded = decodeCustomerCursor(rawCursor, customerEmail, rawStatus)
    if (decoded === null) {
      return apiError(400, 'validation_failed', 'cursor is not valid for this request.')
    }
    cursor = decoded
  }

  // Over-fetch by one to detect a further page without a second query.
  const rows = await deps.store.listCustomerConversations({
    customerEmail,
    folder: rawStatus,
    limit: limit + 1,
    ...(cursor !== undefined ? { cursor } : {}),
  })

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCustomerCursor({
          u: last.updatedAt.toISOString(),
          i: last.id,
          e: customerEmail,
          f: rawStatus,
        })
      : null

  return json(200, { conversations: page.map(toCustomerSummaryJson), nextCursor })
}

/**
 * Handle `GET /api/v1/customer/conversations/{id}` (spec §6c).
 *
 * Unknown id, another customer's conversation, and a `spam`/`deleted` row all
 * produce the identical `404` — §5's no-existence-leak rule, enforced by the
 * store resolving all four in one predicate rather than by branching here.
 */
export async function handleCustomerGetConversation(
  customerEmail: string,
  id: string,
  deps: { store: ConversationStore },
): Promise<Response> {
  if (!isUuidLike(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }
  const found = await deps.store.getCustomerConversation(id, customerEmail)
  if (found === null) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }
  return json(200, {
    ...toCustomerSummaryJson(found),
    threads: found.threads.map(toCustomerThreadJson),
  })
}

/**
 * Handle `POST /api/v1/customer/conversations/{id}/replies` (spec §6d).
 *
 * On `404` the integrator must preserve the user's typed text: the
 * conversation may have been filed as spam or deleted between the read and
 * the reply, and this surface cannot say which without disclosing the spam
 * verdict (§3c).
 */
export async function handleCustomerReply(
  customerEmail: string,
  id: string,
  request: Request,
  deps: { store: ConversationStore },
): Promise<Response> {
  if (!isUuidLike(id)) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }

  const parsedBody = await parseJsonBody(request)
  if (!parsedBody.ok) {
    return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
  }
  if (!isRecord(parsedBody.value)) {
    return apiError(400, 'validation_failed', 'Request body must be a JSON object.')
  }
  const bodyText = boundedString(parsedBody.value.bodyText, MAX_BODY_LENGTH)
  if (bodyText === null) {
    return apiError(
      400,
      'validation_failed',
      `bodyText is required and must be 1-${MAX_BODY_LENGTH} characters.`,
    )
  }

  const result = await deps.store.appendCustomerReply(id, customerEmail, bodyText)
  if (result === null) {
    return apiError(404, 'not_found', 'No conversation with that id.')
  }
  return json(201, toCustomerThreadJson(result.thread))
}

/** Cheap shape check so a non-uuid path segment becomes a 404, never a Postgres error. */
function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
