import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createPgliteDb, type Db } from '../../db/client.js'
import { migrate } from '../../db/migrate.js'
import type { QueueMessage } from '../../providers/queue.js'
import { type AssistantStore, createAssistantStore } from '../../store/assistants.js'
import {
  createModuleInstallStore,
  type ModuleInstallStore,
  ModuleInstallTransitionError,
} from '../../store/module-installs.js'
import { decrypt } from '../../store/token-crypto.js'
import { createVercelConnectionStore } from '../../store/vercel-connection.js'
import {
  createWebhookEndpointStore,
  type WebhookEndpointStore,
} from '../../store/webhook-endpoints.js'
import type { ModuleConfigV1 } from '../artifact/index.js'
import type {
  CreateDeploymentInput,
  CreateDeploymentResult,
  CreateProjectInput,
  CreateProjectResult,
  DeleteProjectInput,
  DeploymentState,
  DeployProvider,
  GetDeploymentStateInput,
  GetDeploymentStateResult,
  SetEnvVarsInput,
  UploadArtifactInput,
  UploadArtifactResult,
} from '../deploy/provider.js'
import {
  BUILD_POLL_MAX_ATTEMPTS,
  createModuleInstallHandler,
  ENV_ASSISTANT_TOKEN,
  ENV_WEBHOOK_SECRET,
  type ExtractArtifactFn,
  type InstallCatalogClient,
  type ModuleInstallerDeps,
  type ModuleInstallJob,
} from './installer.js'

const CREDENTIAL_KEY = randomBytes(32)

/** Insert an `agents` row directly (the same helper `module-installs.test.ts` uses). */
async function insertAgent(db: Db, email = 'admin@example.test'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO agents (email, name, role, status) VALUES ($1, 'Admin', 'admin', 'active') RETURNING id`,
    [email],
  )
  return rows[0].id
}

async function insertConnection(db: Db, agentId: string, connectionsKey: Buffer): Promise<string> {
  const store = createVercelConnectionStore(db, connectionsKey)
  const connection = await store.connect({
    teamId: 'team_abc123',
    token: 'vercel-token-plaintext',
    tokenFingerprint: 'fp_1',
    connectedByAgentId: agentId,
  })
  return connection.id
}

function moduleConfig(): ModuleConfigV1 {
  return {
    schemaVersion: 1,
    module: 'qa-scoring',
    env: [
      {
        name: ENV_ASSISTANT_TOKEN,
        required: true,
        sensitive: true,
        owner: 'engine-managed',
        description: 'assistant token',
      },
      {
        name: ENV_WEBHOOK_SECRET,
        required: true,
        sensitive: true,
        owner: 'engine-managed',
        description: 'webhook secret',
      },
      {
        name: 'THIRD_PARTY_KEY',
        required: true,
        sensitive: true,
        owner: 'operator-managed',
        description: 'a key the operator supplies',
      },
    ],
  }
}

const fakeExtractArtifact: ExtractArtifactFn = async () => ({
  files: [{ path: 'index.js', data: new Uint8Array([1, 2, 3]) }],
  moduleConfig: moduleConfig(),
})

/** A `DeployProvider` fake with no real network — Vercel-shaped enough to exercise the installer's reconciliation logic (deterministic project names, a name conflict on retry) without touching a real account. */
function createFakeDeployProvider(opts: { buildStates?: DeploymentState[] } = {}) {
  const projects = new Map<string, string>()
  let projectSeq = 0
  let deploymentSeq = 0
  const calls = {
    createProject: 0,
    uploadArtifact: 0,
    createDeployment: 0,
    getDeploymentState: 0,
    setEnvVars: 0,
    deleteProject: 0,
  }
  const setEnvVarsCalls: SetEnvVarsInput['vars'][] = []

  const provider: DeployProvider = {
    async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
      calls.createProject += 1
      if (projects.has(input.name)) {
        throw new Error(`Project name '${input.name}' is already in use with a different team.`)
      }
      projectSeq += 1
      const projectId = `proj_${projectSeq}`
      projects.set(input.name, projectId)
      return { projectId }
    },
    async uploadArtifact(_input: UploadArtifactInput): Promise<UploadArtifactResult> {
      calls.uploadArtifact += 1
      return { uploadId: 'upload_1' }
    },
    async createDeployment(_input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
      calls.createDeployment += 1
      deploymentSeq += 1
      return {
        deploymentId: `dep_${deploymentSeq}`,
        url: `https://module-${deploymentSeq}.example.test`,
      }
    },
    async getDeploymentState(_input: GetDeploymentStateInput): Promise<GetDeploymentStateResult> {
      calls.getDeploymentState += 1
      const states = opts.buildStates ?? ['ready']
      const state = states[Math.min(calls.getDeploymentState - 1, states.length - 1)]
      return { state }
    },
    async setEnvVars(input: SetEnvVarsInput): Promise<void> {
      calls.setEnvVars += 1
      setEnvVarsCalls.push(input.vars)
    },
    async deleteProject(_input: DeleteProjectInput): Promise<void> {
      calls.deleteProject += 1
    },
  }

  return { provider, calls, projects, setEnvVarsCalls }
}

/** Matches `newInstallInput`'s `artifactDigest`/`manifestKeyId` — the manifest identity {@link stepArtifactUploaded}'s check compares against. */
const MATCHING_MANIFEST = { artifactSha256: 'sha256:deadbeef', keyId: 'key_1' }

function fakeCatalog(): InstallCatalogClient {
  return {
    async downloadArtifact() {
      return {
        ok: true,
        artifact: { tarballBytes: Buffer.from('fake-tarball'), manifest: MATCHING_MANIFEST },
      }
    },
  }
}

/** A challenge transport that always answers correctly — reads the real, DB-committed webhook secret back off the install's credential-escrow row (mirrors `installer.ts`'s own `loadIssuedCredentials`) so the fake genuinely proves possession rather than being told the answer out of band. */
function correctChallengeSend(installs: ModuleInstallStore, installId: string) {
  return async (_url: string, body: string) => {
    const { nonce } = JSON.parse(body) as { nonce: string }
    const ciphertext = await installs.getCredentialEscrow(installId)
    if (ciphertext === null) throw new Error('no credential-escrow row yet')
    const envelope = JSON.parse(decrypt(ciphertext, CREDENTIAL_KEY)) as {
      webhookSecret: string
    }
    const signature = createHmac('sha256', envelope.webhookSecret).update(nonce).digest('hex')
    return { status: 200, body: JSON.stringify({ signature }) }
  }
}

function wrongChallengeSend() {
  return async (_url: string, body: string) => {
    const { nonce } = JSON.parse(body) as { nonce: string }
    return { status: 200, body: JSON.stringify({ signature: `wrong-${nonce}` }) }
  }
}

function makeMessage(payload: ModuleInstallJob, attempts = 1): QueueMessage<ModuleInstallJob> {
  return { id: randomUUID(), topic: 'module.install', payload, attempts, enqueuedAt: new Date() }
}

describe('createModuleInstallHandler', () => {
  let db: Db | undefined

  afterEach(async () => {
    await db?.close()
    db = undefined
  })

  async function freshFixtures(): Promise<{
    db: Db
    installs: ModuleInstallStore
    assistants: AssistantStore
    webhookEndpoints: WebhookEndpointStore
    connections: ReturnType<typeof createVercelConnectionStore>
    connectionId: string
  }> {
    db = await createPgliteDb()
    await migrate(db)
    const agentId = await insertAgent(db)
    const connectionsKey = randomBytes(32)
    const connections = createVercelConnectionStore(db, connectionsKey)
    const connectionId = await insertConnection(db, agentId, connectionsKey)
    return {
      db,
      installs: createModuleInstallStore(db),
      assistants: createAssistantStore(db),
      webhookEndpoints: createWebhookEndpointStore(db, randomBytes(32)),
      connections,
      connectionId,
    }
  }

  function newInstallInput(connectionId: string, moduleSlug = 'qa-scoring') {
    return {
      idempotencyKey: randomUUID(),
      moduleSlug,
      entitlementId: 'ent_123',
      domain: 'support.example.com',
      vercelConnectionId: connectionId,
      desiredReleaseVersion: '1.0.0',
      artifactDigest: 'sha256:deadbeef',
      manifestKeyId: 'key_1',
    }
  }

  function baseDeps(
    fixtures: Awaited<ReturnType<typeof freshFixtures>>,
    provider: DeployProvider,
    overrides: Partial<ModuleInstallerDeps> = {},
  ): ModuleInstallerDeps {
    return {
      installs: fixtures.installs,
      connections: fixtures.connections,
      assistants: fixtures.assistants,
      webhookEndpoints: fixtures.webhookEndpoints,
      catalog: fakeCatalog(),
      createDeployProvider: () => provider,
      extractArtifact: fakeExtractArtifact,
      encryptionKey: CREDENTIAL_KEY,
      // Never actually called by the fake deploy provider's default
      // `buildStates: ['ready']` (one poll always sees the build already
      // ready) — tests that need to exercise the re-enqueue loop supply
      // their own fake via `overrides`.
      enqueueInstallJob: async () => {
        throw new Error('enqueueInstallJob: no fake installed for this test')
      },
      ...overrides,
    }
  }

  it('drives the full happy path from planned to active in one invocation', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider, calls, setEnvVarsCalls } = createFakeDeployProvider()

    const deps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })

    const handler = createModuleInstallHandler(deps)
    const result = await handler(
      makeMessage({
        installId: install.id,
        operatorEnvVars: { THIRD_PARTY_KEY: 'operator-value' },
      }),
    )

    expect(result).toEqual({ kind: 'ack' })

    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('active')
    // `module_installs.remote_project_id`/`remote_deployment_id`
    // are queryable directly off the row — `ModuleInstallStore.transition`
    // now accepts them as options and sets them in the SAME fenced write
    // as the state change, not only on the audit event's `detail`.
    expect(final?.remoteProjectId).toBeTruthy()
    expect(final?.remoteDeploymentId).toBeTruthy()

    expect(calls.createProject).toBe(1)
    expect(calls.createDeployment).toBe(1)
    expect(calls.uploadArtifact).toBe(1)
    expect(calls.setEnvVars).toBe(1)

    const vars = setEnvVarsCalls[0]
    const varNames = vars.map((v) => v.key).sort()
    expect(varNames).toEqual([ENV_ASSISTANT_TOKEN, ENV_WEBHOOK_SECRET, 'THIRD_PARTY_KEY'].sort())
    expect(vars.find((v) => v.key === 'THIRD_PARTY_KEY')?.value).toBe('operator-value')

    const endpoints = await fixtures.webhookEndpoints.list()
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0].status).toBe('active')
    expect(endpoints[0].module).toBe('qa-scoring')

    const assistants = await fixtures.assistants.list()
    expect(assistants).toHaveLength(1)
    expect(assistants[0].status).toBe('active')
  })

  it('a stale fence token loses — the worker stops instead of overwriting a newer transition, and never touches assistants', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))

    // This worker's `claim` returns the STALE pre-race snapshot — model a
    // reclaim that raced ahead of it (e.g. a lapsed-lease reconciliation)
    // by handing the handler a store whose `claim` reports success with
    // the ORIGINAL, now-stale install, while every other method still hits
    // the real store.
    const staleInstalls: ModuleInstallStore = {
      ...fixtures.installs,
      async claim() {
        return { ok: true, install }
      },
    }

    // A concurrent, newer worker completes the first transition for real —
    // this advances state AND re-mints the lease token.
    const winner = await fixtures.installs.transition(
      install.id,
      'planned',
      'credentials_issued',
      install.leaseToken,
    )
    expect(winner.ok).toBe(true)

    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider, { installs: staleInstalls })
    const handler = createModuleInstallHandler(deps)
    const result = await handler(makeMessage({ installId: install.id, operatorEnvVars: {} }))

    expect(result).toEqual({ kind: 'ack' })

    // The winner's transition is untouched by the stale worker.
    const current = await fixtures.installs.get(install.id)
    expect(current?.state).toBe('credentials_issued')
    if (winner.ok) {
      expect(current?.leaseToken).toBe(winner.install.leaseToken)
    }

    // the stale worker DID mint a token in memory, but its
    // transition lost the fence, so `assistants` must be completely
    // untouched by it — no row, no orphaned hash pointing at a token this
    // install's audit trail never recorded.
    expect(await fixtures.assistants.list()).toHaveLength(0)
  })

  it('a losing worker never writes assistants — credentials are only ever persisted after winning the fenced transition', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))

    // Model a worker whose CAS is destined to be refused (preempted by a
    // concurrent winner) by wiring a store whose `transition` always
    // reports refusal, while everything else is real.
    const alwaysRefusedInstalls: ModuleInstallStore = {
      ...fixtures.installs,
      async transition(id, from, to, fence) {
        return {
          ok: false,
          error: new ModuleInstallTransitionError(id, 'lease_stale', from, to, {
            state: from,
            leaseToken: fence,
          }),
        }
      },
    }

    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider, { installs: alwaysRefusedInstalls })
    const handler = createModuleInstallHandler(deps)

    const result = await handler(makeMessage({ installId: install.id, operatorEnvVars: {} }))
    expect(result).toEqual({ kind: 'ack' })

    expect(await fixtures.assistants.list()).toHaveLength(0)
  })

  it('claim refusal makes a concurrent worker perform zero network calls', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))

    // Worker A holds a live, unexpired lease — models a genuinely
    // in-flight concurrent delivery of the SAME install.
    const claimedByA = await fixtures.installs.claim(install.id, 300)
    expect(claimedByA.ok).toBe(true)

    const { provider, calls } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider)
    const handler = createModuleInstallHandler(deps)

    // Worker B: a concurrent/duplicate delivery of the same message.
    const result = await handler(makeMessage({ installId: install.id, operatorEnvVars: {} }))

    // a live lease only means SOMEONE holds it right now, not that
    // they're still alive — `retry`, never `ack`, so a holder that crashed
    // mid-transition doesn't get this job silently deleted out from under
    // it (see the handler's own doc comment on this branch).
    expect(result).toEqual({ kind: 'retry', backoffSeconds: 30 })
    expect(calls.createProject).toBe(0)
    expect(calls.uploadArtifact).toBe(0)
    expect(calls.createDeployment).toBe(0)
    expect(calls.getDeploymentState).toBe(0)
    expect(calls.setEnvVars).toBe(0)

    // The install is exactly where worker A left it — untouched.
    const current = await fixtures.installs.get(install.id)
    expect(current?.state).toBe('planned')
  })

  it("a stale worker's failure path cannot disable a healthy install's Assistant", async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))

    // The REAL pipeline runs all the way to active — models "a newer
    // worker already finished the job for real."
    const { provider } = createFakeDeployProvider()
    const winningDeps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    const winResult = await createModuleInstallHandler(winningDeps)(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(winResult).toEqual({ kind: 'ack' })
    const activeInstall = await fixtures.installs.get(install.id)
    expect(activeInstall?.state).toBe('active')

    // A stale worker: believes it is still at `build_pending`, holding the
    // ORIGINAL (pre-race) lease token, and is about to permanently fail
    // the install.
    const staleSnapshot = { ...install, state: 'build_pending' as const }
    const staleInstalls: ModuleInstallStore = {
      ...fixtures.installs,
      async claim() {
        return { ok: true, install: staleSnapshot }
      },
    }
    const staleDeps = baseDeps(fixtures, createFakeDeployProvider().provider, {
      installs: staleInstalls,
    })
    const staleResult = await createModuleInstallHandler(staleDeps)(
      makeMessage({ installId: install.id, operatorEnvVars: {} }),
    )
    expect(staleResult.kind).toBe('deadLetter')

    // The winner's install is untouched — still active.
    const finalInstall = await fixtures.installs.get(install.id)
    expect(finalInstall?.state).toBe('active')

    // the Assistant the ACTIVE install depends on is still
    // enabled — the stale worker's failure path never reached `revoke`
    // because its fenced transition to a terminal state lost the race.
    const assistants = await fixtures.assistants.list()
    expect(assistants[0].status).toBe('active')

    // the endpoint-disable cleanup, similarly, never ran.
    const endpoints = await fixtures.webhookEndpoints.list()
    expect(endpoints[0].status).toBe('active')
  })

  it('an ACTIVE install with a revoked Vercel connection is left completely untouched', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    const handler = createModuleInstallHandler(deps)

    const initial = await handler(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(initial).toEqual({ kind: 'ack' })
    const activeInstall = await fixtures.installs.get(install.id)
    expect(activeInstall?.state).toBe('active')

    // The operator rotates/revokes their Vercel token AFTER the module is
    // live — condition 7: this must never disable, degrade, or
    // reconfigure the RUNNING module.
    await fixtures.connections.revoke(fixtures.connectionId)

    let connectionLookups = 0
    const spyConnections: typeof fixtures.connections = {
      ...fixtures.connections,
      async get(id: string) {
        connectionLookups += 1
        return fixtures.connections.get(id)
      },
    }
    const redeliveredDeps = baseDeps(fixtures, provider, { connections: spyConnections })
    const redeliveredHandler = createModuleInstallHandler(redeliveredDeps)

    // A stray redelivery of the same (non-update) message.
    const result = await redeliveredHandler(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(result).toEqual({ kind: 'ack' })
    expect(connectionLookups).toBe(0)

    const finalInstall = await fixtures.installs.get(install.id)
    expect(finalInstall?.state).toBe('active')
    const assistants = await fixtures.assistants.list()
    expect(assistants[0].status).toBe('active')
  })

  it('remote project/deployment ids are persisted directly on the row, not only in the audit trail', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    const final = await fixtures.installs.get(install.id)
    expect(final?.remoteProjectId).toMatch(/^proj_/)
    expect(final?.remoteDeploymentId).toMatch(/^dep_/)
  })

  it('an artifact whose manifest identity does not match the install is refused permanently, before any deploy happens', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider, calls } = createFakeDeployProvider()

    const substitutedCatalog: InstallCatalogClient = {
      async downloadArtifact() {
        return {
          ok: true,
          artifact: {
            tarballBytes: Buffer.from('fake-tarball'),
            // Validly-signed by the SAME first-party key, but for a
            // DIFFERENT release than what this install recorded at
            // request time (`newInstallInput`'s `artifactDigest`/
            // `manifestKeyId`, which `MATCHING_MANIFEST` mirrors).
            manifest: { artifactSha256: 'sha256:attacker-substituted', keyId: 'key_1' },
          },
        }
      },
    }
    const deps = baseDeps(fixtures, provider, { catalog: substitutedCatalog })
    const handler = createModuleInstallHandler(deps)

    const result = await handler(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(result.kind).toBe('deadLetter')

    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('build_failed')
    expect(calls.setEnvVars).toBe(0)
    expect(calls.uploadArtifact).toBe(0)
  })

  it('two workers racing to register the same deployment URL cannot both leave an active duplicate endpoint', async () => {
    const fixtures = await freshFixtures()
    const first = await fixtures.webhookEndpoints.create({
      url: 'https://module-race.example.test',
      secret: 'secret-a',
      events: [],
      module: 'qa-scoring',
      status: 'disabled',
    })
    const second = await fixtures.webhookEndpoints.create({
      url: 'https://module-race.example.test',
      secret: 'secret-b',
      events: [],
      module: 'qa-scoring',
      status: 'disabled',
    })

    // The loser's create() is coalesced onto the SAME row — never a
    // second, independently-live endpoint for the same url.
    expect(second.id).toBe(first.id)
    const endpoints = await fixtures.webhookEndpoints.list()
    expect(endpoints).toHaveLength(1)

    await fixtures.webhookEndpoints.patch(first.id, { status: 'active' })
    const finalList = await fixtures.webhookEndpoints.list()
    expect(finalList).toHaveLength(1)
    expect(finalList[0].status).toBe('active')
  })

  it('a crash between creating the project and persisting its id does not create a second project on retry', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider, calls, projects } = createFakeDeployProvider()

    let crashed = false
    const crashyInstalls: ModuleInstallStore = {
      ...fixtures.installs,
      async transition(id, from, to, fence, options) {
        if (!crashed && from === 'credentials_issued' && to === 'project_created') {
          crashed = true
          throw new Error('simulated process crash between the remote call and the persist')
        }
        return fixtures.installs.transition(id, from, to, fence, options)
      },
    }

    const firstDeps = baseDeps(fixtures, provider, { installs: crashyInstalls })
    const handler1 = createModuleInstallHandler(firstDeps)
    const result1 = await handler1(makeMessage({ installId: install.id, operatorEnvVars: {} }))
    // The simulated crash surfaces as an ordinary failure this step
    // retries — from the worker's point of view it cannot tell "the
    // network call failed" apart from "the call succeeded but the
    // process died before the persist," which is exactly the point:
    // both must be safe to retry.
    expect(result1.kind).toBe('retry')

    // Nothing was persisted — state is unchanged, remoteProjectId is still
    // unset — but the provider call already happened for real.
    const afterCrash = await fixtures.installs.get(install.id)
    expect(afterCrash?.state).toBe('credentials_issued')
    expect(afterCrash?.remoteProjectId).toBeNull()
    expect(calls.createProject).toBe(1)
    expect(projects.size).toBe(1)

    // Retry with the real store — the SAME deterministic project name is
    // requested again, and the fake (like real Vercel) refuses a second
    // project under a name already in use.
    const secondDeps = baseDeps(fixtures, provider)
    const handler2 = createModuleInstallHandler(secondDeps)
    const result2 = await handler2(makeMessage({ installId: install.id, operatorEnvVars: {} }))

    expect(result2.kind).toBe('deadLetter')
    expect(calls.createProject).toBe(2)
    // Still exactly ONE project ever recorded — the retry never created a
    // second, orphaned one.
    expect(projects.size).toBe(1)

    const final = await fixtures.installs.get(install.id)
    // A named project-name conflict needs an operator to look at the
    // Vercel dashboard, not a code retry — the `cleanup_required`,
    // not `build_failed`.
    expect(final?.state).toBe('cleanup_required')
  })

  it('a build failure lands in build_failed and revokes the minted assistant credentials', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider({ buildStates: ['error'] })
    const deps = baseDeps(fixtures, provider)
    const handler = createModuleInstallHandler(deps)

    const result = await handler(makeMessage({ installId: install.id, operatorEnvVars: {} }))
    expect(result.kind).toBe('deadLetter')

    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('build_failed')

    const assistants = await fixtures.assistants.list()
    expect(assistants).toHaveLength(1)
    expect(assistants[0].status).toBe('disabled')

    const endpoints = await fixtures.webhookEndpoints.list()
    expect(endpoints).toHaveLength(0)
  })

  it('a challenge failure prevents activation and leaves a previously-verified endpoint live', async () => {
    const fixtures = await freshFixtures()

    // Install A: succeeds end to end, registering a real, active webhook
    // endpoint.
    const installA = await fixtures.installs.create(
      newInstallInput(fixtures.connectionId, 'module-a'),
    )
    const providerA = createFakeDeployProvider()
    const depsA = baseDeps(fixtures, providerA.provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, installA.id) },
    })
    const resultA = await createModuleInstallHandler(depsA)(
      makeMessage({ installId: installA.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(resultA).toEqual({ kind: 'ack' })
    const endpointsAfterA = await fixtures.webhookEndpoints.list()
    expect(endpointsAfterA).toHaveLength(1)
    const liveEndpointId = endpointsAfterA[0].id

    // Install B: everything succeeds up through deployment, but the
    // deployed module answers the possession challenge incorrectly.
    const installB = await fixtures.installs.create(
      newInstallInput(fixtures.connectionId, 'module-b'),
    )
    const providerB = createFakeDeployProvider()
    const depsB = baseDeps(fixtures, providerB.provider, {
      challenge: { send: wrongChallengeSend() },
    })
    const resultB = await createModuleInstallHandler(depsB)(
      makeMessage({ installId: installB.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(resultB.kind).toBe('deadLetter')

    const finalB = await fixtures.installs.get(installB.id)
    expect(finalB?.state).toBe('verification_failed')

    // No endpoint was ever registered for B, and A's live endpoint is
    // completely untouched.
    const endpointsAfterB = await fixtures.webhookEndpoints.list()
    expect(endpointsAfterB).toHaveLength(1)
    expect(endpointsAfterB[0].id).toBe(liveEndpointId)
    expect(endpointsAfterB[0].status).toBe('active')

    const assistantB = await fixtures.assistants.get(
      (await fixtures.assistants.list()).find((a) => a.module === 'module-b')?.id ?? '',
    )
    expect(assistantB?.status).toBe('disabled')
  })

  it('an update carrying a drifted engine-managed env var is refused before any remote call', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider, calls } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    const handler = createModuleInstallHandler(deps)

    const initial = await handler(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(initial).toEqual({ kind: 'ack' })
    const setEnvVarsCallsAfterInstall = calls.setEnvVars

    const driftResult = await handler(
      makeMessage({
        installId: install.id,
        operatorEnvVars: { [ENV_ASSISTANT_TOKEN]: 'attacker-supplied-value' },
        isUpdate: true,
      }),
    )

    expect(driftResult.kind).toBe('deadLetter')
    if (driftResult.kind === 'deadLetter') {
      expect(driftResult.reason).toContain(ENV_ASSISTANT_TOKEN)
    }
    // The refusal happened before touching the hosting provider again.
    expect(calls.setEnvVars).toBe(setEnvVarsCallsAfterInstall)

    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('active')
  })

  // Credential escrow (migration 032) — the audit trail never carries
  // decryptable credential material, and the escrow row's lifetime tracks
  // the install's own need to recover in-flight credentials.
  it('the credentials_issued audit event never carries ciphertext or key material', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )

    const events = await fixtures.installs.listEvents(install.id)
    const credEvent = events.find((e) => e.toState === 'credentials_issued')
    const detail = credEvent?.detail as Record<string, unknown>
    expect(Object.keys(detail).sort()).toEqual(['assistantId', 'credentialEscrowId'])
    // The escrow id is opaque — nowhere near long/rich enough to itself be
    // usable ciphertext, but assert the shape directly rather than by size.
    expect(typeof detail.credentialEscrowId).toBe('string')
  })

  it('deletes the credential-escrow row once the install reaches active', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('active')
    expect(await fixtures.installs.getCredentialEscrow(install.id)).toBeNull()
  })

  it('deletes the credential-escrow row once the install reaches a terminal failure state', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider({ buildStates: ['error'] })
    const deps = baseDeps(fixtures, provider)
    const result = await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: {} }),
    )
    expect(result.kind).toBe('deadLetter')
    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('build_failed')
    expect(await fixtures.installs.getCredentialEscrow(install.id)).toBeNull()
  })

  it('a crash right after credentials_issued commits still recovers the SAME credentials from escrow on retry', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider()

    let crashed = false
    const crashyInstalls: ModuleInstallStore = {
      ...fixtures.installs,
      async transition(id, from, to, fence, options) {
        const result = await fixtures.installs.transition(id, from, to, fence, options)
        if (!crashed && from === 'planned' && to === 'credentials_issued' && result.ok) {
          crashed = true
          throw new Error('simulated crash right after credentials_issued committed')
        }
        return result
      },
    }
    const crashyDeps = baseDeps(fixtures, provider, { installs: crashyInstalls })
    await expect(
      createModuleInstallHandler(crashyDeps)(
        makeMessage({ installId: install.id, operatorEnvVars: {} }),
      ),
    ).rejects.toThrow('simulated crash')

    const afterCrash = await fixtures.installs.get(install.id)
    expect(afterCrash?.state).toBe('credentials_issued')
    // The escrow write committed in the SAME transaction as the state
    // transition — a crash after the transition commits can never observe
    // the state advanced with no escrow row to recover from.
    expect(await fixtures.installs.getCredentialEscrow(install.id)).not.toBeNull()

    // The crashed worker's own lease is still held under the token its
    // (real, committed) transition minted — simulate it naturally lapsing
    // rather than waiting out the real TTL, the same technique the
    // existing `endpoint_verified`-crash test above uses.
    await fixtures.db.query(
      `UPDATE module_installs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [install.id],
    )

    // A fresh delivery recovers the SAME credentials well enough to
    // complete the whole pipeline — if it had re-minted a different token,
    // the possession challenge (which reads the webhook secret straight
    // out of escrow) would sign with a value the deployed module was never
    // actually given, and the install would end at verification_failed.
    const recoveredDeps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    const recovered = await createModuleInstallHandler(recoveredDeps)(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(recovered).toEqual({ kind: 'ack' })
    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('active')
  })

  // Fenced, retryable cleanup (migration 033) — a transient failure
  // revoking/disabling must never be silently absorbed into a terminal
  // state that isn't actually true yet.
  it('a revocation failure during cleanup leaves the install retryable at cleanup_pending, not silently terminal', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider({ buildStates: ['error'] })

    let shouldFail = true
    const flakyAssistants: AssistantStore = {
      ...fixtures.assistants,
      async patch(id, patch) {
        if (shouldFail) {
          shouldFail = false
          throw new Error('simulated transient DB failure revoking the assistant')
        }
        return fixtures.assistants.patch(id, patch)
      },
    }
    const deps = baseDeps(fixtures, provider, { assistants: flakyAssistants })
    const result = await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: {} }),
    )
    expect(result.kind).toBe('retry')

    const afterFailedCleanup = await fixtures.installs.get(install.id)
    expect(afterFailedCleanup?.state).toBe('cleanup_pending')

    // The Assistant this install minted is still ACTIVE — the cleanup that
    // was supposed to disable it never actually completed.
    const assistantsAfterFirstAttempt = await fixtures.assistants.list()
    expect(assistantsAfterFirstAttempt[0].status).toBe('active')

    // The lease must ALREADY be free: a cleanup that failed released it on
    // the way out. Rewinding `lease_expires_at` by hand here would hide the
    // very defect this asserts — a still-held lease makes every redelivery
    // lose `claim` and burn the queue's attempt budget waiting, and with a
    // low `maxAttempts` the job dead-letters leaving a live Assistant token
    // behind. So assert the row is genuinely claimable, with no help.
    const reclaimed = await fixtures.installs.claim(install.id, 300)
    expect(reclaimed.ok).toBe(true)
    // Hand it straight back: claiming re-mints the token, so holding it
    // here would starve the redelivery below of the very lease this just
    // proved was free.
    if (reclaimed.ok) {
      await fixtures.installs.release(install.id, reclaimed.install.leaseToken)
    }

    // A later delivery retries the SAME cleanup — this time it succeeds —
    // and only THEN reaches the real terminal state.
    const recoveredDeps = baseDeps(fixtures, provider, { assistants: flakyAssistants })
    const recovered = await createModuleInstallHandler(recoveredDeps)(
      makeMessage({ installId: install.id, operatorEnvVars: {} }),
    )
    expect(recovered.kind).toBe('deadLetter')
    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('build_failed')
    expect((await fixtures.assistants.list())[0].status).toBe('disabled')
  })

  it('a permanent failure disables a previously-recorded webhook endpoint before reaching its terminal state', async () => {
    const fixtures = await freshFixtures()
    const install0 = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const endpoint = await fixtures.webhookEndpoints.create({
      url: 'https://module-cleanup-seed.example.test',
      secret: 'secret-x',
      events: [],
      module: 'qa-scoring',
      status: 'active',
    })

    // Seed an `endpoint_verified` audit event recording THIS install's own
    // endpoint, then rewind the row's current state back to `build_pending`
    // — `disableRecordedEndpoint` reads the id from history regardless of
    // the install's CURRENT state, so this reproduces "an endpoint this
    // install verified earlier in its life" without needing a second
    // reachable failure state after `endpoint_verified` (v1's pipeline has
    // none: the only step after that one is the `active` CAS).
    let install = install0
    for (const [from, to] of [
      ['planned', 'credentials_issued'],
      ['credentials_issued', 'project_created'],
      ['project_created', 'artifact_uploaded'],
      ['artifact_uploaded', 'deployment_created'],
      ['deployment_created', 'build_pending'],
    ] as const) {
      const result = await fixtures.installs.transition(install.id, from, to, install.leaseToken)
      if (!result.ok) throw new Error(`seeding failed at ${from} -> ${to}`)
      install = result.install
    }
    const seeded = await fixtures.installs.transition(
      install.id,
      'build_pending',
      'endpoint_verified',
      install.leaseToken,
      { detail: { webhookEndpointId: endpoint.id } },
    )
    if (!seeded.ok) throw new Error('seeding endpoint_verified failed')
    const rewound = await fixtures.installs.transition(
      seeded.install.id,
      'endpoint_verified',
      'build_pending',
      seeded.install.leaseToken,
    )
    if (!rewound.ok) throw new Error('rewinding to build_pending failed')

    // No remoteDeploymentId was ever recorded, so `build_pending`'s own
    // step refuses permanently before ever touching the fake provider —
    // any failInstall call exercises the cleanup path this test cares
    // about, regardless of which reason triggered it.
    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider)
    const result = await createModuleInstallHandler(deps)(
      makeMessage({ installId: install0.id, operatorEnvVars: {} }),
    )
    expect(result.kind).toBe('deadLetter')

    const final = await fixtures.installs.get(install0.id)
    expect(final?.state).toBe('build_failed')

    const endpoints = await fixtures.webhookEndpoints.list()
    expect(endpoints.find((e) => e.id === endpoint.id)?.status).toBe('disabled')
  })

  // Fenced lease renewal (module doc's own long-running-step gap) — a
  // worker that has lost the fence mid-step must abort before its next
  // remote call, never complete a step whose remote side effect a NEWER
  // worker might already be duplicating.
  it('a lease renewal that loses the fence aborts before the next provider call', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider, calls } = createFakeDeployProvider()

    const fenceLostInstalls: ModuleInstallStore = {
      ...fixtures.installs,
      async renew() {
        return false
      },
    }
    const deps = baseDeps(fixtures, provider, { installs: fenceLostInstalls })
    const result = await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )

    // createProject (credentials_issued -> project_created) has no
    // renewal checkpoint of its own — it's the first remote call after a
    // fresh claim, still well inside the claim-time lease — so it still
    // runs once. `artifact_uploaded`'s renewal check, right before the
    // catalog download, is the first to see the lost fence and aborts —
    // uploadArtifact/createDeployment/getDeploymentState must never run.
    expect(result).toEqual({ kind: 'ack' })
    expect(calls.createProject).toBe(1)
    expect(calls.uploadArtifact).toBe(0)
    expect(calls.createDeployment).toBe(0)
    expect(calls.getDeploymentState).toBe(0)

    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('project_created')
  })

  it('an update with no drift is a no-op ack', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    const handler = createModuleInstallHandler(deps)

    await handler(makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }))

    const result = await handler(
      makeMessage({
        installId: install.id,
        operatorEnvVars: { THIRD_PARTY_KEY: 'a-new-value' },
        isUpdate: true,
      }),
    )
    expect(result).toEqual({ kind: 'ack' })
  })

  // F1b: a crash between winning bootstrap_pending's own CAS to
  // `endpoint_verified` and any further code running in that process must
  // not leave the endpoint permanently disabled.
  it('a crash right after the endpoint_verified CAS commits still reaches active with the endpoint ACTIVE, not disabled', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider()

    // The real CAS is allowed to commit for real (so `install.state` is
    // genuinely `endpoint_verified` in the database afterward), but the
    // simulated worker throws immediately after — modeling a process death
    // between that commit and anything else running in this invocation
    // (in particular, the OLD inline `patch(...active)` this fix removed).
    let crashed = false
    const crashyInstalls: ModuleInstallStore = {
      ...fixtures.installs,
      async transition(id, from, to, fence, options) {
        const result = await fixtures.installs.transition(id, from, to, fence, options)
        if (!crashed && from === 'bootstrap_pending' && to === 'endpoint_verified' && result.ok) {
          crashed = true
          throw new Error('simulated crash right after the endpoint_verified CAS committed')
        }
        return result
      },
    }
    const crashyDeps = baseDeps(fixtures, provider, {
      installs: crashyInstalls,
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })

    await expect(
      createModuleInstallHandler(crashyDeps)(
        makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
      ),
    ).rejects.toThrow('simulated crash')

    // The CAS genuinely committed — the row is recoverable, not stuck
    // mid-transition — but the endpoint this crashed worker never got to
    // touch is still DISABLED.
    const afterCrash = await fixtures.installs.get(install.id)
    expect(afterCrash?.state).toBe('endpoint_verified')
    const endpointsAfterCrash = await fixtures.webhookEndpoints.list()
    expect(endpointsAfterCrash).toHaveLength(1)
    expect(endpointsAfterCrash[0].status).toBe('disabled')

    // Simulate the crashed worker's lease naturally elapsing (this test
    // does not wait out the real TTL) so a later redelivery can reclaim it.
    await fixtures.db.query(
      `UPDATE module_installs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [install.id],
    )

    // A later, ordinary redelivery re-enters `endpoint_verified` and
    // reconciles the endpoint BEFORE attempting the CAS to `active` — FIX
    // 1b's `ensureEndpointActive`, run unconditionally on every entry into
    // this state.
    const recoveredDeps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    const recovered = await createModuleInstallHandler(recoveredDeps)(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )
    expect(recovered).toEqual({ kind: 'ack' })

    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('active')
    const endpointsFinal = await fixtures.webhookEndpoints.list()
    expect(endpointsFinal).toHaveLength(1)
    expect(endpointsFinal[0].status).toBe('active')
  })

  // F1a: a live lease only proves someone holds it right now, never that
  // they're still alive to finish the job.
  it('a lease_held claim refusal is a retry, never an ack that could permanently strand the install', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const claimedByOther = await fixtures.installs.claim(install.id, 300)
    expect(claimedByOther.ok).toBe(true)

    const { provider } = createFakeDeployProvider()
    const deps = baseDeps(fixtures, provider)
    const result = await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: {} }),
    )

    expect(result.kind).toBe('retry')
    if (result.kind === 'retry') {
      expect(result.backoffSeconds).toBeGreaterThan(0)
    }
  })

  // F2: BUILD_POLL_MAX_ATTEMPTS must actually be reachable — a build that
  // never becomes ready must land in a TERMINAL state, never strand the
  // row at build_pending forever with credentials already minted and real
  // hosting resources already created.
  it('a build that never becomes ready is permanently failed once BUILD_POLL_MAX_ATTEMPTS is reached, never stranded at build_pending', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider, calls } = createFakeDeployProvider({
      buildStates: Array(BUILD_POLL_MAX_ATTEMPTS + 5).fill('building'),
    })

    const enqueueCalls: { job: ModuleInstallJob; delaySeconds: number }[] = []
    const deps = baseDeps(fixtures, provider, {
      // A fake standing in for the composition root's real QueueProvider —
      // just records the follow-up job rather than actually redelivering
      // it, so this test drives each "poll" explicitly.
      enqueueInstallJob: async (job, delaySeconds) => {
        enqueueCalls.push({ job, delaySeconds })
      },
    })
    const handler = createModuleInstallHandler(deps)

    let result = await handler(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )

    let iterations = 0
    while (result.kind !== 'deadLetter' && iterations < BUILD_POLL_MAX_ATTEMPTS + 5) {
      const next = enqueueCalls.shift()
      if (next === undefined) break
      // Every follow-up poll is scheduled at the same flat 15s delay —
      // never the queue adapter's exponential multiplier.
      expect(next.delaySeconds).toBe(15)
      result = await handler(makeMessage(next.job))
      iterations += 1
    }

    expect(result.kind).toBe('deadLetter')
    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('build_failed')
    expect(calls.getDeploymentState).toBe(BUILD_POLL_MAX_ATTEMPTS)

    // Failure policy already in force for `build_failed`: minted
    // credentials are revoked.
    const assistants = await fixtures.assistants.list()
    expect(assistants).toHaveLength(1)
    expect(assistants[0].status).toBe('disabled')
  })

  // F4: `create`'s url-coalescing (`../../store/webhook-endpoints.ts`)
  // returns the EXISTING row's own secret on a conflict — never the
  // caller's freshly-supplied one. If a different owner already registered
  // an endpoint at the same url, this install must never silently promote
  // itself onto that row.
  it("refuses to promote onto a coalesced webhook endpoint holding a DIFFERENT owner's secret", async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider()

    // The fake deploy provider's first deployment is always
    // `https://module-1.example.test` — pre-register an endpoint at that
    // SAME url under a DIFFERENT secret (an operator-registered endpoint,
    // or a re-provisioned install after rotation).
    const preexisting = await fixtures.webhookEndpoints.create({
      url: 'https://module-1.example.test',
      secret: 'someone-elses-secret',
      events: [],
      module: 'a-different-module',
      status: 'disabled',
    })

    const deps = baseDeps(fixtures, provider, {
      challenge: { send: correctChallengeSend(fixtures.installs, install.id) },
    })
    const result = await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: { THIRD_PARTY_KEY: 'x' } }),
    )

    expect(result.kind).toBe('deadLetter')
    const final = await fixtures.installs.get(install.id)
    expect(final?.state).toBe('cleanup_required')

    // The other owner's row and secret are completely untouched.
    const untouchedSecret = await fixtures.webhookEndpoints.getSecret(preexisting.id)
    expect(untouchedSecret).toBe('someone-elses-secret')
    const endpoints = await fixtures.webhookEndpoints.list()
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0].module).toBe('a-different-module')
  })

  // F6: a permanently-failed install must release its lease with the
  // WINNING transition's own new token, not leave it held under the stale
  // pre-transition token for the full claim TTL.
  it('a permanently-failed install releases its lease immediately, not for the full claim TTL', async () => {
    const fixtures = await freshFixtures()
    const install = await fixtures.installs.create(newInstallInput(fixtures.connectionId))
    const { provider } = createFakeDeployProvider({ buildStates: ['error'] })
    const deps = baseDeps(fixtures, provider)

    const result = await createModuleInstallHandler(deps)(
      makeMessage({ installId: install.id, operatorEnvVars: {} }),
    )
    expect(result.kind).toBe('deadLetter')

    // A fresh claim succeeds immediately — if the release had used the
    // stale pre-transition token, this would be refused with 'lease_held'
    // for the remainder of the TTL.
    const reclaimed = await fixtures.installs.claim(install.id, 300)
    expect(reclaimed.ok).toBe(true)
    // Hand it straight back: claiming re-mints the token, so holding it
    // here would starve the redelivery below of the very lease this just
    // proved was free.
    if (reclaimed.ok) {
      await fixtures.installs.release(install.id, reclaimed.install.leaseToken)
    }
  })
})
