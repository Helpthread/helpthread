#!/usr/bin/env node
/**
 * `helpthread-module` CLI entrypoint (HT-116). Dispatches to `install` and
 * `verify`; everything else lives in the other files in this directory so
 * it can be unit-tested without a process/TTY.
 */
import { ArgsError, INSTALL_HELP, parseInstallArgs, parseVerifyArgs, VERIFY_HELP } from './args.js'
import { InstallError, runInstall } from './install.js'
import { promptHidden } from './prompt.js'
import { runVerify, VerifyCommandError } from './verify.js'

const TOP_LEVEL_HELP = `Usage: helpthread-module <command> [options]

Commands:
  install <module-slug>   Download, verify, and extract a module from the marketplace
  verify <tarball>        Offline: verify a tarball against this CLI's trust store

Run 'helpthread-module <command> --help' for command-specific options.`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (!command || command === '-h' || command === '--help') {
    console.log(TOP_LEVEL_HELP)
    return command ? 0 : 1
  }

  if (command === 'install') {
    let parsed: ReturnType<typeof parseInstallArgs>
    try {
      parsed = parseInstallArgs(rest)
    } catch (err) {
      if (err instanceof ArgsError) {
        console.error(`Error: ${err.message}\n`)
        console.error(INSTALL_HELP)
        return 1
      }
      throw err
    }
    if (parsed.help) {
      console.log(INSTALL_HELP)
      return 0
    }
    try {
      await runInstall(parsed, {
        fetchImpl: fetch,
        getLicenseKey: () => promptHidden('License key: '),
        log: (line) => console.log(line),
      })
      return 0
    } catch (err) {
      if (err instanceof InstallError) {
        console.error(`Error: ${err.message}`)
        return 1
      }
      throw err
    }
  }

  if (command === 'verify') {
    let parsed: ReturnType<typeof parseVerifyArgs>
    try {
      parsed = parseVerifyArgs(rest)
    } catch (err) {
      if (err instanceof ArgsError) {
        console.error(`Error: ${err.message}\n`)
        console.error(VERIFY_HELP)
        return 1
      }
      throw err
    }
    if (parsed.help) {
      console.log(VERIFY_HELP)
      return 0
    }
    try {
      await runVerify(parsed, { log: (line) => console.log(line) })
      return 0
    } catch (err) {
      if (err instanceof VerifyCommandError) {
        console.error(`Error: ${err.message}`)
        return 1
      }
      throw err
    }
  }

  console.error(`Error: unknown command '${command}'\n`)
  console.error(TOP_LEVEL_HELP)
  return 1
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
    process.exitCode = 1
  },
)
