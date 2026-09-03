import { join } from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { checkCommand, runCommand } from './command'
import { parseWorktreeList, worktreeDirName, isValidBranchName, type Worktree } from '@shared/worktrees'
import { SauronError } from '@shared/types'

export interface WorktreeSafety {
  dirty: boolean
  /** Commits on this worktree's HEAD that the main checkout does not have. */
  unmergedCommits: number
}

export class WorktreeService {
  constructor(
    private readonly git: string,
    /** Base directory for Sauron-created worktrees: <base>/<project name>/<branch dir>. */
    private readonly base: string,
  ) {}

  projectBase(projectName: string): string {
    return join(this.base, projectName)
  }

  async list(repoPath: string, projectName: string): Promise<Worktree[]> {
    const out = await checkCommand(this.git, ['worktree', 'list', '--porcelain'], { cwd: repoPath })
    // git reports resolved paths (/private/var on macOS), so compare against the resolved base.
    const base = await realpath(this.projectBase(projectName)).catch(() => this.projectBase(projectName))
    return parseWorktreeList(out, base)
  }

  /** Creates a new branch from the repo's HEAD in a new worktree and returns its path. */
  async create(repoPath: string, projectName: string, branch: string): Promise<string> {
    if (!isValidBranchName(branch)) throw new SauronError('invalid_state', `"${branch}" is not a valid branch name.`)
    const dir = join(this.projectBase(projectName), worktreeDirName(branch))
    await mkdir(this.projectBase(projectName), { recursive: true })
    const exists = await runCommand(this.git, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoPath })
    const args = exists.code === 0 ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir]
    await checkCommand(this.git, args, { cwd: repoPath })
    return dir
  }

  async safety(repoPath: string, worktreePath: string): Promise<WorktreeSafety> {
    const status = await checkCommand(this.git, ['status', '--porcelain'], { cwd: worktreePath })
    const mainHead = (await checkCommand(this.git, ['rev-parse', 'HEAD'], { cwd: repoPath })).trim()
    const count = await runCommand(this.git, ['rev-list', '--count', `${mainHead}..HEAD`], { cwd: worktreePath })
    return {
      dirty: status.trim().length > 0,
      unmergedCommits: count.code === 0 ? Number(count.stdout.trim()) || 0 : 0,
    }
  }

  async remove(repoPath: string, worktreePath: string, force: boolean): Promise<void> {
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]
    await checkCommand(this.git, args, { cwd: repoPath })
  }
}
