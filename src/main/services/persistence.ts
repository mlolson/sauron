import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONFIG_VERSION, SESSIONS_VERSION, SauronError } from '@shared/types'
import type { AppConfig, SessionsFile } from '@shared/types'

/** On-disk layout under the app's userData directory. */
export class AppPaths {
  constructor(public readonly root: string) {}

  get configFile() { return join(this.root, 'config.json') }
  get sessionsFile() { return join(this.root, 'sessions.json') }
  get statusDir() { return join(this.root, 'status') }
  get masterDir() { return join(this.root, 'master') }
  get sessionsDir() { return join(this.root, 'sessions') }
  get worktreesDir() { return join(this.root, 'worktrees') }
  get binDir() { return join(this.root, 'bin') }
  get socketFile() { return join(this.root, 'sauron.sock') }

  async createLayout(): Promise<void> {
    for (const dir of [this.root, this.statusDir, this.masterDir, this.sessionsDir, this.worktreesDir, this.binDir]) {
      await mkdir(dir, { recursive: true })
    }
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmp, file)
}

export class Persistence {
  private pendingConfig: AppConfig | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    public readonly paths: AppPaths,
    private readonly debounceMs = 250,
  ) {}

  async loadConfig(): Promise<AppConfig> {
    await this.paths.createLayout()
    if (!existsSync(this.paths.configFile)) return { version: CONFIG_VERSION, projects: [] }
    const config = JSON.parse(await readFile(this.paths.configFile, 'utf8')) as AppConfig
    if (config.version > CONFIG_VERSION) {
      throw new SauronError('persistence', `config.json version ${config.version} is newer than this app supports (${CONFIG_VERSION}).`)
    }
    return config
  }

  /** Schedules a write; calls within the debounce window collapse into one. */
  saveConfig(config: AppConfig): void {
    this.pendingConfig = config
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), this.debounceMs)
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const config = this.pendingConfig
    if (!config) return
    this.pendingConfig = null
    await writeJsonAtomic(this.paths.configFile, config)
  }

  async loadSessions(): Promise<SessionsFile> {
    await this.paths.createLayout()
    if (!existsSync(this.paths.sessionsFile)) return { version: SESSIONS_VERSION, sessions: [] }
    const file = JSON.parse(await readFile(this.paths.sessionsFile, 'utf8')) as SessionsFile
    if (file.version > SESSIONS_VERSION) {
      throw new SauronError('persistence', `sessions.json version ${file.version} is newer than this app supports (${SESSIONS_VERSION}).`)
    }
    return file
  }

  /** Sessions matter for crash recovery, so they are written immediately. */
  saveSessions(file: SessionsFile): Promise<void> {
    return writeJsonAtomic(this.paths.sessionsFile, file)
  }
}
