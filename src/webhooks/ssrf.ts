/**
 * SSRF defense for the webhook delivery handler (HT-69; specs/modules/
 * substrate-v1.md §5's closing bullet: "the delivery handler refuses URLs
 * resolving to private/link-local ranges (impl note: resolve-then-connect
 * pinning)").
 *
 * ## Resolve-then-connect pinning, and the TOCTOU it closes
 *
 * A webhook `url`'s hostname is attacker-influenceable (any admin, or in a
 * future marketplace world, any module author, can register one) and DNS is
 * not trustworthy at connect time: a hostname that resolves to a public IP
 * when this module CHECKS it could resolve to `127.0.0.1` or `10.0.0.0/8`
 * moments later when the HTTP client actually CONNECTS (a classic DNS-
 * rebinding attack). Checking the resolved address and then handing the
 * ORIGINAL HOSTNAME to an HTTP client for it to re-resolve independently
 * reopens exactly that gap.
 *
 * {@link resolveSafeAddress} closes it structurally: it resolves the
 * hostname itself, validates EVERY returned address (not just the first —
 * a round-robin DNS answer could otherwise hide an unsafe address behind a
 * safe one), and returns the address to pin. The caller (`./delivery.ts`)
 * then hands that EXACT address to `node:https`' `lookup` option, so the
 * TCP connection is forced onto the address this module already validated
 * — DNS is never consulted a second time, and there is no window between
 * "checked" and "connected" for the answer to change.
 *
 * ## What this checker does and does not cover
 *
 * Documented honestly, per this ticket's brief: {@link isDisallowedAddress}
 * covers the IANA special-purpose registries that matter for SSRF
 * (loopback, link-local, RFC 1918 + carrier-grade NAT private ranges,
 * multicast, the IPv4-mapped IPv6 `::ffff:0:0/96` block, unique-local IPv6,
 * and the common documentation/benchmarking ranges). It does NOT unwrap an
 * IPv6 6to4 (`2002::/16`) or Teredo (`2001::/32`) address to inspect the
 * IPv4 address embedded in its bits — those whole prefixes are blocked
 * outright instead, which is conservative (a legitimate 6to4/Teredo-only
 * webhook target would be refused) rather than under-strict. It also
 * cannot defend against a target that is a genuinely public IP at
 * connect-time but sits behind infrastructure (a reverse proxy, a cloud
 * metadata-endpoint alias) that later forwards the request somewhere
 * private — that is outside what an SSRF check at THIS layer can ever see,
 * and is a residual risk of allowing operator-configured webhook URLs at
 * all, not something resolve-then-connect pinning claims to close.
 */

import { lookup as dnsLookup } from 'node:dns/promises'

/** Thrown by {@link resolveSafeAddress} — the delivery handler treats this as an immediate, non-retryable dead-letter (retrying can never change what a hostname is configured to resolve to). */
export class SsrfRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfRefusedError'
  }
}

/** One resolved-and-validated address, ready to pin a connection to. */
export interface PinnedAddress {
  address: string
  family: 4 | 6
}

// --- IPv4 ---------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.')
  if (parts.length !== 4) throw new Error(`ssrf: not a dotted-quad IPv4 address: ${ip}`)
  let value = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`ssrf: not a dotted-quad IPv4 address: ${ip}`)
    }
    value = (value << 8) | n
  }
  return value >>> 0
}

interface Ipv4Range {
  /** Human label, purely for a refusal message — never load-bearing. */
  label: string
  base: string
  prefixLength: number
}

/**
 * IANA special-purpose IPv4 registry entries relevant to SSRF (RFC 6890 and
 * successors): loopback, the three RFC 1918 private blocks, carrier-grade
 * NAT (RFC 6598), link-local (RFC 3927), multicast, the documentation/
 * benchmarking TEST-NET blocks, the deprecated 6to4 relay anycast prefix,
 * and the reserved/broadcast top block.
 */
const IPV4_DISALLOWED_RANGES: Ipv4Range[] = [
  { label: 'this-network', base: '0.0.0.0', prefixLength: 8 },
  { label: 'private (RFC 1918)', base: '10.0.0.0', prefixLength: 8 },
  { label: 'carrier-grade NAT (RFC 6598)', base: '100.64.0.0', prefixLength: 10 },
  { label: 'loopback', base: '127.0.0.0', prefixLength: 8 },
  { label: 'link-local (RFC 3927)', base: '169.254.0.0', prefixLength: 16 },
  { label: 'private (RFC 1918)', base: '172.16.0.0', prefixLength: 12 },
  { label: 'IETF protocol assignments', base: '192.0.0.0', prefixLength: 24 },
  { label: 'documentation (TEST-NET-1)', base: '192.0.2.0', prefixLength: 24 },
  { label: '6to4 relay anycast', base: '192.88.99.0', prefixLength: 24 },
  { label: 'private (RFC 1918)', base: '192.168.0.0', prefixLength: 16 },
  { label: 'benchmarking', base: '198.18.0.0', prefixLength: 15 },
  { label: 'documentation (TEST-NET-2)', base: '198.51.100.0', prefixLength: 24 },
  { label: 'documentation (TEST-NET-3)', base: '203.0.113.0', prefixLength: 24 },
  { label: 'multicast', base: '224.0.0.0', prefixLength: 4 },
  { label: 'reserved / broadcast', base: '240.0.0.0', prefixLength: 4 },
]

function ipv4InRange(ip: number, range: Ipv4Range): boolean {
  const baseInt = ipv4ToInt(range.base)
  const mask = range.prefixLength === 0 ? 0 : (0xffffffff << (32 - range.prefixLength)) >>> 0
  return (ip & mask) === (baseInt & mask)
}

/** Is `ip` (a dotted-quad string) in any disallowed IPv4 range? */
export function isDisallowedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  return IPV4_DISALLOWED_RANGES.some((range) => ipv4InRange(value, range))
}

// --- IPv6 -----------------------------------------------------------------

/**
 * Expand an IPv6 address (RFC 4291 textual form, `::`-compressed or not,
 * with an optional trailing IPv4-embedded tail like `::ffff:192.168.1.1`,
 * and an optional `%zone` suffix stripped) into its eight 16-bit hextets.
 * Deliberately hand-rolled rather than built on `node:net`'s `BlockList`:
 * verified live (see this ticket's report) that mixing an IPv4-mapped
 * (`::ffff:0:0/96`) subnet rule into a `BlockList` makes EVERY plain IPv4
 * `check()` call return `true` regardless of the address checked — a
 * confirmed footgun in the Node version this repo targets, not a
 * theoretical concern, so this module owns its own parsing instead.
 */
export function expandIpv6(address: string): number[] {
  const withoutZone = address.split('%')[0]
  const halves = withoutZone.split('::')
  if (halves.length > 2) {
    throw new Error(`ssrf: not a valid IPv6 address: ${address}`)
  }

  const parseGroups = (part: string): string[] => (part === '' ? [] : part.split(':'))

  /** A trailing dotted-quad group (`::ffff:192.168.1.1`'s `192.168.1.1`) becomes two hex hextets in place — the rest of RFC 4291's textual form is plain hex groups. */
  const expandEmbeddedIpv4Tail = (groups: string[]): string[] => {
    if (groups.length === 0) return groups
    const last = groups[groups.length - 1]
    if (!last.includes('.')) return groups
    const octets = last.split('.').map(Number)
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
      throw new Error(`ssrf: invalid IPv4-embedded tail in IPv6 address: ${address}`)
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16)
    const lo = ((octets[2] << 8) | octets[3]).toString(16)
    return [...groups.slice(0, -1), hi, lo]
  }

  const assertHextet = (group: string): void => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      throw new Error(`ssrf: invalid IPv6 hextet '${group}' in address: ${address}`)
    }
  }

  if (halves.length === 1) {
    const groups = expandEmbeddedIpv4Tail(parseGroups(halves[0]))
    if (groups.length !== 8) {
      throw new Error(`ssrf: not a valid IPv6 address (expected 8 groups): ${address}`)
    }
    for (const g of groups) assertHextet(g)
    return groups.map((g) => Number.parseInt(g, 16))
  }

  const left = expandEmbeddedIpv4Tail(parseGroups(halves[0]))
  const right = expandEmbeddedIpv4Tail(parseGroups(halves[1]))
  const missing = 8 - (left.length + right.length)
  // RFC 4291 §2.2: "::" stands for ONE OR MORE groups of 16 zero bits — it
  // can never represent zero groups (that would just be the two halves
  // written without compression at all), so `missing === 0` here is also
  // invalid, not merely `missing < 0`.
  if (missing < 1) {
    throw new Error(`ssrf: not a valid IPv6 address (too many groups): ${address}`)
  }
  const groups = [...left, ...new Array(missing).fill('0'), ...right]
  for (const g of groups) assertHextet(g)
  return groups.map((g) => Number.parseInt(g, 16))
}

/** Pack an IPv6 address's eight hextets into a single 128-bit `bigint`, most-significant hextet first. */
export function ipv6ToBigInt(address: string): bigint {
  return expandIpv6(address).reduce((acc, hextet) => (acc << 16n) | BigInt(hextet), 0n)
}

interface Ipv6Range {
  label: string
  base: string
  prefixLength: number
}

/**
 * IANA special-purpose IPv6 registry entries relevant to SSRF: the
 * unspecified and loopback addresses, unique-local (RFC 4193, the IPv6
 * analogue of RFC 1918), link-local (RFC 4291 §2.5.6), multicast, the
 * NAT64 well-known prefix (RFC 6052) and IPv4-mapped block (RFC 4291
 * §2.5.5.2) — both of which embed an IPv4 address this module does not
 * separately unwrap, so the WHOLE prefix is refused (module doc) — the
 * discard-only range (RFC 6666), and the documentation prefix (RFC 3849).
 * 6to4 (`2002::/16`) and Teredo (`2001::/32`) are refused in full for the
 * same "don't unwrap, block outright" reason (module doc).
 */
const IPV6_DISALLOWED_RANGES: Ipv6Range[] = [
  { label: 'loopback', base: '::1', prefixLength: 128 },
  { label: 'unspecified', base: '::', prefixLength: 128 },
  { label: 'IPv4-mapped', base: '::ffff:0:0', prefixLength: 96 },
  { label: 'NAT64 well-known prefix', base: '64:ff9b::', prefixLength: 96 },
  { label: 'discard-only (RFC 6666)', base: '100::', prefixLength: 64 },
  { label: 'documentation (RFC 3849)', base: '2001:db8::', prefixLength: 32 },
  { label: 'Teredo', base: '2001::', prefixLength: 32 },
  { label: '6to4', base: '2002::', prefixLength: 16 },
  { label: 'unique-local (RFC 4193)', base: 'fc00::', prefixLength: 7 },
  { label: 'link-local (RFC 4291)', base: 'fe80::', prefixLength: 10 },
  { label: 'multicast', base: 'ff00::', prefixLength: 8 },
]

function ipv6InRange(value: bigint, range: Ipv6Range): boolean {
  if (range.prefixLength === 0) return true
  const shift = BigInt(128 - range.prefixLength)
  return value >> shift === ipv6ToBigInt(range.base) >> shift
}

/** Is `ip` (a textual IPv6 address) in any disallowed IPv6 range? */
export function isDisallowedIpv6(ip: string): boolean {
  const value = ipv6ToBigInt(ip)
  return IPV6_DISALLOWED_RANGES.some((range) => ipv6InRange(value, range))
}

/** Is `address` (of `family` 4 or 6) in any disallowed range for its family? The one check {@link resolveSafeAddress} applies to every candidate DNS answer. */
export function isDisallowedAddress(address: string, family: 4 | 6): boolean {
  return family === 4 ? isDisallowedIpv4(address) : isDisallowedIpv6(address)
}

// --- resolve + validate -----------------------------------------------------

/** The DNS lookup shape {@link resolveSafeAddress} needs — `node:dns/promises`' own `lookup(hostname, { all: true })` signature, injectable for tests. */
export type LookupAllFn = (
  hostname: string,
  options: { all: true; verbatim?: boolean },
) => Promise<{ address: string; family: number }[]>

const defaultLookupAll: LookupAllFn = (hostname, options) => dnsLookup(hostname, options)

/**
 * Resolve `hostname` and return ONE address safe to connect to (module
 * doc's resolve-then-connect pinning). Every resolved candidate is
 * validated — not just the one returned — so a multi-answer response
 * cannot hide an unsafe address behind a safe one. Throws
 * {@link SsrfRefusedError} if resolution fails, returns no answers, or ANY
 * answer falls in a disallowed range.
 */
export async function resolveSafeAddress(
  hostname: string,
  deps: { lookup?: LookupAllFn } = {},
): Promise<PinnedAddress> {
  const lookup = deps.lookup ?? defaultLookupAll
  let answers: { address: string; family: number }[]
  try {
    answers = await lookup(hostname, { all: true, verbatim: true })
  } catch (err) {
    throw new SsrfRefusedError(
      `could not resolve webhook hostname '${hostname}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (answers.length === 0) {
    throw new SsrfRefusedError(`webhook hostname '${hostname}' resolved to no addresses`)
  }
  for (const answer of answers) {
    const family = answer.family === 6 ? 6 : 4
    if (isDisallowedAddress(answer.address, family)) {
      throw new SsrfRefusedError(
        `webhook hostname '${hostname}' resolves to a disallowed address (${answer.address}) — ` +
          'private/link-local/loopback/multicast ranges are refused',
      )
    }
  }
  const chosen = answers[0]
  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 }
}
