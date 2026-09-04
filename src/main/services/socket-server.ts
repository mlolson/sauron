import { createServer, type Server, type Socket } from 'node:net'
import { chmod, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import type { AppState } from '../state'

/**
 * Unix-domain-socket control server used by the `sauron` CLI (and later, hooks).
 * Protocol: one JSON request line in, one JSON response line out, then close.
 */
export type SocketRequest = { cmd: string } & Record<string, unknown>
export type SocketResponse = { ok: true; result: unknown } | { ok: false; error: string }

export class SocketServer {
  private server: Server | null = null

  constructor(private readonly state: AppState, private readonly path: string) {}

  async start(): Promise<void> {
    await this.removeStaleSocket()
    this.server = createServer((socket) => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.path, () => resolve())
    })
    await chmod(this.path, 0o600)
    console.log('socket listening at', this.path)
  }

  private async removeStaleSocket(): Promise<void> {
    if (!existsSync(this.path)) return
    // If something answers, another Sauron is running; refuse to steal the socket.
    const alive = await new Promise<boolean>((resolve) => {
      const c = connect(this.path)
      c.once('connect', () => { c.destroy(); resolve(true) })
      c.once('error', () => resolve(false))
    })
    if (alive) throw new Error(`Another Sauron instance is listening at ${this.path}`)
    await unlink(this.path)
  }

  private handleConnection(socket: Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = ''
      void this.dispatch(line).then((response) => {
        socket.end(JSON.stringify(response) + '\n')
      })
    })
    socket.on('error', (e) => console.warn('socket client error', e.message))
  }

  private async dispatch(line: string): Promise<SocketResponse> {
    let request: SocketRequest
    try {
      request = JSON.parse(line)
    } catch {
      return { ok: false, error: 'invalid JSON' }
    }
    try {
      return { ok: true, result: await this.execute(request) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private findProject(key: unknown) {
    if (typeof key !== 'string') return undefined
    return this.state.projects.find((p) => p.id === key || p.name === key || p.path === key)
  }

  private async execute(req: SocketRequest): Promise<unknown> {
    const state = this.state
    switch (req.cmd) {
      case 'ping':
        return 'pong'
      case 'hook': {
        const tool = req.tool
        if (tool !== 'claude' && tool !== 'codex') throw new Error(`unknown tool ${String(tool)}`)
        if (typeof req.session !== 'string') throw new Error('missing session id (SAURON_SESSION_ID)')
        const payload = req.payload && typeof req.payload === 'object' ? (req.payload as Record<string, unknown>) : {}
        state.handleHook(req.session, { tool, event: String(req.event), payload })
        return null
      }
      case 'projects.list':
        return state.projects.map(({ id, name, path }) => ({ id, name, path }))
      case 'projects.add': {
        await state.addProject(String(req.path))
        return state.projects.map(({ id, name, path }) => ({ id, name, path }))
      }
      case 'projects.remove': {
        const project = this.findProject(req.project)
        if (!project) throw new Error(`unknown project ${req.project}`)
        state.removeProject(project.id)
        return null
      }
      case 'sessions.list': {
        const project = req.project === undefined ? null : this.findProject(req.project)
        if (req.project !== undefined && !project) throw new Error(`unknown project ${req.project}`)
        return state.allSessions
          .filter((s) => !project || s.projectId === project.id)
          .map(({ id, projectId, tool, kind, displayName, tmuxName, state: st, workingDir, cliSessionId, transcriptPath, lastActivityAt }) => ({ id, projectId, tool, kind, displayName, tmuxName, state: st, workingDir, cliSessionId, transcriptPath, lastActivityAt }))
      }
      case 'commits.record': {
        if (typeof req.session !== 'string' || typeof req.cwd !== 'string' || typeof req.hash !== 'string') throw new Error('session, cwd, and hash are required')
        state.recordCommit(req.session, req.cwd, req.hash)
        return null
      }
      case 'sessions.launch': {
        const project = this.findProject(req.project)
        if (!project) throw new Error(`unknown project ${req.project}`)
        const tool = req.tool ?? 'claude'
        if (typeof tool !== 'string' || (tool !== 'shell' && !state.agentDefinitions().some((agent) => agent.id === tool))) throw new Error(`unsupported tool ${String(req.tool)}`)
        const session = await state.launchSession(project.id, tool, {
          title: typeof req.title === 'string' ? req.title : undefined,
          prompt: typeof req.prompt === 'string' ? req.prompt : undefined,
          worktreeBranch: req.worktree === undefined ? undefined : typeof req.worktree === 'string' ? req.worktree : '',
        })
        if (!session) throw new Error('launch failed')
        return { id: session.id, tmuxName: session.tmuxName }
      }
      case 'worktrees.list': {
        const project = this.findProject(req.project)
        if (!project) throw new Error(`unknown project ${req.project}`)
        await state.refreshWorktrees(project.id)
        return state.worktrees[project.id] ?? []
      }
      case 'worktrees.remove': {
        const project = this.findProject(req.project)
        if (!project) throw new Error(`unknown project ${req.project}`)
        await state.removeWorktree(project.id, String(req.path), Boolean(req.force))
        return state.worktrees[project.id] ?? []
      }
      case 'sessions.send': {
        await state.sendToSession(String(req.session), String(req.text ?? ''))
        return null
      }
      case 'status.get': {
        const project = this.findProject(req.project)
        if (!project) throw new Error(`unknown project ${req.project}`)
        return state.statusStore.statuses[project.id] ?? null
      }
      case 'status.set': {
        const project = this.findProject(req.project)
        if (!project) throw new Error(`unknown project ${req.project}`)
        if (typeof req.summary !== 'string' || !req.summary.trim()) throw new Error('summary is required')
        const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : [])
        return state.setStatus(
          project.id,
          req.summary,
          typeof req.details === 'string' && req.details.trim() ? req.details : null,
          strings(req.updates),
          strings(req.todos),
        )
      }
      case 'status.refresh': {
        const project = this.findProject(req.project)
        if (!project) throw new Error(`unknown project ${req.project}`)
        state.requestRefresh(project.id)
        return null
      }
      case 'master.start': {
        await state.startMaster()
        return state.masterSession() ?? null
      }
      case 'sessions.stop': {
        await state.stopSession(String(req.session))
        return null
      }
      case 'sessions.hide': {
        state.hideSession(String(req.session))
        return null
      }
      case 'sessions.close': {
        await state.closeSession(String(req.session))
        return null
      }
      case 'sessions.fork': {
        const session = await state.forkSession(String(req.session))
        if (!session) throw new Error('fork failed')
        return { id: session.id, tmuxName: session.tmuxName }
      }
      case 'sessions.rename': {
        await state.renameSession(String(req.session), String(req.title ?? ''))
        return null
      }
      case 'sessions.resume': {
        await state.resumeSession(String(req.session))
        return null
      }
      case 'select': {
        if (typeof req.document === 'string') {
          const project = this.findProject(req.project)
          if (!project) throw new Error(`unknown project ${req.project}`)
          state.select({ kind: 'document', projectId: project.id, path: req.document })
        } else if (typeof req.session === 'string') state.select({ kind: 'session', id: req.session })
        else if (req.project !== undefined) {
          const project = this.findProject(req.project)
          if (!project) throw new Error(`unknown project ${req.project}`)
          state.select({ kind: 'project', id: project.id })
        }
        return null
      }
      default:
        throw new Error(`unknown command ${req.cmd}`)
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    if (existsSync(this.path)) await unlink(this.path).catch(() => undefined)
  }
}
