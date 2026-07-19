/**
 * `WebAuthnAuthProvider` — the passkey login `AuthProvider` (HT-75;
 * specs/auth/passkeys.md §4). This is ONLY the final verify step dispatched
 * via the existing generic `POST /auth/verify { providerKey: 'webauthn',
 * response, challengeToken }` (spec §4.2) — the options-minting pre-step
 * (`authentication/options`) lives outside the `AuthProvider` interface
 * entirely, in `src/api/webauthn.ts`, per spec §4.2's own reasoning
 * (`authenticate()` is a single-shot contract; a two-step ceremony's
 * options-minting doesn't fit it and shouldn't grow a hook for one provider).
 *
 * How this differs from `PasswordAuthProvider` (spec §4.3):
 *
 * - No identifier is asserted by the caller — the identity is DISCOVERED
 *   from the assertion's own credential id (`verifyAuthenticationCeremony`).
 * - Verification is cryptographic, not a KDF comparison — no `DUMMY_HASH`-
 *   style timing equalization is needed (a credential id carries no
 *   enumeration oracle the way an email address does).
 * - One narrow, deliberate exception to "uniform 401": a `challenge_expired`
 *   ceremony-freshness signal (spec §6.2) is distinguishable — this
 *   provider signals it by throwing {@link WebAuthnChallengeExpiredError},
 *   which `handleAuthVerify` (`src/api/agents.ts`) catches specifically and
 *   nothing else does; every OTHER rejection returns `null` exactly like
 *   `password`'s provider.
 */

import type {
  AuthAttempt,
  AuthProvider,
  AuthProviderDescriptor,
  VerifiedIdentity,
} from './provider.js'
import { verifyAuthenticationCeremony, type WebAuthnCeremonyDeps } from './webauthn-ceremony.js'

/** Thrown by {@link createWebAuthnAuthProvider}'s `authenticate()` on the one distinguishable failure mode (spec §6.2). Caught ONLY by `handleAuthVerify`'s webauthn dispatch — never surfaces past `src/api/agents.ts`. */
export class WebAuthnChallengeExpiredError extends Error {
  constructor() {
    super('webauthn: challenge expired, missing, or already used')
    this.name = 'WebAuthnChallengeExpiredError'
  }
}

const DESCRIPTOR: AuthProviderDescriptor = {
  key: 'webauthn',
  label: 'Passkey',
  kind: 'webauthn',
}

/** Build the passkey login `AuthProvider`. `deps` is the same {@link WebAuthnCeremonyDeps} the step-up webauthn ceremony (`src/api/webauthn.ts`) shares — one RP config, one store, one keyring, wired once at the composition root. */
export function createWebAuthnAuthProvider(deps: WebAuthnCeremonyDeps): AuthProvider {
  return {
    key: 'webauthn',

    descriptor(): AuthProviderDescriptor {
      return DESCRIPTOR
    },

    async authenticate(attempt: AuthAttempt): Promise<VerifiedIdentity | null> {
      const { response, challengeToken } = attempt
      if (typeof challengeToken !== 'string' || challengeToken.length === 0) return null
      if (typeof response !== 'object' || response === null) return null

      const result = await verifyAuthenticationCeremony(deps, {
        ceremony: 'authentication',
        responseJson: response,
        challengeToken,
      })

      if (result.ok) return { agentId: result.agentId }
      if (result.reason === 'challenge_expired') throw new WebAuthnChallengeExpiredError()
      return null
    },
  }
}
