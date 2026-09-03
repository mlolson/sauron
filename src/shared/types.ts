import type { Worktree } from './worktrees'

export interface Project {
  id: string
  name: string
  /** Absolute path to the repository root. */
  path: string
  addedAt: string
  pinned: boolean
}

export interface AppConfig {
  version: number
  projects: Project[]
}

export const CONFIG_VERSION = 1

export type AgentTool = 'claude' | 'codex'
export type SessionKind = 'managed' | 'external'
export type SessionState = 'running' | 'waitingForInput' | 'idle' | 'stopped'
export type StateSource = 'hook' | 'inferred'

export interface Session {
  id: string
  /** null for the master agent or an adopted orphan. */
  projectId: string | null
  tool: AgentTool
  kind: SessionKind
  displayName: string
  tmuxName: string | null
  /** The Claude or Codex session id. For Claude it is chosen by Sauron at launch. */
  cliSessionId: string | null
  transcriptPath: string | null
  workingDir: string
  worktreePath: string | null
  createdAt: string
  lastActivityAt: string
  state: SessionState
  stateSource: StateSource
}

export interface SessionsFile {
  version: number
  sessions: Session[]
}

export const SESSIONS_VERSION = 1

export interface ToolPaths {
  claude: string | null
  codex: string | null
  tmux: string | null
  git: string | null
  /** The PATH used to find them; passed into launched sessions. */
  path: string
}

export function missingRequiredTools(t: ToolPaths): string[] {
  const missing: string[] = []
  if (!t.claude) missing.push('claude')
  if (!t.tmux) missing.push('tmux')
  if (!t.git) missing.push('git')
  return missing
}

export function isAlive(s: Session): boolean {
  return s.state !== 'stopped'
}

/** Everything the renderer needs to draw. Sent whole on every change; it is small. */
export interface Snapshot {
  projects: Project[]
  sessions: Session[]
  orphanTmuxSessions: string[]
  toolPaths: ToolPaths | null
  /** Worktrees per project id, refreshed on demand and after changes. */
  worktrees: Record<string, Worktree[]>
  loaded: boolean
}

export interface LaunchOptions {
  prompt?: string
  /** Run the session in a new git worktree on this branch. */
  worktreeBranch?: string
}

export interface WorktreeRemovalCheck {
  dirty: boolean
  unmergedCommits: number
  inUseBy: string[]
}

export interface AppError {
  message: string
  /** Optional scope so the renderer can attach the banner to a project or session. */
  projectId?: string
  sessionId?: string
}

export class SauronError extends Error {
  constructor(
    public readonly code:
      | 'not_a_git_repository'
      | 'project_already_added'
      | 'command_failed'
      | 'executable_not_found'
      | 'persistence'
      | 'invalid_state',
    message: string,
  ) {
    super(message)
    this.name = 'SauronError'
  }
}

/** Renderer-facing API exposed by the preload script. */
export interface SauronApi {
  getSnapshot(): Promise<Snapshot>
  onSnapshot(cb: (s: Snapshot) => void): () => void
  onError(cb: (e: AppError) => void): () => void

  addProjectDialog(): Promise<void>
  addProjects(paths: string[]): Promise<void>
  removeProject(id: string): Promise<void>
  resolveTools(): Promise<void>

  launchSession(projectId: string, tool: AgentTool, options?: LaunchOptions): Promise<void>
  refreshWorktrees(projectId: string): Promise<void>
  checkWorktreeRemoval(projectId: string, path: string): Promise<WorktreeRemovalCheck>
  removeWorktree(projectId: string, path: string, force: boolean): Promise<void>
  stopSession(id: string): Promise<void>
  detachSession(id: string): Promise<void>
  resumeSession(id: string): Promise<void>
  forgetSession(id: string): Promise<void>
  adoptOrphan(tmuxName: string): Promise<void>
  killOrphan(tmuxName: string): Promise<void>

  ptyOpen(sessionId: string, cols: number, rows: number): Promise<void>
  ptyClose(sessionId: string): Promise<void>
  ptyInput(sessionId: string, data: string): void
  ptyResize(sessionId: string, cols: number, rows: number): void
  onPtyData(sessionId: string, cb: (data: string) => void): () => void
  onPtyExit(sessionId: string, cb: () => void): () => void

  /** Where the renderer wants to be; the main process may steer this (e.g. after launch). */
  onSelect(cb: (item: SelectionTarget) => void): () => void
  revealInFinder(path: string): void
  copyToClipboard(text: string): void
}

export type SelectionTarget =
  | { kind: 'master' }
  | { kind: 'project'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'orphan'; name: string }
