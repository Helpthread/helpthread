/**
 * `ImapClient` — the thin, injectable port around the real IMAP network
 * calls this adapter needs, plus `createImapClient`, the ONE place
 * **imapflow** (MIT — verified in `node_modules/imapflow/package.json` at
 * adoption, 2026-07-20) is touched. Mirrors the Gmail adapter's
 * `fetchImpl`-injection shape (`../gmail/history.ts`): the pure fetch logic
 * in `./fetch.ts` depends only on this interface, never on `imapflow`
 * directly, so it is unit-testable with a fake client and no real IMAP
 * server or network call — see `README.md`'s "adapters are selected at the
 * composition root" rule.
 *
 * `createImapClient` ITSELF takes an injectable `createFlow` factory (default:
 * a real `ImapFlow`) so that even this file's UID-discovery/bounding logic —
 * the part that talks to imapflow — is exercised by `./client.test.ts` with a
 * fake flow modelling real-world mailbox shapes (sparse UIDs, high base UIDs,
 * gaps, out-of-order FETCH responses). An earlier draft bounded the fetch with
 * a raw UID *range* (`sinceUid+1 : sinceUid+max`); that silently stalled on any
 * mailbox whose next real UID sat above `sinceUid+max` (expunged history, or a
 * UIDVALIDITY reset onto a high-UID epoch) — the fetch returned nothing, the
 * cursor never advanced, and new mail was never ingested (CHARTER.md §2's
 * never-drop invariant). The fix (see `uidFetchRawSince`) discovers the ACTUAL
 * new UIDs via `SEARCH` and bounds by message COUNT, never by UID arithmetic.
 *
 * ## Raw bytes only — `BODY.PEEK[]`, zero transformation
 *
 * specs/mail/mailbox-connection.md §5 requires `FETCH BODY.PEEK[]` — full
 * RFC822, `.PEEK` so `\Seen` is never set by the fetch itself. imapflow's
 * `fetch`/`fetchOne` compile a `{ source: true }` query item to exactly
 * `BODY.PEEK[]` (verified directly in
 * `node_modules/imapflow/lib/commands/fetch.js`, the "Helper to build
 * BODY.PEEK[section]" comment) — there is no separate "give me PEEK"
 * flag to set; requesting `source` IS the PEEK request. The returned
 * `Buffer` is handed to the caller with NO decoding, no line-ending
 * normalization, and no MIME parsing — `Buffer` already satisfies the
 * `Uint8Array` interface, so no copy is made at all; see
 * {@link ImapRawMessage.raw}'s doc.
 *
 * ## Why `uidValidity` is `number` here, not imapflow's `bigint`
 *
 * imapflow types `MailboxObject.uidValidity` as `bigint` (IMAP's
 * UIDVALIDITY is defined as an unsigned 32-bit value, RFC 3501 §2.3.1.1 —
 * imapflow's own type is simply conservative). A 32-bit unsigned value is
 * always exactly representable as a JS `number` (`Number.MAX_SAFE_INTEGER`
 * is far larger), so `createImapClient` narrows it with `Number(...)` once,
 * here, keeping the `ImapClient` port — and every cursor/store type built on
 * it — plain `number` throughout the rest of this adapter and (later)
 * Stage 2's storage layer. Flagged for review as a judgment call: this
 * assumes no real server ever sends a UIDVALIDITY exceeding 2^53, which
 * RFC 3501's 32-bit definition guarantees.
 */

import { ImapFlow } from 'imapflow'

/** One connected mailbox's cursor-relevant state, as `SELECT`/`EXAMINE` reports it (RFC 3501 §7.2.1, §7.2.3). */
export interface ImapMailboxInfo {
  /** `UIDVALIDITY` — changes if the server ever renumbers UIDs for this folder; see `./fetch.ts`'s module doc for what a change means for the stored cursor. */
  uidValidity: number
  /** `UIDNEXT` — the UID the server predicts for the next message to arrive. Not currently consumed by `./fetch.ts`'s logic, but surfaced because it is a free part of the same `SELECT` response and a natural Stage 2 diagnostic (e.g. detecting a mailbox that has gone silent). */
  uidNext: number
}

/** One message fetched by UID: its raw RFC822 bytes and the server's own receipt timestamp. */
export interface ImapRawMessage {
  uid: number
  /**
   * The raw RFC822 bytes, completely untouched — no decoding, no
   * line-ending normalization, no MIME parsing (see the module doc). This is
   * imapflow's own `Buffer`, which structurally satisfies `Uint8Array`; it
   * is passed through as-is, not copied, so no transformation of any kind
   * happens between imapflow's socket read and this field.
   */
  raw: Uint8Array
  /**
   * `INTERNALDATE` — the time the SERVER recorded receiving this message
   * (RFC 3501 §2.3.3), fetched alongside `source` in the same `FETCH`
   * command at no extra round trip. This is a more faithful value for
   * `RawInboundMessage.receivedAt` ("when the provider recorded/delivered
   * the message" — `src/providers/inbound-email.ts`) than the time this
   * adapter's own `fetch()` call happened to run, which is why `./fetch.ts`
   * uses it instead of `new Date()`.
   */
  internalDate: Date
}

/**
 * The port `./fetch.ts`'s pure logic depends on. One connection per call —
 * `connect()` opens it, `close()` tears it down; there is no session reuse
 * across invocations (specs/mail/mailbox-connection.md §5: "no IDLE, no
 * held connections, no resident process").
 */
export interface ImapClient {
  /** Open the TCP/TLS connection and authenticate. */
  connect(): Promise<void>

  /** `SELECT INBOX` (read-write — flags are never mutated by this adapter, but `.PEEK` on the fetch itself is what actually protects `\Seen`, not a read-only `SELECT`). */
  selectInbox(): Promise<ImapMailboxInfo>

  /**
   * Return the raw bytes of at most `max` messages whose UID is strictly
   * greater than `sinceUid`, oldest-UID-first.
   *
   * The bound is by message COUNT, not by UID arithmetic: the implementation
   * asks the server which UIDs above `sinceUid` actually exist (`SEARCH`),
   * takes the lowest `max` of them, and fetches exactly that set. This is the
   * only correct way to bound an IMAP incremental fetch, because UIDs are not
   * dense — a mailbox's live messages can sit at any UID (RFC 3501 §2.3.1.1),
   * so a `sinceUid+1 : sinceUid+max` range can span zero real messages while
   * mail waits just above it. See the module doc for the stall that shape
   * caused.
   */
  uidFetchRawSince(sinceUid: number, max: number): Promise<ImapRawMessage[]>

  /** Close the connection. Callers (see `./fetch.ts`) MUST call this in a `finally` — never left open, never IDLE. */
  close(): Promise<void>
}

/** Credentials + connection info for {@link createImapClient}. */
export interface ImapClientOptions {
  host: string
  port: number
  /** Implicit TLS (as opposed to STARTTLS, which imapflow negotiates automatically when this is `false` and the server advertises it). Defaults to `true` — every provider in specs/mail/mailbox-connection.md §3 (Gmail, Fastmail, Zoho/Yahoo/iCloud, cPanel) offers implicit-TLS IMAP on port 993. */
  secure?: boolean
  auth: {
    user: string
    /** An app password (specs/mail/mailbox-connection.md §5's "Credentials" section) or equivalent mailbox password. Never logged — imapflow's own logger is hardcoded off below precisely because its default logger would otherwise echo AUTH traffic. */
    pass: string
  }
  /**
   * Milliseconds applied to imapflow's `connectionTimeout`, `greetingTimeout`,
   * and `socketTimeout` alike — one knob bounding connect, greeting, and
   * inactivity. Defaults to 30 000, matching the Gmail adapter's
   * `timeoutMs` default (`../gmail/sender.ts`).
   *
   * This is NOT specs/mail/mailbox-connection.md §5's full
   * remaining-invocation-budget scheme ("every network operation... carries
   * its own timeout derived from the remaining invocation budget, and the
   * worker stops starting new work once too little budget remains") — that
   * is cron-invocation-level orchestration belonging to Stage 2/3's wiring,
   * not this thin per-connection client. Flagged for review: this option
   * only gives Stage 2 a single safety-net bound to build that scheme on
   * top of, not the scheme itself.
   */
  timeoutMs?: number
}

/**
 * The minimal `imapflow` surface `createImapClient` uses — injectable so the
 * UID-discovery/bounding logic in this file is testable with a fake, no real
 * IMAP server or network. A real `ImapFlow` satisfies this structurally.
 */
export interface ImapFlowLike {
  connect(): Promise<void>
  mailboxOpen(path: string): Promise<{ uidValidity: bigint | number; uidNext: number }>
  /** `UID SEARCH` when `options.uid` is true — resolves to the matching UIDs (ascending), or `false`. */
  search(query: { uid: string }, options: { uid: boolean }): Promise<number[] | false>
  /** `UID FETCH` of an explicit UID set when `options.uid` is true. */
  fetch(
    range: number[],
    query: { source: boolean; internalDate: boolean },
    options: { uid: boolean },
  ): AsyncIterable<{ uid: number; source?: Buffer; internalDate?: Date | string }>
  logout(): Promise<void>
  close(): void
}

/** Matches the Gmail adapter's `timeoutMs` default (`../gmail/sender.ts`, `../gmail/history.ts`). */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * The default `ImapFlowLike` factory — a real imapflow connection built from
 * `options`. This is the ONLY place `imapflow` is instantiated in this
 * codebase. Tests pass their own factory to {@link createImapClient} and this
 * never runs.
 */
function defaultCreateFlow(options: ImapClientOptions): ImapFlowLike {
  const { host, port, secure = true, auth, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  return new ImapFlow({
    host,
    port,
    secure,
    auth,
    // Never held open across invocations (module doc) — no reason for
    // imapflow to auto-start IDLE the moment authentication completes.
    disableAutoIdle: true,
    // imapflow's default logger writes connection/protocol detail (including
    // AUTH exchanges) to stdout via pino. The app password is a long-lived,
    // full-mailbox-access secret (specs/mail/mailbox-connection.md §5's
    // "Credentials" section) — hardcoded off, not exposed as an option, so a
    // caller cannot accidentally turn on a logger that leaks it. Mirrors
    // every other adapter in this codebase never logging a credential
    // (`../gmail/sender.ts`, `../gmail/history.ts`).
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  }) as unknown as ImapFlowLike
}

/**
 * Build the real, imapflow-backed {@link ImapClient}. See the module doc for
 * the PEEK/zero-transformation, count-based-bounding, and UIDVALIDITY-narrowing
 * contracts.
 *
 * @param createFlow Builds the underlying imapflow connection — defaults to a
 *   real `ImapFlow` ({@link defaultCreateFlow}); tests inject a fake so this
 *   file's own UID logic runs without a network.
 */
export function createImapClient(
  options: ImapClientOptions,
  createFlow: (options: ImapClientOptions) => ImapFlowLike = defaultCreateFlow,
): ImapClient {
  let flow: ImapFlowLike | undefined

  function requireFlow(): ImapFlowLike {
    if (!flow) {
      throw new Error('createImapClient: connect() must be called before any other method')
    }
    return flow
  }

  return {
    async connect() {
      flow = createFlow(options)
      await flow.connect()
    },

    async selectInbox() {
      const mailbox = await requireFlow().mailboxOpen('INBOX')
      return {
        // See the module doc for why narrowing bigint -> number is safe.
        uidValidity: Number(mailbox.uidValidity),
        uidNext: mailbox.uidNext,
      }
    },

    async uidFetchRawSince(sinceUid, max) {
      const imap = requireFlow()

      // Discover which UIDs above `sinceUid` actually exist, then bound by
      // COUNT — never by UID arithmetic (module doc). `${sinceUid + 1}:*` is
      // the IMAP idiom for "everything from here up"; `*` is the highest UID.
      // A subtlety: when `sinceUid + 1` exceeds the highest UID, IMAP ranges
      // are order-independent, so `N:*` still matches the single highest
      // message — hence the explicit `> sinceUid` filter below, which drops
      // that already-seen message so it is never re-fetched.
      const found = await imap.search({ uid: `${sinceUid + 1}:*` }, { uid: true })
      const uids = (Array.isArray(found) ? found : [])
        .filter((uid) => uid > sinceUid)
        .sort((a, b) => a - b)
        .slice(0, max)

      if (uids.length === 0) return []

      const results: ImapRawMessage[] = []
      // `{ uid: true }` MUST be the THIRD argument (`options`), not a field
      // inside the second (`query`) — verified directly in
      // `node_modules/imapflow/lib/imap-flow.js`'s `fetch()`: it is
      // `options.uid` that gets forwarded to the low-level FETCH command,
      // which is what makes this a `UID FETCH` (interpreting `range` as UIDs)
      // rather than a plain sequence-number `FETCH`. `range` is the explicit
      // UID array resolved above.
      for await (const message of imap.fetch(
        uids,
        { source: true, internalDate: true },
        { uid: true },
      )) {
        if (!message.source) {
          // Requested `source: true` but the server returned none for this
          // UID — should not happen per imapflow's contract, but silently
          // dropping a message here would violate the never-drop invariant
          // (CHARTER.md §2), so this fails loudly instead.
          throw new Error(
            `createImapClient: FETCH for UID ${message.uid} returned no message source (BODY.PEEK[] response was empty)`,
          )
        }
        if (!message.internalDate || typeof message.internalDate === 'string') {
          // imapflow types `internalDate` as `Date | string`, but requesting
          // `internalDate: true` (as opposed to reading a raw, unparsed
          // header) always yields a parsed `Date` in practice; a `string`
          // here would mean imapflow failed to parse the server's response,
          // which should fail loudly rather than silently guess a receive
          // time.
          throw new Error(
            `createImapClient: FETCH for UID ${message.uid} did not return a parsed INTERNALDATE`,
          )
        }
        results.push({
          uid: message.uid,
          // Buffer already satisfies Uint8Array — no copy, no transformation
          // (module doc, `ImapRawMessage.raw`'s doc).
          raw: message.source,
          internalDate: message.internalDate,
        })
      }

      // imapflow's FETCH does not guarantee UID order in its response stream;
      // the ingestion contract is oldest-UID-first, so sort before returning.
      results.sort((a, b) => a.uid - b.uid)
      return results
    },

    // NEVER throws. Callers use this in a `finally` (`./fetch.ts`) and in a
    // catch-all cleanup (`../../../mail/imap-connect.ts`), so a throw here
    // would replace a real outcome — including a SUCCESSFUL fetch — with a
    // cleanup error, discarding a batch that was already ingested. imapflow's
    // own `close()` can throw synchronously on an already-broken connection,
    // which the previous revision left unguarded (review, 2026-07-25).
    async close() {
      if (!flow) return
      try {
        // Graceful LOGOUT first; only fall back to a hard socket close if
        // the server doesn't cooperate (e.g. already-broken connection).
        await flow.logout()
      } catch {
        try {
          flow.close()
        } catch {
          // Both paths failed: the connection is already gone in some way this
          // library reports by throwing. There is nothing further to release
          // and nothing a caller could do with the error.
        }
      }
    },
  }
}
