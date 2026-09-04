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

/** One record per commit, unit separators between fields and a record separator between commits. */
const COMMIT_FORMAT = '--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%aI%x1e'

function parseCommitRows(stdout: string): RecentCommit[] {
  return stdout
    .split('\x1e')
    .map((row) => row.trim())
    .filter(Boolean)
    .map((row) => {
      const [hash = '', shortHash = '', title = '', body = '', author = '', authoredAt = ''] = row.split('\x1f')
      return {
        hash,
        shortHash,
        title: title.trim(),
        message: body.trim(),
        branch: '',
        author: author.trim(),
        authoredAt: authoredAt.trim(),
        sessionId: null,
        sessionName: null,
        agentTool: null,
      }
    })
}

/** Local branch names, current first, then alphabetical. */
export async function listBranches(git: string, dir: string): Promise<string[]> {
  const result = await runCommand(git, ['branch', '--format=%(refname:short)'], { cwd: dir })
  if (result.code !== 0) return []
  const branches = result.stdout.split('\n').map((b) => b.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))
  const head = await runCommand(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
  const current = head.code === 0 ? head.stdout.trim() : ''
  return current && branches.includes(current) ? [current, ...branches.filter((b) => b !== current)] : branches
}

/**
 * Every commit reachable from a branch. One call and an exact answer, which beats asking
 * `git branch --contains` per candidate; the cap keeps a very old repository from being read
 * into memory whole.
 */
export async function hashesOnBranch(git: string, dir: string, branch: string): Promise<Set<string>> {
  const result = await runCommand(git, ['rev-list', '--max-count=50000', branch], { cwd: dir })
  if (result.code !== 0) return new Set()
  return new Set(result.stdout.split('\n').map((h) => h.trim()).filter(Boolean))
}

/** Most recent commits, newest first: across local branches, or on one branch when named. */
export async function recentGitCommits(git: string, dir: string, limit = 20, branch?: string): Promise<RecentCommit[]> {
  const result = await runCommand(git, ['log', branch || '--all', `-${limit}`, '--date-order', COMMIT_FORMAT], { cwd: dir })
  if (result.code !== 0) throw new SauronError('command_failed', `git log: ${result.stderr.trim()}`)
  return Promise.all(parseCommitRows(result.stdout).map(async (commit) => {
    const named = await runCommand(git, ['name-rev', '--name-only', '--refs=refs/heads/*', commit.hash], { cwd: dir }).catch(() => null)
    const branch = named?.code === 0 ? named.stdout.trim().replace(/[~^].*$/, '') : ''
    return { ...commit, branch: branch === 'undefined' ? '' : branch }
  }))
}

/**
 * Named commits, in one call. Hashes that no longer resolve are absent from the result, and
 * branch is left empty: naming a branch costs a git call each and the caller lists by session.
 */
export async function commitsByHash(git: string, dir: string, hashes: string[]): Promise<RecentCommit[]> {
  const wanted = hashes.filter((hash) => /^[0-9a-f]{40}$/i.test(hash))
  if (wanted.length === 0) return []
  const result = await runCommand(git, ['log', '--no-walk', '--ignore-missing', COMMIT_FORMAT, ...wanted], { cwd: dir })
  if (result.code !== 0) return []
  return parseCommitRows(result.stdout)
}

export async function gitCommitDiff(git: string, dir: string, hash: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new SauronError('invalid_state', 'Invalid commit hash.')
  const result = await runCommand(git, ['show', '--format=', '--no-ext-diff', '--find-renames', '--find-copies', '--unified=3', hash], { cwd: dir })
  if (result.code !== 0) throw new SauronError('command_failed', `git show: ${result.stderr.trim()}`)
  return result.stdout
}

/**
 * Stages one path and commits just that path. `--only` keeps anything else the user has
 * staged out of the commit, so saving a document never sweeps up unrelated work.
 */
export async function commitPath(git: string, dir: string, rel: string, message: string): Promise<string> {
  const add = await runCommand(git, ['add', '--', rel], { cwd: dir })
  if (add.code !== 0) throw new SauronError('command_failed', `git add: ${add.stderr.trim()}`)
  const commit = await runCommand(git, ['commit', '--only', '--message', message, '--', rel], { cwd: dir })
  if (commit.code !== 0) {
    const detail = `${commit.stdout.trim()}\n${commit.stderr.trim()}`.trim()
    throw new SauronError('command_failed', /nothing to commit|no changes added/i.test(detail) ? `${rel} has no changes to commit.` : `git commit: ${detail}`)
  }
  const head = await runCommand(git, ['rev-parse', 'HEAD'], { cwd: dir })
  return head.code === 0 ? head.stdout.trim() : ''
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
