import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AgentTool, AppError, LaunchOptions, Preferences, Project, Session, SelectionTarget, Snapshot, ToolPaths, WorktreeRemovalCheck } from '@shared/types'
import { defaultPreferences } from '@shared/types'
import { claudeHookSettings, codexNotifyConfig, looksLikeApprovalPrompt, transitionForHook, type HookEvent } from '@shared/hooks'
import { writeJsonAtomic } from './services/persistence'
import { join } from 'node:path'
import { Notifier } from './services/notifier'
import { TranscriptIndexer, TranscriptTailer, type TranscriptFile } from './services/transcripts'
import { projectForCwd } from '@shared/transcripts'
import type { TranscriptEntry, TranscriptPage } from '@shared/transcript-types'
import { MASTER_SESSION_ID, type ProjectStatus } from '@shared/status'
import { StatusStore } from './services/status-store'
import { MasterHome, RefreshScheduler } from './services/master'
import { ensureClaudeTrusts } from './services/claude-config'
import type { Worktree } from '@shared/worktrees'
import { defaultWorktreeBranch } from '@shared/worktrees'
import { WorktreeService } from './services/worktrees'
import { CONFIG_VERSION, SESSIONS_VERSION, SauronError, isAlive } from '@shared/types'
import { tmuxSessionName } from '@shared/tmux-args'
import { claudeTranscriptPath } from '@shared/transcripts'
import { Persistence } from './services/persistence'
import { gitToplevel } from './services/git'
import { resolveTools, sessionEnvironment } from './services/cli-resolver'
import { TmuxService } from './services/tmux'
import { PtyService } from './services/pty'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface StateEvents {
  snapshot: [Snapshot]
  error: [AppError]
  select: [SelectionTarget]
}

/** All application state lives here, in the main process. The renderer only sees snapshots. */
export class AppState extends EventEmitter<StateEvents> {
  projects: Project[] = []
  sessions: Session[] = []
  orphanTmuxSessions: string[] = []
  toolPaths: ToolPaths | null = null
  worktrees: Record<string, Worktree[]> = {}
  preferences: Preferences = { ...defaultPreferences }
  loaded = false
  /** Absolute path of the installed `sauron` shim; set by main before load(). */
  sauronBin: string | null = null
  /** The session the user currently has in front of them, reported by the renderer. */
  activeSessionId: string | null = null
  windowFocused = true
  readonly notifier = new Notifier()
  /** Sessions discovered from transcripts on disk; never persisted. Keyed by transcript path. */
  private externalSessions = new Map<string, Session>()
  private readonly indexer = new TranscriptIndexer(() => void this.rescanTranscripts())
  private tailers = new Map<string, TranscriptTailer>()
  private transcriptListeners = new Map<string, (entries: TranscriptEntry[]) => void>()
  private transcriptTimer: NodeJS.Timeout | null = null
  readonly statusStore: StatusStore
  readonly masterHome: MasterHome
  readonly refresh: RefreshScheduler

  tmux: TmuxService | null = null
  pty: PtyService | null = null
  worktreeService: WorktreeService | null = null
  private livenessTimer: NodeJS.Timeout | null = null

  constructor(public readonly persistence: Persistence) {
    super()
    this.statusStore = new StatusStore(persistence.paths.statusDir, () => {
      this.refresh.markDone()
      this.changed()
    })
    this.masterHome = new MasterHome(persistence.paths.masterDir, persistence.paths.statusDir)
    this.refresh = new RefreshScheduler({
      isMasterIdle: () => this.masterSession()?.state === 'idle',
      send: (projectId) => this.sendRefreshPrompt(projectId),
      onChange: () => this.changed(),
    })
  }

  get paths() {
    return this.persistence.paths
  }

  /** Managed sessions plus discovered external ones. */
  get allSessions(): Session[] {
    return [...this.sessions, ...this.externalSessions.values()]
  }

  snapshot(): Snapshot {
    return {
      projects: this.projects,
      sessions: this.allSessions,
      orphanTmuxSessions: this.orphanTmuxSessions,
      toolPaths: this.toolPaths,
      worktrees: this.worktrees,
      preferences: this.preferences,
      statuses: this.statusStore.statuses,
      refresh: { queued: this.refresh.queued, inProgress: this.refresh.inProgress },
      loaded: this.loaded,
    }
  }

  private changed(): void {
    this.emit('snapshot', this.snapshot())
  }

  report(error: unknown, scope: Partial<AppError> = {}): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error('error:', message, scope)
    this.emit('error', { message, ...scope })
  }

  select(target: SelectionTarget): void {
    this.emit('select', target)
  }

  // MARK: Loading

  async load(): Promise<void> {
    try {
      const config = await this.persistence.loadConfig()
      this.projects = config.projects
      this.preferences = { ...defaultPreferences, ...config.preferences }
      this.notifier.muted = this.preferences.notificationsMuted
      this.sessions = (await this.persistence.loadSessions()).sessions
      this.loaded = true
    } catch (error) {
      this.report(error)
    }
    await this.refreshTools()
    await this.reconcileSessions()
    await Promise.all(this.projects.map((p) => this.refreshWorktrees(p.id, false)))
    this.startLivenessPolling()
    this.indexer.start()
    await this.rescanTranscripts()
    this.transcriptTimer = setInterval(() => void this.rescanTranscripts(), 30_000)
    await this.statusStore.start()
    await this.regenerateMasterHome()
    if (this.preferences.masterAutoStart && !(this.masterSession() && isAlive(this.masterSession()!))) {
      await this.startMaster()
    }
    this.changed()
  }

  async refreshTools(): Promise<void> {
    const tools = await resolveTools()
    this.toolPaths = tools
    this.worktreeService = tools.git ? new WorktreeService(tools.git, this.paths.worktreesDir) : null
    if (tools.tmux) {
      const env = sessionEnvironment(tools.path)
      this.tmux = new TmuxService(tools.tmux, env)
      this.pty?.closeAll()
      this.pty = new PtyService(tools.tmux, env)
    } else {
      this.tmux = null
      this.pty = null
    }
    this.changed()
  }

  private persistConfig(): void {
    this.persistence.saveConfig({ version: CONFIG_VERSION, projects: this.projects, preferences: this.preferences })
  }

  setPreferences(prefs: Partial<Preferences>): void {
    this.preferences = { ...this.preferences, ...prefs }
    this.notifier.muted = this.preferences.notificationsMuted
    this.persistConfig()
    this.changed()
  }

  private persistSessions(): void {
    this.persistence.saveSessions({ version: SESSIONS_VERSION, sessions: this.sessions }).catch((e) => this.report(e))
  }

  // MARK: Projects

  project(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  session(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id) ?? [...this.externalSessions.values()].find((s) => s.id === id)
  }

  sessionsFor(projectId: string | null): Session[] {
    return this.sessions.filter((s) => s.projectId === projectId)
  }

  async addProject(dir: string): Promise<void> {
    try {
      if (!this.toolPaths?.git) throw new SauronError('executable_not_found', 'git was not found on PATH.')
      const root = await gitToplevel(this.toolPaths.git, resolve(dir))
      if (this.projects.some((p) => p.path === root)) {
        throw new SauronError('project_already_added', `${root} is already in the project list.`)
      }
      const project: Project = { id: randomUUID(), name: basename(root), path: root, addedAt: new Date().toISOString(), pinned: false }
      this.projects.push(project)
      this.persistConfig()
      this.changed()
      this.select({ kind: 'project', id: project.id })
      await this.regenerateMasterHome()
      await this.refreshWorktrees(project.id)
      this.refresh.enqueue(project.id)
    } catch (error) {
      this.report(error)
    }
  }

  async addProjects(dirs: string[]): Promise<void> {
    for (const dir of dirs) await this.addProject(dir)
  }

  removeProject(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.refresh.remove(id)
    this.persistConfig()
    this.changed()
    void this.regenerateMasterHome()
  }

  // MARK: Session helpers

  private updateSession(id: string, change: (s: Session) => void): void {
    const s = this.sessions.find((x) => x.id === id)
    if (!s) return
    change(s)
    this.persistSessions()
    this.changed()
  }

  private requireTools(): { tools: ToolPaths; tmux: TmuxService } {
    if (!this.toolPaths || !this.tmux) throw new SauronError('executable_not_found', 'tmux was not found on PATH.')
    return { tools: this.toolPaths, tmux: this.tmux }
  }

  private launchEnvironment(sessionId: string, tools: ToolPaths): Record<string, string> {
    return {
      PATH: tools.path,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      SAURON_SESSION_ID: sessionId,
      SAURON_SOCKET: this.paths.socketFile,
    }
  }

  private nextDisplayName(tool: AgentTool, projectId: string | null): string {
    const label = tool === 'claude' ? 'Claude' : 'Codex'
    const count = this.sessionsFor(projectId).filter((s) => s.tool === tool).length
    return count === 0 ? label : `${label} ${count + 1}`
  }

  // MARK: Session lifecycle

  async launchSession(projectId: string, tool: AgentTool, options: LaunchOptions = {}): Promise<Session | null> {
    const project = this.project(projectId)
    if (!project) {
      this.report(new SauronError('invalid_state', `Unknown project ${projectId}`))
      return null
    }
    try {
      const { tools, tmux } = this.requireTools()
      const id = randomUUID()
      const tmuxName = tmuxSessionName(project.name, id)
      const prompt = options.prompt?.trim()
      let worktreePath: string | null = null
      if (options.worktreeBranch !== undefined) {
        if (!this.worktreeService) throw new SauronError('executable_not_found', 'git was not found on PATH.')
        const branch = options.worktreeBranch.trim() || defaultWorktreeBranch(id)
        worktreePath = await this.worktreeService.create(project.path, project.name, branch)
        await this.refreshWorktrees(project.id, false)
      }
      const cwd = worktreePath ?? project.path
      let command: string[]
      let cliSessionId: string | null
      let transcriptPath: string | null
      if (tool === 'claude') {
        if (!tools.claude) throw new SauronError('executable_not_found', 'claude was not found on PATH.')
        command = [tools.claude, '--session-id', id, ...(await this.claudeSettingsArgs(id))]
        cliSessionId = id
        transcriptPath = claudeTranscriptPath(homedir(), cwd, id)
      } else {
        if (!tools.codex) throw new SauronError('executable_not_found', 'codex was not found on PATH.')
        command = [tools.codex, '-C', cwd, ...(this.sauronBin ? ['-c', codexNotifyConfig(this.sauronBin)] : [])]
        // Codex picks its own session id; the transcript indexer (slice 6) fills these in.
        cliSessionId = null
        transcriptPath = null
      }
      if (prompt) command.push(prompt)
      await tmux.newSession({ name: tmuxName, workingDir: cwd, environment: this.launchEnvironment(id, tools), command })
      const now = new Date().toISOString()
      const session: Session = {
        id,
        projectId: project.id,
        tool,
        kind: 'managed',
        displayName: this.nextDisplayName(tool, project.id),
        tmuxName,
        cliSessionId,
        transcriptPath,
        workingDir: project.path,
        worktreePath,
        createdAt: now,
        lastActivityAt: now,
        state: 'running',
        stateSource: 'inferred',
      }
      this.sessions.push(session)
      this.persistSessions()
      this.changed()
      this.select({ kind: 'session', id })
      return session
    } catch (error) {
      this.report(error, { projectId })
      return null
    }
  }

  /** Writes the per-session Claude settings file carrying Sauron's hooks and returns the CLI args. */
  private async claudeSettingsArgs(sessionId: string): Promise<string[]> {
    if (!this.sauronBin) return []
    const file = join(this.paths.sessionsDir, sessionId, 'claude-settings.json')
    await writeJsonAtomic(file, claudeHookSettings(this.sauronBin))
    return ['--settings', file]
  }

  async resumeSession(id: string): Promise<void> {
    const session = this.session(id)
    if (!session || session.state !== 'stopped' || !session.cliSessionId) return
    try {
      const { tools, tmux } = this.requireTools()
      let command: string[]
      if (session.tool === 'claude') {
        if (!tools.claude) throw new SauronError('executable_not_found', 'claude was not found on PATH.')
        command = [tools.claude, '--resume', session.cliSessionId, ...(await this.claudeSettingsArgs(session.id))]
      } else {
        if (!tools.codex) throw new SauronError('executable_not_found', 'codex was not found on PATH.')
        command = [tools.codex, ...(this.sauronBin ? ['-c', codexNotifyConfig(this.sauronBin)] : []), 'resume', session.cliSessionId]
      }
      const tmuxName = tmuxSessionName(session.displayName, randomUUID())
      await tmux.newSession({
        name: tmuxName,
        workingDir: session.worktreePath ?? session.workingDir,
        environment: this.launchEnvironment(session.id, tools),
        command,
      })
      this.pty?.close(id)
      this.updateSession(id, (s) => {
        s.tmuxName = tmuxName
        s.state = 'running'
        s.stateSource = 'inferred'
        s.lastActivityAt = new Date().toISOString()
      })
      this.select({ kind: 'session', id })
    } catch (error) {
      this.report(error, { sessionId: id })
    }
  }

  /** Interrupts the agent, then kills the tmux session if it is still there. */
  async stopSession(id: string): Promise<void> {
    const session = this.session(id)
    if (!session?.tmuxName) return
    try {
      const { tmux } = this.requireTools()
      if (await tmux.hasSession(session.tmuxName)) {
        await tmux.sendInterrupt(session.tmuxName)
        await sleep(2000)
        if (await tmux.hasSession(session.tmuxName)) await tmux.killSession(session.tmuxName)
      }
      this.pty?.close(id)
      this.markStopped(id)
    } catch (error) {
      this.report(error, { sessionId: id })
    }
  }

  /** Closes the embedded terminal; the tmux session keeps running. */
  detachSession(id: string): void {
    this.pty?.close(id)
    const projectId = this.session(id)?.projectId
    if (projectId) this.select({ kind: 'project', id: projectId })
  }

  forgetSession(id: string): void {
    this.pty?.close(id)
    this.sessions = this.sessions.filter((s) => s.id !== id)
    this.persistSessions()
    this.changed()
  }

  markStopped(id: string): void {
    this.updateSession(id, (s) => {
      s.state = 'stopped'
      s.lastActivityAt = new Date().toISOString()
    })
  }

  // MARK: Worktrees

  async refreshWorktrees(projectId: string, broadcast = true): Promise<void> {
    const project = this.project(projectId)
    if (!project || !this.worktreeService) return
    try {
      this.worktrees[projectId] = await this.worktreeService.list(project.path, project.name)
      if (broadcast) this.changed()
    } catch (error) {
      this.report(error, { projectId })
    }
  }

  sessionsUsingWorktree(path: string): Session[] {
    return this.sessions.filter((s) => s.worktreePath === path && isAlive(s))
  }

  async checkWorktreeRemoval(projectId: string, path: string): Promise<WorktreeRemovalCheck> {
    const project = this.project(projectId)
    if (!project || !this.worktreeService) throw new SauronError('invalid_state', 'No project or git.')
    const safety = await this.worktreeService.safety(project.path, path)
    return { ...safety, inUseBy: this.sessionsUsingWorktree(path).map((s) => s.displayName) }
  }

  async removeWorktree(projectId: string, path: string, force: boolean): Promise<void> {
    const project = this.project(projectId)
    if (!project || !this.worktreeService) return
    try {
      const inUse = this.sessionsUsingWorktree(path)
      if (inUse.length) {
        throw new SauronError('invalid_state', `Worktree is in use by ${inUse.map((s) => s.displayName).join(', ')}. Stop those sessions first.`)
      }
      await this.worktreeService.remove(project.path, path, force)
      await this.refreshWorktrees(projectId)
    } catch (error) {
      this.report(error, { projectId })
      throw error
    }
  }

  // MARK: Attention

  waitingCount(): number {
    return this.sessions.filter((s) => s.state === 'waitingForInput').length
  }

  private isInFront(sessionId: string): boolean {
    return this.windowFocused && this.activeSessionId === sessionId
  }

  /** Applies a hook event reported by the `sauron` CLI. */
  handleHook(sessionId: string, event: HookEvent): void {
    const session = this.session(sessionId)
    if (!session) {
      console.warn('hook for unknown session', sessionId, event.event)
      return
    }
    const transition = transitionForHook(event, session.displayName)
    console.log('hook', session.displayName, event.event, '->', transition?.state ?? '(ignored)')
    if (!transition) return
    const wasStopped = session.state === 'stopped'
    this.updateSession(sessionId, (s) => {
      s.state = transition.state
      s.stateSource = 'hook'
      s.lastActivityAt = new Date().toISOString()
      if (event.tool === 'claude' && typeof event.payload.session_id === 'string') s.cliSessionId = event.payload.session_id
      if (event.tool === 'codex') {
        const tid = event.payload['thread-id'] ?? event.payload.thread_id ?? event.payload['session-id']
        if (typeof tid === 'string') s.cliSessionId = tid
      }
    })
    if (transition.state === 'stopped' && !wasStopped) this.pty?.close(sessionId)
    this.notifier.setBadge(this.waitingCount())
    if (sessionId === MASTER_SESSION_ID) {
      if (transition.state === 'idle') this.refresh.markDone()
      // The master's own turn-complete is noise; only prompts for input matter.
      if (event.event === 'Stop') return
    }
    if (transition.notify && !this.isInFront(sessionId)) {
      this.notifier.post({ ...transition.notify, onClick: () => this.select({ kind: 'session', id: sessionId }) })
    }
  }

  /** Codex has no permission hook: infer waiting-for-input from the visible screen. */
  private async inferCodexState(session: Session): Promise<void> {
    if (!this.tmux || !session.tmuxName || session.tool !== 'codex' || session.state === 'stopped') return
    const screen = await this.tmux.capturePane(session.tmuxName).catch(() => null)
    if (screen === null) return
    const waiting = looksLikeApprovalPrompt(screen)
    if (waiting && session.state !== 'waitingForInput') {
      this.updateSession(session.id, (s) => {
        s.state = 'waitingForInput'
        s.stateSource = 'inferred'
      })
      this.notifier.setBadge(this.waitingCount())
      if (!this.isInFront(session.id)) {
        this.notifier.post({ title: `${session.displayName} is waiting`, body: 'Codex appears to be asking for approval.', onClick: () => this.select({ kind: 'session', id: session.id }) })
      }
    } else if (!waiting && session.state === 'waitingForInput' && session.stateSource === 'inferred') {
      this.updateSession(session.id, (s) => {
        s.state = 'running'
      })
      this.notifier.setBadge(this.waitingCount())
    }
  }

  // MARK: Transcripts and external sessions

  /** Re-reads the transcript index: links managed sessions to their files, discovers external ones. */
  async rescanTranscripts(): Promise<void> {
    let files: TranscriptFile[]
    try {
      files = await this.indexer.scan()
    } catch (error) {
      console.warn('transcript scan failed', error)
      return
    }
    const worktreePaths: Record<string, string[]> = {}
    for (const [pid, wts] of Object.entries(this.worktrees)) worktreePaths[pid] = wts.map((w) => w.path)
    const managedByCliId = new Map(this.sessions.filter((s) => s.cliSessionId).map((s) => [s.cliSessionId!, s]))
    const managedByPath = new Map(this.sessions.filter((s) => s.transcriptPath).map((s) => [s.transcriptPath!, s]))
    let managedChanged = false
    const next = new Map<string, Session>()
    const now = Date.now()

    // Codex sessions get their id from the first rollout in the same cwd created after launch.
    const unlinkedCodex = this.sessions.filter((s) => s.tool === 'codex' && s.kind === 'managed' && !s.cliSessionId)
    const claimed = new Set<string>()

    for (const f of files) {
      const { sessionId, cwd } = f.header
      if (!sessionId || !cwd) continue
      const managed = managedByCliId.get(sessionId) ?? managedByPath.get(f.path)
      if (managed) {
        if (managed.transcriptPath !== f.path) {
          managed.transcriptPath = f.path
          managedChanged = true
        }
        continue
      }
      if (f.tool === 'codex') {
        const candidate = unlinkedCodex.find((s) => !claimed.has(s.id) && (s.worktreePath ?? s.workingDir) === cwd && f.header.startedAt && f.header.startedAt >= s.createdAt)
        if (candidate) {
          claimed.add(candidate.id)
          candidate.cliSessionId = sessionId
          candidate.transcriptPath = f.path
          managedChanged = true
          continue
        }
      }
      const projectId = projectForCwd(cwd, this.projects, worktreePaths)
      if (!projectId) continue
      const existing = this.externalSessions.get(f.path)
      const ageMs = now - f.mtimeMs
      const state: Session['state'] = ageMs < 2 * 60_000 ? 'running' : 'idle'
      const session: Session = existing ?? {
        id: `external:${f.tool}:${sessionId}`,
        projectId,
        tool: f.tool,
        kind: 'external',
        displayName: `${f.tool === 'claude' ? 'Claude' : 'Codex'} ${sessionId.slice(0, 8)}`,
        tmuxName: null,
        cliSessionId: sessionId,
        transcriptPath: f.path,
        workingDir: cwd,
        worktreePath: null,
        createdAt: f.header.startedAt ?? new Date(f.mtimeMs).toISOString(),
        lastActivityAt: new Date(f.mtimeMs).toISOString(),
        state,
        stateSource: 'inferred',
      }
      session.projectId = projectId
      session.lastActivityAt = new Date(f.mtimeMs).toISOString()
      session.state = state
      next.set(f.path, session)
    }
    this.externalSessions = next
    if (managedChanged) this.persistSessions()
    this.changed()
  }

  async transcriptOpen(sessionId: string): Promise<TranscriptPage | null> {
    const session = this.session(sessionId)
    if (!session?.transcriptPath) return null
    let tailer = this.tailers.get(sessionId)
    if (!tailer) {
      const path = session.transcriptPath
      tailer = new TranscriptTailer(path, session.tool, {
        onEntries: (entries) => this.transcriptListeners.get(sessionId)?.(entries),
      })
      this.tailers.set(sessionId, tailer)
      try {
        await tailer.start()
      } catch (error) {
        this.tailers.delete(sessionId)
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], total: 0 }
        throw error
      }
    }
    const entries = tailer.entries.slice(-300)
    return { entries, total: tailer.entries.length }
  }

  transcriptLoadOlder(sessionId: string, beforeIndex: number, count: number): TranscriptEntry[] {
    const tailer = this.tailers.get(sessionId)
    if (!tailer) return []
    const all = tailer.entries
    const end = all.findIndex((e) => e.index >= beforeIndex)
    const stop = end === -1 ? all.length : end
    return all.slice(Math.max(0, stop - count), stop)
  }

  transcriptClose(sessionId: string): void {
    this.tailers.get(sessionId)?.stop()
    this.tailers.delete(sessionId)
    this.transcriptListeners.delete(sessionId)
  }

  setTranscriptListener(sessionId: string, cb: ((entries: TranscriptEntry[]) => void) | null): void {
    if (cb) this.transcriptListeners.set(sessionId, cb)
    else this.transcriptListeners.delete(sessionId)
  }

  // MARK: Master agent

  masterSession(): Session | undefined {
    return this.sessions.find((s) => s.id === MASTER_SESSION_ID)
  }

  async regenerateMasterHome(): Promise<void> {
    if (!this.sauronBin) return
    try {
      await this.masterHome.regenerate(this.projects, this.sauronBin)
    } catch (error) {
      this.report(error)
    }
  }

  /** Starts the master agent, resuming its previous conversation when possible. */
  async startMaster(): Promise<void> {
    const existing = this.masterSession()
    if (existing && isAlive(existing)) {
      this.select({ kind: 'session', id: MASTER_SESSION_ID })
      return
    }
    try {
      const { tools, tmux } = this.requireTools()
      if (!tools.claude) throw new SauronError('executable_not_found', 'claude was not found on PATH.')
      await this.regenerateMasterHome()
      await ensureClaudeTrusts(this.masterHome.dir)
      const addDirs = this.projects.flatMap((p) => ['--add-dir', p.path])
      const settings = await this.claudeSettingsArgs(MASTER_SESSION_ID)
      const tryStart = async (cliSessionId: string, resume: boolean): Promise<string> => {
        const tmuxName = tmuxSessionName('master', randomUUID())
        const command = resume
          ? [tools.claude!, '--resume', cliSessionId, ...settings, ...addDirs]
          : [tools.claude!, '--session-id', cliSessionId, ...settings, ...addDirs]
        await tmux.newSession({ name: tmuxName, workingDir: this.masterHome.dir, environment: this.launchEnvironment(MASTER_SESSION_ID, tools), command })
        return tmuxName
      }
      let cliSessionId = existing?.cliSessionId ?? null
      let tmuxName: string
      let resumed = false
      if (cliSessionId) {
        tmuxName = await tryStart(cliSessionId, true)
        await sleep(3000)
        resumed = await tmux.hasSession(tmuxName)
        if (!resumed) console.warn('master resume failed; starting fresh')
      }
      if (!resumed) {
        cliSessionId = randomUUID()
        tmuxName = await tryStart(cliSessionId, false)
      }
      const now = new Date().toISOString()
      const session: Session = {
        id: MASTER_SESSION_ID,
        projectId: null,
        tool: 'claude',
        kind: 'managed',
        displayName: 'Master Agent',
        tmuxName: tmuxName!,
        cliSessionId,
        transcriptPath: claudeTranscriptPath(homedir(), this.masterHome.dir, cliSessionId!),
        workingDir: this.masterHome.dir,
        worktreePath: null,
        createdAt: existing?.createdAt ?? now,
        lastActivityAt: now,
        state: 'running',
        stateSource: 'inferred',
      }
      this.pty?.close(MASTER_SESSION_ID)
      this.sessions = [session, ...this.sessions.filter((s) => s.id !== MASTER_SESSION_ID)]
      this.persistSessions()
      this.changed()
    } catch (error) {
      this.report(error, { sessionId: MASTER_SESSION_ID })
    }
  }

  async stopMaster(): Promise<void> {
    await this.stopSession(MASTER_SESSION_ID)
  }

  private masterPromptFor(projectId: string): string | null {
    const project = this.project(projectId)
    if (!project) return null
    return `Please refresh the status summary for project "${project.name}" (id ${project.id}, path ${project.path}). Follow the "Status refresh" procedure in CLAUDE.md and reply with one line when done.`
  }

  private async sendRefreshPrompt(projectId: string): Promise<boolean> {
    const master = this.masterSession()
    const prompt = this.masterPromptFor(projectId)
    if (!master?.tmuxName || !isAlive(master) || !prompt || !this.tmux) return false
    try {
      await this.tmux.sendText(master.tmuxName, prompt)
      this.updateSession(MASTER_SESSION_ID, (s) => {
        s.state = 'running'
      })
      return true
    } catch (error) {
      this.report(error, { sessionId: MASTER_SESSION_ID })
      return false
    }
  }

  requestRefresh(projectId: string): void {
    if (!this.project(projectId)) return
    const master = this.masterSession()
    if (!master || !isAlive(master)) {
      this.report(new SauronError('invalid_state', 'The master agent is not running. Start it to refresh summaries.'), { projectId })
    }
    this.refresh.enqueue(projectId)
  }

  /** Types text into a running managed session. Refused while the agent is mid-turn. */
  async sendToSession(sessionId: string, text: string): Promise<void> {
    const session = this.session(sessionId)
    if (!session?.tmuxName || session.kind !== 'managed' || !isAlive(session)) throw new SauronError('invalid_state', `Session ${sessionId} is not running.`)
    if (session.state === 'running' && session.stateSource === 'hook') throw new SauronError('invalid_state', `${session.displayName} is mid-turn; try again when it is idle.`)
    const { tmux } = this.requireTools()
    await tmux.sendText(session.tmuxName, text)
    this.updateSession(sessionId, (s) => {
      s.lastActivityAt = new Date().toISOString()
    })
  }

  async setStatus(projectId: string, summary: string, details: string | null, source: ProjectStatus['source'] = 'master'): Promise<ProjectStatus> {
    const project = this.project(projectId)
    if (!project) throw new SauronError('invalid_state', `Unknown project ${projectId}`)
    let headCommit: string | null = null
    if (this.toolPaths?.git) {
      const { runCommand } = await import('./services/command')
      const r = await runCommand(this.toolPaths.git, ['rev-parse', 'HEAD'], { cwd: project.path })
      if (r.code === 0) headCommit = r.stdout.trim()
    }
    const status: ProjectStatus = { projectId, summary: summary.trim(), details, updatedAt: new Date().toISOString(), headCommit, source }
    await this.statusStore.write(status)
    this.refresh.markDone(projectId)
    this.changed()
    return status
  }

  // MARK: Orphans

  adoptOrphan(tmuxName: string): void {
    const now = new Date().toISOString()
    const session: Session = {
      id: randomUUID(),
      projectId: null,
      tool: 'claude',
      kind: 'managed',
      displayName: tmuxName,
      tmuxName,
      cliSessionId: null,
      transcriptPath: null,
      workingDir: homedir(),
      worktreePath: null,
      createdAt: now,
      lastActivityAt: now,
      state: 'running',
      stateSource: 'inferred',
    }
    this.sessions.push(session)
    this.orphanTmuxSessions = this.orphanTmuxSessions.filter((n) => n !== tmuxName)
    this.persistSessions()
    this.changed()
    this.select({ kind: 'session', id: session.id })
  }

  async killOrphan(tmuxName: string): Promise<void> {
    try {
      const { tmux } = this.requireTools()
      await tmux.killSession(tmuxName)
      this.orphanTmuxSessions = this.orphanTmuxSessions.filter((n) => n !== tmuxName)
      this.changed()
    } catch (error) {
      this.report(error)
    }
  }

  // MARK: Reconciliation

  async reconcileSessions(): Promise<void> {
    if (!this.tmux) return
    try {
      const live = new Set(await this.tmux.listSauronSessions())
      const known = new Set<string>()
      for (const s of this.sessions) {
        if (s.kind !== 'managed' || !s.tmuxName) continue
        known.add(s.tmuxName)
        if (live.has(s.tmuxName)) {
          if (s.state === 'stopped') s.state = 'idle'
        } else if (s.state !== 'stopped') {
          s.state = 'stopped'
        }
      }
      this.orphanTmuxSessions = [...live].filter((n) => !known.has(n)).sort()
      this.persistSessions()
      this.changed()
    } catch (error) {
      this.report(error)
    }
  }

  async checkLiveness(): Promise<void> {
    if (!this.tmux) return
    for (const s of this.sessions) {
      if (s.kind !== 'managed' || !isAlive(s) || !s.tmuxName) continue
      if (!(await this.tmux.hasSession(s.tmuxName))) {
        this.pty?.close(s.id)
        this.markStopped(s.id)
        this.notifier.setBadge(this.waitingCount())
      } else if (s.tool === 'codex') {
        await this.inferCodexState(s)
      }
    }
  }

  private startLivenessPolling(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = setInterval(() => void this.checkLiveness(), 5000)
  }

  async shutdown(): Promise<void> {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    if (this.transcriptTimer) clearInterval(this.transcriptTimer)
    this.indexer.stop()
    this.statusStore.stop()
    for (const id of [...this.tailers.keys()]) this.transcriptClose(id)
    this.pty?.closeAll()
    await this.persistence.flush()
  }
}
