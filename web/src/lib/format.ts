/**
 * Display formatting per the design system's content rules (its README):
 * relative times ("7h", "yesterday", "just now" — never "now ago"),
 * customers appear by a name derived from their email, tabular numerals are
 * the components' job. Pure functions, shared by server and client.
 */

/** "just now", "12m", "7h", "yesterday", "6d", then "Mar 3" / "Mar 3, 2025". */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const ms = now.getTime() - then.getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d`
  const sameYear = then.getFullYear() === now.getFullYear()
  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** "jordan@brightpine.co" → "Jordan"; "sam.torres@…" → "Sam Torres". */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  return local
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ')
}

/** "Jun 19" / "Jun 19, 2025" (year only when not the current year) — used
 *  for the context panel's Previous conversations rows. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const sameYear = then.getFullYear() === now.getFullYear()
  return then.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** Message-band timestamp: same calendar day → absolute clock time
 *  ("6:10 PM"); older → the short date. Unlike `relativeTime`, this never
 *  ages in place while a conversation is open. */
export function messageTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  if (sameDay) {
    return then.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  return shortDate(iso, now)
}
