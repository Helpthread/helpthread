/**
 * `createLocalManualDeployProvider` — the no-hosting-account fallback, and
 * the proof that `DeployProvider` (`./provider.ts`) is genuinely
 * vendor-neutral (HT-119).
 *
 * ## Why this exists
 *
 * Two independent reasons, both real:
 *
 * 1. **Proof of the interface.** `./vercel-adapter.ts` is complex enough
 *    (an allowlist, team-id binding, hostile-artifact rejection) that it
 *    would be easy for the install/orchestration logic upstream to grow an
 *    implicit dependency on some Vercel-shaped detail of it — a field that
 *    "happens" to always be present, an error message format, a call
 *    ordering only Vercel's API needs. A second, trivially-simple
 *    implementation with a completely different execution model (writes to
 *    a local directory instead of calling a remote API) is what actually
 *    catches that kind of drift: if the install logic only compiles and
 *    passes its tests against the Vercel adapter, `DeployProvider` was
 *    never really the seam it claimed to be.
 * 2. **A real fallback.** Not every operator running Helpthread has (or
 *    wants) a Vercel account. This implementation writes a module's
 *    prebuilt artifact to a local directory and returns instructions
 *    instead of calling any hosting API — an operator can point their own
 *    deploy tooling (any static host, any CI) at the resulting directory.
 *    It is deliberately manual: this module doesn't try to guess how to
 *    run the resulting bundle, because a bundle built for the Vercel Build
 *    Output API v3 shape isn't portable to just any host without operator
 *    judgment about what's on the other end.
 *
 * ## What "deployed" means here
 *
 * There is no async remote side to wait on, so
 * {@link createLocalManualDeployProvider}'s `createDeployment` writes the
 * files synchronously-under-the-hood and returns a deployment that is
 * already `'ready'` — `getDeploymentState` is `'ready'` from the first
 * call onward.  A `file://` URL stands in for a reachable deployment URL;
 * it is not one (nothing serves it), and the caller's own next step
 * (printed in `CreateDeploymentResult.url`'s companion instructions, when
 * a caller chooses to surface them) is "look in this directory and deploy
 * it yourself."
 *
 * ## Env vars
 *
 * `setEnvVars` writes a `.env.local`-shaped file into the project
 * directory rather than injecting values into any running process — there
 * is no running process this provider controls. Values marked `sensitive`
 * are written like any other value (the file itself is the operator's own
 * local disk, the same trust boundary as every other file this provider
 * writes) but the returned promise never echoes them back, matching the
 * `DeployProvider` contract every other implementation upholds.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  CreateDeploymentInput,
  CreateDeploymentResult,
  CreateProjectInput,
  CreateProjectResult,
  DeleteProjectInput,
  DeployProvider,
  GetDeploymentStateInput,
  GetDeploymentStateResult,
  SetEnvVarsInput,
  UploadArtifactInput,
  UploadArtifactResult,
} from './provider.js'

export interface LocalManualDeployProviderConfig {
  /** Root directory under which one subdirectory per project id is written. Must already exist. */
  outputDir: string
}

/** Thrown by {@link createLocalManualDeployProvider}'s methods on a `teamId` that doesn't match the connection's — same discipline as `./vercel-adapter.ts`, kept even though this provider has no real remote account to protect, so a caller cannot depend on "local-manual doesn't check" as a shortcut. */
export class LocalManualDeployError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalManualDeployError'
  }
}

/** Reject a path component that would let a project name escape `outputDir` (traversal, absolute paths) — the same spirit as `../artifact/extract.ts`'s tar-entry containment checks, applied to a name this module itself constructs a filesystem path from. */
function assertSafeProjectId(projectId: string): void {
  if (
    projectId.length === 0 ||
    projectId.includes('/') ||
    projectId.includes('\\') ||
    projectId === '.' ||
    projectId === '..'
  ) {
    throw new LocalManualDeployError(`local-manual: unsafe project id: '${projectId}'`)
  }
}

/**
 * A `DeployProvider` scoped to one immutable `teamId`, purely for the same
 * "refuse a mismatched team id" discipline every other implementation
 * upholds — there is no real multi-tenant account underneath this
 * provider, so `teamId` here is just an opaque label the caller chose.
 */
export function createLocalManualDeployProvider(
  boundTeamId: string,
  config: LocalManualDeployProviderConfig,
): DeployProvider {
  function assertTeam(teamId: string): void {
    if (teamId !== boundTeamId) {
      throw new LocalManualDeployError(
        `local-manual: refusing operation for team '${teamId}' — this provider is bound to '${boundTeamId}'`,
      )
    }
  }

  function projectDir(projectId: string): string {
    assertSafeProjectId(projectId)
    return path.join(config.outputDir, projectId)
  }

  return {
    async createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
      assertTeam(input.teamId)
      // A local directory has no separate "create" step distinct from
      // "write files into it" — the project id IS the sanitized name, and
      // the directory is created empty here so a later `uploadArtifact`
      // has somewhere to write.
      const projectId = input.name
      const dir = projectDir(projectId)
      await mkdir(dir, { recursive: true })
      return { projectId }
    },

    async uploadArtifact(input: UploadArtifactInput): Promise<UploadArtifactResult> {
      assertTeam(input.teamId)
      const dir = projectDir(input.projectId)
      for (const file of input.files) {
        const dest = path.join(dir, file.path)
        // Same containment discipline as `../artifact/extract.ts`: an
        // artifact file's path must resolve inside the project directory,
        // never escape it via `..` — `uploadArtifact` receives files from
        // an ALREADY-safeExtract'd artifact in the intended caller
        // pattern, but this provider does not assume that and re-checks
        // rather than trusting an upstream guarantee it cannot see.
        const resolvedDest = path.resolve(dest)
        const resolvedDir = path.resolve(dir)
        if (resolvedDest !== resolvedDir && !resolvedDest.startsWith(resolvedDir + path.sep)) {
          throw new LocalManualDeployError(
            `local-manual: refusing artifact file path that escapes the project directory: '${file.path}'`,
          )
        }
        await mkdir(path.dirname(resolvedDest), { recursive: true })
        await writeFile(resolvedDest, file.data)
      }
      // No separate remote upload identity exists — the project directory
      // itself is the "upload."
      return { uploadId: input.projectId }
    },

    async createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult> {
      assertTeam(input.teamId)
      const dir = projectDir(input.projectId)
      return {
        deploymentId: input.projectId,
        url: `file://${path.resolve(dir)}`,
      }
    },

    async getDeploymentState(input: GetDeploymentStateInput): Promise<GetDeploymentStateResult> {
      assertTeam(input.teamId)
      // Files were already written synchronously by uploadArtifact/
      // createDeployment — there is nothing left to become ready.
      return { state: 'ready', url: `file://${path.resolve(projectDir(input.deploymentId))}` }
    },

    async setEnvVars(input: SetEnvVarsInput): Promise<void> {
      assertTeam(input.teamId)
      const dir = projectDir(input.projectId)
      await mkdir(dir, { recursive: true })
      // `.env.local` is a `KEY=value`-per-line format: an unescaped `\n`
      // (or `\r`) in either a key or a value splits into a SECOND line the
      // file's own reader will parse as its own assignment — a value like
      // `'x\nEVIL_VAR=y'` would inject `EVIL_VAR=y` as a wholly separate,
      // unintended env var rather than staying part of the one value it
      // came from. Refused outright rather than silently escaped: a
      // caller-supplied value here is meant to be read back byte-for-byte
      // by whatever the operator points at this directory, and there is no
      // escaping convention this format defines that every such reader is
      // guaranteed to honor.
      for (const v of input.vars) {
        if (v.key.includes('\n') || v.key.includes('\r')) {
          throw new LocalManualDeployError(
            `local-manual: refusing env var whose KEY contains a newline: '${JSON.stringify(v.key)}'`,
          )
        }
        if (v.value.includes('\n') || v.value.includes('\r')) {
          throw new LocalManualDeployError(
            `local-manual: refusing env var '${v.key}' whose value contains a newline`,
          )
        }
      }
      const lines = input.vars.map((v) => `${v.key}=${v.value}`)
      await writeFile(path.join(dir, '.env.local'), `${lines.join('\n')}\n`, 'utf8')
    },

    async deleteProject(input: DeleteProjectInput): Promise<void> {
      assertTeam(input.teamId)
      const dir = projectDir(input.projectId)
      await rm(dir, { recursive: true, force: true })
    },
  }
}
