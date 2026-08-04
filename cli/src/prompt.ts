/**
 * Hidden-input prompt for the license key (HT-116). Isolated in its own
 * file because it's the one place this CLI touches the raw TTY — everything
 * else is pure and unit-tested; this is exercised by hand /
 * integration-only.
 */
import * as readline from 'node:readline'

/**
 * Prompt `promptText` on stdout and read a line from stdin without
 * echoing it back — the license key must never appear on screen, in shell
 * history (it isn't typed as an arg), or in any log this process writes.
 * Falls back to a normal (echoed) read if stdin is not a TTY (e.g. piped
 * input in a script or test), since raw mode requires a TTY.
 */
const CTRL_C = '\x03'
const BACKSPACE_DEL = '\x7f'
const BACKSPACE_BS = '\x08'

export async function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const stdout = process.stdout
    stdout.write(promptText)

    let settled = false
    const settleResolve = (answer: string) => {
      if (settled) return
      settled = true
      resolve(answer)
    }
    const settleReject = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }

    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: undefined, terminal: false })
      const onClose = () => {
        settleReject(new Error('prompt input closed before a value was read'))
      }
      const onError = (err: Error) => {
        settleReject(err)
      }
      rl.question('', (answer) => {
        rl.off('close', onClose)
        stdin.off('error', onError)
        rl.close()
        settleResolve(answer)
      })
      // Non-TTY input (piped/redirected) that closes or errors without a
      // line ever being sent must not leave this promise pending forever --
      // `question`'s callback never fires in that case.
      rl.on('close', onClose)
      stdin.on('error', onError)
      return
    }

    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r') {
          cleanup()
          stdout.write('\n')
          settleResolve(value)
          return
        }
        if (ch === CTRL_C) {
          cleanup()
          settleReject(new Error('prompt cancelled'))
          return
        }
        if (ch === BACKSPACE_DEL || ch === BACKSPACE_BS) {
          value = value.slice(0, -1)
          continue
        }
        value += ch
      }
    }
    const onClose = () => {
      cleanup()
      settleReject(new Error('prompt input closed before a value was read'))
    }
    const onError = (err: Error) => {
      cleanup()
      settleReject(err)
    }
    const cleanup = () => {
      stdin.removeListener('data', onData)
      stdin.removeListener('close', onClose)
      stdin.removeListener('error', onError)
      stdin.setRawMode(Boolean(wasRaw))
      stdin.pause()
    }
    stdin.on('data', onData)
    stdin.on('close', onClose)
    stdin.on('error', onError)
  })
}
