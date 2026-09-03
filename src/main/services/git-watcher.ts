import { watch, existsSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './command'

/**
 * Watches a repository's refs and reports when any branch tip changes (a commit in the main
 * checkout or any worktree). Rapid changes are debounced into one report.
 */
export class GitWatcher {
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private lastFingerprint: string | null = null

  constructor(
    private readonly git: string,
    readonly repoPath: string,
    private readonly onCommit: (fingerprint: string) => void,
    private readonly debounceMs = 30_000,
  ) {}

  /** Hash-like summary of every local branch tip. */
  async fingerprint(): Promise<string | null> {
    const r = await runCommand(this.git, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], { cwd: this.repoPath }).catch(() => null)
    if (!r || r.code !== 0) return null
    return r.stdout.trim()
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
