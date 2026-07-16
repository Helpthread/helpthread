/**
 * Gmail OAuth disconnect (HT-47; specs/mail/gmail-connect.md's disconnect
 * section) — the admin action that is the inverse of HT-40's connect flow
 * (`./gmail-connect.ts`): revoke the stored OAuth grant at Google, unarm the
 * mailbox's Gmail push watch, and deactivate the mailbox locally.
 *
 * ## The three steps, and why THIS order (the best-effort ordering decision)
 *
 * 1. **Stop the watch** ({@link GmailWatchClient.stop}, `users.stop` —
 *    `../providers/adapters/gmail/watch.ts`) using a LIVE access token
 *    ({@link GmailOAuthTokenService.getAccessToken}, HT-38). This runs
 *    FIRST, before revoke, because revoking the refresh token (step 2) can
 *    invalidate every access token issued under that grant immediately —
 *    calling `stop()` AFTER that would likely fail against a token Google
 *    has already killed. Best-effort: a failure is caught and recorded
 *    (`watchStopped: false`) rather than aborting the disconnect.
 * 2. **Revoke the refresh token** ({@link revokeToken}, Google's
 *    `https://oauth2.googleapis.com/revoke`, RFC 7009) — the grant itself,
 *    so Google stops trusting Helpthread for this mailbox even if local
 *    state were somehow restored later. Also best-effort
 *    (`revoked: false` on failure).
 * 3. **Deactivate locally, UNCONDITIONALLY** — mark the mailbox
 *    `disconnected` (migration 017) and delete its `mailbox_oauth_tokens`
 *    and `gmail_watch_state` rows, in ONE transaction, regardless of
 *    whether steps 1/2 succeeded. The status flip runs FIRST inside that
 *    transaction — its row lock is what fences out a concurrent token
 *    refresh (see the step-3 comment in `disconnect()` and
 *    `MailboxTokenStore.upsertTokensUnlessDisconnected`'s doc).
 *
 * Steps 1 and 2 being best-effort is a deliberate asymmetry with the connect
 * flow (gmail-connect.md §4, which aborts on the FIRST failure and persists
 * nothing): HT-47's own framing is "a revoked-at-Google-but-active-locally
 * mailbox is worse than the reverse." An operator who disconnects a mailbox
 * wants it OFF locally no matter what — a Google-side hiccup (a network
 * blip on revoke, a watch that already lapsed) must never leave Helpthread
 * still ingesting/sending as that mailbox. Local state always wins; the
 * returned {@link DisconnectResult}'s `revoked`/`watchStopped` flags tell
 * the caller which remote step(s), if any, need a manual follow-up at
 * Google's end.
 *
 * ## Idempotency (ticket §5)
 *
 * Disconnecting an already-`disconnected` mailbox is a no-op success:
 * `alreadyDisconnected: true`, no remote calls attempted (its token/
 * watch-state rows are normally already gone — there's nothing left to
 * revoke or stop). It STILL re-runs the step-3 transactional deletes,
 * though — as belt-and-braces cleanup, not a required recovery path: the
 * token-resurrection race a concurrent refresh (`./gmail-oauth.ts`'s
 * `refresh()`) used to be able to win is closed at the SQL layer
 * (`MailboxTokenStore.upsertTokensUnlessDisconnected`'s guarded write plus
 * this module's flip-first transaction ordering), so re-running the
 * (idempotent, cheap) deletes here just means an operator retry also
 * sweeps anything an unforeseen writer might strand. An unknown address
 * throws {@link GmailDisconnectError} `not_found`, which the API layer
 * (`src/api/gmail-disconnect.ts`) maps to `404`.
 *
 * ## Never log or leak a token
 *
 * Same discipline as `./gmail-connect.ts`/`./gmail-oauth.ts`: the refresh
 * token is read once (via `tokenStore.getTokens`) to hand to
 * {@link revokeToken} and never appears in a thrown error or a log line —
 * failures are logged with the mailbox id and the caught error only, and
 * {@link revokeToken} keeps that caught error token-free structurally: a
 * non-2xx revoke response's body is never read into the thrown error at
 * all, since an error body can echo the submitted token back (see the
 * comment on its throw).
 */

import type { Db } from '../db/client.js'
import type { GmailWatchClient } from '../providers/adapters/gmail/index.js'
import type { GmailWatchStateStore } from '../store/gmail-watch-state.js'
import type { MailboxTokenStore } from '../store/mailbox-tokens.js'
import type { MailboxStore } from '../store/mailboxes.js'
import type { GmailOAuthTokenService } from './gmail-oauth.js'

/** Google's OAuth2 token-revocation endpoint (RFC 7009 §2.1). Fixed — not configurable, since Google has exactly one. */
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

/** Default bound on the revoke HTTP call, matching `./gmail-oauth.ts`'s own default. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Options for {@link revokeToken}. */
export interface RevokeTokenOptions {
  /** The refresh token to revoke, plaintext. Never logged or included in a thrown error. */
  token: string
  /** Injectable `fetch`, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Milliseconds before the revoke HTTP call is abandoned. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Revoke an OAuth refresh token at Google's revocation endpoint (RFC 7009
 * §2.1: `POST application/x-www-form-urlencoded`, `token=<value>`). Per RFC
 * 7009 §2.2 and Google's own documentation, Google answers `200` for BOTH
 * "the token was revoked" and "the client submitted an already-invalid
 * token" — so a `200` here proves Google no longer honors this value, not
 * that the grant was ever live. Throws a plain `Error` on any other non-2xx,
 * built from the HTTP status line ONLY — the response body is never read
 * into it (see the comment on the throw for why that is structural, not
 * just a length bound).
 */
export async function revokeToken(options: RevokeTokenOptions): Promise<void> {
  const { token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options

  const response = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
    // Bounds the whole exchange, same rationale as gmail-oauth.ts's
    // identical use of AbortSignal.timeout.
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    // The response body is deliberately NEVER read into this error — not
    // even a bounded snippet (a review fix; a length cap bounds, it does
    // not redact). A revocation error body can echo the submitted request
    // back — token included — and anything folded into this message ends up
    // in the caller's failure log (`disconnect`'s `console.error`),
    // breaking the module doc's "never log or leak a token" guarantee. The
    // status line alone is the diagnostic; it never carries request
    // material.
    throw new Error(`revokeToken: revoke failed with ${response.status} ${response.statusText}`)
  }
}

/** The one operator-fixable outcome {@link GmailDisconnectService.disconnect} can fail with. */
export type GmailDisconnectErrorCode = 'not_found'

/**
 * A `disconnect` failure the API layer (`src/api/gmail-disconnect.ts`)
 * renders as a `404` — distinct from an unexpected failure (a DB blip),
 * which that layer maps to a `500` instead. `message` is always safe to
 * render to the operator.
 */
export class GmailDisconnectError extends Error {
  readonly code: GmailDisconnectErrorCode

  constructor(code: GmailDisconnectErrorCode, message: string) {
    super(message)
    this.name = 'GmailDisconnectError'
    this.code = code
  }
}

/** Result of a successful {@link GmailDisconnectService.disconnect} call. */
export interface DisconnectResult {
  mailboxId: string
  address: string
  /**
   * `true` when this mailbox was ALREADY `disconnected` before this call —
   * a no-op (module doc's idempotency section). `revoked`/`watchStopped` are
   * always `false` in that case, since nothing was attempted.
   */
  alreadyDisconnected: boolean
  /** Best-effort outcome of revoking the OAuth grant at Google (module doc). `false` on a caught failure, or when there were no tokens to revoke. */
  revoked: boolean
  /** Best-effort outcome of stopping the Gmail push watch (module doc). `false` on a caught failure, or when there were no tokens to authenticate the call with. */
  watchStopped: boolean
}

/** Dependencies {@link createGmailDisconnectService} needs. */
export interface GmailDisconnectServiceDeps {
  /** The database handle whose {@link Db.transaction} wraps the step-3 local deactivation (token delete + watch-state delete + status flip) into one atomic unit — see the module doc. */
  db: Db
  mailboxStore: MailboxStore
  tokenStore: MailboxTokenStore
  watchStateStore: GmailWatchStateStore
  /** Reads/refreshes a live access token for a mailbox (HT-38) — used to authenticate the `users.stop` call. */
  tokenService: GmailOAuthTokenService
  /**
   * Builds a {@link GmailWatchClient} bound to a per-call `getAccessToken` —
   * REQUIRED and injected, matching `./gmail-connect.ts`'s identical
   * `createWatchClient` seam (`src/providers/README.md`'s "engine modules
   * only ever see adapter interfaces" rule). The composition root wires in
   * the real `createGmailWatchClient`
   * (`../providers/adapters/gmail/watch.ts`); tests pass a fake.
   */
  createWatchClient: (getAccessToken: () => Promise<string>) => GmailWatchClient
  /** Injectable `fetch` for the revoke call, for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Milliseconds before the revoke HTTP call is abandoned. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** The disconnect orchestration service. See the module doc for the full flow. */
export interface GmailDisconnectService {
  /**
   * Disconnect the mailbox connected at `address`. Throws
   * {@link GmailDisconnectError} `not_found` when no mailbox has this
   * address. See the module doc for the best-effort revoke/stop ordering
   * and the idempotent no-op on an already-disconnected mailbox.
   */
  disconnect(address: string): Promise<DisconnectResult>
}

/** Build the Gmail disconnect service. See the module doc for the full contract. */
export function createGmailDisconnectService(
  deps: GmailDisconnectServiceDeps,
): GmailDisconnectService {
  const {
    db,
    mailboxStore,
    tokenStore,
    watchStateStore,
    tokenService,
    createWatchClient,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = deps

  return {
    async disconnect(address) {
      const mailbox = await mailboxStore.getMailboxByAddress(address)
      if (mailbox === null) {
        throw new GmailDisconnectError('not_found', `No mailbox is connected at ${address}.`)
      }

      // --- Idempotent no-op, BUT still runs the step-3 deletes (module doc's
      // "Idempotency" section): an already-disconnected mailbox's tokens/
      // watch-state rows are normally already gone, so there's nothing to
      // revoke or stop and this transaction is usually a true no-op — EXCEPT
      // when a token row was RESURRECTED after the fact (a concurrent
      // refresh — `./gmail-oauth.ts`'s `refresh()` — that was already
      // in-flight when the FIRST disconnect committed can still upsert a
      // fresh token row moments later). Re-running the deletes here converts
      // that resurrection from a permanent strand into something a retried
      // operator disconnect cleans up. No remote calls are attempted either
      // way: a resurrected token belongs to a grant this mailbox's FIRST
      // disconnect already tried to revoke, and re-revoking on every retry
      // would just be repeat work for no added safety. ---
      if (mailbox.status === 'disconnected') {
        // Same flip-first statement order as the main step-3 transaction
        // below (and for the same lock-fence reason — see its comment);
        // markDisconnected on an already-`disconnected` row is an idempotent
        // no-op write that still takes the row lock.
        await db.transaction(async (tx) => {
          await mailboxStore.markDisconnected(mailbox.id, tx)
          await tokenStore.deleteTokens(mailbox.id, tx)
          await watchStateStore.deleteState(mailbox.id, tx)
        })
        return {
          mailboxId: mailbox.id,
          address: mailbox.address,
          alreadyDisconnected: true,
          revoked: false,
          watchStopped: false,
        }
      }

      const tokens = await tokenStore.getTokens(mailbox.id)

      // --- Step 1: stop the watch, BEFORE revoke (module doc: revoke can
      // invalidate the access token stop() needs). Best-effort. ---
      let watchStopped = false
      if (tokens !== null) {
        try {
          const watchClient = createWatchClient(() => tokenService.getAccessToken(mailbox.id))
          await watchClient.stop()
          watchStopped = true
        } catch (err) {
          console.error(`[gmail-disconnect] users.stop failed for mailbox ${mailbox.id}`, err)
        }
      }

      // --- Step 2: revoke the refresh token. Best-effort. ---
      let revoked = false
      if (tokens !== null) {
        try {
          await revokeToken({ token: tokens.refreshToken, fetchImpl, timeoutMs })
          revoked = true
        } catch (err) {
          console.error(`[gmail-disconnect] token revoke failed for mailbox ${mailbox.id}`, err)
        }
      }

      // --- Step 3: deactivate locally, UNCONDITIONALLY (module doc: local
      // state always wins) — one transaction. The status flip runs FIRST,
      // not last: its UPDATE takes the `mailboxes` row lock for the rest of
      // the transaction, which is this side's half of the anti-resurrection
      // fence (`../store/mailbox-tokens.ts`'s
      // `upsertTokensUnlessDisconnected` locks the SAME row before writing).
      // A concurrent refresh's guarded token write therefore either commits
      // before this lock is taken — leaving a row the deleteTokens below
      // sweeps — or blocks on it and re-evaluates its status predicate to
      // `disconnected` after this commits, writing nothing. With the flip
      // LAST (the original ordering), a refresh could take the row lock
      // between this transaction's deletes and its flip and persist a row
      // the deletes had already run past. ---
      await db.transaction(async (tx) => {
        await mailboxStore.markDisconnected(mailbox.id, tx)
        await tokenStore.deleteTokens(mailbox.id, tx)
        await watchStateStore.deleteState(mailbox.id, tx)
      })

      return {
        mailboxId: mailbox.id,
        address: mailbox.address,
        alreadyDisconnected: false,
        revoked,
        watchStopped,
      }
    },
  }
}
