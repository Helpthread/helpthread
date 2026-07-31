/**
 * IMAP/SMTP connect and connectivity-check service (HT-101 Stage 2a-ii;
 * specs/mail/mailbox-connection.md §5's connect flow). The per-inbox
 * counterpart of `./gmail-connect.ts`, but for an operator-supplied IMAP/SMTP
 * mail server rather than a Google OAuth grant.
 *
 * ## Two operations, backing two routes (`src/api/imap-connect.ts`)
 *
 * - {@link ImapConnectService.checkConnection} — `POST
 *   /api/v1/inbound/imap/check`: attempt BOTH the IMAP and SMTP legs and
 *   report each leg's outcome INDEPENDENTLY, persisting nothing. Lets an
 *   operator validate host/port/credentials before committing them.
 * - {@link ImapConnectService.connect} — `POST /api/v1/inbound/imap/connect`:
 *   the same two checks, but ABORTS on the first failure (never both-report,
 *   unlike `checkConnection`) and, only once both legs are proven usable,
 *   persists the mailbox/config/credential/cursor rows atomically.
 *
 * ## No OAuth, no pre-auth callback — unlike `./gmail-connect.ts`
 *
 * Gmail's connect flow is a two-request OAuth dance: a Bearer-gated `POST
 * .../connect` that mints a consent URL, then a PRE-AUTH `GET .../callback`
 * Google's redirect lands on (`./gmail-connect.ts`'s module doc). IMAP/SMTP
 * has no third party to redirect through — an operator supplies host/port/
 * username/password directly in one Bearer-gated request. So `connect` here
 * is a single ordinary authenticated action, not a `beginConnect`/
 * `completeConnect` pair, and there is no signed `state` CSRF token to mint
 * or verify (`src/api/router.ts` never carves out a pre-auth path for either
 * IMAP route).
 *
 * ## The mailbox address is operator-supplied, not authoritatively resolved
 *
 * Gmail's connect flow resolves the connected address from the OAuth grant
 * itself (`getProfile()`, never operator input) — there is no equivalent
 * discovery call for a generic IMAP/SMTP server, so `ImapConnectInput.address`
 * is taken as given. A caller with the service Bearer token could in
 * principle claim any address; that is the SAME trust level every other
 * ordinary Bearer-gated admin action in this API already carries (creating
 * Agents, connecting/disconnecting mailboxes, registering webhooks) — not a
 * new privilege boundary this ticket introduces. Flagged for the reviewer,
 * not resolved here.
 *
 * ## Both legs run to completion, independently (`checkConnection`)
 *
 * A failing IMAP leg must never suppress the SMTP leg's result, and vice
 * versa — {@link attemptImapConnection}/{@link attemptSmtpVerification} are
 * both always awaited (never short-circuited with `&&`/early-return), so an
 * operator fixing a typo'd IMAP host still learns the SMTP credentials are
 * ALSO wrong in the same response, rather than in a second round-trip.
 *
 * ## `connect` aborts on the first failure — nothing persisted until both pass
 *
 * Unlike `checkConnection`, `connect` runs the IMAP leg first and THROWS
 * {@link ImapConnectError} immediately on failure, before the SMTP leg is
 * ever attempted — mirroring `./gmail-connect.ts`'s "nothing persisted unless
 * the grant is proven usable" discipline (module doc there, step 4-5). Only
 * once BOTH legs have proven usable does the persist step below run.
 *
 * ## The baseline cursor: `lastUid = uidNext - 1`
 *
 * The IMAP leg's `selectInbox()` call (`../providers/adapters/imap/client.ts`)
 * returns `uidValidity`/`uidNext` in the SAME round trip that proves the
 * credentials work — no second connection is opened to read them. `uidNext`
 * is the UID the server predicts for the NEXT message to arrive, so seeding
 * the baseline at `lastUid = uidNext - 1` means the first scheduled fetch
 * (`./imap-fetch.ts`) starts strictly AFTER whatever is already in the
 * mailbox — mail that arrived before this connect is never fetched, exactly
 * like `./gmail-connect.ts`'s `watch()`-response `historyId` baseline seeds
 * "start fetching new mail from here forward, never a resync of the
 * mailbox's entire history" (`../store/imap-watch-state.ts`'s module doc).
 *
 * ## Persist is ONE transaction — atomicity mirrors `./gmail-connect.ts` step 5
 *
 * `MailboxStore.upsertConnectedMailbox` → `ImapConfigStore.upsertConfig` →
 * `ImapCredentialStore.upsertPassword` → `ImapWatchStateStore.seedBaseline`,
 * all against the SAME `tx` — a mid-persist failure (a constraint violation,
 * a dropped connection) rolls back the WHOLE unit, never a partial connect
 * (e.g. a mailbox row with no baseline cursor, which `./imap-fetch.ts`'s
 * `runImapFetch` would then skip forever as "missing cursor," silently
 * un-ingesting — worse than no mailbox row at all).
 *
 * ## Error messages: bounded, never the password, never a stack trace
 *
 * {@link sanitizeConnectionError} builds every `LegResult.error`/
 * `ImapConnectError.message` from ONLY the caught error's own `.message`
 * (never `.stack`), redacts any LITERAL occurrence of the submitted password
 * (defense in depth against a pathological failure that echoes back raw
 * protocol traffic — imapflow's/nodemailer's own logging is already off by
 * default, per `../providers/adapters/imap/client.ts`'s and `./verify.ts`'s
 * module docs, so this is a second, independent layer, not the only one),
 * and truncates to a bounded length. Every message this module produces is
 * safe to return over the API (`src/api/imap-connect.ts`) or to log.
 */

import type { Db } from '../db/client.js'
import {
  type ImapClient,
  type ImapClientOptions,
  imapImplicitTlsForPort,
} from '../providers/adapters/imap/index.js'
import type { VerifySmtpConnectionOptions } from '../providers/adapters/smtp/index.js'
import type { ImapConfigStore } from '../store/imap-config.js'
import type { ImapCredentialStore } from '../store/imap-credentials.js'
import type { ImapWatchStateStore } from '../store/imap-watch-state.js'
import {
  MailboxProviderConflictError,
  type MailboxRecord,
  type MailboxStore,
} from '../store/mailboxes.js'

/** Longest a sanitized connection-error message is allowed to be (module doc). */
const MAX_ERROR_MESSAGE_LENGTH = 500

/** Input shared by {@link ImapConnectService.checkConnection} and {@link ImapConnectService.connect} — the request body `src/api/imap-connect.ts` validates and passes through verbatim. */
export interface ImapConnectInput {
  /** The mailbox address this connection is for (module doc: operator-supplied, not authoritatively resolved). */
  address: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  /** Shared by both the IMAP and SMTP legs (`../store/imap-config.ts`'s module doc: "the overwhelmingly common case... is one account authenticating both IMAP and SMTP identically"). */
  username: string
  /** The app password (or equivalent). Never logged, never echoed back — see the module doc. */
  password: string
  /** Implicit TLS for BOTH legs. Defaults to `true` when omitted — matches `../providers/adapters/imap/client.ts`'s/`./verify.ts`'s own defaults. */
  secure?: boolean
}

/** The outcome of one connectivity leg (IMAP or SMTP) — `checkConnection` reports one of these per leg, independently. */
export type LegResult = { ok: true } | { ok: false; error: string }

/**
 * The operator-fixable outcomes {@link ImapConnectService.connect} can fail
 * with, so the API layer can map each to a clean, secret-free response.
 * `imap_failed`/`smtp_failed` say which connectivity leg failed;
 * `provider_conflict` says the address is already connected under another
 * transport, and changing an existing inbox's transport is not supported —
 * disconnecting does NOT clear the way, because it leaves `provider` set
 * (`MailboxStore.upsertConnectedMailbox`'s SACRED section, and
 * `MailboxProviderConflictError`'s own doc).
 */
export type ImapConnectErrorCode = 'imap_failed' | 'smtp_failed' | 'provider_conflict'

/**
 * A `connect` failure the API layer (`src/api/imap-connect.ts`) maps to a
 * clean 4xx — distinct from an unexpected failure (a DB blip), which that
 * layer maps to a 500 instead. `message` is always safe to render to the
 * operator (module doc's "Error messages" section).
 */
export class ImapConnectError extends Error {
  readonly code: ImapConnectErrorCode

  constructor(code: ImapConnectErrorCode, message: string) {
    super(message)
    this.name = 'ImapConnectError'
    this.code = code
  }
}

/** Dependencies {@link createImapConnectService} needs. */
export interface ImapConnectServiceDeps {
  /** The database handle whose {@link Db.transaction} wraps the atomic persist (module doc). */
  db: Db
  mailboxStore: MailboxStore
  configStore: ImapConfigStore
  credentialStore: ImapCredentialStore
  watchStateStore: ImapWatchStateStore
  /**
   * Builds an {@link ImapClient} for one connectivity attempt — REQUIRED and
   * injected, never defaulted to the concrete `createImapClient` here, per
   * `src/providers/README.md`'s "engine modules only ever see adapter
   * interfaces" rule (mirrors `./gmail-connect.ts`'s `createWatchClient`).
   * The composition root wires in the real `createImapClient`
   * (`../providers/adapters/imap/index.js`); tests pass a fake.
   */
  createImapClient: (options: ImapClientOptions) => ImapClient
  /**
   * Verifies one SMTP connection — REQUIRED and injected, same rationale as
   * `createImapClient` above. The composition root wires in the real
   * `verifySmtpConnection` (`../providers/adapters/smtp/index.js`); tests
   * pass a fake.
   */
  verifySmtp: (options: VerifySmtpConnectionOptions) => Promise<void>
}

/** The connect/check orchestration service. See the module doc for the full contract. */
export interface ImapConnectService {
  /**
   * Attempt BOTH legs and report each independently — persists nothing.
   * See the module doc's "Both legs run to completion, independently"
   * section.
   */
  checkConnection(input: ImapConnectInput): Promise<{ imap: LegResult; smtp: LegResult }>

  /**
   * Verify both legs (aborting on the first failure) and, only once both
   * pass, persist the connection atomically. Throws {@link ImapConnectError}
   * on either leg's failure — see the module doc's "connect aborts on the
   * first failure" section.
   */
  connect(input: ImapConnectInput): Promise<MailboxRecord>
}

/**
 * True if `value` is a non-empty string — used only to decide whether
 * redacting the password from an error message is meaningful (an empty
 * password has nothing worth splitting on).
 */
function isNonEmpty(value: string): boolean {
  return value.length > 0
}

/**
 * Build a bounded, secret-free message from a caught connectivity failure
 * (module doc's "Error messages" section): `.message` only (never `.stack`),
 * every literal occurrence of `password` redacted, truncated to
 * {@link MAX_ERROR_MESSAGE_LENGTH}.
 */
function sanitizeConnectionError(err: unknown, password: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  let redacted = raw
  if (isNonEmpty(password)) {
    // Redact the password both literally and as base64 — the form SMTP AUTH
    // puts it on the wire, and so the likeliest encoding a diagnostic might
    // echo back. Provider auth errors don't reflect the credential in
    // practice; this is defense in depth on top of the spec-required verbatim
    // error text.
    redacted = redacted.split(password).join('[redacted]')
    const base64 = Buffer.from(password, 'utf8').toString('base64')
    redacted = redacted.split(base64).join('[redacted]')
  }
  return redacted.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : redacted
}

/** One successful IMAP attempt's result — the fields {@link ImapConnectService.connect} needs to seed the baseline cursor. */
type ImapAttemptResult =
  | { ok: true; uidValidity: number; uidNext: number }
  | { ok: false; error: string }

/**
 * Attempt the IMAP leg: connect, `SELECT INBOX`, close — in a `finally`, so
 * the connection is never left open regardless of outcome (mirrors
 * `../providers/adapters/imap/fetch.ts`'s `fetchImapInboundMessages`'s own
 * close-in-finally discipline). Returns `uidValidity`/`uidNext` on success
 * (module doc's baseline-seed rationale) or a sanitized error string on
 * failure — never throws.
 */
async function attemptImapConnection(
  input: ImapConnectInput,
  createImapClient: (options: ImapClientOptions) => ImapClient,
): Promise<ImapAttemptResult> {
  let client: ImapClient | undefined
  try {
    // Construction is INSIDE the try so even a constructor throw becomes a
    // sanitized LegResult, never a raw throw carrying connection options.
    client = createImapClient({
      host: input.imapHost,
      port: input.imapPort,
      // Per-leg: the IMAP port decides, with `input.secure` still able to opt
      // IN to implicit TLS on a non-standard port. See
      // `imapImplicitTlsForPort` for why neither signal alone is sufficient.
      secure: imapImplicitTlsForPort(input.imapPort, input.secure),
      auth: { user: input.username, pass: input.password },
    })
    await client.connect()
    const mailbox = await client.selectInbox()
    return { ok: true, uidValidity: mailbox.uidValidity, uidNext: mailbox.uidNext }
  } catch (err) {
    return { ok: false, error: sanitizeConnectionError(err, input.password) }
  } finally {
    // A close() failure must never override the leg result nor propagate out
    // of this "never throws" attempt — that would break checkConnection's
    // both-legs-independent contract and could surface a raw, unsanitized
    // error to the caller/logger.
    if (client) {
      try {
        await client.close()
      } catch {
        /* swallow — see above */
      }
    }
  }
}

/**
 * Attempt the SMTP leg: a handshake-only verify, no message sent. Never
 * throws — a failure becomes a `LegResult`.
 */
async function attemptSmtpVerification(
  input: ImapConnectInput,
  verifySmtp: (options: VerifySmtpConnectionOptions) => Promise<void>,
): Promise<LegResult> {
  try {
    await verifySmtp({
      host: input.smtpHost,
      port: input.smtpPort,
      secure: input.secure ?? true,
      auth: { user: input.username, pass: input.password },
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: sanitizeConnectionError(err, input.password) }
  }
}

/** Build the IMAP connect/check service. See the module doc for the full contract. */
export function createImapConnectService(deps: ImapConnectServiceDeps): ImapConnectService {
  const {
    db,
    mailboxStore,
    configStore,
    credentialStore,
    watchStateStore,
    createImapClient,
    verifySmtp,
  } = deps

  return {
    async checkConnection(input) {
      // Both legs are ALWAYS attempted, independently — module doc's "Both
      // legs run to completion, independently" section. Never short-circuit
      // with `&&`: a failing IMAP leg must never hide the SMTP leg's result.
      const imapAttempt = await attemptImapConnection(input, createImapClient)
      const smtp = await attemptSmtpVerification(input, verifySmtp)
      const imap: LegResult = imapAttempt.ok
        ? { ok: true }
        : { ok: false, error: imapAttempt.error }
      return { imap, smtp }
    },

    async connect(input) {
      // --- (a) IMAP leg — captures uidValidity/uidNext for the baseline
      // seed below. Aborts immediately on failure (module doc). ---
      const imapAttempt = await attemptImapConnection(input, createImapClient)
      if (!imapAttempt.ok) {
        throw new ImapConnectError(
          'imap_failed',
          `Could not connect to the IMAP server: ${imapAttempt.error}`,
        )
      }

      // --- (b) SMTP leg — only reached once the IMAP leg has already
      // proven usable. Aborts immediately on failure. ---
      const smtpResult = await attemptSmtpVerification(input, verifySmtp)
      if (!smtpResult.ok) {
        throw new ImapConnectError(
          'smtp_failed',
          `Could not verify the SMTP connection: ${smtpResult.error}`,
        )
      }

      // --- (c) Persist, ONLY now that both legs are proven usable — ONE
      // atomic transaction (module doc). ---
      const secure = input.secure ?? true
      return db.transaction(async (tx) => {
        let mailbox: MailboxRecord
        try {
          mailbox = await mailboxStore.upsertConnectedMailbox(
            { address: input.address, provider: 'imap' },
            tx,
          )
        } catch (err) {
          // The address is already connected over another transport (Gmail).
          // Converting it in place would leave that transport's token and
          // cursor behind and double-ingest every message — see the store
          // method's SACRED section. Surface it as a 409, never a 500: the
          // request is well-formed and the credentials may be perfect; it is
          // existing state that refuses. NOT described to the operator as
          // "disconnect it first" — disconnect leaves `provider` set, so that
          // instruction could never terminate.
          if (err instanceof MailboxProviderConflictError) {
            throw new ImapConnectError('provider_conflict', err.message)
          }
          throw err
        }
        await configStore.upsertConfig(
          mailbox.id,
          {
            imapHost: input.imapHost,
            imapPort: input.imapPort,
            smtpHost: input.smtpHost,
            smtpPort: input.smtpPort,
            username: input.username,
            secure,
          },
          tx,
        )
        await credentialStore.upsertPassword(mailbox.id, input.password, tx)
        // Baseline ONLY if this inbox has no cursor yet. A RECONNECT
        // (credential rotation, host/port edit) must PRESERVE the existing
        // cursor — re-baselining would silently skip mail that arrived since
        // the last fetch but is not yet ingested (CHARTER §2 never-drop). For
        // a brand-new inbox, lastUid = uidNext - 1 starts fetching from "now,"
        // never the mailbox's pre-existing history. A UIDVALIDITY change on a
        // reconnect surfaces via the cron's pause path, not a silent reseed.
        await watchStateStore.seedBaselineIfAbsent(
          mailbox.id,
          { uidValidity: imapAttempt.uidValidity, lastUid: imapAttempt.uidNext - 1 },
          tx,
        )
        return mailbox
      })
    },
  }
}
