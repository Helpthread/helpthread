/**
 * The `verify` subcommand (HT-116): fully offline verification of a
 * tarball/manifest/signature triple against this CLI's compiled-in trust
 * store. This is the fork/AGPL-honesty path — anyone can check a release
 * artifact's authenticity without talking to marketplace.helpthread.app at
 * all, using only Helpthread's own open-source verifier.
 */
import * as fs from 'node:fs'
import type { VerifyOptions } from './args.js'
import { TRUST_STORE } from './trust-store.js'
import { verifyArtifact } from './verify-core.js'

export class VerifyCommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerifyCommandError'
  }
}

export interface VerifyDeps {
  log: (line: string) => void
  fsImpl?: typeof fs
}

export async function runVerify(options: VerifyOptions, deps: VerifyDeps): Promise<void> {
  const fsImpl = deps.fsImpl ?? fs

  deps.log(
    `1. Reading ${options.tarballPath}, ${options.manifestPath}, ${options.signaturePath}...`,
  )
  let tarballBytes: Buffer
  let manifestJson: string
  let signature: string
  try {
    tarballBytes = fsImpl.readFileSync(options.tarballPath)
  } catch (err) {
    throw new VerifyCommandError(
      `could not read tarball '${options.tarballPath}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  try {
    manifestJson = fsImpl.readFileSync(options.manifestPath, 'utf8')
  } catch (err) {
    throw new VerifyCommandError(
      `could not read manifest '${options.manifestPath}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  try {
    signature = fsImpl.readFileSync(options.signaturePath, 'utf8').trim()
  } catch (err) {
    throw new VerifyCommandError(
      `could not read signature '${options.signaturePath}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  deps.log(
    '2. Checking checksum, size, and signature against the compiled-in trust store (offline, no network)...',
  )
  const result = verifyArtifact(tarballBytes, manifestJson, signature, TRUST_STORE)
  if (!result.ok) {
    throw new VerifyCommandError(`FAILED (${result.code}): ${result.message}`)
  }

  deps.log('3. OK.')
  deps.log(`   module:  ${result.manifest.module}`)
  deps.log(`   version: ${result.manifest.semver}`)
  deps.log(`   keyId:   ${result.manifest.keyId}`)
  deps.log(`   sha256:  ${result.manifest.artifactSha256}`)
}
