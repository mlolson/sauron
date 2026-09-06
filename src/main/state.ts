import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { AgentDefinition, AgentTool, AppError, BackgroundJob, JobRun, LaunchOptions, Preferences, Project, RecentCommit, Session, SelectionTarget, SessionCommit, Snapshot, TmuxClient, ToolPaths, WorktreeRemovalCheck } from '@shared/types'
import { defaultPreferences } from '@shared/types'
import { compareSessions } from '@shared/session-order'
import { claudeHookSettings, codexNotifyConfig, looksLikeApprovalPrompt, transitionForHook, type HookEvent } from '@shared/hooks'
import { writeJsonAtomic } from './services/persistence'
import { join } from 'node:path'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { Notifier } from './services/notifier'
import { TranscriptIndexer, TranscriptTailer, type TranscriptFile } from './services/transcripts'
import { projectForCwd } from '@shared/transcripts'
import type { TranscriptEntry, TranscriptPage } from '@shared/transcript-types'
import { defaultProjectSummaryPrompt, MASTER_SESSION_ID, firstSentence, type ProjectStatus } from '@shared/status'
import { StatusStore } from './services/status-store'
import { MasterHome, RefreshScheduler } from './services/master'
import { ensureClaudeTrusts } from './services/claude-config'
import { GitWatcher } from './services/git-watcher'
import { listKeyDocuments, readDocument, relativeInside, writeDocument } from './services/documents'
import type { KeyDocument } from '@shared/types'
import { runCommand } from './services/command'
import type { Worktree } from '@shared/worktrees'
import { defaultWorktreeBranch } from '@shared/worktrees'
import { WorktreeService } from './services/worktrees'
import { CONFIG_VERSION, SESSIONS_VERSION, SauronError, isAlive } from '@shared/types'
import { tmuxSessionName, shellCommandLine, TMUX_OPTION_PROJECT, TMUX_OPTION_SESSION, TMUX_OPTION_TITLE, TMUX_OPTION_TOOL } from '@shared/tmux-args'
import { claudeTranscriptPath } from '@shared/transcripts'
import { Persistence } from './services/persistence'
import { commitPath, commitSummaries, commitsByHash, gitCommitDiff, gitToplevel, hashesOnBranch, listBranches, recentGitCommits } from './services/git'
import { readTranscriptEntries } from './services/transcripts'
import { renderHandoff } from '@shared/handoff'
import { installPostCommitHook, removePostCommitHook } from './services/git-hooks'
import { resolveTools, sessionEnvironment } from './services/cli-resolver'
import { TmuxService } from './services/tmux'
import { PtyService } from './services/pty'
import { AttributionStore } from './services/attribution-store'
import { JobStore } from './services/job-store'
import { runTranscriptPath } from './services/job-runner'
import { installTick } from './services/launchd'

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
  private automaticRefreshAt = new Map<string, number>()
  readonly masterHome: MasterHome
  readonly refresh: RefreshScheduler
  readonly attributionStore: AttributionStore
  readonly jobStore: JobStore
  /** Recent background runs per project, refreshed from the job store on change. */
  runs: Record<string, JobRun[]> = {}
  schedulerLoaded: boolean | null = null

  tmux: TmuxService | null = null
  pty: PtyService | null = null
  worktreeService: WorktreeService | null = null
  private livenessTimer: NodeJS.Timeout | null = null

  constructor(public readonly persistence: Persistence) {
    super()
    this.statusStore = new StatusStore(persistence.paths.statusDir, () => {
      const master = this.masterSession()
      if (master && master.tool !== 'claude' && master.tool !== 'codex') {
        this.updateSession(MASTER_SESSION_ID, (session) => { session.state = 'idle' })
      }
      this.refresh.markDone()
      this.changed()
    })
    this.masterHome = new MasterHome(persistence.paths.masterDir, persistence.paths.statusDir)
    this.attributionStore = new AttributionStore(persistence.paths.attributionDatabase)
    this.jobStore = new JobStore(persistence.paths.jobsDatabase)
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
      runs: this.runs,
      schedulerLoaded: this.schedulerLoaded,
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
      this.jobStore.open()
      const config = await this.persistence.loadConfig()
      this.projects = config.projects
      const savedPreferences = config.preferences
      const legacyPreferences = (savedPreferences ?? {}) as Partial<Preferences> & {
        supervisorAutoSummariesActiveProjects?: boolean
        supervisorAutoSummariesAfterCommit?: boolean
        supervisorSummaryCooldownMinutes?: number
        supervisorProjectSummaryPrompt?: string
        externalRecentHours?: number
      }
      const {
        supervisorAutoSummariesActiveProjects: _removedActiveSummary,
        externalRecentHours: _removedExternalCutoff,
        supervisorAutoSummariesAfterCommit: legacySummaryAfterCommit,
        supervisorSummaryCooldownMinutes: legacySummaryCooldown,
        supervisorProjectSummaryPrompt: legacySummaryPrompt,
        ...cleanPreferences
      } = legacyPreferences
      let migratedAgents = savedPreferences?.agents ?? [
        { ...defaultPreferences.agents[0]!, command: savedPreferences?.toolOverrides?.claude || 'claude' },
        { ...defaultPreferences.agents[1]!, command: savedPreferences?.toolOverrides?.codex || 'codex' },
        ...(savedPreferences?.customAgents ?? []),
      ]
      if (config.version < 2) {
        const defaultsById = new Map(defaultPreferences.agents.map((agent) => [agent.id, agent]))
        migratedAgents = migratedAgents.map((agent) => {
          const defaultAgent = defaultsById.get(agent.id)
          if (!defaultAgent) return agent
          return { ...agent, args: [...defaultAgent.args.filter((arg) => !agent.args.includes(arg)), ...agent.args] }
        })
      }
      if (config.version < 3) {
        const defaultsById = new Map(defaultPreferences.agents.map((agent) => [agent.id, agent]))
        migratedAgents = migratedAgents.map((agent) => ({ ...agent, forkCommand: agent.forkCommand ?? defaultsById.get(agent.id)?.forkCommand }))
      }
      {
        // Not versioned: filling in a missing background command is idempotent and harmless.
        const defaultsById = new Map(defaultPreferences.agents.map((agent) => [agent.id, agent]))
        migratedAgents = migratedAgents.map((agent) => ({ ...agent, backgroundCommand: agent.backgroundCommand ?? defaultsById.get(agent.id)?.backgroundCommand }))
      }
      this.preferences = {
        ...defaultPreferences,
        ...cleanPreferences,
        agents: migratedAgents,
        supervisorArgs: savedPreferences?.supervisorArgs ?? [],
        supervisorProjectSummaryAfterCommit: cleanPreferences.supervisorProjectSummaryAfterCommit ?? legacySummaryAfterCommit ?? true,
        supervisorProjectSummaryAfterCommitCooldownMinutes: cleanPreferences.supervisorProjectSummaryAfterCommitCooldownMinutes ?? legacySummaryCooldown ?? 5,
        supervisorProjectSummaryPromptFile: cleanPreferences.supervisorProjectSummaryPromptFile ?? 'summary-prompt.md',
        toolOverrides: { ...defaultPreferences.toolOverrides, ...savedPreferences?.toolOverrides },
      }
      await this.ensureSummaryPromptFile(legacySummaryPrompt)
      if (config.version < CONFIG_VERSION) this.persistConfig()
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
    await this.refreshRuns()
    await this.installScheduler()
    await Promise.all(this.projects.map((p) => this.refreshWorktrees(p.id, false)))
    await Promise.all(this.projects.map((p) => this.refreshDocuments(p.id, false)))
    this.startLivenessPolling()
    this.indexer.start()
    await this.rescanTranscripts()
    this.transcriptTimer = setInterval(() => void this.rescanTranscripts(), 30_000)
    await this.statusStore.start()
    await this.syncGitWatchers()
    await this.syncCommitHooks()
    await this.regenerateMasterHome()
    if (this.preferences.supervisorEnabled && this.preferences.masterAutoStart && !(this.masterSession() && isAlive(this.masterSession()!))) {
      await this.startMaster()
    }
    this.changed()
  }

  async refreshTools(): Promise<void> {
    const o = this.preferences.toolOverrides
    const tools = await resolveTools({ claude: o.claude || undefined, codex: o.codex || undefined, tmux: o.tmux || undefined, git: o.git || undefined }, this.preferences.agents)
    console.log('resolved tools', tools)
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
    // Disabling is not just a flag: the running agent has to go, and any queued summary work
    // with it, or the app would keep waiting on an agent that will never answer.
    if (before.supervisorEnabled && !this.preferences.supervisorEnabled) {
      for (const project of this.projects) this.refresh.remove(project.id)
      void this.stopMaster().catch((error) => this.report(error, { sessionId: MASTER_SESSION_ID }))
    }
    void this.ensureSummaryPromptFile().catch((error) => this.report(error))
    this.persistConfig()
    this.changed()
    const toolsChanged =
      JSON.stringify(before.toolOverrides) !== JSON.stringify(this.preferences.toolOverrides) ||
      JSON.stringify(before.agents) !== JSON.stringify(this.preferences.agents) ||
      before.worktreeBase !== this.preferences.worktreeBase
    if (toolsChanged) void this.refreshTools().then(() => this.syncGitWatchers())
  }

  async getConfigFile(): Promise<{ path: string; content: string }> {
    this.persistConfig()
    await this.persistence.flush()
    return { path: this.paths.configFile, content: await readFile(this.paths.configFile, 'utf8') }
  }

  async saveConfigFile(content: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new SauronError('persistence', `Invalid JSON: ${(error as Error).message}`)
    }
    if (!parsed || typeof parsed !== 'object') throw new SauronError('persistence', 'Config must be a JSON object.')
    const config = parsed as Partial<import('@shared/types').AppConfig>
    if (!Array.isArray(config.projects)) throw new SauronError('persistence', 'Config must contain a projects array.')
    if (!config.preferences || typeof config.preferences !== 'object') throw new SauronError('persistence', 'Config must contain a preferences object.')
    if (!Array.isArray(config.preferences.agents)) throw new SauronError('persistence', 'preferences.agents must be an array.')
    if (typeof config.preferences.supervisorProjectSummaryAfterCommit !== 'boolean') throw new SauronError('persistence', 'supervisorProjectSummaryAfterCommit must be a boolean.')
    if (typeof config.preferences.supervisorProjectSummaryAfterCommitCooldownMinutes !== 'number' || config.preferences.supervisorProjectSummaryAfterCommitCooldownMinutes < 0) throw new SauronError('persistence', 'supervisorProjectSummaryAfterCommitCooldownMinutes must be a non-negative number.')
    if (typeof config.preferences.supervisorProjectSummaryPromptFile !== 'string' || !config.preferences.supervisorProjectSummaryPromptFile.trim()) throw new SauronError('persistence', 'supervisorProjectSummaryPromptFile must be a non-empty string.')
    for (const agent of config.preferences.agents) {
      if (!agent || typeof agent.id !== 'string' || !agent.id || typeof agent.name !== 'string' || typeof agent.command !== 'string' || !Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === 'string')) {
        throw new SauronError('persistence', 'Every agent needs string id, name, command, and a string args array.')
      }
      if (agent.forkCommand !== undefined && (!Array.isArray(agent.forkCommand) || !agent.forkCommand.every((arg) => typeof arg === 'string'))) {
        throw new SauronError('persistence', 'Agent forkCommand must be a string array when present.')
      }
    }
    this.projects = config.projects
    this.preferences = {
      ...defaultPreferences,
      ...config.preferences,
      agents: config.preferences.agents,
      supervisorArgs: Array.isArray(config.preferences.supervisorArgs) ? config.preferences.supervisorArgs : [],
      toolOverrides: { ...defaultPreferences.toolOverrides, ...config.preferences.toolOverrides },
    }
    this.notifier.muted = this.preferences.notificationsMuted
    await this.ensureSummaryPromptFile()
    this.persistConfig()
    await this.persistence.flush()
    await this.refreshTools()
    await this.syncGitWatchers()
    await this.regenerateMasterHome()
    this.changed()
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

  /** Local branch names, for the commit list's filter. */
  async projectBranches(projectId: string): Promise<string[]> {
    const project = this.project(projectId)
    if (!project || !this.toolPaths?.git) return []
    return listBranches(this.toolPaths.git, project.path)
  }

  async recentCommits(projectId: string, limit = 20, branch?: string) {
    const project = this.project(projectId)
    if (!project || !this.toolPaths?.git) return []
    const commits = await recentGitCommits(this.toolPaths.git, project.path, limit, branch)
    return commits.map((commit) => {
      const sessionId = this.attributionStore.get(projectId, commit.hash)
      const session = sessionId ? this.session(sessionId) : undefined
      return { ...commit, sessionId, sessionName: session?.displayName ?? null, agentTool: session?.tool ?? null }
    })
  }

  /** Commits this session made, newest first, whether or not they are recent in the project. */
  async sessionCommits(sessionId: string, branch?: string, limit = 200): Promise<RecentCommit[]> {
    const session = this.session(sessionId)
    if (!session?.projectId || !this.toolPaths?.git) return []
    const project = this.project(session.projectId)
    if (!project) return []
    let hashes = this.attributionStore.commitsForSession(sessionId, limit)
    if (branch) {
      const onBranch = await hashesOnBranch(this.toolPaths.git, project.path, branch)
      hashes = hashes.filter((hash) => onBranch.has(hash))
    }
    const found = new Map((await commitsByHash(this.toolPaths.git, project.path, hashes)).map((c) => [c.hash, c]))
    // The store's order is the order the session made them; git's own ordering is by date.
    return hashes.flatMap((hash) => {
      const commit = found.get(hash)
      return commit ? [{ ...commit, sessionId, sessionName: session.displayName, agentTool: session.tool }] : []
    })
  }

  /** Stores a manual order for a project's managed sessions; unlisted ones keep their place. */
  reorderSessions(projectId: string, orderedIds: string[]): void {
    const positions = new Map(orderedIds.map((id, index) => [id, index]))
    let changed = false
    for (const session of this.sessions) {
      if (session.projectId !== projectId) continue
      const next = positions.get(session.id)
      if (next === undefined || session.sortIndex === next) continue
      session.sortIndex = next
      changed = true
    }
    if (!changed) return
    this.persistSessions()
    this.changed()
  }

  async recordCommit(sessionId: string, cwd: string, hash: string): Promise<void> {
    if (!/^[0-9a-f]{40}$/i.test(hash) || !this.session(sessionId)) return
    let projectId = this.projectForDirectory(cwd)
    if (!projectId) {
      // A miss is the signal that the worktree list may be stale: an agent's very first commit
      // in a worktree made outside Sauron arrives before that worktree has been seen. Refresh
      // once and look again, so the commit is recorded rather than silently dropped.
      await Promise.all(this.projects.map((project) => this.refreshWorktrees(project.id, false)))
      projectId = this.projectForDirectory(cwd)
      if (!projectId) return
    }
    this.attributionStore.set(projectId, hash, sessionId)
    this.maybeCommitSummaryRefresh(projectId)
    this.changed()
  }

  /** The project owning a directory, whether it is the checkout or one of its worktrees. */
  private projectForDirectory(cwd: string): string | null {
    const worktreePaths = Object.fromEntries(Object.entries(this.worktrees).map(([id, worktrees]) => [id, worktrees.map((worktree) => worktree.path)]))
    return projectForCwd(cwd, this.projects, worktreePaths)
  }

  /** The latest commit each session in this project made, for the session list. */
  async lastCommitBySession(projectId: string): Promise<Record<string, SessionCommit>> {
    const project = this.project(projectId)
    if (!project || !this.toolPaths?.git) return {}
    const latest = this.attributionStore.latestPerSession(projectId)
    if (latest.size === 0) return {}
    const summaries = await commitSummaries(this.toolPaths.git, project.path, [...new Set(latest.values())])
    const bySession: Record<string, SessionCommit> = {}
    for (const [sessionId, hash] of latest) {
      const summary = summaries.get(hash)
      if (summary) bySession[sessionId] = summary
    }
    return bySession
  }

  /**
   * Keeps every project's post-commit hook current. Runs on load and whenever a project is
   * added, so a Sauron upgrade or a moved CLI repairs the hooks without the user doing anything.
   */
  async syncCommitHooks(): Promise<void> {
    const git = this.toolPaths?.git
    if (!git || !this.sauronBin) return
    await Promise.all(this.projects.map((project) => this.installCommitHook(project)))
  }

  private async installCommitHook(project: Project): Promise<void> {
    const git = this.toolPaths?.git
    if (!git || !this.sauronBin) return
    try {
      await installPostCommitHook(git, project.path, this.sauronBin)
    } catch (error) {
      this.report(error, { projectId: project.id })
    }
  }

  private async uninstallCommitHook(project: Project): Promise<void> {
    const git = this.toolPaths?.git
    if (!git) return
    try {
      await removePostCommitHook(git, project.path)
    } catch (error) {
      this.report(error, { projectId: project.id })
    }
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
      const project: Project = { id: randomUUID(), name: basename(root), path: root, addedAt: new Date().toISOString(), pinned: false, archived: false }
      this.projects.push(project)
      this.persistConfig()
      this.changed()
      this.select({ kind: 'project', id: project.id })
      await this.regenerateMasterHome()
      await this.installCommitHook(project)
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
    const project = this.project(id)
    if (project) void this.uninstallCommitHook(project)
    this.projects = this.projects.filter((p) => p.id !== id)
    this.refresh.remove(id)
    this.persistConfig()
    this.changed()
    void this.regenerateMasterHome()
    void this.syncGitWatchers()
  }

  async archiveProject(id: string, archived: boolean): Promise<void> {
    const project = this.project(id)
    if (!project || Boolean(project.archived) === archived) return
    if (archived) {
      const live = this.sessionsFor(id).filter((session) => session.kind === 'managed' && isAlive(session))
      for (const session of live) await this.closeSession(session.id)
      this.refresh.remove(id)
    }
    project.archived = archived
    this.persistConfig()
    await this.syncGitWatchers()
    this.changed()
    this.select({ kind: 'project', id })
  }

  /** Watches refs for worktree metadata only; commit summary triggers come from the post-commit hook. */
  async syncGitWatchers(): Promise<void> {
    const git = this.toolPaths?.git
    if (!git) return
    const wanted = new Set(this.projects.filter((project) => !project.archived).map((p) => p.id))
    for (const [id, w] of this.gitWatchers) {
      if (!wanted.has(id)) {
        w.stop()
        this.gitWatchers.delete(id)
      }
    }
    for (const project of this.projects.filter((candidate) => !candidate.archived)) {
      if (this.gitWatchers.has(project.id)) continue
      const watcher = new GitWatcher(git, project.path, () => {
        console.log('commit detected in', project.name)
        void this.refreshWorktrees(project.id)
      })
      this.gitWatchers.set(project.id, watcher)
      await watcher.start()
    }
  }

  private maybeCommitSummaryRefresh(projectId: string): void {
    const enabled = this.preferences.supervisorProjectSummaryAfterCommit
    const project = this.project(projectId)
    if (!enabled || !project || project.archived) return
    const cooldown = Math.max(0, this.preferences.supervisorProjectSummaryAfterCommitCooldownMinutes) * 60_000
    const lastRequest = this.automaticRefreshAt.get(projectId) ?? 0
    const lastSummary = new Date(this.statusStore.statuses[projectId]?.updatedAt ?? 0).getTime()
    if (Date.now() - Math.max(lastRequest, Number.isFinite(lastSummary) ? lastSummary : 0) < cooldown) return
    this.automaticRefreshAt.set(projectId, Date.now())
    this.refresh.enqueue(projectId)
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
    }
  }

  private nextDisplayName(tool: AgentTool, projectId: string | null): string {
    const label = tool === 'shell' ? 'Terminal' : this.agentDefinition(tool)?.name ?? tool
    const count = this.sessionsFor(projectId).filter((s) => s.tool === tool).length
    return count === 0 ? label : `${label} ${count + 1}`
  }

  agentDefinitions(): AgentDefinition[] {
    return this.preferences.agents
  }

  private agentDefinition(id: string): AgentDefinition | undefined {
    return this.agentDefinitions().find((agent) => agent.id === id)
  }

  private expandAgentArgs(args: string[], values: Record<string, string | undefined>): { args: string[]; usedPrompt: boolean } {
    let usedPrompt = false
    const expanded: string[] = []
    for (const arg of args) {
      if (arg.includes('{prompt}')) usedPrompt = true
      const value = arg.replace(/\{(prompt|cwd|sessionId|sourceSessionId|sauronBin)\}/g, (_m, key: string) => values[key] ?? '')
      if (value) expanded.push(value)
    }
    return { args: expanded, usedPrompt }
  }

  /** The command line that starts an agent inside a session's shell, or null for a plain shell. */
  private async agentCommand(tool: AgentTool, sessionId: string, prompt: string | undefined, tools: ToolPaths, cwd?: string): Promise<string[] | null> {
    if (tool === 'claude') {
      const definition = this.agentDefinition(tool)
      const executable = tools.agents.claude
      if (!definition || !executable) throw new SauronError('executable_not_found', 'Claude is not configured or its executable was not found.')
      const extra = this.expandAgentArgs(definition.args, { prompt, cwd, sessionId, sauronBin: this.sauronBin ?? undefined })
      const cmd = [executable, '--session-id', sessionId, ...(await this.claudeSettingsArgs(sessionId)), ...extra.args]
      if (prompt && !extra.usedPrompt) cmd.push(prompt)
      return cmd
    }
    if (tool === 'codex') {
      const definition = this.agentDefinition(tool)
      const executable = tools.agents.codex
      if (!definition || !executable) throw new SauronError('executable_not_found', 'Codex is not configured or its executable was not found.')
      const extra = this.expandAgentArgs(definition.args, { prompt, cwd, sessionId, sauronBin: this.sauronBin ?? undefined })
      const cmd = [executable, ...(this.sauronBin ? ['-c', codexNotifyConfig(this.sauronBin)] : []), ...extra.args]
      if (prompt && !extra.usedPrompt) cmd.push(prompt)
      return cmd
    }
    if (tool === 'shell') return null
    const definition = this.agentDefinition(tool)
    const executable = tools.agents[tool]
    if (!definition || !executable) throw new SauronError('executable_not_found', `${definition?.command ?? tool} was not found on PATH.`)
    const expanded = this.expandAgentArgs(definition.args, { prompt, cwd, sessionId, sauronBin: this.sauronBin ?? undefined })
    return [executable, ...expanded.args, ...(prompt && !expanded.usedPrompt ? [prompt] : [])]
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
    if (project.archived) {
      this.report(new SauronError('invalid_state', `Unarchive ${project.name} before starting a session.`), { projectId })
      return null
    }
    try {
      const { tools, tmux } = this.requireTools()
      const id = randomUUID()
      const title = options.title?.trim() || this.nextDisplayName(tool, project.id)
      const tmuxName = tmuxSessionName(title, id)
      let worktreePath: string | null = options.worktreePath ?? null
      if (!worktreePath && options.worktreeBranch !== undefined) {
        if (!this.worktreeService) throw new SauronError('executable_not_found', 'git was not found on PATH.')
        const branch = options.worktreeBranch.trim() || defaultWorktreeBranch(id)
        worktreePath = await this.worktreeService.create(project.path, project.name, branch)
        await this.refreshWorktrees(project.id, false)
      }
      const cwd = worktreePath ?? project.path
      const agent = await this.agentCommand(tool, id, options.prompt?.trim() || undefined, tools, cwd)
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
    if (session.background) {
      this.report(new SauronError('invalid_state', 'A background run cannot be resumed. Run the job again, or open the run to continue by hand.'), { sessionId: id })
      return
    }
    try {
      const { tools, tmux } = this.requireTools()
      let command: string[] | null = null
      if (session.cliSessionId && session.tool === 'claude') {
        const executable = tools.agents.claude
        if (!executable) throw new SauronError('executable_not_found', 'Claude executable was not found.')
        command = [executable, '--resume', session.cliSessionId, ...(await this.claudeSettingsArgs(session.id)), ...(this.agentDefinition('claude')?.args ?? [])]
      } else if (session.cliSessionId && session.tool === 'codex') {
        const executable = tools.agents.codex
        if (!executable) throw new SauronError('executable_not_found', 'Codex executable was not found.')
        command = [executable, ...(this.sauronBin ? ['-c', codexNotifyConfig(this.sauronBin)] : []), ...(this.agentDefinition('codex')?.args ?? []), 'resume', session.cliSessionId]
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

  /**
   * Forks an agent conversation into a new managed session: a fresh terminal running
   * `claude --resume <id> --fork-session` or `codex fork <id>`. Works for external sessions too.
   */
  async forkSession(id: string, options: { worktreeBranch?: string } = {}): Promise<Session | null> {
    const source = this.session(id)
    const definition = source ? this.agentDefinition(source.tool) : undefined
    if (!source?.cliSessionId || !definition?.forkCommand?.length) {
      this.report(new SauronError('invalid_state', 'This agent has no fork command configured, or the session id is not known.'), { sessionId: id })
      return null
    }
    try {
      const { tools, tmux } = this.requireTools()
      const newId = randomUUID()
      const executable = tools.agents[source.tool]
      if (!executable) throw new SauronError('executable_not_found', `${definition.name} executable was not found.`)
      // A fork into a worktree starts from the same conversation but its own checkout, so the
      // two can diverge without stepping on each other's files.
      let worktreePath: string | null = source.kind === 'external' ? null : source.worktreePath
      let workingDir = source.kind === 'external' ? (source.worktreePath ?? source.workingDir) : source.workingDir
      if (options.worktreeBranch !== undefined) {
        const project = source.projectId ? this.project(source.projectId) : undefined
        if (!project) throw new SauronError('invalid_state', 'A worktree needs a project; this session has none.')
        if (!this.worktreeService) throw new SauronError('executable_not_found', 'git was not found on PATH.')
        const branch = options.worktreeBranch.trim() || defaultWorktreeBranch(newId)
        worktreePath = await this.worktreeService.create(project.path, project.name, branch)
        workingDir = project.path
        await this.refreshWorktrees(project.id, false)
      }
      const cwd = worktreePath ?? workingDir
      const profileArgs = this.expandAgentArgs(definition.args, { cwd, sessionId: newId, sourceSessionId: source.cliSessionId, sauronBin: this.sauronBin ?? undefined }).args
      const forkArgs = this.expandAgentArgs(definition.forkCommand, { cwd, sessionId: newId, sourceSessionId: source.cliSessionId, sauronBin: this.sauronBin ?? undefined }).args
      const integrationArgs = source.tool === 'claude'
        ? await this.claudeSettingsArgs(newId)
        : source.tool === 'codex' && this.sauronBin ? ['-c', codexNotifyConfig(this.sauronBin)] : []
      const command = [executable, ...integrationArgs, ...profileArgs, ...forkArgs]
      const title = source.kind === 'external' ? source.displayName : `${source.displayName} (fork)`
      const tmuxName = tmuxSessionName(title, newId)
      const shell = process.env.SHELL || '/bin/zsh'
      await tmux.newSession({ name: tmuxName, workingDir: cwd, environment: this.launchEnvironment(newId, tools), command: [shell, '-l'] })
      const now = new Date().toISOString()
      const session: Session = {
        id: newId,
        projectId: source.projectId,
        tool: source.tool,
        kind: 'managed',
        displayName: title,
        tmuxName,
        // The fork gets a new CLI session id; the SessionStart hook (Claude) or the
        // transcript indexer (Codex) fills it in.
        cliSessionId: null,
        transcriptPath: null,
        workingDir,
        worktreePath,
        createdAt: now,
        lastActivityAt: now,
        state: 'running',
        stateSource: 'inferred',
      }
      await this.stampTmux(tmux, tmuxName, session)
      await tmux.sendText(tmuxName, shellCommandLine(command))
      this.sessions.push(session)
      this.persistSessions()
      this.changed()
      this.select({ kind: 'session', id: newId })
      return session
    } catch (error) {
      this.report(error, { sessionId: id })
      return null
    }
  }

  /**
   * Hands a session's work to a different agent. Agents cannot read each other's session
   * stores, so this is a briefed restart, not a fork: the new agent starts in the same
   * directory with a prompt pointing at a handoff document. The document is written
   * mechanically from the transcript, the session's commits, and `git status`; no model is
   * involved, so it is instant. Works for external sessions too.
   */
  async handoffSession(id: string, tool: AgentTool): Promise<Session | null> {
    const source = this.session(id)
    const target = this.agentDefinition(tool)
    if (!source || !source.projectId || !target || tool === 'shell') {
      this.report(new SauronError('invalid_state', 'The session or the target agent is not known.'), { sessionId: id })
      return null
    }
    if (tool === source.tool) {
      this.report(new SauronError('invalid_state', `${target.name} is already running this session; use Fork instead.`), { sessionId: id })
      return null
    }
    try {
      const { tools } = this.requireTools()
      if (!tools.agents[tool]) throw new SauronError('executable_not_found', `${target.name} executable was not found.`)
      const project = this.project(source.projectId)
      if (!project) throw new SauronError('invalid_state', 'The session belongs to a project that no longer exists.')
      const cwd = source.worktreePath ?? source.workingDir
      const entries = source.transcriptPath && (source.tool === 'claude' || source.tool === 'codex')
        ? await readTranscriptEntries(source.transcriptPath, source.tool)
        : []
      const git = tools.git
      const hashes = this.attributionStore.commitsForSession(source.id, 10)
      const [status, branch, summaries] = git
        ? await Promise.all([
            runCommand(git, ['status', '--short'], { cwd }),
            runCommand(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
            commitSummaries(git, cwd, hashes),
          ])
        : [null, null, new Map<string, SessionCommit>()]
      const document = renderHandoff({
        sourceName: source.displayName,
        sourceTool: source.tool,
        targetName: target.name,
        cwd,
        branch: branch?.code === 0 ? branch.stdout.trim() : null,
        entries,
        commits: hashes.flatMap((hash) => summaries.get(hash) ?? []),
        gitStatus: status?.code === 0 ? status.stdout : '',
      })
      const file = join(await mkdtemp(join(tmpdir(), 'sauron-handoff-')), 'handoff.md')
      await writeFile(file, document, 'utf8')
      const prompt = `You are taking over work from another agent. Read ${file} before doing anything else, then continue the work it describes.`
      return await this.launchSession(project.id, tool, {
        title: `${source.displayName} → ${target.name}`,
        prompt,
        worktreePath: cwd !== project.path ? cwd : undefined,
      })
    } catch (error) {
      this.report(error, { sessionId: id })
      return null
    }
  }

  /**
   * Clients attached to a session's tmux session besides Sauron's own. tmux sizes a window to
   * its most recently active client, so a second client of a different size leaves the other
   * one looking broken; knowing about it lets the app step aside rather than fight.
   */
  async sessionClients(id: string): Promise<TmuxClient[]> {
    const session = this.session(id)
    if (!session?.tmuxName || !this.tmux) return []
    const own = this.pty?.pid(id) ?? null
    return (await this.tmux.listClients(session.tmuxName)).filter((client) => client.pid !== own)
  }

  async detachOtherClients(id: string): Promise<void> {
    const session = this.session(id)
    if (!session?.tmuxName || !this.tmux) return
    for (const client of await this.sessionClients(id)) await this.tmux.detachClient(client.tty)
  }

  // MARK: Background jobs

  /** Installs the launchd agent that runs `sauron tick`, so cron jobs fire with the app closed. */
  async installScheduler(): Promise<void> {
    if (!this.sauronBin) return
    try {
      const result = await installTick(this.sauronBin, join(this.paths.jobsDir, 'tick.log'))
      this.schedulerLoaded = result.loaded
      if (result.error) this.report(new SauronError('command_failed', `Background scheduler not installed: ${result.error}`))
    } catch (error) {
      this.schedulerLoaded = false
      this.report(error)
    }
  }

  /** Reloads runs from the store and makes sure each one exists as a session. */
  async refreshRuns(): Promise<void> {
    const runs: Record<string, JobRun[]> = {}
    for (const project of this.projects) runs[project.id] = this.jobStore.forProject(project.id, 50)
    this.runs = runs
    let changed = false
    for (const [projectId, list] of Object.entries(runs)) {
      const project = this.project(projectId)
      if (!project) continue
      for (const run of list) {
        const job = project.backgroundJobs?.find((j) => j.id === run.jobId)
        const tool = job?.agentId ?? 'shell'
        const existing = this.sessions.find((s) => s.id === run.sessionId)
        const finished = run.status !== 'running'
        if (!existing) {
          this.sessions.push({
            id: run.sessionId,
            projectId,
            tool,
            kind: 'managed',
            displayName: `${job?.name ?? run.jobId} (run)`,
            tmuxName: run.tmuxName,
            cliSessionId: tool === 'claude' ? run.sessionId : null,
            transcriptPath: runTranscriptPath(run, tool),
            workingDir: project.path,
            worktreePath: run.worktreePath,
            createdAt: run.startedAt,
            lastActivityAt: run.finishedAt ?? run.startedAt,
            state: finished ? 'stopped' : 'running',
            stateSource: 'inferred',
            background: { jobId: run.jobId, runId: run.id },
          })
          changed = true
        } else if (finished && existing.state !== 'stopped') {
          existing.state = 'stopped'
          existing.lastActivityAt = run.finishedAt ?? existing.lastActivityAt
          this.pty?.close(existing.id)
          changed = true
        }
      }
    }
    if (changed) this.persistSessions()
    this.changed()
  }

  async saveProjectJobs(projectId: string, jobs: BackgroundJob[]): Promise<void> {
    const project = this.project(projectId)
    if (!project) throw new SauronError('invalid_state', `Unknown project ${projectId}`)
    const ids = new Set<string>()
    for (const job of jobs) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(job.id)) throw new SauronError('invalid_state', `Job id "${job.id}" must be lowercase letters, digits and hyphens.`)
      if (ids.has(job.id)) throw new SauronError('invalid_state', `Two jobs share the id "${job.id}".`)
      ids.add(job.id)
      if (!this.agentDefinition(job.agentId)?.backgroundCommand?.length) throw new SauronError('invalid_state', `Agent "${job.agentId}" has no background command, so it cannot run jobs.`)
      if (!job.promptFile.trim()) throw new SauronError('invalid_state', `Job "${job.name}" needs a prompt file.`)
    }
    project.backgroundJobs = jobs
    this.persistConfig()
    this.changed()
  }

  /**
   * Starts a run through the CLI runner, the one code path that starts runs, so the app,
   * launchd and the post-commit hook cannot disagree. Waits for the runner to hand off to
   * tmux, which takes a few seconds, so its errors can be shown.
   */
  async runJob(projectId: string, jobId: string): Promise<void> {
    const project = this.project(projectId)
    if (!project || !this.sauronBin) throw new SauronError('invalid_state', 'Unknown project, or the CLI is not installed.')
    const result = await runCommand(this.sauronBin, ['job', 'run', '--project', project.id, '--job', jobId, '--trigger', 'manual'], { timeoutMs: 90_000 })
    if (result.code !== 0) throw new SauronError('command_failed', result.stderr.trim() || result.stdout.trim() || `sauron job run exited ${result.code}`)
    await this.refreshRuns()
    await this.refreshWorktrees(project.id)
  }

  private runContext(runId: string): { run: JobRun; project: Project; git: string; worktrees: WorktreeService } {
    const run = this.jobStore.get(runId)
    if (!run) throw new SauronError('invalid_state', `Unknown run ${runId}`)
    const project = this.project(run.projectId)
    if (!project) throw new SauronError('invalid_state', 'The run belongs to a project that no longer exists.')
    if (!this.toolPaths?.git || !this.worktreeService) throw new SauronError('executable_not_found', 'git was not found on PATH.')
    return { run, project, git: this.toolPaths.git, worktrees: this.worktreeService }
  }

  /**
   * Merges a run's branch into the project's current branch with --no-ff, keeping the agent's
   * commits. Checked with merge-tree first, which computes the merge without touching the
   * working tree, so a conflict is reported rather than left half-applied.
   */
  async mergeRun(runId: string): Promise<void> {
    const { run, project, git, worktrees } = this.runContext(runId)
    if (run.status !== 'needs_review') throw new SauronError('invalid_state', `Run is ${run.status.replace('_', ' ')}, not awaiting review.`)
    const job = project.backgroundJobs?.find((j) => j.id === run.jobId)
    const head = await runCommand(git, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: project.path })
    const current = head.code === 0 ? head.stdout.trim() : 'HEAD'
    const probe = await runCommand(git, ['merge-tree', '--write-tree', current, run.branch], { cwd: project.path })
    if (probe.code !== 0) {
      throw new SauronError('command_failed', `${run.branch} conflicts with ${current}. Open the run and resolve it in a session, then merge again.`)
    }
    const merge = await runCommand(git, ['merge', '--no-ff', '-m', `Merge background run: ${job?.name ?? run.jobId}`, run.branch], { cwd: project.path })
    if (merge.code !== 0) throw new SauronError('command_failed', `git merge: ${merge.stderr.trim() || merge.stdout.trim()}`)
    await worktrees.remove(project.path, run.worktreePath, true).catch((error) => this.report(error, { projectId: project.id }))
    await runCommand(git, ['branch', '-d', run.branch], { cwd: project.path })
    this.jobStore.setStatus(run.id, 'merged')
    await this.refreshRuns()
    await this.refreshWorktrees(project.id)
    this.maybeCommitSummaryRefresh(project.id)
  }

  async discardRun(runId: string): Promise<void> {
    const { run, project, git, worktrees } = this.runContext(runId)
    if (run.status === 'running') throw new SauronError('invalid_state', 'The run is still in progress; stop its session first.')
    await worktrees.remove(project.path, run.worktreePath, true).catch(() => undefined)
    await runCommand(git, ['branch', '-D', run.branch], { cwd: project.path })
    this.jobStore.setStatus(run.id, 'discarded')
    await this.refreshRuns()
    await this.refreshWorktrees(project.id)
  }

  /** An interactive agent in the run's worktree, to continue or to resolve a conflict. */
  async openRun(runId: string, prompt?: string): Promise<void> {
    const { run, project } = this.runContext(runId)
    const job = project.backgroundJobs?.find((j) => j.id === run.jobId)
    const tool = job?.agentId ?? this.preferences.supervisorAgentId
    await this.launchSession(project.id, tool, { title: `${job?.name ?? run.jobId} (review)`, worktreePath: run.worktreePath, prompt })
  }

  async runLog(runId: string, maxChars = 20_000): Promise<string> {
    const run = this.jobStore.get(runId)
    if (!run) throw new SauronError('invalid_state', `Unknown run ${runId}`)
    const text = await readFile(run.logPath, 'utf8').catch(() => '')
    return text.length > maxChars ? `…${text.slice(-maxChars)}` : text
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

  async writeDocument(projectId: string, rel: string, content: string, expectedMtime: string | null): Promise<{ mtime: string }> {
    const project = this.project(projectId)
    if (!project) throw new SauronError('invalid_state', `Unknown project ${projectId}`)
    const result = await writeDocument(project, rel, content, expectedMtime)
    await this.refreshDocuments(projectId)
    return result
  }

  /**
   * Commits one document. The commit is the user's, not a session's, so it carries no
   * attribution: the post-commit hook sees no SAURON_SESSION_ID and records nothing.
   */
  async commitDocument(projectId: string, rel: string, message: string): Promise<void> {
    const project = this.project(projectId)
    if (!project) throw new SauronError('invalid_state', `Unknown project ${projectId}`)
    if (!this.toolPaths?.git) throw new SauronError('executable_not_found', 'git was not found on PATH.')
    if (!message.trim()) throw new SauronError('invalid_state', 'A commit message is required.')
    await commitPath(this.toolPaths.git, project.path, rel, message.trim())
    this.maybeCommitSummaryRefresh(projectId)
    this.changed()
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
      if (session.tool !== 'claude' && session.tool !== 'codex') return { entries: [], total: 0 }
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
        `Sauron regenerated your instructions. Read ${this.masterHome.instructionsPath} again now and follow it from here on; reply with one line when done.`,
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
    if (!this.preferences.supervisorEnabled) {
      this.report(new SauronError('invalid_state', 'The supervisor agent is disabled. Enable it from its row in the sidebar.'), { sessionId: MASTER_SESSION_ID })
      return
    }
    const existing = this.masterSession()
    if (existing && isAlive(existing)) {
      this.select({ kind: 'session', id: MASTER_SESSION_ID })
      return
    }
    try {
      const { tools, tmux } = this.requireTools()
      const supervisorId = this.preferences.supervisorAgentId
      const definition = this.agentDefinition(supervisorId)
      const executable = tools.agents[supervisorId]
      if (!definition || !executable) throw new SauronError('executable_not_found', `${definition?.command ?? supervisorId} was not found on PATH.`)
      await this.regenerateMasterHome()
      if (supervisorId === 'claude') await ensureClaudeTrusts(this.masterHome.dir)
      const addDirs = this.projects.flatMap((p) => ['--add-dir', p.path])
      const settings = supervisorId === 'claude' ? await this.claudeSettingsArgs(MASTER_SESSION_ID) : []
      const tryStart = async (cliSessionId: string | null, resume: boolean): Promise<string> => {
        const tmuxName = tmuxSessionName('supervisor', randomUUID())
        let command: string[]
        const profileArgs = this.expandAgentArgs(definition.args, {
          cwd: this.masterHome.dir,
          sessionId: MASTER_SESSION_ID,
          sauronBin: this.sauronBin ?? undefined,
        }).args
        if (supervisorId === 'claude') {
          command = resume
            ? [executable, '--resume', cliSessionId!, ...settings, ...addDirs, ...profileArgs, ...this.preferences.supervisorArgs]
            : [executable, '--session-id', cliSessionId!, ...settings, ...addDirs, ...profileArgs, ...this.preferences.supervisorArgs]
        } else if (supervisorId === 'codex') {
          command = [executable, ...(this.sauronBin ? ['-c', codexNotifyConfig(this.sauronBin)] : []), ...profileArgs, ...this.preferences.supervisorArgs]
        } else {
          const expanded = this.expandAgentArgs([...definition.args, ...this.preferences.supervisorArgs], {
            cwd: this.masterHome.dir,
            sessionId: MASTER_SESSION_ID,
            sauronBin: this.sauronBin ?? undefined,
          })
          command = [executable, ...expanded.args]
        }
        await tmux.newSession({ name: tmuxName, workingDir: this.masterHome.dir, environment: this.launchEnvironment(MASTER_SESSION_ID, tools), command })
        return tmuxName
      }
      let cliSessionId = supervisorId === 'claude' && existing?.tool === 'claude' ? existing.cliSessionId : null
      let tmuxName: string
      let resumed = false
      if (cliSessionId && supervisorId === 'claude') {
        tmuxName = await tryStart(cliSessionId, true)
        await sleep(3000)
        resumed = await tmux.hasSession(tmuxName)
        if (!resumed) console.warn('master resume failed; starting fresh')
      }
      if (!resumed) {
        cliSessionId = supervisorId === 'claude' ? randomUUID() : null
        tmuxName = await tryStart(cliSessionId, false)
      }
      const now = new Date().toISOString()
      const session: Session = {
        id: MASTER_SESSION_ID,
        projectId: null,
        tool: supervisorId,
        kind: 'managed',
        displayName: 'Supervisor Agent',
        tmuxName: tmuxName!,
        cliSessionId,
        transcriptPath: supervisorId === 'claude' && cliSessionId ? claudeTranscriptPath(homedir(), this.masterHome.dir, cliSessionId) : null,
        workingDir: this.masterHome.dir,
        worktreePath: null,
        createdAt: existing?.createdAt ?? now,
        lastActivityAt: now,
        state: supervisorId === 'claude' || supervisorId === 'codex' ? 'running' : 'idle',
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

  /** Stops the current supervisor process and starts it with the latest profile settings. */
  async restartMaster(): Promise<void> {
    const existing = this.masterSession()
    if (existing && isAlive(existing)) await this.stopMaster()
    await this.startMaster()
  }

  private summaryPromptPath(): string {
    const configured = this.preferences.supervisorProjectSummaryPromptFile
    return isAbsolute(configured) ? configured : resolve(this.paths.root, configured)
  }

  private async ensureSummaryPromptFile(legacyPrompt?: string): Promise<void> {
    const path = this.summaryPromptPath()
    await mkdir(dirname(path), { recursive: true })
    try {
      const existing = await readFile(path, 'utf8')
      if (existing.includes('Follow the "Status refresh" procedure in AGENTS.md')) {
        await writeFile(path, defaultProjectSummaryPrompt, 'utf8')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const initial = legacyPrompt?.includes('Follow the "Status refresh" procedure in AGENTS.md')
        ? defaultProjectSummaryPrompt
        : legacyPrompt?.trim() || defaultProjectSummaryPrompt
      await writeFile(path, initial, { encoding: 'utf8', flag: 'wx' })
    }
  }

  private async masterPromptFor(projectId: string): Promise<string | null> {
    const project = this.project(projectId)
    if (!project) return null
    const previous = this.statusStore.statuses[projectId]
    const cutoff = previous?.updatedAt ?? 'none (this is the first summary)'
    const values: Record<string, string> = {
      projectName: project.name,
      projectId: project.id,
      projectPath: project.path,
      previousSummaryUpdatedAt: cutoff,
    }
    const template = await readFile(this.summaryPromptPath(), 'utf8')
    return template.replace(
      /\{(projectName|projectId|projectPath|previousSummaryUpdatedAt)\}/g,
      (_match, key: string) => values[key]!,
    )
  }

  private async sendRefreshPrompt(projectId: string): Promise<boolean> {
    const master = this.masterSession()
    try {
      const prompt = await this.masterPromptFor(projectId)
      if (!master?.tmuxName || !isAlive(master) || !prompt || !this.tmux) return false
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
    if (!this.preferences.supervisorEnabled) {
      this.report(new SauronError('invalid_state', 'The supervisor agent is disabled, so summaries cannot be refreshed.'), { projectId })
      return
    }
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
    const tool: AgentTool = toolRaw === 'shell' || (toolRaw && this.agentDefinition(toolRaw)) ? toolRaw : 'shell'
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
    this.jobStore.close()
    await this.persistence.flush()
  }
}
