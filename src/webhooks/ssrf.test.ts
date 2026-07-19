import { describe, expect, it } from 'vitest'
import {
  expandIpv6,
  isDisallowedIpv4,
  isDisallowedIpv6,
  type LookupAllFn,
  resolveSafeAddress,
  SsrfRefusedError,
} from './ssrf.js'

describe('isDisallowedIpv4', () => {
  it.each([
    ['0.0.0.0', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['127.0.0.1', true],
    ['169.254.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.0.0.1', true],
    ['192.0.2.1', true],
    ['192.88.99.1', true],
    ['192.168.1.1', true],
    ['198.18.0.1', true],
    ['198.51.100.1', true],
    ['203.0.113.1', true],
    ['224.0.0.1', true],
    ['240.0.0.1', true],
    ['255.255.255.255', true],
  ])('%s is disallowed', (ip, expected) => {
    expect(isDisallowedIpv4(ip)).toBe(expected)
  })

  it.each([
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['172.15.255.255', false], // just below the 172.16.0.0/12 block
    ['172.32.0.0', false], // just above it
    ['100.63.255.255', false], // just below 100.64.0.0/10
    ['100.128.0.0', false], // just above it
  ])('%s is allowed', (ip, expected) => {
    expect(isDisallowedIpv4(ip)).toBe(expected)
  })
})

describe('expandIpv6', () => {
  it('expands a fully-written address', () => {
    expect(expandIpv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toEqual([
      0x2001, 0x0db8, 0, 0, 0, 0, 0, 1,
    ])
  })

  it('expands "::" (unspecified) to eight zero hextets', () => {
    expect(expandIpv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('expands "::1" (loopback)', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  })

  it('expands a leading-compressed address', () => {
    expect(expandIpv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
  })

  it('expands a trailing-compressed address', () => {
    expect(expandIpv6('fc00::')).toEqual([0xfc00, 0, 0, 0, 0, 0, 0, 0])
  })

  it('expands an IPv4-embedded tail', () => {
    expect(expandIpv6('::ffff:192.168.1.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0101])
  })

  it('throws on a malformed address', () => {
    expect(() => expandIpv6('not-an-address')).toThrow()
    expect(() => expandIpv6('1:2:3::4:5:6:7:8')).toThrow() // too many groups with ::
    expect(() => expandIpv6('gggg::1')).toThrow() // invalid hex
  })
})

describe('isDisallowedIpv6', () => {
  it.each([
    ['::1', true], // loopback
    ['::', true], // unspecified
    ['fe80::1', true], // link-local
    ['fe80::ffff:ffff:ffff:ffff', true], // still within fe80::/10
    ['fc00::1', true], // unique-local
    ['fdff:ffff::1', true], // still within fc00::/7
    ['ff02::1', true], // multicast
    ['::ffff:127.0.0.1', true], // IPv4-mapped
    ['::ffff:8.8.8.8', true], // IPv4-mapped, even a public embedded address (module doc: blocked outright)
    ['64:ff9b::1', true], // NAT64
    ['2001:db8::1', true], // documentation
    ['2002:c000:0204::1', true], // 6to4
    ['2001:0:1::1', true], // Teredo
  ])('%s is disallowed', (ip, expected) => {
    expect(isDisallowedIpv6(ip)).toBe(expected)
  })

  it.each([
    ['2001:4860:4860::8888', false], // Google public DNS
    ['2606:4700:4700::1111', false], // Cloudflare public DNS
    ['fbff:ffff::1', false], // just below fc00::/7
    ['fe7f:ffff::1', false], // just below fe80::/10
  ])('%s is allowed', (ip, expected) => {
    expect(isDisallowedIpv6(ip)).toBe(expected)
  })
})

describe('resolveSafeAddress', () => {
  function fakeLookup(answers: { address: string; family: number }[]): LookupAllFn {
    return async () => answers
  }

  it('returns the first answer when every resolved address is safe', async () => {
    const lookup = fakeLookup([
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ])
    const result = await resolveSafeAddress('example.test', { lookup })
    expect(result).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('refuses when the ONLY answer is unsafe', async () => {
    const lookup = fakeLookup([{ address: '127.0.0.1', family: 4 }])
    await expect(resolveSafeAddress('evil.test', { lookup })).rejects.toBeInstanceOf(
      SsrfRefusedError,
    )
  })

  it('refuses when ANY answer is unsafe, even if the first is safe (no round-robin bypass)', async () => {
    const lookup = fakeLookup([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ])
    await expect(resolveSafeAddress('evil.test', { lookup })).rejects.toBeInstanceOf(
      SsrfRefusedError,
    )
  })

  it('refuses when resolution returns no answers', async () => {
    const lookup = fakeLookup([])
    await expect(resolveSafeAddress('nowhere.test', { lookup })).rejects.toBeInstanceOf(
      SsrfRefusedError,
    )
  })

  it('refuses when the lookup itself throws (e.g. NXDOMAIN)', async () => {
    const lookup: LookupAllFn = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    await expect(resolveSafeAddress('nxdomain.test', { lookup })).rejects.toBeInstanceOf(
      SsrfRefusedError,
    )
  })

  it('validates an IPv6 answer using the same disallowed-range rules', async () => {
    const lookup = fakeLookup([{ address: '::1', family: 6 }])
    await expect(resolveSafeAddress('evil6.test', { lookup })).rejects.toBeInstanceOf(
      SsrfRefusedError,
    )
  })
})
