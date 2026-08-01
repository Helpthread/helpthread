/**
 * The two IMAP/SMTP connect-flow HTTP handlers (HT-101 Stage 2a-ii;
 * specs/mail/mailbox-connection.md §5) — thin wrappers around
 * `src/mail/imap-connect.ts`'s `ImapConnectService`. Neither handler does
 * any network or persistence work itself; both just validate the request
 * body and translate the service's result (or thrown error) into a
 * `Response`.
 *
 * ## Both are ORDINARY Bearer-gated routes — no pre-auth carve-out
 *
 * Unlike Gmail's OAuth connect (`src/api/gmail-connect.ts`'s `POST
 * .../connect` + PRE-AUTH `GET .../callback` pair), there is no third party
 * to redirect through here — an operator supplies host/port/credentials
 * directly in one request. Both `handleImapConnect` and `handleImapCheck`
 * sit in the normal authenticated route table (`src/api/router.ts`), same as
 * the conversation-CRUD routes; the router guarantees the method is `POST`
 * and the caller already cleared the Bearer gate before either ever runs.
 *
 * **The Bearer gate is NOT the only check.** Both handlers additionally
 * require an **admin acting Agent** ({@link requireAdmin}), because both make
 * the server dial an operator-supplied `host:port`. An earlier revision of
 * this heading described them as ordinary Bearer-gated routes and nothing
 * more — which is precisely the misreading that left them un-gated in the
 * first place (review, 2026-07-31). `web/src/lib/api.ts` sends
 * `actingAgent: true` for both calls.
 *
 * ## The password is never echoed back
 *
 * `handleImapConnect`'s success response is the persisted `MailboxRecord`
 * (`{ id, address, provider, status }`, `src/store/mailboxes.ts`) — that
 * type carries no password field at all, so there is nothing to
 * accidentally serialize. `handleImapCheck`'s response is `{ imap, smtp }`
 * (`LegResult` each), which by construction (`src/mail/imap-connect.ts`'s
 * `attemptImapConnection`/`attemptSmtpVerification`) never carries the
 * submitted password either — only `{ ok: true }` or `{ ok: false, error }`,
 * where `error` is a caught failure's own sanitized message.
 */

import {
  ImapConnectError,
  type ImapConnectInput,
  type ImapConnectService,
} from '../mail/imap-connect.js'
import type { AgentRecord } from '../store/agents.js'
import type { ImapConfigStore } from '../store/imap-config.js'
import type { MailboxStore } from '../store/mailboxes.js'
import { apiError, json } from './responses.js'
import { isUuid } from './uuid.js'

/**
 * Dependencies both handlers need. ABSENT BY DEFAULT on `InboxApiDeps`
 * (`src/api/index.ts`) — a deployment that hasn't wired the IMAP/SMTP
 * connect service simply never configures this.
 *
 * `configStore`/`mailboxStore` (HT-101 Stage 2b) back the read-only
 * `GET .../mailboxes/{id}/imap-config` handler below — the SAME
 * `ImapConfigStore`/`MailboxStore` instances the composition root already
 * builds `service` from (`src/composition/root.ts`), not a second copy.
 */
export interface ImapConnectDeps {
  service: ImapConnectService
  configStore: ImapConfigStore
  mailboxStore: MailboxStore
}

/** Best-effort parse of a request body as a JSON object. Mirrors `src/api/gmail-disconnect.ts`'s `parseJsonBody` convention. */
async function parseJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

/** A field-name → validation-failure pair, for building one combined message. */
type FieldProblem = string

/**
 * Validate and narrow a parsed JSON body into an {@link ImapConnectInput}.
 * `address`/`imapHost`/`smtpHost`/`username`/`password` must be non-empty
 * strings; `imapPort`/`smtpPort` must be integers in the same `1..65535`
 * range migration 028's `CHECK` constraint enforces on `imap_mailbox_config`
 * (so an invalid port is rejected HERE, before ever attempting a connection
 * or a doomed insert); `secure`, if present, must be a boolean.
 */
function validateConnectInput(
  body: unknown,
): { ok: true; value: ImapConnectInput } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, message: 'Request body must be a JSON object.' }
  }
  const b = body as Record<string, unknown>

  const requireString = (field: string): string | null => {
    const v = b[field]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const requirePort = (field: string): number | null => {
    const v = b[field]
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null
  }

  const problems: FieldProblem[] = []

  const address = requireString('address')
  if (address === null) problems.push('address (non-empty string)')
  const imapHost = requireString('imapHost')
  if (imapHost === null) problems.push('imapHost (non-empty string)')
  const imapPort = requirePort('imapPort')
  if (imapPort === null) problems.push('imapPort (integer, 1-65535)')
  const smtpHost = requireString('smtpHost')
  if (smtpHost === null) problems.push('smtpHost (non-empty string)')
  const smtpPort = requirePort('smtpPort')
  if (smtpPort === null) problems.push('smtpPort (integer, 1-65535)')
  const username = requireString('username')
  if (username === null) problems.push('username (non-empty string)')
  const password = requireString('password')
  if (password === null) problems.push('password (non-empty string)')

  const secureRaw = b.secure
  if (secureRaw !== undefined && typeof secureRaw !== 'boolean') {
    problems.push('secure (boolean, if present)')
  }

  if (problems.length > 0) {
    return {
      ok: false,
      message: `Invalid or missing field(s): ${problems.join(', ')}.`,
    }
  }

  return {
    ok: true,
    value: {
      address: address as string,
      imapHost: imapHost as string,
      imapPort: imapPort as number,
      smtpHost: smtpHost as string,
      smtpPort: smtpPort as number,
      username: username as string,
      password: password as string,
      ...(typeof secureRaw === 'boolean' ? { secure: secureRaw } : {}),
    },
  }
}

/**
 * Admin-only, for every endpoint in this module. Returns the refusal
 * `Response` to send, or `null` when the caller may proceed.
 *
 * Both write endpoints take an operator-supplied `host`/`port` and make the
 * server open a connection to it. Left at service-Bearer-only — as an earlier
 * revision was, until an adversarial review caught it (2026-07-31) — any
 * holder of the deployment's API token could use `/imap/check` as a network
 * probe against hosts and ports it can reach but the caller cannot,
 * distinguishing open from closed from filtered by the leg outcomes this
 * module returns. The sibling read endpoint
 * ({@link handleGetMailboxImapConfig}) already required admin; the two
 * endpoints that actually *dial* did not, which is the wrong way round.
 *
 * This is authorization, not a full SSRF defence: it bounds *who* can name a
 * target, not *which* targets are nameable. Host/port allowlisting for
 * outbound mail connections — the equivalent of `src/webhooks/ssrf.ts` for
 * webhook URLs — is deliberately NOT attempted here and is filed separately.
 */
function requireAdmin(actingAgent: AgentRecord | null): Response | null {
  if (actingAgent === null) {
    return apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
  }
  if (actingAgent.role !== 'admin') {
    return apiError(403, 'forbidden', 'Admin role required.')
  }
  return null
}

/**
 * Handle `POST /api/v1/inbound/imap/connect`. Admin only. Validates the body,
 * calls `ImapConnectService.connect`, and returns the persisted
 * `MailboxRecord` — never the password (module doc).
 *
 * - Missing/invalid JSON body, or an invalid/missing field → `400
 *   validation_failed`.
 * - A caught {@link ImapConnectError} (`imap_failed` / `smtp_failed`) → `422`
 *   with the error's own code and (already secret-free) message.
 * - `provider_conflict` → `409` instead: the address is already connected over
 *   another transport, so nothing about the submitted credentials is wrong —
 *   the conflict is with existing state the operator must clear first.
 * - Any other error (a DB blip — genuinely unexpected) → `500 server_error`.
 * - Success → `200` with the mailbox.
 *
 * Own try/catch: every exit from here must be a `Response` this module
 * built, matching every other handler's convention.
 */
export async function handleImapConnect(
  request: Request,
  actingAgent: AgentRecord | null,
  deps: ImapConnectDeps,
): Promise<Response> {
  try {
    const denied = requireAdmin(actingAgent)
    if (denied !== null) {
      return denied
    }
    const parsedBody = await parseJsonBody(request)
    if (!parsedBody.ok) {
      return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
    }
    const validated = validateConnectInput(parsedBody.value)
    if (!validated.ok) {
      return apiError(400, 'validation_failed', validated.message)
    }

    try {
      const mailbox = await deps.service.connect(validated.value)
      return json(200, mailbox)
    } catch (err) {
      if (err instanceof ImapConnectError) {
        // 409, not 422: the submitted credentials are not what is wrong.
        return apiError(err.code === 'provider_conflict' ? 409 : 422, err.code, err.message)
      }
      throw err
    }
  } catch (err) {
    console.error('[imap-connect] unhandled error connecting mailbox', err)
    return apiError(500, 'server_error', 'Internal server error.')
  }
}

/**
 * Handle `POST /api/v1/inbound/imap/check`. Validates the body (same shape
 * as {@link handleImapConnect}), calls `ImapConnectService.checkConnection`,
 * and returns `{ imap, smtp }` per-leg results. Persists NOTHING regardless
 * of outcome.
 *
 * - Missing/invalid JSON body, or an invalid/missing field → `400
 *   validation_failed`.
 * - Any other error (a genuinely unexpected internal failure — the service
 *   itself never throws for a connectivity failure, only reports a
 *   `LegResult`) → `500 server_error`.
 * - Success (regardless of whether either leg failed — a failed leg is
 *   reported IN the 200 body, not a non-2xx status) → `200` with `{ imap,
 *   smtp }`.
 */
export async function handleImapCheck(
  request: Request,
  actingAgent: AgentRecord | null,
  deps: ImapConnectDeps,
): Promise<Response> {
  try {
    const denied = requireAdmin(actingAgent)
    if (denied !== null) {
      return denied
    }
    const parsedBody = await parseJsonBody(request)
    if (!parsedBody.ok) {
      return apiError(400, 'validation_failed', 'Request body must be valid JSON.')
    }
    const validated = validateConnectInput(parsedBody.value)
    if (!validated.ok) {
      return apiError(400, 'validation_failed', validated.message)
    }

    const result = await deps.service.checkConnection(validated.value)
    return json(200, result)
  } catch (err) {
    console.error('[imap-connect] unhandled error checking mailbox connection', err)
    return apiError(500, 'server_error', 'Internal server error.')
  }
}

/**
 * Handle `GET /api/v1/mailboxes/{id}/imap-config` (HT-101 Stage 2b; the
 * mailbox-settings "Connection" section's read-only view). Admin only —
 * same posture as `handleListMailboxes`/the other mailbox-scoped endpoints
 * in `src/api/agents.ts`.
 *
 * Returns `imap_mailbox_config`'s non-secret columns via
 * `ImapConfigStore.getConfig` — {@link ImapConnectionConfig} carries no
 * password field at all (the credential lives in the sibling
 * `imap_mailbox_credentials` table, `../store/imap-credentials.ts`), so
 * there is nothing to accidentally serialize here; the UI renders a
 * "configured" state instead of a value (spec's "never a value" rule).
 *
 * - Unknown/malformed id, or a mailbox with no IMAP/SMTP config on file
 *   (e.g. a Gmail-connected mailbox) → `404 not_found`.
 * - Non-admin acting Agent → `403 forbidden`. No acting Agent → `401
 *   unauthorized`.
 */
export async function handleGetMailboxImapConfig(
  mailboxId: string,
  actingAgent: AgentRecord | null,
  deps: ImapConnectDeps,
): Promise<Response> {
  if (actingAgent === null) {
    return apiError(401, 'unauthorized', 'Missing or invalid Agent identity.')
  }
  if (actingAgent.role !== 'admin') {
    return apiError(403, 'forbidden', 'Admin role required.')
  }
  if (!isUuid(mailboxId)) {
    return apiError(404, 'not_found', 'No mailbox with that id.')
  }

  const mailbox = await deps.mailboxStore.getMailboxById(mailboxId)
  if (mailbox === null) {
    return apiError(404, 'not_found', 'No mailbox with that id.')
  }

  const config = await deps.configStore.getConfig(mailboxId)
  if (config === null) {
    return apiError(404, 'not_found', 'This mailbox has no IMAP/SMTP configuration.')
  }

  return json(200, {
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    username: config.username,
    secure: config.secure,
  })
}
