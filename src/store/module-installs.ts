/**
 * `ModuleInstallStore` — persistence for `module_installs` and
 * `module_install_events` (migration 030, `src/db/migrate.ts`). See that
 * migration's doc comment for the schema reasoning; this module is the
 * state-machine DISCIPLINE on top of it — every write either creates a row
 * idempotently or moves one atomically between exactly the two states the
 * caller names, never a bare `UPDATE ... SET state = $1 WHERE id = $2`.
 *
 * ## Why compare-and-swap, not "read state, then update"
 *
 * The deploy orchestrator this store backs is async by construction — never
 * a DB transaction across network calls — so the SAME install can be picked
 * up by more than one worker invocation: a serverless function that timed
 * out mid-step and got redelivered, or a reconciliation sweep reclaiming a
 * lapsed lease while the original worker is still finishing a Vercel call.
 * If a worker read `state` in one query and wrote a new one in a second, a
 * slow stale worker could commit AFTER a second worker moved the row through
 * several more states — silently resurrecting an obsolete install. This is
 * the bug class `inbound_deliveries`'s fence and `postgres-queue`'s
 * lease-fenced dequeue both exist to prevent, applied to a multi-step
 * pipeline instead of a single message.
 *
 * {@link ModuleInstallStore.transition} closes it the same way: ONE `UPDATE
 * ... WHERE id = $installId AND state = $fromState AND lease_token =
 * $fenceToken` — a single row-locked statement, so two concurrent attempts
 * against the same row can never both match. Whichever commits first
 * re-mints `lease_token` (`gen_random_uuid()`, in the same `UPDATE`),
 * invalidating every other in-flight caller's fence token even if their
 * `fromState` guess was still correct. **A caller must always chain its next
 * `transition`'s `fenceToken` off the record `transition` just returned**,
 * never off a value read separately or cached from an earlier step. A
 * stale-fence or from-state-mismatched call matches zero rows and is
 * refused, rather than silently doing nothing or applying to the wrong
 * generation.
 *
 * ## `false`, not a thrown error, for a refused transition
 *
 * {@link ModuleInstallStore.transition} returns `{ ok: false, ... }` rather
 * than throwing, because a refused transition is an ORDINARY, expected
 * outcome here (two workers racing a reclaim, exactly as designed) — not a
 * caller bug. `ModuleInstallTransitionError` is still exported as a typed
 * value carried on the failure branch (never thrown) so a caller can log or
 * branch on WHY it was refused (`state_mismatch` vs `lease_stale` vs
 * `not_found`) without a `try`/`catch` around routine control flow —
 * matching `QueueHandlerResult`'s "explicit result rather than throw/catch"
 * reasoning in `src/providers/queue.ts`.
 *
 * ## Every transition writes its own audit row, same transaction
 *
 * `module_install_events` is append-only. {@link ModuleInstallStore.create}'s
 * initial row and every {@link ModuleInstallStore.transition} write their
 * event INSIDE the same `Db.transaction` as the state write, so the two can
 * never diverge: a committed transition always has exactly one corresponding
 * event row, and a rolled-back one never leaves an orphaned event. (Nothing
 * else in the transaction can fail after the fenced UPDATE succeeds, but it
 * stays transactional for the same one-unit discipline
 * `InboundDeliveryStore.markStoredInTx` documents.)
 *
 * ## Idempotent `create`
 *
 * {@link ModuleInstallStore.create} is the get-or-insert shape
 * `InboundDeliveryStore.claim` uses: `INSERT ... ON CONFLICT
 * (idempotency_key) DO NOTHING RETURNING *`, falling back to a `SELECT` on
 * conflict. A caller retrying an "install this module" request — e.g. after
 * a client-side timeout where the write actually landed — gets the SAME row
 * back both times, never a second competing `planned` install.
 *
 * ## `claim` — the lease that actually excludes concurrent workers
 *
 * `transition` fences WRITES against each other, but by itself does nothing
 * to stop N concurrent workers from all reading the SAME fence token, all
 * passing their CAS precondition in sequence, and all performing a real side
 * effect — minting a token, calling a hosting API — before any attempts to
 * write. The fence token sat READABLE on the row the whole time, so "holding
 * a valid fence" and "being the only worker allowed to act" were never the
 * same thing.
 *
 * {@link ModuleInstallStore.claim} closes that gap the way
 * `inbound_deliveries`' `claimed_until` lease does: a conditional `UPDATE
 * ... WHERE (lease_expires_at IS NULL OR lease_expires_at < now())` only ONE
 * caller can win for a given lease generation.
 * `../../modules/install/installer.ts` calls it BEFORE anything else, so a
 * refused claim means a network call, a mint, or a provider call is never
 * even attempted.
 *
 * `attempt` is bumped in the same statement — this row's own count of claim
 * attempts, independent of (and a superset of) `QueueMessage.attempts`,
 * since a reconciliation sweep reclaiming a lapsed lease is a claim with no
 * corresponding queue redelivery. `next_retry_at`, when set by a future
 * reconciliation sweep (nothing in this codebase writes it yet),
 * additionally holds a claim back until its scheduled time; left `NULL` the
 * condition is always satisfied, so claiming behaves as if the column did
 * not exist.
 *
 * {@link ModuleInstallStore.release} is claim's counterpart: called once an
 * invocation is done with the row, whatever the outcome, so the next
 * legitimate delivery — which may arrive well before `lease_expires_at`,
 * since `build_pending`'s poll interval is 15 seconds against any sane
 * crash-safety TTL — need not wait out the full lease. `lease_expires_at`
 * alone is the crash-recovery backstop: a worker SIGKILLed mid-invocation
 * never calls `release` and the lease simply lapses. `release` is fenced on
 * `fenceToken` for the same reason every other write is — a caller whose own
 * claim already lost a race must never clear a newer claim's lease.
 */

import type { Db, SqlValue } from '../db/client.js'

/**
 * The install lifecycle (migration 030's CHECK constraint, extended by
 * migration 033 to add `cleanup_pending`, spelled identically). See
 * migration 030's doc comment, "the fourteen conditions" section, for what
 * each of the original states means and which failure/recovery branches
 * exist, and migration 033's doc comment for `cleanup_pending` specifically
 * — the fenced, retryable stop `src/modules/install/installer.ts`'s
 * `failInstall` passes through before a terminal-failure transition, so
 * that revoking a minted Assistant or disabling a bootstrapped endpoint is
 * never merely best-effort. This module deliberately does NOT encode which
 * `toState`s are reachable from which `fromState` — that transition TABLE
 * is the orchestrator's concern (a later ticket), not this store's; this
 * store only guarantees that WHATEVER transition the orchestrator asks
 * for happens atomically and exactly once per fence generation.
 */
export type ModuleInstallState =
  | 'planned'
  | 'credentials_issued'
  | 'project_created'
  | 'artifact_uploaded'
  | 'deployment_created'
  | 'build_pending'
  | 'build_failed'
  | 'bootstrap_pending'
  | 'endpoint_verified'
  | 'active'
  | 'verification_failed'
  | 'rollback_pending'
  | 'cleanup_required'
  | 'abandoned'
  | 'cleanup_pending'

/** A Vercel Build Output API deployment target — the platform's own vocabulary (migration 030's doc comment). */
export type ModuleInstallEnvironment = 'production' | 'preview'

/** A `module_installs` row, camelCase, timestamps as `Date`. */
export interface ModuleInstallRecord {
  id: string
  idempotencyKey: string
  moduleSlug: string
  entitlementId: string
  domain: string
  environment: ModuleInstallEnvironment
  vercelConnectionId: string
  /** `null` until the orchestrator's Vercel project-creation call succeeds and persists it (condition 3). */
  remoteProjectId: string | null
  /** `null` until the orchestrator's Vercel deployment-creation call succeeds and persists it (condition 3). */
  remoteDeploymentId: string | null
  desiredReleaseVersion: string
  artifactDigest: string
  manifestKeyId: string
  configGeneration: number
  /** The deployment id to restore during `rollback_pending` — `null` until a cutover is first attempted. */
  previousActiveDeploymentId: string | null
  state: ModuleInstallState
  attempt: number
  /** The current claim-generation fence — pass this back into {@link ModuleInstallStore.transition} as `fenceToken`. Re-minted on every successful `create`/`transition`. */
  leaseToken: string
  leaseExpiresAt: Date | null
  lastErrorClass: string | null
  nextRetryAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Input to {@link ModuleInstallStore.create}. */
export interface NewModuleInstall {
  /** The caller's dedupe key — see the module doc's "Idempotent create" section. */
  idempotencyKey: string
  moduleSlug: string
  entitlementId: string
  domain: string
  /** Defaults to `'production'` (the schema default) if omitted. */
  environment?: ModuleInstallEnvironment
  vercelConnectionId: string
  desiredReleaseVersion: string
  artifactDigest: string
  manifestKeyId: string
}

/** One `module_install_events` row, camelCase. Append-only — see the module doc. */
export interface ModuleInstallEvent {
  id: string
  installId: string
  /** `null` only for the very first event (the row's creation) — see migration 030's doc comment. */
  fromState: ModuleInstallState | null
  toState: ModuleInstallState
  actorAgentId: string | null
  at: Date
  detail: unknown
}

/** Why a {@link ModuleInstallStore.transition} call was refused — see the module doc's "compare-and-swap" section. */
export type ModuleInstallTransitionRefusalReason = 'not_found' | 'state_mismatch' | 'lease_stale'

/**
 * Carried (never thrown — see the module doc) on a refused {@link
 * ModuleInstallStore.transition} call. `actual`, when the install exists,
 * reflects the row's state as of the diagnostic read that follows the
 * failed fenced `UPDATE` — informational only; by the time a caller reads
 * it, a concurrent transition may already have moved the row again. Never
 * use it as a basis for a subsequent write; always re-fetch or retry the
 * whole operation instead.
 */
export class ModuleInstallTransitionError extends Error {
  readonly installId: string
  readonly reason: ModuleInstallTransitionRefusalReason
  readonly expectedFromState: ModuleInstallState
  readonly toState: ModuleInstallState
  readonly actual: { state: ModuleInstallState; leaseToken: string } | null

  constructor(
    installId: string,
    reason: ModuleInstallTransitionRefusalReason,
    expectedFromState: ModuleInstallState,
    toState: ModuleInstallState,
    actual: { state: ModuleInstallState; leaseToken: string } | null,
  ) {
    super(
      `module-installs: transition ${expectedFromState} -> ${toState} refused for install ${installId} (${reason})`,
    )
    this.name = 'ModuleInstallTransitionError'
    this.installId = installId
    this.reason = reason
    this.expectedFromState = expectedFromState
    this.toState = toState
    this.actual = actual
  }
}

/** The result of {@link ModuleInstallStore.transition} — see the module doc for why this is a result, not a throw. */
export type TransitionResult =
  | { ok: true; install: ModuleInstallRecord }
  | { ok: false; error: ModuleInstallTransitionError }

/** Optional detail to attach to a transition's audit event. */
export interface TransitionOptions {
  /** The agent whose step-up-authenticated action caused this transition, if any (e.g. an operator approving a rollback). `null`/omitted for a system-driven transition (the orchestrator advancing on its own after a successful Vercel API call). */
  actorAgentId?: string | null
  /** Arbitrary JSON to record on the event row (a Vercel deployment id, an error class, a challenge nonce) — see migration 030's doc comment on `module_install_events.detail`. */
  detail?: unknown
  /**
   * When given (including explicit `null`), also sets `module_installs.
   * remote_project_id` in the SAME fenced `UPDATE` as the state write —
   * the id becomes known at exactly the moment one particular transition
   * (`credentials_issued` -> `project_created`) commits, so persisting it
   * there needs no separate write, and no separate fencing: it rides the
   * transition's own CAS. Omit to leave the column untouched.
   */
  remoteProjectId?: string | null
  /** The `remoteDeploymentId` counterpart of {@link TransitionOptions.remoteProjectId}, set at `artifact_uploaded` -> `deployment_created`. */
  remoteDeploymentId?: string | null
  /**
   * When given, atomically upserts (keyed by `installId` — migration 032's
   * `module_install_credential_escrow` is one row per install, ever) this
   * install's credential-escrow row, in the SAME transaction as the state
   * write, and records the escrowed row's own id as `credentialEscrowId` on
   * the event's `detail` (merged in alongside whatever {@link
   * TransitionOptions.detail} the caller supplies). Ciphertext itself is
   * never part of `detail` — this is precisely what keeps it out of the
   * permanent, append-only `module_install_events` table (migration 032's
   * doc comment).
   */
  credentialCiphertext?: Uint8Array
  /**
   * When `true`, deletes this install's credential-escrow row (if any) in
   * the SAME transaction as the state write. The recovery need that row
   * exists for ends the moment the install reaches a state from which it
   * will never again need to recover in-flight credentials — `active`, or
   * any terminal failure state (migration 032's doc comment).
   */
  deleteCredentialEscrow?: boolean
}

/** Why a {@link ModuleInstallStore.claim} call was refused — see the module doc's "claim" section. */
export type ModuleInstallClaimRefusalReason = 'not_found' | 'lease_held'

/** The result of {@link ModuleInstallStore.claim}. */
export type ClaimResult =
  | { ok: true; install: ModuleInstallRecord }
  | { ok: false; reason: ModuleInstallClaimRefusalReason }

/** Persistence for `module_installs` / `module_install_events`. See the module doc for the compare-and-swap and append-only-audit contracts. */
export interface ModuleInstallStore {
  /**
   * Idempotent get-or-insert: a fresh row starts at `state: 'planned'`,
   * `attempt: 0`, with a freshly-minted `leaseToken`. A second call with
   * the same `input.idempotencyKey` returns the EXISTING row unchanged
   * (its `leaseToken` is NOT re-minted by a repeated `create` — only
   * `transition` advances the fence) — see the module doc.
   *
   * `actorAgentId`, if given, is recorded on the row's initial
   * (`fromState: null`) event.
   */
  create(input: NewModuleInstall, actorAgentId?: string | null): Promise<ModuleInstallRecord>

  /** Look up an install by id. `null` if no row has that id. */
  get(id: string): Promise<ModuleInstallRecord | null>

  /**
   * Atomically move `installId` from `fromState` to `toState`, fenced on
   * `fenceToken` matching the row's CURRENT `lease_token` — see the module
   * doc's "compare-and-swap" section. On success, re-mints `lease_token`
   * and records an audit event in the SAME transaction, then returns the
   * updated record. On refusal (row doesn't exist, `state` isn't
   * `fromState`, or `lease_token` isn't `fenceToken`), returns `{ ok:
   * false }` with a typed reason — never throws for this expected-in-
   * normal-operation outcome.
   */
  transition(
    installId: string,
    fromState: ModuleInstallState,
    toState: ModuleInstallState,
    fenceToken: string,
    options?: TransitionOptions,
  ): Promise<TransitionResult>

  /** Every event for `installId`, oldest first — the full audit trail migration 030's `module_install_events` table exists to hold. */
  listEvents(installId: string): Promise<ModuleInstallEvent[]>

  /**
   * Read back `installId`'s credential-escrow ciphertext (migration 032),
   * decrypting nothing — the caller (`src/modules/install/installer.ts`)
   * owns the encryption key and the envelope format. `null` if no escrow
   * row exists: either none was ever written, or it was already deleted
   * because the install reached `active` or a terminal state (see {@link
   * TransitionOptions.deleteCredentialEscrow}).
   */
  getCredentialEscrow(installId: string): Promise<Uint8Array | null>

  /**
   * Atomically claim `installId` for the next `ttlSeconds`, minting a
   * fresh `lease_token` and setting `lease_expires_at` — the module doc's
   * "claim" section. Succeeds only when no unexpired lease is currently
   * held (`lease_expires_at IS NULL OR lease_expires_at < now()`) AND, if
   * a future ticket ever schedules one, `next_retry_at` has passed.
   * Refused with `'lease_held'` when the row exists but a live lease is
   * already held by someone else — the caller must perform ZERO further
   * work (module doc). Refused with `'not_found'` when `installId` does
   * not exist at all.
   */
  claim(installId: string, ttlSeconds: number): Promise<ClaimResult>

  /**
   * Extend `installId`'s lease for another `ttlSeconds`, WITHOUT re-minting
   * `lease_token` — unlike {@link ModuleInstallStore.claim} and {@link
   * ModuleInstallStore.transition}, a renewal must never invalidate the
   * very fence its own caller is mid-use of. Fenced on `fenceToken`
   * matching the row's CURRENT `lease_token`: returns `false` the instant
   * another worker's claim or transition has already reclaimed this row —
   * exactly the signal a long-running remote operation (an artifact
   * upload, a build poll) needs in order to know it must abort rather than
   * complete, since finishing after losing the fence would duplicate
   * whatever side effect the new owner is already performing. See
   * `src/modules/install/installer.ts`'s call sites for where this is
   * actually used, and this store's own module doc's "the fence" section
   * for why CAS on the DATABASE alone is not enough to protect a REMOTE
   * side effect that can outlive one claim's TTL.
   */
  renew(installId: string, fenceToken: string, ttlSeconds: number): Promise<boolean>

  /**
   * Release the lease {@link ModuleInstallStore.claim} minted for
   * `installId`, fenced on `fenceToken` — see the module doc's "claim"
   * section. A `fenceToken` mismatch (this caller's own claim already
   * lost a race) is silently ignored, exactly like every other refused
   * CAS in this store: releasing would clear a NEWER claim's lease, which
   * is never correct.
   */
  release(installId: string, fenceToken: string): Promise<void>
}

/** Raw `module_installs` row shape, before mapping to {@link ModuleInstallRecord}. */
interface ModuleInstallRow {
  id: string
  idempotency_key: string
  module_slug: string
  entitlement_id: string
  domain: string
  environment: string
  vercel_connection_id: string
  remote_project_id: string | null
  remote_deployment_id: string | null
  desired_release_version: string
  artifact_digest: string
  manifest_key_id: string
  config_generation: number
  previous_active_deployment_id: string | null
  state: string
  attempt: number
  lease_token: string
  lease_expires_at: Date | string | null
  last_error_class: string | null
  next_retry_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

/** Raw `module_install_events` row shape, before mapping to {@link ModuleInstallEvent}. */
interface ModuleInstallEventRow {
  id: string
  install_id: string
  from_state: string | null
  to_state: string
  actor_agent_id: string | null
  at: Date | string
  detail: unknown
}

const INSTALL_COLUMNS =
  'id, idempotency_key, module_slug, entitlement_id, domain, environment, vercel_connection_id, ' +
  'remote_project_id, remote_deployment_id, desired_release_version, artifact_digest, manifest_key_id, ' +
  'config_generation, previous_active_deployment_id, state, attempt, lease_token, lease_expires_at, ' +
  'last_error_class, next_retry_at, created_at, updated_at'

const EVENT_COLUMNS = 'id, install_id, from_state, to_state, actor_agent_id, at, detail'

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toNullableDate(value: Date | string | null): Date | null {
  return value === null ? null : toDate(value)
}

function toInstallRecord(row: ModuleInstallRow): ModuleInstallRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    moduleSlug: row.module_slug,
    entitlementId: row.entitlement_id,
    domain: row.domain,
    environment: row.environment as ModuleInstallEnvironment,
    vercelConnectionId: row.vercel_connection_id,
    remoteProjectId: row.remote_project_id,
    remoteDeploymentId: row.remote_deployment_id,
    desiredReleaseVersion: row.desired_release_version,
    artifactDigest: row.artifact_digest,
    manifestKeyId: row.manifest_key_id,
    configGeneration: row.config_generation,
    previousActiveDeploymentId: row.previous_active_deployment_id,
    state: row.state as ModuleInstallState,
    attempt: row.attempt,
    leaseToken: row.lease_token,
    leaseExpiresAt: toNullableDate(row.lease_expires_at),
    lastErrorClass: row.last_error_class,
    nextRetryAt: toNullableDate(row.next_retry_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

function toEventRecord(row: ModuleInstallEventRow): ModuleInstallEvent {
  return {
    id: row.id,
    installId: row.install_id,
    fromState: row.from_state as ModuleInstallState | null,
    toState: row.to_state as ModuleInstallState,
    actorAgentId: row.actor_agent_id,
    at: toDate(row.at),
    detail: row.detail,
  }
}

/** Create a {@link ModuleInstallStore} backed by `db`. */
export function createModuleInstallStore(db: Db): ModuleInstallStore {
  return {
    async create(input, actorAgentId = null) {
      return db.transaction(async (tx) => {
        const inserted = await tx.query<ModuleInstallRow>(
          `INSERT INTO module_installs (
             idempotency_key, module_slug, entitlement_id, domain, environment,
             vercel_connection_id, desired_release_version, artifact_digest, manifest_key_id
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING ${INSTALL_COLUMNS}`,
          [
            input.idempotencyKey,
            input.moduleSlug,
            input.entitlementId,
            input.domain,
            input.environment ?? 'production',
            input.vercelConnectionId,
            input.desiredReleaseVersion,
            input.artifactDigest,
            input.manifestKeyId,
          ],
        )

        if (inserted.length > 0) {
          const row = inserted[0]
          await tx.query(
            `INSERT INTO module_install_events (install_id, from_state, to_state, actor_agent_id, detail)
             VALUES ($1, NULL, $2, $3, $4)`,
            [row.id, row.state, actorAgentId, JSON.stringify({ reason: 'created' })],
          )
          return toInstallRecord(row)
        }

        // Conflict on idempotency_key — a prior call already created this
        // install. Return that SAME row rather than inserting a competitor.
        const existing = await tx.query<ModuleInstallRow>(
          `SELECT ${INSTALL_COLUMNS} FROM module_installs WHERE idempotency_key = $1`,
          [input.idempotencyKey],
        )
        return toInstallRecord(existing[0])
      })
    },

    async get(id) {
      const rows = await db.query<ModuleInstallRow>(
        `SELECT ${INSTALL_COLUMNS} FROM module_installs WHERE id = $1`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? null : toInstallRecord(row)
    },

    async transition(installId, fromState, toState, fenceToken, options) {
      return db.transaction(async (tx) => {
        const sets = ['state = $1', 'lease_token = gen_random_uuid()', 'updated_at = now()']
        const params: SqlValue[] = [toState]
        if (options?.remoteProjectId !== undefined) {
          params.push(options.remoteProjectId)
          sets.push(`remote_project_id = $${params.length}`)
        }
        if (options?.remoteDeploymentId !== undefined) {
          params.push(options.remoteDeploymentId)
          sets.push(`remote_deployment_id = $${params.length}`)
        }
        params.push(installId, fromState, fenceToken)
        const installIdParam = params.length - 2
        const fromStateParam = params.length - 1
        const fenceTokenParam = params.length

        const updated = await tx.query<ModuleInstallRow>(
          `UPDATE module_installs
           SET ${sets.join(', ')}
           WHERE id = $${installIdParam} AND state = $${fromStateParam} AND lease_token = $${fenceTokenParam}
           RETURNING ${INSTALL_COLUMNS}`,
          params,
        )

        const row = updated[0]
        if (row === undefined) {
          // Refused — diagnose why for the caller. This SELECT is
          // informational only (see ModuleInstallTransitionError's doc
          // comment): by the time it runs, a concurrent transition may
          // have already moved the row again, so its result is never fed
          // back into a write.
          const diagnostic = await tx.query<{ state: string; lease_token: string }>(
            'SELECT state, lease_token FROM module_installs WHERE id = $1',
            [installId],
          )
          const current = diagnostic[0]
          if (current === undefined) {
            return {
              ok: false,
              error: new ModuleInstallTransitionError(
                installId,
                'not_found',
                fromState,
                toState,
                null,
              ),
            }
          }
          const actual = {
            state: current.state as ModuleInstallState,
            leaseToken: current.lease_token,
          }
          const reason: ModuleInstallTransitionRefusalReason =
            current.state !== fromState ? 'state_mismatch' : 'lease_stale'
          return {
            ok: false,
            error: new ModuleInstallTransitionError(installId, reason, fromState, toState, actual),
          }
        }

        // Escrow write/delete happens in this SAME transaction as the state
        // write and the audit event insert below — see migration 032's doc
        // comment. Ciphertext is never placed on `detail`; only the
        // escrowed row's own id is, when a write happened.
        let eventDetail = (options?.detail ?? {}) as Record<string, unknown>
        if (options?.credentialCiphertext !== undefined) {
          const escrowed = await tx.query<{ id: string }>(
            `INSERT INTO module_install_credential_escrow (install_id, ciphertext)
             VALUES ($1, $2)
             ON CONFLICT (install_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext
             RETURNING id`,
            [installId, Buffer.from(options.credentialCiphertext)],
          )
          eventDetail = { ...eventDetail, credentialEscrowId: escrowed[0].id }
        } else if (options?.deleteCredentialEscrow) {
          await tx.query('DELETE FROM module_install_credential_escrow WHERE install_id = $1', [
            installId,
          ])
        }

        await tx.query(
          `INSERT INTO module_install_events (install_id, from_state, to_state, actor_agent_id, detail)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            installId,
            fromState,
            toState,
            options?.actorAgentId ?? null,
            JSON.stringify(eventDetail),
          ],
        )

        return { ok: true, install: toInstallRecord(row) }
      })
    },

    async listEvents(installId) {
      const rows = await db.query<ModuleInstallEventRow>(
        `SELECT ${EVENT_COLUMNS} FROM module_install_events WHERE install_id = $1 ORDER BY at ASC, id ASC`,
        [installId],
      )
      return rows.map(toEventRecord)
    },

    async getCredentialEscrow(installId) {
      const rows = await db.query<{ ciphertext: Uint8Array }>(
        'SELECT ciphertext FROM module_install_credential_escrow WHERE install_id = $1',
        [installId],
      )
      const row = rows[0]
      return row === undefined ? null : new Uint8Array(Buffer.from(row.ciphertext))
    },

    async claim(installId, ttlSeconds) {
      return db.transaction(async (tx) => {
        const updated = await tx.query<ModuleInstallRow>(
          `UPDATE module_installs
           SET lease_token = gen_random_uuid(),
               lease_expires_at = now() + ($2 * interval '1 second'),
               attempt = attempt + 1,
               updated_at = now()
           WHERE id = $1
             AND (lease_expires_at IS NULL OR lease_expires_at < now())
             AND (next_retry_at IS NULL OR next_retry_at <= now())
           RETURNING ${INSTALL_COLUMNS}`,
          [installId, ttlSeconds],
        )
        const row = updated[0]
        if (row !== undefined) {
          return { ok: true, install: toInstallRecord(row) }
        }
        // Refused — diagnose why, same informational-only posture as
        // `transition`'s own diagnostic SELECT.
        const diagnostic = await tx.query<{ id: string }>(
          'SELECT id FROM module_installs WHERE id = $1',
          [installId],
        )
        if (diagnostic.length === 0) {
          return { ok: false, reason: 'not_found' }
        }
        return { ok: false, reason: 'lease_held' }
      })
    },

    async renew(installId, fenceToken, ttlSeconds) {
      const rows = await db.query<{ id: string }>(
        `UPDATE module_installs
         SET lease_expires_at = now() + ($3 * interval '1 second'), updated_at = now()
         WHERE id = $1 AND lease_token = $2
         RETURNING id`,
        [installId, fenceToken, ttlSeconds],
      )
      return rows.length > 0
    },

    async release(installId, fenceToken) {
      // Best-effort, fenced: a mismatched fenceToken means someone else
      // now legitimately holds the lease — see the module doc.
      await db.query(
        `UPDATE module_installs
         SET lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [installId, fenceToken],
      )
    },
  }
}
