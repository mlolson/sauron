import { watch, existsSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './command'

/**
 * Watches a repository and reports when its shape changes: a commit, a branch switch, or a
 * worktree added or removed. Rapid changes are debounced into one report.
 */
export class GitWatcher {
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private lastFingerprint: string | null = null

  constructor(
    private readonly git: string,
    readonly repoPath: string,
    private readonly onCommit: (fingerprint: string) => void,
    private readonly debounceMs = 2_000,
  ) {}

  /**
   * Summary of every branch tip and of what each worktree has checked out. Tips alone miss a
   * branch switch, which moves HEAD without touching a ref, and would leave the branch a
   * session is on looking stale until something else refreshed it.
   */
  async fingerprint(): Promise<string | null> {
    const [refs, worktrees] = await Promise.all([
      runCommand(this.git, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], { cwd: this.repoPath }).catch(() => null),
      runCommand(this.git, ['worktree', 'list', '--porcelain'], { cwd: this.repoPath }).catch(() => null),
    ])
    if (!refs || refs.code !== 0) return null
    const checkouts = worktrees?.code === 0 ? worktrees.stdout.trim() : ''
    return `${refs.stdout.trim()}\n${checkouts}`
  }

  async headCommit(): Promise<string | null> {
    const r = await runCommand(this.git, ['rev-parse', 'HEAD'], { cwd: this.repoPath }).catch(() => null)
    return r && r.code === 0 ? r.stdout.trim() : null
  }

  async start(): Promise<void> {
    this.lastFingerprint = await this.fingerprint()
    const gitDir = await this.gitDir()
    if (!gitDir) return
    for (const rel of ['HEAD', 'refs/heads', 'logs/HEAD', 'packed-refs', 'worktrees']) {
      const target = join(gitDir, rel)
      if (!existsSync(target)) continue
      try {
        const w = watch(target, { recursive: rel === 'refs/heads' || rel === 'worktrees' }, () => this.schedule())
        w.on('error', (e) => console.warn('git watcher error', target, e.message))
        this.watchers.push(w)
      } catch (error) {
        console.warn('cannot watch', target, error)
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.timer) clearTimeout(this.timer)
  }

  private async gitDir(): Promise<string | null> {
    const r = await runCommand(this.git, ['rev-parse', '--git-common-dir'], { cwd: this.repoPath }).catch(() => null)
    if (!r || r.code !== 0) return null
    const dir = r.stdout.trim()
    return dir.startsWith('/') ? dir : join(this.repoPath, dir)
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.check(), this.debounceMs)
  }

  async check(): Promise<void> {
    const fp = await this.fingerprint()
    if (fp === null || fp === this.lastFingerprint) return
    this.lastFingerprint = fp
    this.onCommit(fp)
  }
}
