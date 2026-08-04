/**
 * The `install` subcommand's orchestration (HT-116): resolve a module +
 * version from the marketplace, prompt for a license key, download,
 * verify against the compiled-in trust store, extract, and print next
 * steps. Everything I/O-shaped (network, prompt, filesystem) is passed in
 * as a `deps` object so the ordering/branching logic can be exercised in
 * tests without a network or a TTY; `cli/src/main.ts` wires the real
 * implementations.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseModuleConfig, safeExtract } from '../../src/modules/artifact/index.js'
import type { InstallOptions } from './args.js'
import {
  type CatalogModule,
  type CatalogModuleVersion,
  DEFAULT_CATALOG_ORIGIN,
  type FetchLike,
  fetchCatalog,
  fetchTarball,
  findModule,
  requestDownloadUrl,
  resolveVersion,
} from './catalog.js'
import { renderEnvSummary } from './env-summary.js'
import { TRUST_STORE } from './trust-store.js'
import { verifyArtifact } from './verify-core.js'

export interface InstallDeps {
  fetchImpl: FetchLike
  /** Returns the license key. Real wiring checks $HELPTHREAD_LICENSE_KEY first, then prompts hidden. */
  getLicenseKey: () => Promise<string>
  log: (line: string) => void
  /** Real wiring is `fs`; tests can stub. */
  fsImpl?: typeof fs
  /**
   * keyId -> trusted public key. Defaults to the CLI's real compiled-in
   * {@link TRUST_STORE}; overridable ONLY so tests can exercise the full
   * success path with a locally generated test keypair instead of the
   * real `riq-2026` private key (which this repo never holds). Production
   * wiring in `main.ts` never passes this — the effective trust store is
   * always the compiled-in one.
   */
  trustStore?: Readonly<Record<string, string>>
}

/** Thrown to signal "print this message and exit non-zero" without a stack trace dump. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}

export async function runInstall(options: InstallOptions, deps: InstallDeps): Promise<void> {
  const fsImpl = deps.fsImpl ?? fs
  const trustStore = deps.trustStore ?? TRUST_STORE
  const catalogOrigin =
    options.catalogOrigin ?? process.env.HELPTHREAD_CATALOG_ORIGIN ?? DEFAULT_CATALOG_ORIGIN

  deps.log(`1. Looking up '${options.moduleSlug}' on ${catalogOrigin}`)
  const catalog = await fetchCatalog(catalogOrigin, deps.fetchImpl)
  const mod = findModule(catalog, options.moduleSlug)
  if (!mod) {
    throw new InstallError(`no module named '${options.moduleSlug}' was found on ${catalogOrigin}`)
  }

  const versionEntry = resolveVersion(mod, options.version)
  if (versionEntry.yanked) {
    deps.log(
      `   NOTE: version ${versionEntry.version} is marked yanked; installing it anyway because it was pinned with --version.`,
    )
  }
  deps.log(`   Resolved ${mod.name} @ ${versionEntry.version}`)

  deps.log('2. License key required.')
  const licenseKey = process.env.HELPTHREAD_LICENSE_KEY ?? (await deps.getLicenseKey())
  if (!licenseKey) {
    throw new InstallError('no license key provided')
  }

  deps.log('3. Requesting a download link from the marketplace...')
  const download = await requestDownloadUrl(
    catalogOrigin,
    deps.fetchImpl,
    licenseKey,
    mod.slug,
    versionEntry.version,
  )

  // The marketplace decides which version a license is ENTITLED to, and it
  // is not always the one asked for: a lapsed license is served the version
  // its entitlement snapshot names, not the current latest. The served
  // version is therefore authoritative, and the manifest we verify against
  // must be the one for THAT version — verifying the requested version's
  // manifest against the served version's bytes would fail the digest check
  // and report "tarball does not match its manifest," which is both wrong
  // and alarming when the real story is an ordinary entitlement outcome.
  // A catalog that omits `version` (an older marketplace, or a third-party
  // one) falls back to what we asked for rather than failing: the SECURITY
  // guarantee here is the signature and digest check below, which catches
  // any mismatch regardless. This resolution exists to make the resulting
  // message accurate, not to be the safety net.
  const servedVersion = download.version ?? versionEntry.version
  const servedEntry =
    servedVersion === versionEntry.version
      ? versionEntry
      : mod.versions.find((v) => v.version === servedVersion)
  if (servedEntry === undefined) {
    throw new InstallError(
      `the marketplace served version ${servedVersion}, which is not in its own public feed — refusing to install an artifact whose manifest cannot be independently located.`,
    )
  }
  if (servedEntry !== versionEntry) {
    deps.log(
      `   NOTE: your license entitles you to ${servedEntry.version}, not ${versionEntry.version}. Installing ${servedEntry.version}.`,
    )
  }

  deps.log('4. Downloading the release artifact...')
  const tarballBytes = await fetchTarball(download.downloadUrl, deps.fetchImpl)
  const tmpDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'helpthread-module-'))
  const tmpTarballPath = path.join(tmpDir, `${mod.slug}-${servedEntry.version}.tar.gz`)
  fsImpl.writeFileSync(tmpTarballPath, tarballBytes)

  // Everything from here runs inside try/finally: this is PAID, proprietary
  // software sitting in a world-readable temp directory, and any failure
  // below — a refused destination, a bad archive entry, a missing config —
  // would otherwise leave it there indefinitely. Cleanup must not depend on
  // reaching a particular branch.
  try {
    await installVerifiedArtifact({
      deps,
      fsImpl,
      trustStore,
      options,
      mod,
      servedEntry,
      tarballBytes,
    })
  } finally {
    try {
      fsImpl.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}

interface VerifiedInstallArgs {
  deps: InstallDeps
  fsImpl: typeof fs
  trustStore: Readonly<Record<string, string>>
  options: InstallOptions
  mod: CatalogModule
  servedEntry: CatalogModuleVersion
  tarballBytes: Buffer
}

/** Verify-then-extract, split out so the caller's `finally` owns temp-file cleanup on every path. */
async function installVerifiedArtifact({
  deps,
  fsImpl,
  trustStore,
  options,
  mod,
  servedEntry,
  tarballBytes,
}: VerifiedInstallArgs): Promise<void> {
  deps.log('5. Verifying checksum, size, and signature against the compiled-in trust store...')
  const trustedKeyPresent = trustStore[servedEntry.manifestKeyId] !== undefined
  if (!trustedKeyPresent) {
    throw new InstallError(
      `refusing to install: manifest keyId '${servedEntry.manifestKeyId}' is not in this CLI's trust store`,
    )
  }
  const verification = verifyArtifact(
    tarballBytes,
    servedEntry.manifest,
    servedEntry.manifestSignature,
    trustStore,
  )
  if (!verification.ok) {
    throw new InstallError(
      `refusing to install: verification failed (${verification.code}): ${verification.message}`,
    )
  }

  // A valid signature proves the artifact is AUTHENTIC. It does not prove
  // it is the artifact that was ASKED FOR — every first-party release is
  // signed by the same key, so a compromised marketplace could answer a
  // request for module A, version X with a genuinely-signed module B,
  // version Y and every check above would pass. Bind the verified
  // manifest's own claims to what was requested; this is the difference
  // between "someone we trust signed this" and "this is what we ordered".
  if (verification.manifest.module !== mod.slug) {
    throw new InstallError(
      `refusing to install: asked for '${mod.slug}' but the signed manifest describes '${verification.manifest.module}'. The artifact is authentic but it is not the module requested.`,
    )
  }
  if (verification.manifest.semver !== servedEntry.version) {
    throw new InstallError(
      `refusing to install: expected version ${servedEntry.version} but the signed manifest describes ${verification.manifest.semver}. The artifact is authentic but it is not the version served.`,
    )
  }
  deps.log('   Verified.')

  const destDir = options.dir ?? path.join(process.cwd(), mod.slug)
  deps.log(`6. Extracting to ${destDir}...`)
  prepareDestDir(fsImpl, destDir, options.force)
  const written = await safeExtract(tarballBytes, destDir)
  deps.log(`   Extracted ${written.length} file(s).`)

  deps.log('7. Reading module.config.json...')
  const configPath = path.join(destDir, 'module.config.json')
  if (!fsImpl.existsSync(configPath)) {
    throw new InstallError(`extracted module is missing module.config.json at ${configPath}`)
  }
  const config = parseModuleConfig(fsImpl.readFileSync(configPath, 'utf8'))
  deps.log('')
  deps.log(renderEnvSummary(config))

  deps.log('')
  deps.log('8. Next step (this CLI does not run it for you):')
  deps.log(`   cd ${path.relative(process.cwd(), destDir) || '.'} && vercel deploy --prebuilt`)
}

function prepareDestDir(fsImpl: typeof fs, destDir: string, force: boolean): void {
  const exists = fsImpl.existsSync(destDir)
  if (!exists) {
    fsImpl.mkdirSync(destDir, { recursive: true })
    return
  }
  const stat = fsImpl.statSync(destDir)
  if (!stat.isDirectory()) {
    throw new InstallError(`extraction target exists and is not a directory: ${destDir}`)
  }
  const isEmpty = fsImpl.readdirSync(destDir).length === 0
  if (isEmpty) return
  if (!force) {
    throw new InstallError(
      `extraction target '${destDir}' already exists and is not empty (pass --force to overwrite)`,
    )
  }
  for (const entry of fsImpl.readdirSync(destDir)) {
    fsImpl.rmSync(path.join(destDir, entry), { recursive: true, force: true })
  }
}
