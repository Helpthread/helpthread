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
export async function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const stdout = process.stdout
    stdout.write(promptText)

    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: undefined, terminal: false })
      rl.question('', (answer) => {
        rl.close()
        resolve(answer)
      })
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
          resolve(value)
          return
        }
        if (ch === '') {
          // Ctrl-C
          cleanup()
          reject(new Error('prompt cancelled'))
          return
        }
        if (ch === '' || ch === '\b') {
          // Backspace
          value = value.slice(0, -1)
          continue
        }
        value += ch
      }
    }
    const cleanup = () => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(Boolean(wasRaw))
      stdin.pause()
    }
    stdin.on('data', onData)
  })
}
