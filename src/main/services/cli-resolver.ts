import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { runCommand } from './command'
import type { ToolPaths } from '@shared/types'

/** Directories tools commonly install into; always searched last so a bare Finder launch still finds them. */
function commonToolDirs(): string[] {
  const home = homedir()
  return ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'), join(home, '.cargo/bin'), join(home, 'bin')]
}

function mergePath(...parts: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    for (const dir of part.split(':')) {
      if (dir && !seen.has(dir)) {
        seen.add(dir)
        out.push(dir)
      }
    }
  }
  return out.join(':')
}

/**
 * Asks the user's shell for PATH. GUI apps on macOS get a minimal environment, and many people
 * set PATH in .zshrc (interactive only), so this runs an interactive login shell. A marker
 * isolates the answer from anything rc files print, and a timeout guards against rc files
 * that block.
 */
export async function loginShellPath(): Promise<string> {
  const shell = process.env.SHELL || '/bin/zsh'
  const marker = 'SAURON_PATH_MARKER'
  let reported = ''
  for (const flags of ['-ilc', '-lc']) {
    try {
      const result = await runCommand(shell, [flags, `echo ${marker}$PATH`], { timeoutMs: 8000 })
      const line = result.stdout.split('\n').reverse().find((l) => l.startsWith(marker))
      reported = line?.slice(marker.length).trim() ?? ''
      if (reported) break
      console.warn(`shell ${flags} did not report PATH (exit ${result.code})`, result.stderr.slice(0, 200))
    } catch (error) {
      console.error(`shell ${flags} failed`, error)
    }
  }
  return mergePath(reported, process.env.PATH || '/usr/bin:/bin', ...commonToolDirs())
}

export function findExecutable(name: string, path: string): string | null {
  for (const dir of path.split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return null
}

type ToolName = 'claude' | 'codex' | 'tmux' | 'git'

/**
 * Locates the tools. Precedence: explicit override, `SAURON_TOOL_<NAME>` environment variable
 * (the value "none" forces "not found", handy for testing the setup screen), then PATH.
 */
export async function resolveTools(overrides: Partial<Record<ToolName, string>> = {}): Promise<ToolPaths> {
  const path = await loginShellPath()
  const locate = (name: ToolName): string | null => {
    const override = overrides[name] || process.env[`SAURON_TOOL_${name.toUpperCase()}`]
    if (override === 'none') return null
    return override || findExecutable(name, path)
  }
  const tools: ToolPaths = {
    claude: locate('claude'),
    codex: locate('codex'),
    tmux: locate('tmux'),
    git: locate('git'),
    path,
  }
  console.log('resolved tools', tools)
  return tools
}

/** Environment for spawned processes: PATH replaced, terminal variables set. */
export function sessionEnvironment(path: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.PATH = path
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.LANG = env.LANG || 'en_US.UTF-8'
  // Electron sets these; agents and shells should not inherit them.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ORIGINAL_XDG_CURRENT_DESKTOP
  return { ...env, ...extra }
}
