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
import { MASTER_SESSION_ID, firstSentence, type ProjectStatus } from '@shared/status'
import { StatusStore } from './services/status-store'
import { MasterHome, RefreshScheduler } from './services/master'
import { ensureClaudeTrusts } from './services/claude-config'
import { GitWatcher } from './services/git-watcher'
import { listKeyDocuments, readDocument, relativeInside } from './services/documents'
import type { KeyDocument } from '@shared/types'
import { runCommand } from './services/command'
import type { Worktree } from '@shared/worktrees'
import { defaultWorktreeBranch } from '@shared/worktrees'
import { WorktreeService } from './services/worktrees'
import { CONFIG_VERSION, SESSIONS_VERSION, SauronError, isAlive } from '@shared/types'
import { tmuxSessionName, shellCommandLine, TMUX_OPTION_PROJECT, TMUX_OPTION_SESSION, TMUX_OPTION_TITLE, TMUX_OPTION_TOOL } from '@shared/tmux-args'
import { claudeTranscriptPath } from '@shared/transcripts'
import { Persistence } from './services/persistence'
import { gitCommitDiff, gitToplevel, recentGitCommits } from './services/git'
import { resolveTools, sessionEnvironment } from './services/cli-resolver'
import { TmuxService } from './services/tmux'
import { PtyService } from './services/pty'
import { AttributionStore } from './services/attribution-store'

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
  hiddenExternal = new Set<string>()
  private masterClaudeMdHash: string | null = null
  private masterNeedsReload = false
  toolPaths: ToolPaths | null = null
  worktrees: Record<string, Worktree[]> = {}
  documents: Record<string, KeyDocument[]> = {}
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
  private gitWatchers = new Map<string, GitWatcher>()
  readonly masterHome: MasterHome
  readonly refresh: RefreshScheduler
  readonly attributionStore: AttributionStore

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
    this.attributionStore = new AttributionStore(persistence.paths.attributionDatabase)
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
      hiddenExternal: [...this.hiddenExternal],
      toolPaths: this.toolPaths,
      worktrees: this.worktrees,
      preferences: this.preferences,
      documents: this.documents,
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
      await this.persistence.paths.createLayout()
      this.attributionStore.open()
      const config = await this.persistence.loadConfig()
      this.projects = config.projects
      this.preferences = { ...defaultPreferences, ...config.preferences, toolOverrides: { ...defaultPreferences.toolOverrides, ...config.preferences?.toolOverrides } }
      this.notifier.muted = this.preferences.notificationsMuted
      const file = await this.persistence.loadSessions()
      this.sessions = file.sessions
      for (const s of this.sessions) if (s.id === MASTER_SESSION_ID && s.displayName === 'Master Agent') s.displayName = 'Supervisor Agent'
      this.hiddenExternal = new Set(file.hiddenExternal ?? [])
      this.masterClaudeMdHash = file.masterClaudeMdHash ?? null
      this.loaded = true
    } catch (error) {
      this.report(error)
    }
    await this.refreshTools()
    await this.reconcileSessions()
    await Promise.all(this.projects.map((p) => this.refreshWorktrees(p.id, false)))
    await Promise.all(this.projects.map((p) => this.refreshDocuments(p.id, false)))
    this.startLivenessPolling()
    this.indexer.start()
    await this.rescanTranscripts()
    this.transcriptTimer = setInterval(() => void this.rescanTranscripts(), 30_000)
    await this.statusStore.start()
    await this.syncGitWatchers()
    await this.regenerateMasterHome()
    if (this.preferences.masterAutoStart && !(this.masterSession() && isAlive(this.masterSession()!))) {
      await this.startMaster()
    }
    this.changed()
  }

  async refreshTools(): Promise<void> {
    const o = this.preferences.toolOverrides
    const tools = await resolveTools({ claude: o.claude || undefined, codex: o.codex || undefined, tmux: o.tmux || undefined, git: o.git || undefined })
    this.toolPaths = tools
    this.worktreeService = tools.git ? new WorktreeService(tools.git, this.preferences.worktreeBase || this.paths.worktreesDir) : null
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
    const before = this.preferences
    this.preferences = { ...before, ...prefs, toolOverrides: { ...before.toolOverrides, ...prefs.toolOverrides } }
    this.notifier.muted = this.preferences.notificationsMuted
    this.persistConfig()
    this.changed()
    const toolsChanged =
      JSON.stringify(before.toolOverrides) !== JSON.stringify(this.preferences.toolOverrides) || before.worktreeBase !== this.preferences.worktreeBase
    if (toolsChanged) void this.refreshTools().then(() => this.syncGitWatchers())
  }

  private persistSessions(): void {
    this.persistence
      .saveSessions({
        version: SESSIONS_VERSION,
        sessions: this.sessions,
        hiddenExternal: [...this.hiddenExternal],
        masterClaudeMdHash: this.masterClaudeMdHash ?? undefined,
      })
      .catch((e) => this.report(e))
  }

  // MARK: Projects

  project(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  async recentCommits(projectId: string) {
    const project = this.project(projectId)
    if (!project || !this.toolPaths?.git) return []
    const commits = await recentGitCommits(this.toolPaths.git, project.path, 20)
    return commits.map((commit) => {
      const sessionId = this.attributionStore.get(projectId, commit.hash)
      const session = sessionId ? this.session(sessionId) : undefined
      return { ...commit, sessionId, sessionName: session?.displayName ?? null, agentTool: session?.tool ?? null }
    })
  }

  recordCommit(sessionId: string, cwd: string, hash: string): void {
    if (!/^[0-9a-f]{40}$/i.test(hash) || !this.session(sessionId)) return
    const worktreePaths = Object.fromEntries(Object.entries(this.worktrees).map(([id, worktrees]) => [id, worktrees.map((worktree) => worktree.path)]))
    const projectId = projectForCwd(cwd, this.projects, worktreePaths)
    if (!projectId) return
    this.attributionStore.set(projectId, hash, sessionId)
    this.changed()
  }

  async commitDiff(projectId: string, hash: string): Promise<string> {
    const project = this.project(projectId)
    if (!project || !this.toolPaths?.git) throw new SauronError('invalid_state', 'Project or git is unavailable.')
    return gitCommitDiff(this.toolPaths.git, project.path, hash)
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
      await this.refreshDocuments(project.id)
      await this.syncGitWatchers()
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
    void this.syncGitWatchers()
  }

  /** One watcher per project. On startup, projects whose HEAD moved since their last summary are queued. */
  async syncGitWatchers(): Promise<void> {
    const git = this.toolPaths?.git
    if (!git) return
    const wanted = new Set(this.projects.map((p) => p.id))
    for (const [id, w] of this.gitWatchers) {
      if (!wanted.has(id)) {
        w.stop()
        this.gitWatchers.delete(id)
      }
    }
    for (const project of this.projects) {
      if (this.gitWatchers.has(project.id)) continue
      const watcher = new GitWatcher(git, project.path, () => {
        console.log('commit detected in', project.name)
        this.refresh.enqueue(project.id)
        void this.refreshWorktrees(project.id)
      })
      this.gitWatchers.set(project.id, watcher)
      await watcher.start()
      const status = this.statusStore.statuses[project.id]
      const head = await watcher.headCommit()
      if (status && head && status.headCommit && status.headCommit !== head) {
        console.log('HEAD moved since last summary for', project.name)
        this.refresh.enqueue(project.id)
      }
    }
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
      PATH: `${this.paths.binDir}:${tools.path}`,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      SAURON_SESSION_ID: sessionId,
      SAURON_SOCKET: this.paths.socketFile,
      SAURON_REAL_GIT: tools.git ?? 'git',
    }
  }

  private nextDisplayName(tool: AgentTool, projectId: string | null): string {
    const label = tool === 'claude' ? 'Claude' : tool === 'codex' ? 'Codex' : 'Terminal'
    const count = this.sessionsFor(projectId).filter((s) => s.tool === tool).length
    return count === 0 ? label : `${label} ${count + 1}`
  }

  /** Agents run unattended inside Sauron, so they always start with permission prompts bypassed. */
  private static readonly CLAUDE_BYPASS = ['--dangerously-skip-permissions']
  private static readonly CODEX_BYPASS = ['--dangerously-bypass-approvals-and-sandbox']

  /** The command line that starts an agent inside a session's shell, or null for a plain shell. */
  private async agentCommand(tool: AgentTool, sessionId: string, prompt: string | undefined, tools: ToolPaths): Promise<string[] | null> {
    if (tool === 'claude') {
      if (!tools.claude) throw new SauronError('executable_not_found', 'claude was not found on PATH.')
      const cmd = [tools.claude, ...AppState.CLAUDE_BYPASS, '--session-id', sessionId, ...(await this.claudeSettingsArgs(sessionId))]
      if (prompt) cmd.push(prompt)
      return cmd
    }
    if (tool === 'codex') {
      if (!tools.codex) throw new SauronError('executable_not_found', 'codex was not found on PATH.')
      const cmd = [tools.codex, ...AppState.CODEX_BYPASS, ...(this.sauronBin ? ['-c', codexNotifyConfig(this.sauronBin)] : [])]
      if (prompt) cmd.push(prompt)
      return cmd
    }
    return null
  }

  /** Stamps identifying options onto a tmux session so it can be recovered without sessions.json. */
  private async stampTmux(tmux: TmuxService, tmuxName: string, session: Pick<Session, 'id' | 'projectId' | 'displayName' | 'tool'>): Promise<void> {
    await tmux.setOption(tmuxName, TMUX_OPTION_SESSION, session.id)
    await tmux.setOption(tmuxName, TMUX_OPTION_PROJECT, session.projectId ?? '')
    await tmux.setOption(tmuxName, TMUX_OPTION_TITLE, session.displayName)
    await tmux.setOption(tmuxName, TMUX_OPTION_TOOL, session.tool)
  }

  /**
   * Starts a tmux session running the user's login shell in the project (or a new worktree).
   * For claude/codex the agent command is typed into that shell, so the terminal outlives it.
   */
  async launchSession(projectId: string, tool: AgentTool, options: LaunchOptions = {}): Promise<Session | null> {
    const project = this.project(projectId)
    if (!project) {
      this.report(new SauronError('invalid_state', `Unknown project ${projectId}`))
      return null
    }
    try {
      const { tools, tmux } = this.requireTools()
      const id = randomUUID()
      const title = options.title?.trim() || this.nextDisplayName(tool, project.id)
      const tmuxName = tmuxSessionName(title, id)
      let worktreePath: string | null = null
      if (options.worktreeBranch !== undefined) {
        if (!this.worktreeService) throw new SauronError('executable_not_found', 'git was not found on PATH.')
        const branch = options.worktreeBranch.trim() || defaultWorktreeBranch(id)
        worktreePath = await this.worktreeService.create(project.path, project.name, branch)
        await this.refreshWorktrees(project.id, false)
      }
      const cwd = worktreePath ?? project.path
      const agent = await this.agentCommand(tool, id, options.prompt?.trim() || undefined, tools)
      const shell = process.env.SHELL || '/bin/zsh'
      await tmux.newSession({ name: tmuxName, workingDir: cwd, environment: this.launchEnvironment(id, tools), command: [shell, '-l'] })
      const now = new Date().toISOString()
      const session: Session = {
        id,
        projectId: project.id,
        tool,
        kind: 'managed',
        displayName: title,
        tmuxName,
        cliSessionId: tool === 'claude' ? id : null,
        // Codex picks its own session id; the transcript indexer fills it in later.
        transcriptPath: tool === 'claude' ? claudeTranscriptPath(homedir(), cwd, id) : null,
        workingDir: project.path,
        worktreePath,
        createdAt: now,
        lastActivityAt: now,
        state: 'running',
        stateSource: 'inferred',
      }
      await this.stampTmux(tmux, tmuxName, session)
      if (agent) await tmux.sendText(tmuxName, shellCommandLine(agent))
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

  /** Renames a session everywhere: the record, the tmux session name, and the tmux title option. */
  async renameSession(id: string, title: string): Promise<void> {
    const session = this.session(id)
    const clean = title.trim()
    if (!session || !clean || session.kind !== 'managed') return
    try {
      if (session.tmuxName && isAlive(session) && this.tmux && id !== MASTER_SESSION_ID) {
        const newName = tmuxSessionName(clean, id)
        if (newName !== session.tmuxName) await this.tmux.renameSession(session.tmuxName, newName)
        await this.tmux.setOption(newName, TMUX_OPTION_TITLE, clean)
        this.updateSession(id, (s) => {
          s.tmuxName = newName
          s.displayName = clean
        })
      } else {
        this.updateSession(id, (s) => {
          s.displayName = clean
        })
      }
    } catch (error) {
      this.report(error, { sessionId: id })
    }
  }

  /** Writes the per-session Claude settings file carrying Sauron's hooks and returns the CLI args. */
  private async claudeSettingsArgs(sessionId: string): Promise<string[]> {
    if (!this.sauronBin) return []
    const file = join(this.paths.sessionsDir, sessionId, 'claude-settings.json')
    await writeJsonAtomic(file, claudeHookSettings(this.sauronBin))
    return ['--settings', file]
  }

  /** Starts a new shell session and resumes the agent conversation inside it. */
  async resumeSession(id: string): Promise<void> {
    const session = this.session(id)
    if (!session || session.state !== 'stopped') return
    try {
      const { tools, tmux } = this.requireTools()
      let command: string[] | null = null
      if (session.cliSessionId && session.tool === 'claude') {
        if (!tools.claude) throw new SauronError('executable_not_found', 'claude was not found on PATH.')
        command = [tools.claude, ...AppState.CLAUDE_BYPASS, '--resume', session.cliSessionId, ...(await this.claudeSettingsArgs(session.id))]
      } else if (session.cliSessionId && session.tool === 'codex') {
        if (!tools.codex) throw new SauronError('executable_not_found', 'codex was not found on PATH.')
        command = [tools.codex, ...AppState.CODEX_BYPASS, ...(this.sauronBin ? ['-c', codexNotifyConfig(this.sauronBin)] : []), 'resume', session.cliSessionId]
      }
      const tmuxName = tmuxSessionName(session.displayName, session.id)
      const shell = process.env.SHELL || '/bin/zsh'
      await tmux.newSession({
        name: tmuxName,
        workingDir: session.worktreePath ?? session.workingDir,
        environment: this.launchEnvironment(session.id, tools),
        command: [shell, '-l'],
      })
      await this.stampTmux(tmux, tmuxName, session)
      if (command) await tmux.sendText(tmuxName, shellCommandLine(command))
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

  /** Interrupts whatever runs in the session, then kills the tmux session. */
  private async killTmux(session: Session): Promise<void> {
    if (!session.tmuxName) return
    const { tmux } = this.requireTools()
    if (await tmux.hasSession(session.tmuxName)) {
      await tmux.sendInterrupt(session.tmuxName)
      await sleep(1500)
      if (await tmux.hasSession(session.tmuxName)) await tmux.killSession(session.tmuxName)
    }
    this.pty?.close(session.id)
  }

  /**
   * Closes a managed session: the tmux session dies. Claude and Codex sessions keep their
   * record (stopped, resumable by CLI session id); plain terminals are forgotten.
   */
  async closeSession(id: string): Promise<void> {
    const session = this.session(id)
    if (!session || session.kind !== 'managed') return
    try {
      await this.killTmux(session)
      if (session.tool === 'shell' || !session.cliSessionId) {
        this.sessions = this.sessions.filter((s) => s.id !== id)
        this.persistSessions()
        this.changed()
        if (session.projectId) this.select({ kind: 'project', id: session.projectId })
      } else {
        this.markStopped(id)
      }
      this.notifier.setBadge(this.waitingCount())
    } catch (error) {
      this.report(error, { sessionId: id })
    }
  }

  /** Kept for the supervisor agent and the CLI's `stop`: close without forgetting. */
  async stopSession(id: string): Promise<void> {
    const session = this.session(id)
    if (!session?.tmuxName) return
    try {
      await this.killTmux(session)
      this.markStopped(id)
    } catch (error) {
      this.report(error, { sessionId: id })
    }
  }

  /** External sessions only: remove from view; the transcript stays on disk. */
  hideSession(id: string): void {
    const session = this.session(id)
    if (!session || session.kind !== 'external' || !session.cliSessionId) return
    this.hiddenExternal.add(session.cliSessionId)
    for (const [path, s] of this.externalSessions) if (s.id === id) this.externalSessions.delete(path)
    this.persistSessions()
    this.changed()
    if (session.projectId) this.select({ kind: 'project', id: session.projectId })
  }

  unhideSession(cliSessionId: string): void {
    this.hiddenExternal.delete(cliSessionId)
    this.persistSessions()
    void this.rescanTranscripts()
  }

  forgetSession(id: string): void {
    this.pty?.close(id)
    // Its transcript stays on disk; keep it from coming back as an external session.
    const cliId = this.session(id)?.cliSessionId
    if (cliId) this.hiddenExternal.add(cliId)
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

  // MARK: Key documents

  async refreshDocuments(projectId: string, broadcast = true): Promise<void> {
    const project = this.project(projectId)
    if (!project) return
    try {
      this.documents[projectId] = await listKeyDocuments(project)
      if (broadcast) this.changed()
    } catch (error) {
      this.report(error, { projectId })
    }
  }

  async addKeyDocument(projectId: string, absolutePath: string): Promise<void> {
    const project = this.project(projectId)
    if (!project) return
    try {
      const rel = relativeInside(project, absolutePath)
      const kd = project.keyDocuments ?? { included: [], excluded: [] }
      kd.excluded = kd.excluded.filter((p) => p !== rel)
      if (!kd.included.includes(rel)) kd.included.push(rel)
      project.keyDocuments = kd
      this.persistConfig()
      await this.refreshDocuments(projectId)
    } catch (error) {
      this.report(error, { projectId })
    }
  }

  async removeKeyDocument(projectId: string, rel: string): Promise<void> {
    const project = this.project(projectId)
    if (!project) return
    const kd = project.keyDocuments ?? { included: [], excluded: [] }
    if (kd.included.includes(rel)) kd.included = kd.included.filter((p) => p !== rel)
    else if (!kd.excluded.includes(rel)) kd.excluded.push(rel)
    project.keyDocuments = kd
    this.persistConfig()
    await this.refreshDocuments(projectId)
  }

  async readDocument(projectId: string, rel: string): Promise<{ content: string; mtime: string }> {
    const project = this.project(projectId)
    if (!project) throw new SauronError('invalid_state', `Unknown project ${projectId}`)
    return readDocument(project, rel)
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
    // The agent runs inside a shell that survives it: SessionEnd means idle, not stopped
    // (the master runs claude directly, so for it the tmux liveness poll decides).
    const nextState = transition.state === 'stopped' && sessionId !== MASTER_SESSION_ID ? 'idle' : transition.state
    this.updateSession(sessionId, (s) => {
      s.state = nextState
      s.stateSource = 'hook'
      s.lastActivityAt = new Date().toISOString()
      // A terminal that ran an agent keeps that identity so it stays resumable.
      if (s.tool === 'shell') s.tool = event.tool
      if (event.tool === 'claude' && typeof event.payload.session_id === 'string') {
        s.cliSessionId = event.payload.session_id
        if (typeof event.payload.transcript_path === 'string') s.transcriptPath = event.payload.transcript_path
      }
      if (event.tool === 'codex') {
        const tid = event.payload['thread-id'] ?? event.payload.thread_id ?? event.payload['session-id']
        if (typeof tid === 'string') s.cliSessionId = tid
      }
    })
    if (nextState === 'stopped' && !wasStopped) this.pty?.close(sessionId)
    this.notifier.setBadge(this.waitingCount())
    if (sessionId === MASTER_SESSION_ID) {
      if (transition.state === 'idle') {
        void this.nudgeMasterReload().then(() => this.refresh.markDone())
      }
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
      if (this.hiddenExternal.has(sessionId)) continue
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
      if (session.tool === 'shell') return { entries: [], total: 0 }
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

  // MARK: Supervisor agent

  masterSession(): Session | undefined {
    return this.sessions.find((s) => s.id === MASTER_SESSION_ID)
  }

  /** Rewrites CLAUDE.md; if it changed since the supervisor last saw it, nudge it to re-read. */
  async regenerateMasterHome(): Promise<void> {
    if (!this.sauronBin) return
    try {
      const hash = await this.masterHome.regenerate(this.projects, this.sauronBin)
      if (hash !== this.masterClaudeMdHash) {
        const master = this.masterSession()
        if (master && isAlive(master)) {
          this.masterNeedsReload = true
          await this.nudgeMasterReload()
        } else {
          // Not running: the next start loads the new file directly.
          this.masterClaudeMdHash = hash
          this.persistSessions()
        }
      }
    } catch (error) {
      this.report(error)
    }
  }

  /** Sends the re-read notice when the supervisor is idle; returns once sent or skipped. */
  private async nudgeMasterReload(): Promise<void> {
    const master = this.masterSession()
    if (!this.masterNeedsReload || !master || !isAlive(master) || master.state !== 'idle' || !this.tmux || !master.tmuxName) return
    try {
      await this.tmux.sendText(
        master.tmuxName,
        `Sauron regenerated your instructions. Read ${this.masterHome.claudeMdPath} again now and follow it from here on; reply with one line when done.`,
      )
      this.masterNeedsReload = false
      this.masterClaudeMdHash = await this.masterHome.regenerate(this.projects, this.sauronBin!)
      this.updateSession(MASTER_SESSION_ID, (s) => {
        s.state = 'running'
      })
    } catch (error) {
      this.report(error, { sessionId: MASTER_SESSION_ID })
    }
  }

  /** Starts the supervisor agent, resuming its previous conversation when possible. */
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
        const tmuxName = tmuxSessionName('supervisor', randomUUID())
        const command = resume
          ? [tools.claude!, ...AppState.CLAUDE_BYPASS, '--resume', cliSessionId, ...settings, ...addDirs]
          : [tools.claude!, ...AppState.CLAUDE_BYPASS, '--session-id', cliSessionId, ...settings, ...addDirs]
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
        displayName: 'Supervisor Agent',
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
      if (!resumed) {
        this.masterClaudeMdHash = await this.masterHome.regenerate(this.projects, this.sauronBin!)
        this.masterNeedsReload = false
      }
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
      this.report(new SauronError('invalid_state', 'The supervisor agent is not running. Start it to refresh summaries.'), { projectId })
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

  async setStatus(
    projectId: string,
    summary: string,
    details: string | null,
    recentUpdates: string[] = [],
    todos: string[] = [],
    source: ProjectStatus['source'] = 'master',
  ): Promise<ProjectStatus> {
    const project = this.project(projectId)
    if (!project) throw new SauronError('invalid_state', `Unknown project ${projectId}`)
    let headCommit: string | null = null
    if (this.toolPaths?.git) {
      const r = await runCommand(this.toolPaths.git, ['rev-parse', 'HEAD'], { cwd: project.path })
      if (r.code === 0) headCommit = r.stdout.trim()
    }
    const status: ProjectStatus = { projectId, summary: firstSentence(summary), recentUpdates, todos, details, updatedAt: new Date().toISOString(), headCommit, source }
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
          // Alive after a restart: assume idle until a hook reports otherwise.
          s.state = 'idle'
          s.stateSource = 'inferred'
        } else if (s.state !== 'stopped') {
          s.state = 'stopped'
        }
      }
      const unknown = [...live].filter((n) => !known.has(n)).sort()
      const stillOrphans: string[] = []
      for (const name of unknown) {
        const recovered = await this.recoverStampedSession(name)
        if (!recovered) stillOrphans.push(name)
      }
      this.orphanTmuxSessions = stillOrphans
      this.persistSessions()
      this.changed()
    } catch (error) {
      this.report(error)
    }
  }

  /** Rebuilds a session record from the options Sauron stamped on a tmux session. */
  private async recoverStampedSession(tmuxName: string): Promise<boolean> {
    if (!this.tmux) return false
    const id = await this.tmux.getOption(tmuxName, TMUX_OPTION_SESSION)
    if (!id) return false
    const projectId = (await this.tmux.getOption(tmuxName, TMUX_OPTION_PROJECT)) || null
    const title = (await this.tmux.getOption(tmuxName, TMUX_OPTION_TITLE)) || tmuxName
    const toolRaw = await this.tmux.getOption(tmuxName, TMUX_OPTION_TOOL)
    const tool: AgentTool = toolRaw === 'claude' || toolRaw === 'codex' ? toolRaw : 'shell'
    const project = projectId ? this.project(projectId) : undefined
    const now = new Date().toISOString()
    this.sessions.push({
      id,
      projectId: project?.id ?? null,
      tool,
      kind: 'managed',
      displayName: title,
      tmuxName,
      cliSessionId: tool === 'claude' ? id : null,
      transcriptPath: null,
      workingDir: project?.path ?? homedir(),
      worktreePath: null,
      createdAt: now,
      lastActivityAt: now,
      state: 'idle',
      stateSource: 'inferred',
    })
    console.log('recovered session from tmux options', tmuxName, title)
    return true
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
    for (const w of this.gitWatchers.values()) w.stop()
    for (const id of [...this.tailers.keys()]) this.transcriptClose(id)
    this.pty?.closeAll()
    this.attributionStore.close()
    await this.persistence.flush()
  }
}
