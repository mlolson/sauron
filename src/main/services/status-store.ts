import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import type { ProjectStatus } from '@shared/status'
import { readStatusFile, sauronDir, writeStatusFile } from './status-file'

interface Located {
  id: string
  path: string
}

/**
 * Holds every project's status and watches each project's `.sauron/` directory, so a write
 * from the CLI with the app open, a background run with the app closed, or a hand edit all
 * reach the UI the same way.
 */
export class StatusStore {
  statuses: Record<string, ProjectStatus> = {}
  private watchers = new Map<string, FSWatcher>()
  private projects: Located[] = []
  private debounce: NodeJS.Timeout | null = null

  constructor(private readonly onChange: () => void) {}

  /** Points the store at the current project list: reads every status, watches every directory. */
  async sync(projects: Located[]): Promise<void> {
    this.projects = projects.map(({ id, path }) => ({ id, path }))
    const ids = new Set(this.projects.map((p) => p.id))
    for (const [id, watcher] of this.watchers) {
      if (ids.has(id)) continue
      watcher.close()
      this.watchers.delete(id)
    }
    for (const project of this.projects) {
      if (this.watchers.has(project.id)) continue
      try {
        // fs.watch needs the directory to exist; an empty `.sauron/` is harmless (it is ignored).
        await mkdir(sauronDir(project.path), { recursive: true })
        const watcher = watch(sauronDir(project.path), () => this.scheduleReload())
        watcher.on('error', (e) => console.warn('status watcher error', project.path, e.message))
        this.watchers.set(project.id, watcher)
      } catch (error) {
        console.warn('cannot watch', sauronDir(project.path), error)
      }
    }
    await this.reload()
  }

  private scheduleReload(): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.reload().then(this.onChange), 300)
  }

  stop(): void {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  async reload(): Promise<void> {
    const next: Record<string, ProjectStatus> = {}
    for (const project of this.projects) {
      try {
        const parsed = await readStatusFile(project.id, project.path)
        if (parsed) next[project.id] = parsed
      } catch (error) {
        console.warn('cannot read status file for', project.path, error)
      }
    }
    this.statuses = next
  }

  async write(projectPath: string, status: ProjectStatus): Promise<void> {
    await writeStatusFile(projectPath, status)
    this.statuses[status.projectId] = status
  }
}
