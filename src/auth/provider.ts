/**
 * The auth-provider seam (HT-54; specs/auth/agents-and-auth.md §4) — the
 * interface core and marketplace login methods share.
 *
 * The core ships this interface plus exactly one implementation
 * (`PasswordAuthProvider`, `src/auth/password-provider.ts`). A marketplace
 * module (Google SSO, passkey, ...) is a package that provides another
 * `AuthProvider` and is wired into the registry at the composition root
 * (`src/composition/root.ts`) — `AuthProvider[]`, an ordered list, no
 * discovery mechanism. Spec §4's "honest scope note": this build is the
 * interface + the registry + the one core provider, not a dynamic
 * module-loading system — adding a second provider later is still a `root.ts`
 * code edit, not a drop-in. Kept deliberately minimal for that reason:
 * `AuthProviderDescriptor` carries only what a password form needs to
 * render, not speculative OAuth fields (redirect URLs, client ids, ...) no
 * shipped provider uses yet.
 */

/**
 * What the login UI needs to render one login method, serialized verbatim
 * by `GET /api/v1/auth/providers` (spec §6). `kind: 'credentials'` was the
 * only kind the core seam defined at HT-54 (a password form) — deliberately
 * not widened to anticipate a kind before a module that needs one actually
 * shipped (module doc's "do not speculate" note). HT-75 (specs/auth/
 * passkeys.md §4.1) is that module: `kind` widens to `'credentials' |
 * 'webauthn'`, the exact type-level change that spec section names as the
 * seam's only required edit — no other field is added, since a webauthn
 * login needs nothing beyond `{ key: 'webauthn', label, kind: 'webauthn' }`
 * to know to render a passkey control; every ceremony detail is fetched
 * fresh per-attempt from the options endpoints (passkeys.md §9), never
 * baked into this static descriptor.
 */
export interface AuthProviderDescriptor {
  key: string
  label: string
  kind: 'credentials' | 'webauthn'
}

/**
 * What a provider resolves a verified attempt to: which Agent this is.
 * Never a session — minting one is the core's job (spec §8), not a
 * provider's; a provider only ever answers "who is this," never "let them
 * in."
 */
export interface VerifiedIdentity {
  agentId: string
}

/**
 * One login attempt, as posted to `POST /api/v1/auth/verify` (spec §6).
 * `providerKey` selects which registered `AuthProvider` handles it; every
 * other field is provider-specific (`password`'s reads `email`/`password`)
 * and is intentionally untyped here (`Record<string, unknown>`) — this
 * interface has no business knowing another provider's shape.
 */
export type AuthAttempt = { providerKey: string } & Record<string, unknown>

/**
 * One login method: the core's `password`, or a marketplace module's own
 * (`google`, `passkey`, ...). See the module doc for the registry model.
 */
export interface AuthProvider {
  readonly key: string

  /** What the login UI needs to render this method (a password field; a "Sign in with X" button + start URL) — see {@link AuthProviderDescriptor}. */
  descriptor(): AuthProviderDescriptor

  /**
   * Verify `attempt` and resolve it to an existing Agent identity, or
   * `null` on any failure — wrong credentials, an unknown/inactive Agent,
   * a malformed attempt. `password`'s implementation reads
   * `agent_auth_identities`; an OAuth module would run its own flow then
   * map the verified external subject to an Agent via a core-owned
   * identity service (spec §4 — not built in this increment; see that
   * section's note on why the link/provision API is only sketched, not
   * shipped, until the first module needs it).
   */
  authenticate(attempt: AuthAttempt): Promise<VerifiedIdentity | null>
}
