import type { Worktree } from './worktrees'
import type { TranscriptEntry, TranscriptPage } from './transcript-types'
import type { ProjectStatus, RefreshState } from './status'

export interface Project {
  id: string
  name: string
  /** Absolute path to the repository root. */
  path: string
  addedAt: string
  pinned: boolean
  archived?: boolean
  /** Manual adjustments to the key documents list (project-relative paths). */
  keyDocuments?: { included: string[]; excluded: string[] }
}

export interface KeyDocument {
  /** Project-relative path. */
  path: string
  name: string
  sizeBytes: number
  mtime: string
  source: 'default' | 'added'
}

export interface RecentCommit {
  hash: string
  shortHash: string
  title: string
  message: string
  branch: string
  author: string
  authoredAt: string
  sessionId: string | null
  sessionName: string | null
  agentTool: AgentTool | null
}

export interface Preferences {
  notificationsMuted: boolean
  /** Master switch. When false the supervisor never runs and cannot be started. */
  supervisorEnabled: boolean
  /** Start the supervisor agent when Sauron launches. Only consulted when it is enabled. */
  masterAutoStart: boolean
  /** Explicit executable paths; empty means "find on PATH". */
  toolOverrides: { claude: string; codex: string; tmux: string; git: string }
  /** Configured terminal agents. Claude and Codex start as defaults but are ordinary profiles. */
  agents: AgentDefinition[]
  /** Legacy field read during migration. */
  customAgents?: AgentDefinition[]
  /** Agent profile used for the global supervisor. */
  supervisorAgentId: string
  /** Extra command-line arguments for the supervisor (for example: --model opus). */
  supervisorArgs: string[]
  /** Refresh summaries after commits observed by Sauron's git proxy. */
  supervisorProjectSummaryAfterCommit: boolean
  /** Minimum time between automatic refresh requests for one project. */
  supervisorProjectSummaryAfterCommitCooldownMinutes: number
  /** Summary prompt file; relative paths resolve beside config.json. */
  supervisorProjectSummaryPromptFile: string
  /** Base directory for Sauron-created worktrees; empty means the default under Application Support. */
  worktreeBase: string
  terminalFontSize: number
  terminalScrollback: number
}

export const defaultPreferences: Preferences = {
  notificationsMuted: false,
  supervisorEnabled: true,
  masterAutoStart: true,
  toolOverrides: { claude: '', codex: '', tmux: '', git: '' },
  agents: [
    { id: 'claude', name: 'Claude', command: 'claude', args: ['--dangerously-skip-permissions'], forkCommand: ['--resume', '{sourceSessionId}', '--fork-session'] },
    { id: 'codex', name: 'Codex', command: 'codex', args: ['--dangerously-bypass-approvals-and-sandbox'], forkCommand: ['fork', '{sourceSessionId}'] },
  ],
  supervisorAgentId: 'claude',
  supervisorArgs: [],
  supervisorProjectSummaryAfterCommit: true,
  supervisorProjectSummaryAfterCommitCooldownMinutes: 5,
  supervisorProjectSummaryPromptFile: 'summary-prompt.md',
  worktreeBase: '',
  terminalFontSize: 13,
  terminalScrollback: 50_000,
}

export interface AppConfig {
  version: number
  projects: Project[]
  preferences?: Preferences
}

export const CONFIG_VERSION = 6

/** What the session was started with. A plain shell may later run an agent; hooks update this. */
export type AgentTool = string
export interface AgentDefinition {
  /** Stable lowercase identifier used in persisted sessions and `sauron launch --tool`. */
  id: string
  name: string
  /** Executable name or absolute path. */
  command: string
  /** One argument per item. Supports {prompt}, {cwd}, {sessionId}, and {sauronBin}. */
  args: string[]
  /** Optional arguments used to fork a conversation. */
  forkCommand?: string[]
}
export type SessionKind = 'managed' | 'external'
export type SessionState = 'running' | 'waitingForInput' | 'idle' | 'stopped'
export type StateSource = 'hook' | 'inferred'

export interface Session {
  id: string
  /** null for the supervisor agent or an adopted orphan. */
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
  /** cli session ids of external sessions the user hid. */
  hiddenExternal?: string[]
  /** Hash of the CLAUDE.md the supervisor has been told about; a change triggers a re-read nudge. */
  masterClaudeMdHash?: string
}

export const SESSIONS_VERSION = 1

export interface ToolPaths {
  claude: string | null
  codex: string | null
  tmux: string | null
  git: string | null
  /** Resolved executable path by agent id, including built-ins. */
  agents: Record<string, string | null>
  /** The PATH used to find them; passed into launched sessions. */
  path: string
}

export function missingRequiredTools(t: ToolPaths): string[] {
  const missing: string[] = []
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
  hiddenExternal: string[]
  toolPaths: ToolPaths | null
  /** Worktrees per project id, refreshed on demand and after changes. */
  worktrees: Record<string, Worktree[]>
  preferences: Preferences
  documents: Record<string, KeyDocument[]>
  statuses: Record<string, ProjectStatus>
  refresh: RefreshState
  loaded: boolean
}

export interface LaunchOptions {
  /** Display title; also written into tmux. Defaults to "<Tool> <n>". */
  title?: string
  /** Initial prompt for claude/codex launches (used by the CLI and the supervisor agent). */
  prompt?: string
  /** Run the session in a new git worktree on this branch. */
  worktreeBranch?: string
  /** Run the session in this existing directory instead of the project root. Wins over worktreeBranch. */
  worktreePath?: string
}

export interface WorktreeRemovalCheck {
  dirty: boolean
  unmergedCommits: number
  inUseBy: string[]
}

/** The most recent commit a session made, for the session list. */
export interface SessionCommit {
  hash: string
  shortHash: string
  title: string
  authoredAt: string
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
  archiveProject(id: string, archived: boolean): Promise<void>
  resolveTools(): Promise<void>

  launchSession(projectId: string, tool: AgentTool, options?: LaunchOptions): Promise<void>
  renameSession(id: string, title: string): Promise<void>
  /** Claude/Codex only: new terminal continuing a copy of the conversation as a new session. */
  /** Resolves to the new session, or null when the fork failed (the error is reported as a banner). */
  forkSession(id: string): Promise<Session | null>
  refreshWorktrees(projectId: string): Promise<void>
  recentCommits(projectId: string, limit?: number, branch?: string): Promise<RecentCommit[]>
  /** Commits attributed to one session, newest first, optionally only those on a branch. */
  sessionCommits(sessionId: string, branch?: string): Promise<RecentCommit[]>
  /** Local branch names for a project, current first. */
  projectBranches(projectId: string): Promise<string[]>
  commitDiff(projectId: string, hash: string): Promise<string>
  checkWorktreeRemoval(projectId: string, path: string): Promise<WorktreeRemovalCheck>
  removeWorktree(projectId: string, path: string, force: boolean): Promise<void>
  /** Kills the tmux session. Claude/Codex sessions stay resumable; plain terminals are removed. */
  closeSession(id: string): Promise<void>
  resumeSession(id: string): Promise<void>
  forgetSession(id: string): Promise<void>
  /** External sessions only: remove from view. */
  hideSession(id: string): Promise<void>
  unhideSession(cliSessionId: string): Promise<void>
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
  /** Tells the main process which session is in front of the user, for notification suppression. */
  setActiveSession(sessionId: string | null): void
  setPreferences(prefs: Partial<Preferences>): Promise<void>
  getConfigFile(): Promise<{ path: string; content: string }>
  saveConfigFile(content: string): Promise<void>

  refreshDocuments(projectId: string): Promise<void>
  addKeyDocumentDialog(projectId: string): Promise<void>
  removeKeyDocument(projectId: string, path: string): Promise<void>
  readDocument(projectId: string, path: string): Promise<{ content: string; mtime: string }>
  /** Writes a document; rejects when it changed on disk since `expectedMtime`. */
  writeDocument(projectId: string, path: string, content: string, expectedMtime: string | null): Promise<{ mtime: string }>
  /** Commits just this document, with no session attribution. */
  commitDocument(projectId: string, path: string, message: string): Promise<void>

  startMaster(): Promise<void>
  stopMaster(): Promise<void>
  restartMaster(): Promise<void>
  refreshStatus(projectId: string): Promise<void>
  refreshAllStatuses(): Promise<void>

  /** Opens a live transcript view; returns the most recent page. */
  transcriptOpen(sessionId: string): Promise<TranscriptPage | null>
  transcriptClose(sessionId: string): Promise<void>
  transcriptLoadOlder(sessionId: string, beforeIndex: number, count: number): Promise<TranscriptEntry[]>
  onTranscriptAppend(sessionId: string, cb: (entries: TranscriptEntry[]) => void): () => void
  /**
   * Starts a session of a different agent that continues this one's work from a briefing:
   * the recent conversation, the session's commits, and the working tree state.
   */
  handoffSession(sessionId: string, tool: AgentTool): Promise<void>
  /** The latest commit each session in this project made, keyed by session id. */
  lastCommitBySession(projectId: string): Promise<Record<string, SessionCommit>>
  revealInFinder(path: string): void
  /** Opens a file or directory in VS Code. Rejects if VS Code is not installed. */
  openInVsCode(path: string): Promise<void>
  revealLogs(): void
  chooseDirectory(title: string): Promise<string | null>
  copyToClipboard(text: string): void
}

export type SelectionTarget =
  | { kind: 'master' }
  | { kind: 'project'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'orphan'; name: string }
  | { kind: 'document'; projectId: string; path: string }
