/**
 * `POST /api/v1/inbound/gmail` — the Gmail push webhook receiver (HT-39;
 * specs/mail/gmail-push.md §2). The SECOND unauthenticated surface in this
 * API (the first is the open-tracking pixel, `matchOpenTrackingPixel` /
 * `src/api/index.ts`): Gmail/Pub/Sub cannot present our service Bearer
 * token, so this route is matched and handled BEFORE the Bearer-auth gate
 * (`src/api/index.ts`), authenticated instead by its own mechanism — a
 * Google-signed OIDC JWT (`deps.verifySignature`,
 * `src/providers/adapters/gmail/push-auth.ts`).
 *
 * This handler does NO heavy work inline (gmail-push.md §2): it verifies,
 * resolves the mailbox, and ENQUEUES a reconcile job onto the
 * `QueueProvider` — it never calls the Gmail API itself (`history.list`,
 * `messages.get` — that's HT-41).
 *
 * ## Uniform rejection — no oracle
 *
 * gmail-push.md §2 frames its whole "Required checks" list as one group —
 * "a failure of any is a uniform rejection" — covering the envelope limits
 * (method, content-type, body size) exactly as much as the security checks
 * (JWT, subscription, mailbox). So EVERY failure here, whichever check
 * trips it, produces the byte-identical {@link gmailPushRejected} response.
 * An attacker probing this endpoint learns nothing about which check they
 * failed — or even whether Gmail push is configured for this deployment at
 * all: `src/api/index.ts` returns this SAME response when `deps.gmailPush`
 * is unset, rather than a different one (e.g. 404) that would leak that
 * distinction.
 */

import type { QueueProvider } from '../providers/queue.js'
import type { MailboxStore } from '../store/mailboxes.js'
import { apiError, json } from './responses.js'

/**
 * Hard cap on the request body, enforced while STREAMING it (see
 * {@link readBodyWithLimit}) — not merely via a caller-supplied
 * `Content-Length`, which is absent, wrong, or lying by construction (it's
 * caller data). The real envelope — a Pub/Sub push JSON body wrapping a
 * tiny base64 `{emailAddress, historyId}` payload — is well under 1 KiB in
 * practice; this is generous headroom, not a tight fit, existing only to
 * bound the worst-case memory/parse work an unauthenticated POST can force.
 */
const MAX_BODY_BYTES = 65_536

/** Topic this transport enqueues reconcile jobs on (`QueueProvider`; consumed by HT-41's history-reconciliation worker). */
export const GMAIL_RECONCILE_TOPIC = 'gmail-reconcile'

/**
 * Payload of a "reconcile mailbox X from its stored cursor" job
 * (gmail-push.md §2-§3). `historyId` is the notification's watermark, kept
 * as an opaque string throughout (see migration 011's doc comment,
 * `src/db/migrate.ts`, on why `history_id` is never treated as a number) —
 * HT-41's consumer is expected to re-list `history.list` from the
 * MAILBOX'S STORED CURSOR, not from this `historyId` directly (gmail-push.md
 * §3: the stored cursor, not the notification's watermark, is the source of
 * truth for where to resume).
 */
export interface GmailReconcileJob {
  mailboxId: string
  historyId: string
}

/**
 * Dependencies {@link handleGmailPushWebhook} needs. Optional on
 * `InboxApiDeps` (`src/api/index.ts`) — ABSENT BY DEFAULT: a deployment
 * that hasn't provisioned Gmail push yet (no GCP subscription, HT-43) simply
 * never configures this, and every POST to this path gets the exact same
 * {@link gmailPushRejected} response it would get if Gmail push WERE
 * configured but the request failed a check — see the module doc's
 * "Uniform rejection" section.
 */
export interface GmailPushDeps {
  /**
   * Verifies the Google-signed OIDC JWT on the request (gmail-push.md §2):
   * signature, `iss`, `aud`, `email` + `email_verified`, `exp`. Named to
   * match `InboundEmailProvider.verifySignature`
   * (`src/providers/inbound-email.ts`) so a future full Gmail
   * `InboundEmailProvider` (HT-41) can be passed here verbatim — this
   * handler only ever calls this one method, never `receiveDelivery`. Build
   * the real check via `createGmailPushSignatureVerifier`/
   * `verifyGmailPushJwt` (`src/providers/adapters/gmail/push-auth.ts`) at
   * the composition root — this file never imports that adapter directly
   * (`src/providers/README.md`'s adapter-boundary rule: engine code depends
   * on interfaces/closures, never on a concrete adapter module). MUST be
   * total (never throw) and fail closed.
   */
  verifySignature: (request: Request) => Promise<boolean>
  /**
   * The exact Pub/Sub subscription this deployment provisioned
   * (`projects/{project}/subscriptions/{name}`) — compared against the push
   * envelope's top-level `subscription` field (gmail-push.md §2). A valid
   * Google JWT is necessary but not sufficient: the delivery must also be
   * addressed to OUR subscription, not merely some other authenticated
   * Pub/Sub push.
   */
  subscription: string
  /** Resolves a notification's `emailAddress` to a connected mailbox (gmail-push.md §3); unknown or non-`active` → rejected. */
  mailboxes: MailboxStore
  /** Where the reconcile job is enqueued. This handler never fetches the Gmail API inline (HT-41 owns that). */
  queue: QueueProvider
}

/**
 * The ONE rejection response every failed check produces — see the module
 * doc's "Uniform rejection" section. `403`, not `401`: this isn't our
 * service Bearer-token scheme (`src/api/auth.ts`'s `unauthorized` shape,
 * which implies "present different credentials") — it's "we understood
 * this push and decline to act on it," which is what `403 Forbidden` means.
 */
export function gmailPushRejected(): Response {
  return apiError(403, 'gmail_push_rejected', 'This push notification could not be verified.')
}

/** `Content-Type: application/json`, tolerating an optional `; charset=...` (or other) parameter, case-insensitively. */
function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false
  return /^application\/json(?:\s*;.*)?$/i.test(contentType.trim())
}

/**
 * Read `request`'s body as UTF-8 text, aborting as soon as more than
 * `maxBytes` have been accumulated — enforced while STREAMING (via
 * `request.body`'s reader) rather than by buffering the whole thing first
 * and checking after, so an oversized body never fully lands in memory.
 */
async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = request.body?.getReader()
  if (reader === undefined) {
    return { ok: true, text: '' }
  }

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      return { ok: false }
    }
    chunks.push(value)
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf-8') }
}

/** The Pub/Sub push envelope's shape, narrowed to the fields this transport needs (gmail-push.md §1-§2). */
interface GmailPushEnvelope {
  subscription: string
  message: { data: string }
}

/**
 * Validate a parsed JSON body against the Pub/Sub push envelope shape:
 * `{ subscription: string, message: { data: string } }`. Interpreting this
 * transport's OWN envelope (not the RFC822 message it ultimately carries
 * news of) is explicitly not the parsing `InboundEmailProvider`'s module doc
 * reserves to the pipeline (`src/providers/inbound-email.ts`) — see that
 * file's "A provider MAY still need to interpret its own transport
 * envelope" note. Total: never throws, returns `null` on any violation.
 */
function parseGmailPushEnvelope(raw: unknown): GmailPushEnvelope | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { subscription, message } = raw as Record<string, unknown>
  if (typeof subscription !== 'string' || subscription.length === 0) return null
  if (typeof message !== 'object' || message === null) return null
  const { data } = message as Record<string, unknown>
  if (typeof data !== 'string' || data.length === 0) return null
  return { subscription, message: { data } }
}

/** The decoded notification payload (gmail-push.md §1): `{ emailAddress, historyId }`. */
interface GmailPushNotification {
  emailAddress: string
  historyId: string
}

/**
 * Decode `message.data` — base64 JSON — into `{ emailAddress, historyId }`
 * (gmail-push.md §1). Node's `'base64'` `Buffer` codec accepts BOTH the
 * standard alphabet (`+`/`/`, the actual wire form of Pub/Sub's
 * protobuf-JSON `bytes` mapping) and the base64url alphabet (`-`/`_`,
 * gmail-push.md §1's own description) — see
 * {@link https://nodejs.org/api/buffer.html#buffers-and-character-encodings
 * Node's docs}: "this encoding will also correctly accept 'URL and Filename
 * Safe Alphabet'." Decoding with plain `'base64'` is therefore correct
 * either way, with no need to pick one.
 *
 * `historyId` is accepted as either a JSON string OR a JSON number and
 * normalized to a string: Gmail's REST API represents `historyId` as a
 * string everywhere else in this codebase (migration 011's doc comment,
 * `src/db/migrate.ts`), but this specific payload is emitted by Gmail's
 * push infrastructure, not the same JSON-mapped REST surface, and its exact
 * wire type here isn't nailed down by any fixture — accepting both avoids a
 * brittle assumption silently dropping real pushes.
 *
 * Total: never throws, returns `null` on any violation (invalid base64,
 * invalid JSON, wrong shape).
 */
function decodeGmailPushNotification(base64Data: string): GmailPushNotification | null {
  const decoded = Buffer.from(base64Data, 'base64').toString('utf-8')

  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const { emailAddress, historyId: rawHistoryId } = parsed as Record<string, unknown>
  if (typeof emailAddress !== 'string' || emailAddress.length === 0) return null

  const historyId =
    typeof rawHistoryId === 'string'
      ? rawHistoryId
      : typeof rawHistoryId === 'number' && Number.isFinite(rawHistoryId)
        ? String(rawHistoryId)
        : null
  if (historyId === null || historyId.length === 0) return null

  return { emailAddress, historyId }
}

/**
 * Handle `POST /api/v1/inbound/gmail`. See the module doc for the full
 * shape; in order: method + content-type + body-size checks, JWT
 * verification (before any body parsing — an unverified caller's body is
 * never even read into memory beyond the size-cap check), push-envelope
 * shape + `subscription` match, `message.data` decode, mailbox resolution
 * (must be `active`), then enqueue `{mailboxId, historyId}` onto
 * `deps.queue` and ack `200`. Every failure is {@link gmailPushRejected} —
 * see the module doc's "Uniform rejection" section.
 *
 * Wrapped in its own try/catch: this handler runs in a PRE-AUTH branch of
 * `createInboxApi` (`src/api/index.ts`), before the outer try/catch that
 * protects the normal authenticated routes, so it must guarantee no
 * exception escapes on its own. An unexpected internal error (a DB or queue
 * failure) is `500 server_error`, not folded into the uniform rejection —
 * that distinction is safe here specifically because a `500` is only ever
 * reachable AFTER the JWT and subscription checks already passed, i.e. only
 * for a genuinely Google-signed push; an attacker who cannot forge that JWT
 * never sees anything but `403`.
 */
export async function handleGmailPushWebhook(
  request: Request,
  deps: GmailPushDeps,
): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return gmailPushRejected()
    }
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return gmailPushRejected()
    }

    // Cheap fast-path on the declared length, ahead of the JWT check below —
    // but NOT a substitute for the streaming cap in readBodyWithLimit
    // (called later): Content-Length is caller-supplied and may be absent
    // or wrong.
    const declaredLength = request.headers.get('content-length')
    if (declaredLength !== null) {
      const parsedLength = Number(declaredLength)
      if (!Number.isFinite(parsedLength) || parsedLength > MAX_BODY_BYTES) {
        return gmailPushRejected()
      }
    }

    const verified = await deps.verifySignature(request)
    if (!verified) {
      return gmailPushRejected()
    }

    const body = await readBodyWithLimit(request, MAX_BODY_BYTES)
    if (!body.ok) {
      return gmailPushRejected()
    }

    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(body.text)
    } catch {
      return gmailPushRejected()
    }

    const envelope = parseGmailPushEnvelope(parsedBody)
    if (envelope === null) {
      return gmailPushRejected()
    }
    if (envelope.subscription !== deps.subscription) {
      return gmailPushRejected()
    }

    const notification = decodeGmailPushNotification(envelope.message.data)
    if (notification === null) {
      return gmailPushRejected()
    }

    const mailbox = await deps.mailboxes.getMailboxByAddress(notification.emailAddress)
    if (mailbox === null || mailbox.status !== 'active') {
      return gmailPushRejected()
    }

    const job: GmailReconcileJob = { mailboxId: mailbox.id, historyId: notification.historyId }
    // Best-effort de-dup on (mailboxId, historyId): Pub/Sub's own redelivery
    // of the SAME notification (e.g. because we were slow to ack) would
    // otherwise enqueue a second identical reconcile job. This is a queue-
    // layer optimization, not the correctness boundary — the ingest
    // pipeline's (mailboxId, providerMessageId) claim (inbound-ingestion.md
    // §4) is what actually makes duplicate reconciliation safe either way.
    await deps.queue.enqueue(GMAIL_RECONCILE_TOPIC, job, {
      dedupeKey: `${mailbox.id}:${notification.historyId}`,
    })

    return json(200, { ok: true })
  } catch (err) {
    console.error('[gmail-webhook] unhandled error handling push', err)
    return apiError(500, 'server_error', 'Internal server error.')
  }
}
