import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseStatusFile, type ProjectStatus } from '@shared/status'
import { runCommand } from './command'
import { writeJsonAtomic } from './persistence'

/**
 * A project's status lives inside the project, at `.sauron/status.json`, where any agent
 * working in the checkout can read it. `.sauron/` is reserved for Sauron's per-project working
 * files and is kept out of git through `.git/info/exclude`, never the repository's own
 * `.gitignore`, so adding a project never dirties it.
 */
export const SAURON_DIR = '.sauron'

export function sauronDir(projectPath: string): string {
  return join(projectPath, SAURON_DIR)
}

export function statusFilePath(projectPath: string): string {
  return join(sauronDir(projectPath), 'status.json')
}

export async function readStatusFile(projectId: string, projectPath: string): Promise<ProjectStatus | null> {
  let raw: string
  try {
    raw = await readFile(statusFilePath(projectPath), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return parseStatusFile(projectId, raw)
}

/** The project id is implied by the location, so it is not written into the file. */
export async function writeStatusFile(projectPath: string, status: ProjectStatus): Promise<void> {
  const { projectId: _id, ...rest } = status
  await writeJsonAtomic(statusFilePath(projectPath), rest)
}

/**
 * Moves a status file from the old central `status/<project id>.json` location into the
 * project. Returns true when a file was moved. Never overwrites a file the project already has.
 */
export async function migrateLegacyStatusFile(legacyFile: string, projectPath: string): Promise<boolean> {
  const target = statusFilePath(projectPath)
  if (!(await exists(legacyFile)) || (await exists(target))) return false
  await mkdir(sauronDir(projectPath), { recursive: true })
  await rename(legacyFile, target)
  return true
}

/**
 * Makes git ignore `.sauron/` in a repository without touching its `.gitignore`. Checked with
 * `git check-ignore` first, so a rule the user already has (in `.gitignore` or anywhere else)
 * is honoured and nothing is appended twice.
 */
export async function ensureSauronExcluded(git: string, repoPath: string): Promise<void> {
  const check = await runCommand(git, ['check-ignore', '-q', `${SAURON_DIR}/status.json`], { cwd: repoPath })
  if (check.code === 0) return
  const where = await runCommand(git, ['rev-parse', '--git-path', 'info/exclude'], { cwd: repoPath })
  if (where.code !== 0 || !where.stdout.trim()) throw new Error(`git rev-parse --git-path info/exclude: ${where.stderr.trim()}`)
  const path = where.stdout.trim()
  const file = path.startsWith('/') ? path : join(repoPath, path)
  await mkdir(join(file, '..'), { recursive: true })
  const current = await readFile(file, 'utf8').catch(() => '')
  const prefix = current.length && !current.endsWith('\n') ? '\n' : ''
  await writeFile(file, `${current}${prefix}# Sauron's per-project working files\n${SAURON_DIR}/\n`, 'utf8')
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}
