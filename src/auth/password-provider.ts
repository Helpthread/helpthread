/**
 * `PasswordAuthProvider` — the core's one `AuthProvider` (HT-54;
 * specs/auth/agents-and-auth.md §4). The free-core login: email + password,
 * verified against `agent_auth_identities`.
 *
 * ## No account enumeration (spec §9)
 *
 * `authenticate` returns the SAME `null` outcome for an unknown email, a
 * wrong password, an `invited` Agent (no usable credential yet), and a
 * `disabled` Agent (even with the correct password) — a caller cannot
 * distinguish any of these from the response alone. Timing is kept
 * comparable for the "unknown email" case specifically: when no `password`
 * identity exists for the given email, this still runs a real scrypt
 * verification — against {@link DUMMY_HASH}, a fixed hash computed once at
 * module load — so the wall-clock cost of "no such identity" matches "wrong
 * password against a real identity." (A `disabled`/`invited` Agent's
 * rejection happens AFTER the real scrypt verification against their own
 * stored hash, so that branch is inherently no faster than a genuine
 * password check either.)
 */

import type { AgentStore } from '../store/agents.js'
import { DUMMY_HASH, verifyPassword } from './password-hash.js'
import type {
  AuthAttempt,
  AuthProvider,
  AuthProviderDescriptor,
  VerifiedIdentity,
} from './provider.js'

/** Dependencies {@link createPasswordAuthProvider} needs. */
export interface PasswordAuthProviderDeps {
  agentStore: AgentStore
}

/** The wire key/label this provider serializes as (`GET /api/v1/auth/providers`, spec §6). */
const DESCRIPTOR: AuthProviderDescriptor = {
  key: 'password',
  label: 'Email and password',
  kind: 'credentials',
}

/**
 * Build the core `password` `AuthProvider`. `authenticate` is TOTAL over
 * `attempt` — a malformed attempt (non-string `email`/`password`, or either
 * field missing) returns `null` without ever touching the store or the KDF;
 * this is a distinct, cheap rejection from the "real but wrong" cases above,
 * and is fine to be fast (a malformed request carries no timing signal
 * about any real Agent's existence).
 */
export function createPasswordAuthProvider(deps: PasswordAuthProviderDeps): AuthProvider {
  return {
    key: 'password',

    descriptor(): AuthProviderDescriptor {
      return DESCRIPTOR
    },

    async authenticate(attempt: AuthAttempt): Promise<VerifiedIdentity | null> {
      const { email, password } = attempt
      if (typeof email !== 'string' || typeof password !== 'string') {
        return null
      }

      const identity = await deps.agentStore.getPasswordIdentityByEmail(email)
      if (identity === null) {
        // Burn the same scrypt cost as a real verification, discard the
        // result — see the module doc's timing-comparability note.
        verifyPassword(password, DUMMY_HASH)
        return null
      }

      if (!verifyPassword(password, identity.secretHash)) {
        return null
      }

      const agent = await deps.agentStore.getAgent(identity.agentId)
      if (agent === null || agent.status !== 'active') {
        return null
      }

      return { agentId: identity.agentId }
    },
  }
}
