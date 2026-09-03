import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeJsonAtomic } from './persistence'

/**
 * Marks a directory as trusted in Claude Code's user config so the "do you trust this folder"
 * dialog does not block a session Sauron starts in a directory Sauron itself created.
 * Only ever adds `hasTrustDialogAccepted: true` for that one path.
 */
export async function ensureClaudeTrusts(dir: string, configPath = join(homedir(), '.claude.json')): Promise<void> {
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    } catch (error) {
      console.warn('cannot parse ~/.claude.json; leaving it alone', error)
      return
    }
  }
  const projects = (config.projects && typeof config.projects === 'object' ? config.projects : {}) as Record<string, Record<string, unknown>>
  const entry = projects[dir] ?? {}
  if (entry.hasTrustDialogAccepted === true) return
  projects[dir] = { ...entry, hasTrustDialogAccepted: true }
  config.projects = projects
  await writeJsonAtomic(configPath, config)
}
