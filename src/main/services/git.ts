import { realpath } from 'node:fs/promises'
import { runCommand } from './command'
import { SauronError, type RecentCommit } from '@shared/types'

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
