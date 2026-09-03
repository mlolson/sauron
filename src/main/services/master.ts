import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { renderMasterClaudeMd } from '@shared/status'
import type { Project } from '@shared/types'

/** The master agent's home directory: a generated CLAUDE.md plus whatever the user adds. */
export class MasterHome {
  constructor(
    readonly dir: string,
    private readonly statusDir: string,
  ) {}

  async regenerate(projects: Project[], sauronBin: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const md = renderMasterClaudeMd({
      projects: projects.map(({ id, name, path }) => ({ id, name, path })),
      statusDir: this.statusDir,
      sauronBin,
      claudeTranscriptRoot: join(homedir(), '.claude', 'projects'),
      codexSessionRoot: join(homedir(), '.codex', 'sessions'),
    })
    await writeFile(join(this.dir, 'CLAUDE.md'), md, 'utf8')
  }
}

/**
 * Queue of projects whose summaries need refreshing. Duplicates collapse; nothing is sent
 * while the master is busy or a refresh is already in flight.
 */
export class RefreshScheduler {
  private queue: string[] = []
  inProgress: string | null = null
  private startedAt = 0
  private readonly timeoutMs = 10 * 60_000

  constructor(
    private readonly deps: {
      isMasterIdle: () => boolean
      send: (projectId: string) => Promise<boolean>
      onChange: () => void
    },
  ) {}

  get queued(): string[] {
    return [...this.queue]
  }

  enqueue(projectId: string): void {
    if (this.inProgress === projectId || this.queue.includes(projectId)) return
    this.queue.push(projectId)
    this.deps.onChange()
    void this.drain()
  }

  remove(projectId: string): void {
    this.queue = this.queue.filter((id) => id !== projectId)
    if (this.inProgress === projectId) this.inProgress = null
    this.deps.onChange()
  }

  /** Called when the master finishes a turn or a status file lands. */
  markDone(projectId?: string): void {
    if (this.inProgress && (projectId === undefined || projectId === this.inProgress)) {
      this.inProgress = null
      this.deps.onChange()
    }
    void this.drain()
  }

  async drain(): Promise<void> {
    if (this.inProgress && Date.now() - this.startedAt > this.timeoutMs) {
      console.warn('refresh timed out for', this.inProgress)
      this.inProgress = null
    }
    if (this.inProgress || this.queue.length === 0 || !this.deps.isMasterIdle()) return
    const next = this.queue.shift()!
    this.inProgress = next
    this.startedAt = Date.now()
    this.deps.onChange()
    const sent = await this.deps.send(next)
    if (!sent) {
      // Put it back and wait for the next idle signal.
      this.inProgress = null
      this.queue.unshift(next)
      this.deps.onChange()
    }
  }
}
