export interface Worktree {
  path: string
  branch: string | null
  head: string
  /** The repository's primary checkout. */
  isMain: boolean
  /** Lives under Sauron's worktree base directory. */
  isSauron: boolean
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(output: string, sauronBase: string): Worktree[] {
  const result: Worktree[] = []
  let current: Partial<Worktree> | null = null
  const flush = () => {
    if (current?.path) {
      result.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? '',
        isMain: result.length === 0,
        isSauron: current.path.startsWith(sauronBase.replace(/\/+$/, '') + '/'),
      })
    }
    current = null
  }
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice(5)
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '')
    } else if (line === '') {
      flush()
    }
  }
  flush()
  return result
}

export function defaultWorktreeBranch(sessionId: string): string {
  return `sauron/${sessionId.replace(/-/g, '').slice(0, 8)}`
}

/** Directory name for a branch: slashes become dashes, unsafe characters stripped. */
export function worktreeDirName(branch: string): string {
  return branch.replace(/\//g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree'
}

export function isValidBranchName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) && !name.endsWith('/') && !name.includes('..') && !name.endsWith('.lock')
}
