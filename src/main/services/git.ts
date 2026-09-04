import { realpath } from 'node:fs/promises'
import { runCommand } from './command'
import { SauronError, type RecentCommit, type SessionCommit } from '@shared/types'

/** Returns the repository root containing `dir`, or throws `not_a_git_repository`. */
export async function gitToplevel(git: string, dir: string): Promise<string> {
  const result = await runCommand(git, ['rev-parse', '--show-toplevel'], { cwd: dir }).catch(() => null)
  if (!result || result.code !== 0 || !result.stdout.trim()) {
    throw new SauronError('not_a_git_repository', `${dir} is not inside a git repository.`)
  }
  return realpath(result.stdout.trim())
}

/** Most recent commits across local branches, newest first. */
export async function recentGitCommits(git: string, dir: string, limit = 20): Promise<RecentCommit[]> {
  const result = await runCommand(git, ['log', '--all', `-${limit}`, '--date-order', '--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI%x1e'], { cwd: dir })
  if (result.code !== 0) throw new SauronError('command_failed', `git log: ${result.stderr.trim()}`)
  const rows = result.stdout.split('\x1e').map((row) => row.trim()).filter(Boolean)
  return Promise.all(rows.map(async (row) => {
    const [hash = '', shortHash = '', title = '', body = '', author = '', authoredAt = ''] = row.split('\x1f')
    const named = await runCommand(git, ['name-rev', '--name-only', '--refs=refs/heads/*', hash], { cwd: dir }).catch(() => null)
    const branch = named?.code === 0 ? named.stdout.trim().replace(/[~^].*$/, '') : ''
    return {
      hash,
      shortHash,
      title: title.trim(),
      message: body.trim().replace(/\s+/g, ' '),
      branch: branch === 'undefined' ? '' : branch,
      author: author.trim(),
      authoredAt: authoredAt.trim(),
      sessionId: null,
      sessionName: null,
      agentTool: null,
    }
  }))
}

export async function gitCommitDiff(git: string, dir: string, hash: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new SauronError('invalid_state', 'Invalid commit hash.')
  const result = await runCommand(git, ['show', '--format=', '--no-ext-diff', '--find-renames', '--find-copies', '--unified=3', hash], { cwd: dir })
  if (result.code !== 0) throw new SauronError('command_failed', `git show: ${result.stderr.trim()}`)
  return result.stdout
}

/**
 * Titles and dates for specific commits, in one git call. Hashes that no longer resolve — a
 * branch was reset, a commit was amended away — are simply absent from the result.
 */
export async function commitSummaries(git: string, dir: string, hashes: string[]): Promise<Map<string, SessionCommit>> {
  const wanted = hashes.filter((hash) => /^[0-9a-f]{40}$/i.test(hash))
  const summaries = new Map<string, SessionCommit>()
  if (wanted.length === 0) return summaries
  const result = await runCommand(git, ['log', '--no-walk', '--ignore-missing', '--format=%H%x1f%h%x1f%s%x1f%aI%x1e', ...wanted], { cwd: dir })
  if (result.code !== 0) return summaries
  for (const row of result.stdout.split('\x1e').map((r) => r.trim()).filter(Boolean)) {
    const [hash = '', shortHash = '', title = '', authoredAt = ''] = row.split('\x1f')
    if (hash) summaries.set(hash, { hash, shortHash, title: title.trim(), authoredAt: authoredAt.trim() })
  }
  return summaries
}
