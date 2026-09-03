import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseStatusFile, type ProjectStatus } from '@shared/status'
import { writeJsonAtomic } from './persistence'

/** Reads and watches `status/<project id>.json` files written by the supervisor agent. */
export class StatusStore {
  statuses: Record<string, ProjectStatus> = {}
  private watcher: FSWatcher | null = null
  private debounce: NodeJS.Timeout | null = null

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
  ) {}

  fileFor(projectId: string): string {
    return join(this.dir, `${projectId}.json`)
  }

  async start(): Promise<void> {
    await this.reload()
    try {
      this.watcher = watch(this.dir, () => {
        if (this.debounce) clearTimeout(this.debounce)
        this.debounce = setTimeout(() => void this.reload().then(this.onChange), 300)
      })
      this.watcher.on('error', (e) => console.warn('status watcher error', e.message))
    } catch (error) {
      console.warn('cannot watch status dir', error)
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
  }

  async reload(): Promise<void> {
    const next: Record<string, ProjectStatus> = {}
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const projectId = name.slice(0, -5)
      try {
        const parsed = parseStatusFile(projectId, await readFile(join(this.dir, name), 'utf8'))
        if (parsed) next[projectId] = parsed
        else console.warn('unusable status file', name)
      } catch (error) {
        console.warn('cannot read status file', name, error)
      }
    }
    this.statuses = next
  }

  async write(status: ProjectStatus): Promise<void> {
    const { projectId, ...rest } = status
    await writeJsonAtomic(this.fileFor(projectId), rest)
    this.statuses[projectId] = status
  }
}
