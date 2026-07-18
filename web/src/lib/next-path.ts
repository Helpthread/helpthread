/**
 * Open-redirect hardening for the login flow's `?next=` query param (HT-51).
 *
 * `next` names where to land the operator after a successful login, and it
 * round-trips through a URL the operator does not fully control — the
 * middleware sets it from the path it just blocked, but anyone can also hand
 * out a crafted link like `/login?next=https://evil.example/phish` or
 * `/login?next=//evil.example` hoping a successful login bounces the browser
 * off-site with a freshly authenticated session cookie in tow. The one
 * property that makes a `next` value safe to redirect to is: it names a path
 * on THIS origin and nothing else. `sanitizeNextPath` enforces exactly that
 * — no allow-list of known routes, no attempt to validate the path actually
 * exists; sending an authenticated operator to this app's own 404 is
 * harmless, sending them off-origin is not.
 *
 * Pure and total: any input that isn't obviously a same-origin relative path
 * falls back to `DEFAULT_NEXT_PATH` rather than being rejected with an
 * error — a bad `next` value should degrade the destination, not the login
 * itself.
 */

export const DEFAULT_NEXT_PATH = '/inbox/unassigned'

export function sanitizeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_NEXT_PATH
  if (looksUnsafe(raw)) return DEFAULT_NEXT_PATH

  // A same-origin-looking path can still smuggle a scheme once percent-decoded
  // (e.g. `/%2F%2Fevil.example` decodes to `//evil.example`), so decode once
  // and re-check before trusting it.
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return DEFAULT_NEXT_PATH
  }
  if (looksUnsafe(decoded)) return DEFAULT_NEXT_PATH

  return raw
}

function looksUnsafe(value: string): boolean {
  if (!value.startsWith('/')) return true // must be a relative path, not "evil.example" or "javascript:..."
  if (value.startsWith('//')) return true // protocol-relative ("//evil.example")
  if (value.startsWith('/\\')) return true // some browsers normalize "/\" the same as "//"
  if (value.includes('://')) return true // an absolute URL smuggled after a leading "/"
  return false
}
