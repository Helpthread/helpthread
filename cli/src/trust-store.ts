/**
 * The `helpthread-module` CLI's compiled-in trust store (HT-116).
 *
 * # THIS KEY MUST NEVER BE READ FROM THE CATALOG.
 *
 * The whole point of manifest signing (see
 * `src/modules/artifact/manifest.ts`'s module doc) is that the marketplace
 * is a distribution channel, not a trust root. If this table were populated
 * from something the marketplace served — a field in the `GET /api/v1/modules`
 * response, a `.well-known` file it hosts, anything network-reachable from
 * `catalogOrigin` — a compromised or malicious marketplace could simply
 * serve its own key alongside its own forged manifest and this verifier
 * would wave it through. That defeats the entire threat model. The only
 * place a public key may come from is a literal compiled into this binary,
 * reviewed and released the same way the rest of the CLI's code is.
 *
 * Rotation: add a new `keyId -> key` entry here and cut a new CLI release;
 * do not remove an old entry until every artifact signed under it has
 * either been re-signed or aged out of `install`'s supported version range.
 */

/** keyId -> raw ed25519 public key, 32 bytes, base64url (no padding). */
export const TRUST_STORE: Readonly<Record<string, string>> = Object.freeze({
  // Resonant IQ's 2026 module-signing key. Pinned from the publisher
  // out-of-band, not fetched from marketplace.helpthread.app.
  'riq-2026': 'a2WwY2yYDuwNe8TxOv2dP0VfGLT9TrRfZlIXTNCXPZM',
})

/** Look up a trusted public key by keyId, or `undefined` if this CLI does not (or no longer) trusts that key. */
export function lookupTrustedKey(keyId: string): string | undefined {
  return TRUST_STORE[keyId]
}
