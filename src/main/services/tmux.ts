import { checkCommand, runCommand } from './command'
import { newSessionArgs, tmuxTarget, TMUX_SESSION_PREFIX } from '@shared/tmux-args'
import { SauronError } from '@shared/types'

/** Thin wrapper over the tmux CLI, using the user's default server. */
export class TmuxService {
  constructor(
    public readonly tmuxPath: string,
    public readonly environment: Record<string, string>,
  ) {}

  private run(args: string[]): Promise<string> {
    return checkCommand(this.tmuxPath, args, { env: this.environment })
  }

  async newSession(opts: { name: string; workingDir: string; environment: Record<string, string>; command: string[] }): Promise<void> {
    await this.run(newSessionArgs(opts))
    const t = tmuxTarget(opts.name)
    await this.run(['set-option', '-t', t, 'status', 'off'])
    await this.run(['set-option', '-t', t, 'mouse', 'on'])
    await this.run(['set-option', '-t', t, 'destroy-unattached', 'off'])
  }

  async hasSession(name: string): Promise<boolean> {
    const result = await runCommand(this.tmuxPath, ['has-session', '-t', tmuxTarget(name)], { env: this.environment }).catch(() => null)
    return result?.code === 0
  }

  /** Names of all sessions; an absent server yields an empty list. */
  async listSessions(): Promise<string[]> {
    const result = await runCommand(this.tmuxPath, ['list-sessions', '-F', '#{session_name}'], { env: this.environment })
    if (result.code !== 0) {
      if (/no server running|No such file/.test(result.stderr)) return []
      throw new SauronError('command_failed', `tmux list-sessions: ${result.stderr.trim()}`)
    }
    return result.stdout.split('\n').filter(Boolean)
  }

  async listSauronSessions(): Promise<string[]> {
    return (await this.listSessions()).filter((n) => n.startsWith(TMUX_SESSION_PREFIX))
  }

  async sendText(name: string, text: string): Promise<void> {
    await this.run(['send-keys', '-t', tmuxTarget(name), '-l', text])
    await this.run(['send-keys', '-t', tmuxTarget(name), 'Enter'])
  }

  async sendInterrupt(name: string): Promise<void> {
    await this.run(['send-keys', '-t', tmuxTarget(name), 'C-c'])
  }

  async killSession(name: string): Promise<void> {
    await this.run(['kill-session', '-t', tmuxTarget(name)])
  }
}
