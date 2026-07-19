/**
 * The shared "authentication-shaped" WebAuthn response verifier (HT-75;
 * specs/auth/passkeys.md §6.2, §8) — the one code path BOTH the login
 * ceremony (`webauthn-provider.ts`'s `'authentication'` case, pre-session)
 * and the step-up webauthn ceremony (`src/api/webauthn.ts`'s
 * `'step-up'` case, session-required) run through. `generateAuthenticationOptions`/
 * `verifyAuthenticationResponse` are the SAME library calls for both — the
 * two ceremonies differ only in what `allowCredentials` the OPTIONS step
 * offers (spec §5.1: step-up's options call already knows who's asking) and
 * in step-up's extra post-verify `requireAgentId` check — not in how a
 * signed assertion is actually checked. One reviewed path for a
 * security-critical check, per spec §7's own "one mechanism, not several"
 * reasoning applied here to the sibling ceremony-verify problem.
 *
 * ## The TOCTOU fix (spec §6.2's draft.3 CodeRabbit fix)
 *
 * The counter/clone comparison and the write that updates it happen inside
 * ONE transaction, against a `SELECT ... FOR UPDATE` re-read of the SAME
 * row `verifyAuthenticationResponse` was handed — NOT the earlier, unlocked
 * read used only to supply the library with a public key. See
 * `src/store/webauthn.ts`'s `getCredentialForUpdateInTx` doc for why an
 * unlocked compare-then-write here would let two concurrent valid
 * authentications silently understate the true stored maximum.
 *
 * ## The library's OWN counter check is deliberately disabled
 *
 * `verifyAuthenticationResponse` is called with `credential.counter: 0`
 * ALWAYS, never the credential's real stored `signCount` — see the inline
 * comment at the call site ("Why counter: 0") for the full reasoning. In
 * short: the library throws its own regression error using the UNLOCKED
 * pre-verification counter, which (if not suppressed) swallows the spec §8
 * signal for every ordinary, sequential replay before this module's own
 * locked Tier-1/Tier-2 logic ever runs — leaving `markCounterRegression`
 * reachable only in a narrow concurrent-race window. This module is the
 * sole authority on counter policy; the library verifies the signature
 * only.
 *
 * ## Counter regression is a COMMIT, not a rollback
 *
 * When a Tier-2 regression is detected, `markCounterRegression`'s write
 * MUST survive — it is the HT-44 health-check signal (spec §8). The
 * transaction callback below therefore RETURNS a rejection outcome rather
 * than throwing one: throwing would roll back the very write this code
 * path exists to persist. Only a genuine DB error (an actual thrown
 * exception) rolls back — every business rejection is a returned value,
 * mirroring `src/store/agents.ts`'s last-admin-guard shape.
 */

import type { AuthenticatorTransportFuture } from '@simplewebauthn/server'
import {
  type AuthenticationResponseJSON,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import type { Db, Queryable } from '../db/client.js'
import type { Keyring } from '../mail/reply-token.js'
import type { WebAuthnStore } from '../store/webauthn.js'
import type { WebAuthnRpConfig } from './webauthn-rp.js'
import { verifyChallengeToken } from './webauthn-token.js'

/** Convert an Agent's raw uuid bytes (WebAuthn `userHandle`/registration `userID`) to its canonical hyphenated string form. Total over any 16-byte input; a non-16-byte input simply produces a string that will not match any real Agent id, which is the correct (safe) outcome for a malformed/forged `userHandle`. */
export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Convert an Agent's canonical uuid string to the raw 16 bytes minted as WebAuthn `userID` at registration (spec §6.1). */
export function uuidToBytes(uuid: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(uuid.replace(/-/g, ''), 'hex'))
}

export interface WebAuthnCeremonyDeps {
  db: Db
  store: WebAuthnStore
  keyring: Keyring
  rp: WebAuthnRpConfig
}

export interface VerifyAuthenticationCeremonyParams {
  /** Which ceremony this verify call expects — checked against the token's OWN `ceremony` field before anything else runs (spec §7's application-level discriminator check). */
  ceremony: 'authentication' | 'step-up'
  /** The raw, untrusted request-body `response` field. */
  responseJson: unknown
  challengeToken: string
  /** Step-up only (spec §5.1): the resolved credential's `agent_id` must equal this, or the ceremony is rejected — proving a factor for a DIFFERENT Agent does not step up THIS session. */
  requireAgentId?: string
}

/** Every rejection this function can return collapses to one of two client-visible outcomes (spec §4.3, §6.2): `'challenge_expired'` (the one deliberate, safe exception to uniform 401 — see webauthn-provider.ts) or `'invalid'` (everything else, including a ceremony mismatch, unknown credential, bad signature, counter regression, inactive Agent, or userHandle mismatch — no finer distinction is ever surfaced). */
export type CeremonyVerifyResult =
  | { ok: true; agentId: string }
  | { ok: false; reason: 'challenge_expired' | 'invalid' }

/**
 * Verify an authentication-shaped WebAuthn response end to end: challenge
 * token (signature+TTL, then DB single-use consume), credential lookup,
 * cryptographic verification, `userHandle` cross-check, and the atomic
 * counter/clone policy (spec §8) inside one locked transaction. See the
 * module doc for the two ceremonies that share this path.
 */
export async function verifyAuthenticationCeremony(
  deps: WebAuthnCeremonyDeps,
  params: VerifyAuthenticationCeremonyParams,
): Promise<CeremonyVerifyResult> {
  // --- Challenge token: application-level ceremony check BEFORE the DB (spec §7). ---
  const verifiedToken = verifyChallengeToken(params.challengeToken, deps.keyring)
  if (verifiedToken === null || verifiedToken.ceremony !== params.ceremony) {
    return { ok: false, reason: 'invalid' }
  }

  // --- Step-up only: the challenge must have been minted FOR the acting
  // Agent, checked BEFORE the consume below (Codex review, PR #94).
  //
  // `requireAgentId` was previously enforced only against the resolved
  // credential's owner, further down — after the challenge row had already
  // been burned. That let anyone holding a victim's step-up challenge token
  // spend it from their own session with any garbage `response`: the consume
  // succeeded, verification then failed, and the victim's own legitimate
  // verify came back `challenge_expired`. Not a bypass — the assertion is
  // still cryptographically verified and `requireAgentId` still gates the
  // credential — but a griefing DoS against a real user's step-up.
  //
  // The login ceremony deliberately does NOT get this check: its challenge
  // is minted with `agentId: null` (the credential is discoverable, so no
  // Agent is known at options time, spec §4.3), which is exactly why the
  // binding is conditional on `requireAgentId` rather than unconditional.
  if (params.requireAgentId !== undefined && verifiedToken.agentId !== params.requireAgentId) {
    return { ok: false, reason: 'invalid' }
  }

  // --- DB-level single-use consume — the actual enforcement (spec §7). A
  // zero-row consume (missing, expired, already-used, wrong ceremony, or —
  // for step-up — minted for a different Agent) is the one case the caller
  // may surface as `challenge_expired`. The `expectedAgentId` argument makes
  // the row's own `agent_id` part of that predicate, so the binding holds at
  // the DB layer too rather than resting solely on the check above (spec
  // §7's "two independent layers, not duplicated logic"). ---
  const consumed = await deps.store.consumeChallenge(
    verifiedToken.nonce,
    params.ceremony,
    params.requireAgentId,
  )
  if (!consumed) return { ok: false, reason: 'challenge_expired' }

  // --- Resolve the credential by the assertion's OWN id (spec §4.3 —
  // discovered, never asserted by the caller). ---
  if (typeof params.responseJson !== 'object' || params.responseJson === null) {
    return { ok: false, reason: 'invalid' }
  }
  const responseJson = params.responseJson as AuthenticationResponseJSON
  if (typeof responseJson.id !== 'string' || responseJson.id.length === 0) {
    return { ok: false, reason: 'invalid' }
  }

  const credential = await deps.store.getCredentialByCredentialId(responseJson.id)
  if (credential === null) return { ok: false, reason: 'invalid' }

  if (params.requireAgentId !== undefined && credential.agentId !== params.requireAgentId) {
    return { ok: false, reason: 'invalid' }
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
  try {
    verification = await verifyAuthenticationResponse({
      response: responseJson,
      expectedChallenge: verifiedToken.challengeB64,
      expectedOrigin: deps.rp.expectedOrigin,
      expectedRPID: deps.rp.rpId,
      credential: {
        id: credential.credentialId,
        // A fresh `Uint8Array` (not the `Buffer` the pg/PGlite driver hands
        // back for a `bytea` column) — `@simplewebauthn/server`'s types
        // require `Uint8Array<ArrayBuffer>` specifically, which a `Buffer`
        // (typed `Uint8Array<ArrayBufferLike>`) does not structurally
        // satisfy even though it works correctly at runtime.
        publicKey: new Uint8Array(credential.publicKey),
        // DELIBERATELY 0, never `credential.signCount` — see "Why counter:
        // 0" below. This is load-bearing, not a placeholder.
        counter: 0,
        transports: credential.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: true,
    })
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!verification.verified) return { ok: false, reason: 'invalid' }

  // --- Why counter: 0 above ---------------------------------------------
  //
  // `verifyAuthenticationResponse` runs its OWN counter-regression guard
  // BEFORE the signature check, against whatever `credential.counter` it's
  // handed: `if ((counter > 0 || credential.counter > 0) && counter <=
  // credential.counter) throw`. Had this been given the real
  // `credential.signCount` (from the UNLOCKED pre-verification read above),
  // that guard would THROW on any ordinary, non-concurrent counter
  // regression — caught by the try/catch above and folded into a generic
  // `{ ok: false, reason: 'invalid' }` BEFORE `authenticationInfo.newCounter`
  // is ever obtained and BEFORE the transaction below runs at all. That
  // makes `markCounterRegression` (and the HT-44 alert it feeds) reachable
  // ONLY in the narrow race where the unlocked read was stale enough to slip
  // past the library's check but the locked re-read below still catches
  // it — the library's own guard would silently eat the spec §8 signal for
  // the common, sequential-replay case, which is exactly the case the
  // signal exists to catch.
  //
  // Passing `counter: 0` makes `(counter > 0 || false) && counter <= 0`
  // structurally unsatisfiable (a uint32 response counter cannot be both
  // `> 0` and `<= 0`), so the library NEVER throws for this reason — it
  // verifies ONLY the cryptographic signature and hands back the response's
  // raw counter in `authenticationInfo.newCounter`. This is also the
  // architecture spec §6.2 itself describes: "On a successful SIGNATURE
  // verification, the handler re-reads the same row with SELECT ... FOR
  // UPDATE... applies §8's Tier 1/Tier 2 comparison" — signature
  // verification and counter policy are two separate steps, and OUR
  // Tier-1/Tier-2 logic under the lock below is the sole, sequential- and
  // concurrent-case-alike authority on the latter.

  // --- userHandle cross-check (spec §6.2) — defense in depth, not the
  // identity-resolution path (that was credential_id, above). Optional
  // chaining: `response.response` being absent/malformed would already
  // have been rejected by the try/catch above against the REAL library
  // (its own verification touches `response.response.*` first), but this
  // function must not assume that of a mocked/future verify implementation
  // — a malformed shape here is just another "invalid", never a crash. ---
  const userHandleB64 = responseJson.response?.userHandle
  if (userHandleB64 !== undefined) {
    const userHandleAgentId = bytesToUuid(Buffer.from(userHandleB64, 'base64url'))
    if (userHandleAgentId !== credential.agentId) return { ok: false, reason: 'invalid' }
  }

  const newCounter = verification.authenticationInfo.newCounter
  const backedUp = verification.authenticationInfo.credentialBackedUp

  type TxOutcome = { kind: 'ok'; agentId: string } | { kind: 'rejected' }
  const outcome = await deps.db.transaction<TxOutcome>(async (tx: Queryable) => {
    // The locked re-read the TOCTOU fix requires (module doc) — every
    // subsequent decision uses THIS row, not the unlocked one above.
    const locked = await deps.store.getCredentialForUpdateInTx(credential.credentialId, tx)
    if (locked === null) return { kind: 'rejected' }

    // Spec §8: Tier 1 (never reported nonzero) is exempt; Tier 2 (has ever
    // reported nonzero) rejects any counter <= the locked stored maximum.
    const isTierTwo = locked.signCount > 0
    const isRegression = isTierTwo && newCounter <= locked.signCount
    if (isRegression) {
      // The log line is what makes this investigable; the DB column
      // (below) is what makes it alertable (spec §8, mirroring
      // `src/mail/ingest.ts`'s `forged_token_detected` event — the
      // identical "structured warn + a health-check-visible column"
      // shape for a sibling clone/forgery signal).
      console.warn(
        JSON.stringify({
          event: 'webauthn_counter_regression',
          credentialId: locked.id,
          agentId: locked.agentId,
          storedCounter: locked.signCount,
          responseCounter: newCounter,
        }),
      )
      // COMMIT this write — see the module doc on why this is a return,
      // not a throw.
      await deps.store.markCounterRegression(locked.id, tx)
      return { kind: 'rejected' }
    }

    const statusRows = await tx.query<{ status: string }>(
      'SELECT status FROM agents WHERE id = $1',
      [locked.agentId],
    )
    if (statusRows[0]?.status !== 'active') return { kind: 'rejected' }

    await deps.store.updateAfterSuccessfulAuth(
      locked.id,
      { signCount: newCounter, backupState: backedUp },
      tx,
    )
    return { kind: 'ok', agentId: locked.agentId }
  })

  if (outcome.kind !== 'ok') return { ok: false, reason: 'invalid' }
  return { ok: true, agentId: outcome.agentId }
}
