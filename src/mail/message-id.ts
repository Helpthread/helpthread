/**
 * RFC 5322-aware extraction of `msg-id` tokens (`<...>`) from a header value.
 *
 * `In-Reply-To` and `References` are `*(phrase / msg-id)` with optional CFWS,
 * so a raw value can legally carry comments `(...)` and quoted strings
 * `"..."` around and between the actual message-ids. A naive `/<[^>]+>/g`
 * scan would wrongly treat an angle-bracketed token INSIDE a comment or
 * quoted string as a real message-id — which, for threading, could route a
 * reply to the wrong conversation (a `<...>` planted in a comment before the
 * real reference). This extractor skips comment and quoted-string content
 * (honouring nesting and `\` quoted-pairs) and returns only the top-level
 * `<...>` tokens, in order.
 *
 * Scope note: an exotic `msg-id` whose quoted `id-left` embeds a literal `>`
 * is not handled (we read `<` to the next `>`), but that form never occurs in
 * practice and never in tokens this engine mints. specs/mail/threading.md §3.
 */
export function extractMessageIds(headerValue: string): string[] {
  const ids: string[] = []
  let i = 0
  const n = headerValue.length

  while (i < n) {
    const c = headerValue[i]

    if (c === '(') {
      // Comment — skip to the matching close paren, allowing nesting and
      // `\`-escaped chars (a quoted-pair).
      let depth = 1
      i += 1
      while (i < n && depth > 0) {
        const ch = headerValue[i]
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === '(') depth += 1
        else if (ch === ')') depth -= 1
        i += 1
      }
      continue
    }

    if (c === '"') {
      // Quoted string — skip to the closing quote, honouring quoted-pairs.
      i += 1
      while (i < n && headerValue[i] !== '"') {
        if (headerValue[i] === '\\') {
          i += 2
          continue
        }
        i += 1
      }
      i += 1 // consume the closing quote (or run off the end harmlessly)
      continue
    }

    if (c === '<') {
      const end = headerValue.indexOf('>', i)
      if (end === -1) break // unterminated msg-id — nothing more to extract
      ids.push(headerValue.slice(i, end + 1))
      i = end + 1
      continue
    }

    i += 1
  }

  return ids
}
