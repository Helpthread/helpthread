/**
 * Relying Party (RP) id/origin resolution (HT-75; specs/auth/passkeys.md
 * §3) — the one place `rpId`/`expectedOrigin` are derived, from
 * `config.uiBaseUrl` and NOTHING else. This is the load-bearing
 * phishing-resistance property (spec §3): deriving the expected origin from
 * anything request-supplied would let an attacker assert the origin they
 * want checked against, collapsing WebAuthn's whole protection to nothing.
 *
 * `HELPTHREAD_UI_BASE_URL`'s general validator (`src/composition/config.ts`)
 * already enforces "https, or http on a loopback host" — this module adds
 * the ONE constraint that validator doesn't know about and can't, because
 * it's specific to WebAuthn: an RP ID must be a domain-form hostname (MDN:
 * "must be a domain name"), which `127.0.0.1`/`[::1]` are not, even though
 * `config.ts` accepts them as a valid UI base URL for every OTHER purpose
 * (spec §3's documented gap — local passkey dev must use
 * `http://localhost:<port>`).
 */

/** IPv4 dotted-quad, or a bracketed/unbracketed IPv6 literal — none of these are a valid WebAuthn RP ID (module doc). */
function isIpLiteralHostname(hostname: string): boolean {
  if (hostname.startsWith('[') || hostname.includes(':')) return true // IPv6 literal
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) // IPv4 dotted-quad
}

/** The resolved RP id + expected origin every WebAuthn ceremony (registration/authentication/step-up) is bound to. */
export interface WebAuthnRpConfig {
  /** The bare hostname (no scheme, no port) of `uiBaseUrl` — e.g. `inbox.resonantiq.app`. */
  rpId: string
  /** `uiBaseUrl` verbatim — the exact origin `clientDataJSON.origin` must match. */
  expectedOrigin: string
}

/**
 * Resolve `{ rpId, expectedOrigin }` from `uiBaseUrl` (spec §3). Throws if
 * `uiBaseUrl` is not a well-formed absolute URL, or if its hostname is an IP
 * literal — WebAuthn's RP ID requirement is narrower than `config.ts`'s
 * general UI-base-URL validator (module doc). Called ONCE at composition
 * (the caller decides whether to wire the passkey provider at all when this
 * throws — `uiBaseUrl` unset means the caller never calls this).
 */
export function resolveWebAuthnRp(uiBaseUrl: string): WebAuthnRpConfig {
  let parsed: URL
  try {
    parsed = new URL(uiBaseUrl)
  } catch {
    throw new Error(
      `resolveWebAuthnRp: uiBaseUrl is not a valid absolute URL (got ${JSON.stringify(uiBaseUrl)})`,
    )
  }
  if (isIpLiteralHostname(parsed.hostname)) {
    throw new Error(
      `resolveWebAuthnRp: uiBaseUrl's host must be a domain name, not an IP literal (got ${JSON.stringify(
        parsed.hostname,
      )}) — passkeys require a domain-form RP ID; use http://localhost:<port> for local dev (spec §3).`,
    )
  }
  return { rpId: parsed.hostname, expectedOrigin: uiBaseUrl }
}
