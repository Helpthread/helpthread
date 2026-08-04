/**
 * Pure argv parsing for the two `helpthread-module` subcommands (HT-116).
 * No I/O, no `process.argv` reads here — callers pass the argv slice in
 * and get back a parsed options object or a thrown {@link ArgsError} with
 * a message suitable for printing directly to the operator.
 */

export class ArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgsError'
  }
}

export interface InstallOptions {
  help: false
  moduleSlug: string
  catalogOrigin?: string
  version?: string
  dir?: string
  force: boolean
}

export interface HelpRequested {
  help: true
}

export const INSTALL_HELP = `Usage: helpthread-module install <module-slug> [options]

Download, verify, and extract a Helpthread module release from the marketplace.

Options:
  --catalog <origin>   Catalog origin (default: https://marketplace.helpthread.app,
                        or $HELPTHREAD_CATALOG_ORIGIN)
  --version <semver>   Install a specific version instead of the latest non-yanked one
  --dir <path>         Extraction directory (default: ./<module-slug>)
  --force              Allow extracting into a non-empty directory
  -h, --help           Show this help

The license key is read from $HELPTHREAD_LICENSE_KEY, or prompted for (hidden input)
if that variable is not set. It is never logged, printed, or written to disk.`

/** Parse `install` subcommand args (the argv slice AFTER the leading `install` token). */
export function parseInstallArgs(argv: string[]): InstallOptions | HelpRequested {
  let moduleSlug: string | undefined
  let catalogOrigin: string | undefined
  let version: string | undefined
  let dir: string | undefined
  let force = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        return { help: true }
      case '--catalog':
        catalogOrigin = argv[++i]
        if (!catalogOrigin || catalogOrigin.startsWith('-')) {
          throw new ArgsError('--catalog requires a value')
        }
        break
      case '--version':
        version = argv[++i]
        if (!version || version.startsWith('-')) {
          throw new ArgsError('--version requires a value')
        }
        break
      case '--dir':
        dir = argv[++i]
        if (!dir || dir.startsWith('-')) {
          throw new ArgsError('--dir requires a value')
        }
        break
      case '--force':
        force = true
        break
      default:
        if (arg.startsWith('-')) {
          throw new ArgsError(`unknown option: '${arg}'`)
        }
        if (moduleSlug) {
          throw new ArgsError(`unexpected extra argument: '${arg}'`)
        }
        moduleSlug = arg
    }
  }

  if (!moduleSlug) {
    throw new ArgsError('missing required argument: <module-slug>')
  }

  return { help: false, moduleSlug, catalogOrigin, version, dir, force }
}

export interface VerifyOptions {
  help: false
  tarballPath: string
  manifestPath: string
  signaturePath: string
}

export const VERIFY_HELP = `Usage: helpthread-module verify <tarball> --manifest <path> --signature <path>

Fully offline: verifies a module tarball's checksum, size, and manifest signature
against this CLI's compiled-in trust store. No network access.

Options:
  --manifest <path>    Path to the release's .manifest.json
  --signature <path>   Path to the release's .manifest.sig
  -h, --help           Show this help`

/** Parse `verify` subcommand args (the argv slice AFTER the leading `verify` token). */
export function parseVerifyArgs(argv: string[]): VerifyOptions | HelpRequested {
  let tarballPath: string | undefined
  let manifestPath: string | undefined
  let signaturePath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        return { help: true }
      case '--manifest':
        manifestPath = argv[++i]
        if (!manifestPath || manifestPath.startsWith('-')) {
          throw new ArgsError('--manifest requires a value')
        }
        break
      case '--signature':
        signaturePath = argv[++i]
        if (!signaturePath || signaturePath.startsWith('-')) {
          throw new ArgsError('--signature requires a value')
        }
        break
      default:
        if (arg.startsWith('-')) {
          throw new ArgsError(`unknown option: '${arg}'`)
        }
        if (tarballPath) {
          throw new ArgsError(`unexpected extra argument: '${arg}'`)
        }
        tarballPath = arg
    }
  }

  if (!tarballPath) throw new ArgsError('missing required argument: <tarball>')
  if (!manifestPath) throw new ArgsError('missing required option: --manifest <path>')
  if (!signaturePath) throw new ArgsError('missing required option: --signature <path>')

  return { help: false, tarballPath, manifestPath, signaturePath }
}
