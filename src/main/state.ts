import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AgentTool, AppError, LaunchOptions, Project, Session, SelectionTarget, Snapshot, ToolPaths, WorktreeRemovalCheck } from '@shared/types'
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
  loaded = false

  tmux: TmuxService | null = null
  pty: PtyService | null = null
  worktreeService: WorktreeService | null = null
  private livenessTimer: NodeJS.Timeout | null = null

  constructor(public readonly persistence: Persistence) {
    super()
  }

  get paths() {
    return this.persistence.paths
  }

  snapshot(): Snapshot {
    return {
      projects: this.projects,
      sessions: this.sessions,
      orphanTmuxSessions: this.orphanTmuxSessions,
      toolPaths: this.toolPaths,
      worktrees: this.worktrees,
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
      this.sessions = (await this.persistence.loadSessions()).sessions
      this.loaded = true
    } catch (error) {
      this.report(error)
    }
    await this.refreshTools()
    await this.reconcileSessions()
    await Promise.all(this.projects.map((p) => this.refreshWorktrees(p.id, false)))
    this.startLivenessPolling()
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
    this.persistence.saveConfig({ version: CONFIG_VERSION, projects: this.projects })
  }

  private persistSessions(): void {
    this.persistence.saveSessions({ version: SESSIONS_VERSION, sessions: this.sessions }).catch((e) => this.report(e))
  }

  // MARK: Projects

  project(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  session(id: string): Session | undefined {
    return this.sessions.find((s) => s.id === id)
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
    } catch (error) {
      this.report(error)
    }
  }

  async addProjects(dirs: string[]): Promise<void> {
    for (const dir of dirs) await this.addProject(dir)
  }

  removeProject(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persistConfig()
    this.changed()
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
        command = [tools.claude, '--session-id', id]
        cliSessionId = id
        transcriptPath = claudeTranscriptPath(homedir(), cwd, id)
      } else {
        if (!tools.codex) throw new SauronError('executable_not_found', 'codex was not found on PATH.')
        command = [tools.codex, '-C', cwd]
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

  async resumeSession(id: string): Promise<void> {
    const session = this.session(id)
    if (!session || session.state !== 'stopped' || !session.cliSessionId) return
    try {
      const { tools, tmux } = this.requireTools()
      let command: string[]
      if (session.tool === 'claude') {
        if (!tools.claude) throw new SauronError('executable_not_found', 'claude was not found on PATH.')
        command = [tools.claude, '--resume', session.cliSessionId]
      } else {
        if (!tools.codex) throw new SauronError('executable_not_found', 'codex was not found on PATH.')
        command = [tools.codex, 'resume', session.cliSessionId]
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
      }
    }
  }

  private startLivenessPolling(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = setInterval(() => void this.checkLiveness(), 5000)
  }

  async shutdown(): Promise<void> {
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.pty?.closeAll()
    await this.persistence.flush()
  }
}
