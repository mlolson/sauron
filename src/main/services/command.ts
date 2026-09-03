import { spawn } from 'node:child_process'
import { SauronError } from '@shared/types'

export interface CommandResult {
  stdout: string
  stderr: string
  code: number
}

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Runs an executable and resolves when it exits, whatever the exit code.
 *
 * Resolution is tied to process exit, not to stdio close. A command that leaves a daemon
 * behind (tmux starting a fresh server) keeps the pipes open forever, so waiting for
 * close would hang. After exit we allow a short drain for any buffered output.
 */
export function runCommand(file: string, args: string[], opts: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })

    const finish = (code: number) => {
      if (settled) return
      settled = true
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ stdout, stderr, code })
    }
    child.once('exit', (code, signal) => {
      const exitCode = code ?? (signal ? 128 : 1)
      let closed = false
      child.once('close', () => {
        closed = true
        finish(exitCode)
      })
      setTimeout(() => {
        if (!closed) finish(exitCode)
      }, 100)
    })
  })
}

/** Runs an executable and throws `SauronError('command_failed')` on a non-zero exit. */
export async function checkCommand(file: string, args: string[], opts: CommandOptions = {}): Promise<string> {
  const result = await runCommand(file, args, opts)
  if (result.code !== 0) {
    const detail = result.stderr.trim()
    throw new SauronError(
      'command_failed',
      `${[file, ...args].join(' ')} exited with status ${result.code}${detail ? `: ${detail}` : ''}`,
    )
  }
  return result.stdout
}
