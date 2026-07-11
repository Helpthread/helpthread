/**
 * Raw RFC 5322 message construction for the Gmail adapter
 * (`users.messages.send` takes a base64url-encoded raw MIME message, not a
 * structured JSON body — see `sender.ts`).
 *
 * ## Why this file exists separately from `sender.ts`
 *
 * `specs/mail/sending.md` §4 requires every real `EmailSender` adapter to
 * ship a WIRE-LEVEL contract test proving the engine-minted `Message-ID`
 * (`src/mail/reply-token.ts`) survives unaltered. Isolating "build the raw
 * MIME string" from "call the Gmail HTTP API" lets `mime.test.ts` assert
 * against the exact bytes that leave the process, independent of any network
 * mocking — the strongest form of that contract test the spec calls for.
 *
 * ## mimetext, and a `node`-entrypoint gotcha worth flagging
 *
 * We use `mimetext` (MIT, purpose-built for Gmail-API/SES-style raw-MIME
 * senders) to assemble the message. Two API details mattered enough to call
 * out:
 *
 * 1. **Setting `Message-ID` verbatim.** `MIMEMessage`'s header table
 *    pre-declares a `Message-ID` field with an auto-`generator` (a random
 *    id) that only fires if the field's `value` is still unset when the
 *    message is dumped. Calling `msg.setHeader('Message-ID', value)` goes
 *    through `MIMEMessageHeader#set`, which looks up the field
 *    case-insensitively, finds the pre-declared one, and overwrites its
 *    `value` directly — bypassing the generator entirely. Crucially, the
 *    `Message-ID` field has no custom `dump` transform (unlike `Subject`,
 *    which always RFC-2047-encodes), so a string value is emitted literally:
 *    `value` goes in, `value` comes out, byte-for-byte. That is exactly the
 *    verbatim contract `OutboundEmail.messageId` requires — see
 *    `../email-sender.ts`'s module doc. Verified directly in `mime.test.ts`.
 *    (`In-Reply-To`/`References` are not pre-declared fields at all, so
 *    `setHeader` falls through to `setCustom`, which dumps a string value
 *    the same way: literally, when present, and simply absent from the
 *    output when we never call `setHeader` for them.)
 *
 * 2. **`import 'mimetext'` does NOT reliably give CRLF.** RFC 5322 requires
 *    CRLF line endings, and mimetext's own docs describe CRLF output — but
 *    its default Node entrypoint (`mimetext.node.es.js`, what plain
 *    `import { createMimeMessage } from 'mimetext'` resolves to under
 *    Node/NodeNext ESM) sets `eol` from `node:os`'s `EOL` constant, which is
 *    `'\n'` on Linux/macOS and only `'\r\n'` on Windows. Vercel's Node
 *    functions run on Linux, so importing the bare `mimetext` package here
 *    would silently emit LF-only messages in production despite passing
 *    tests on a Windows dev machine (or vice versa) — a real, environment-
 *    dependent correctness gap, not a hypothetical one (confirmed by reading
 *    `node_modules/mimetext/dist/mimetext.node.es.js`). mimetext's
 *    `./browser` entrypoint hardcodes `eol: '\r\n'` unconditionally, so we
 *    import from `mimetext/browser` instead — its types and API surface are
 *    identical to the default entrypoint (same `MIMEMessage` class), it has
 *    no DOM/window dependency (its base64 helpers use `TextEncoder`/manual
 *    base64, not `Buffer`, so it runs fine under Node), and it gives us
 *    deterministic CRLF regardless of the host OS. This is a deliberate
 *    workaround for what looks like an upstream oversight (the "node"
 *    entrypoint choosing an OS-dependent EOL is backwards — Node programs
 *    are exactly the ones that most often run headless on Linux); if
 *    mimetext fixes this upstream, `mimetext/browser` still works fine, so
 *    there is nothing to revert.
 *
 * 3. **Header-injection & line-length guards.** mimetext writes address and
 *    custom-header values, and body `data`, LITERALLY — it does not sanitize
 *    CRLF, does not fold long headers, and does not encode bodies to match the
 *    declared CTE. So this module adds three guards around it: (a) reject any
 *    control/newline char in every externally-influenced header atom
 *    (`assertHeaderSafe`), so a stored inbound Message-ID or a customer
 *    address cannot inject a second header line (`\r\nBcc: …`); (b)
 *    base64-encode bodies wrapped at 76 chars (`base64Body`), so a long HTML
 *    line or URL cannot exceed RFC 5322's 998-octet line limit; (c) fold a
 *    long `References` chain at WSP between msg-ids (`foldHeaderAtoms`), same
 *    limit. mimetext preserves the engine-inserted CRLF+WSP folds and the
 *    pre-encoded body verbatim — both verified in `mime.test.ts`.
 */

import { createMimeMessage } from 'mimetext/browser'
import type { OutboundEmail } from '../../email-sender.js'

/**
 * Build the raw RFC 5322 message for `email`, ready to base64url-encode and
 * hand to `users.messages.send` (see `sender.ts`).
 *
 * Sets, verbatim: `From`, `To`, `Cc` (if any), `Subject`, `Message-ID`
 * (`email.messageId` — see the module doc for why this survives untouched),
 * `In-Reply-To` and `References` (space-joined) when supplied. Adds a
 * `text/plain` part from `email.text` and/or a `text/html` part from
 * `email.html`; mimetext automatically wraps both into `multipart/
 * alternative` when both are present. At least one body is required — see
 * `../email-sender.ts`'s `OutboundEmail.text`/`.html` doc — so this throws
 * rather than silently emitting a bodyless message.
 *
 * @throws {Error} if neither `email.text` nor `email.html` is provided.
 */
export function buildRawMessage(email: OutboundEmail): string {
  if (!email.text && !email.html) {
    throw new Error(
      'buildRawMessage: OutboundEmail must include at least one of text/html — refusing to build a bodyless message',
    )
  }

  // HEADER-INJECTION GUARD (see module doc §3). mimetext writes address and
  // custom-header values LITERALLY, so a value containing a CR/LF — reachable
  // via a stored inbound Message-ID or a customer address — would emit a
  // second header line (`\r\nBcc: attacker@…`). Reject any control/newline in
  // every externally-influenced header atom BEFORE it reaches mimetext.
  // (`subject` is exempt: mimetext RFC-2047-encodes it, neutralizing CRLF.)
  assertHeaderSafe('from', email.from)
  for (const to of email.to) assertHeaderSafe('to', to)
  for (const cc of email.cc ?? []) assertHeaderSafe('cc', cc)
  assertHeaderSafe('messageId', email.messageId)
  if (email.inReplyTo) assertHeaderSafe('inReplyTo', email.inReplyTo)
  for (const ref of email.references ?? []) assertHeaderSafe('references[]', ref)

  const msg = createMimeMessage()

  msg.setSender(email.from)
  msg.setTo(email.to)
  if (email.cc && email.cc.length > 0) {
    msg.setCc(email.cc)
  }
  msg.setSubject(email.subject)

  // VERBATIM — see the module doc's point (1). This MUST run after
  // createMimeMessage() (which pre-declares the field) and is what prevents
  // mimetext's random-id generator from ever firing.
  msg.setHeader('Message-ID', email.messageId)

  if (email.inReplyTo) {
    msg.setHeader('In-Reply-To', email.inReplyTo)
  }
  if (email.references && email.references.length > 0) {
    // FOLDED (module doc §3): a long References chain (dozens of msg-ids) on
    // one line would exceed RFC 5322's 998-octet limit. mimetext does not
    // fold custom headers, but it DOES preserve CRLF+WSP folds we insert, so
    // fold at WSP between ids ourselves. Unfolding recovers `join(' ')`.
    msg.setHeader('References', foldHeaderAtoms(email.references))
  }

  // BASE64 bodies (module doc §3): mimetext writes body `data` VERBATIM after
  // the part headers — it does not transform to match the declared CTE. Raw
  // UTF-8 (`8bit`) would leave a long HTML line or URL over the 998-octet line
  // limit. So we base64-encode (line-safe, wrapped at 76) ourselves and hand
  // mimetext the pre-encoded string with a matching `base64` CTE.
  if (email.text) {
    msg.addMessage({ contentType: 'text/plain', data: base64Body(email.text), encoding: 'base64' })
  }
  if (email.html) {
    msg.addMessage({ contentType: 'text/html', data: base64Body(email.html), encoding: 'base64' })
  }

  return msg.asRaw()
}

/** Any C0 control char (incl. CR/LF/TAB) or DEL — the header-injection vector. */
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f]/

/**
 * Throw if `value` carries a control or newline character — the header-
 * injection guard (module doc §3). The engine's OWN folding (CRLF+WSP inserted
 * by {@link foldHeaderAtoms}) is applied AFTER this check, on already-validated
 * atoms, so a legitimate fold is never rejected and caller CRLF is never let
 * through.
 */
function assertHeaderSafe(label: string, value: string): void {
  if (CONTROL_OR_NEWLINE.test(value)) {
    throw new Error(
      `buildRawMessage: ${label} contains a control or newline character — refusing to build (header-injection guard)`,
    )
  }
}

/** Base64-encode a UTF-8 body and wrap at 76 chars per CRLF-separated line (RFC 2045 line-length safe). */
function base64Body(data: string): string {
  const b64 = Buffer.from(data, 'utf8').toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76))
  }
  return lines.join('\r\n')
}

/**
 * Fold a list of msg-id atoms into a `References`/`In-Reply-To`-style header
 * value, packing atoms onto continuation lines that stay well under RFC 5322's
 * 998-octet limit (target ~78). Continuation lines begin with a single space
 * (folding WSP), so RFC unfolding recovers exactly `atoms.join(' ')`. Each
 * atom is assumed already validated by {@link assertHeaderSafe}.
 */
function foldHeaderAtoms(atoms: string[]): string {
  const SOFT_LIMIT = 78
  let value = ''
  // First physical line already carries `References: ` (~12 chars); the rest
  // is generous headroom under the 998 hard limit even if the estimate drifts.
  let lineLen = 'References: '.length
  for (const atom of atoms) {
    if (value === '') {
      value = atom
      lineLen += atom.length
    } else if (lineLen + 1 + atom.length > SOFT_LIMIT) {
      value += `\r\n ${atom}` // fold: CRLF + WSP starts a continuation line
      lineLen = 1 + atom.length
    } else {
      value += ` ${atom}`
      lineLen += 1 + atom.length
    }
  }
  return value
}
