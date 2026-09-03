import * as pty from 'node-pty'
import { attachArgs } from '@shared/tmux-args'

export interface PtyHandlers {
  onData: (data: string) => void
  onExit: () => void
}

/** One `tmux attach` client per open terminal tab. Closing kills only the client. */
export class PtyService {
  private ptys = new Map<string, pty.IPty>()

  constructor(private readonly tmuxPath: string, private readonly environment: Record<string, string>) {}

  isOpen(sessionId: string): boolean {
    return this.ptys.has(sessionId)
  }

  open(sessionId: string, tmuxName: string, cwd: string, cols: number, rows: number, handlers: PtyHandlers): void {
    if (this.ptys.has(sessionId)) return
    const proc = pty.spawn(this.tmuxPath, attachArgs(tmuxName), {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 2),
      cwd,
      env: this.environment,
    })
    this.ptys.set(sessionId, proc)
    proc.onData(handlers.onData)
    proc.onExit(() => {
      this.ptys.delete(sessionId)
      handlers.onExit()
    })
  }

  write(sessionId: string, data: string): void {
    this.ptys.get(sessionId)?.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    this.ptys.get(sessionId)?.resize(cols, rows)
  }

  close(sessionId: string): void {
    const proc = this.ptys.get(sessionId)
    if (!proc) return
    this.ptys.delete(sessionId)
    proc.kill()
  }

  closeAll(): void {
    for (const id of [...this.ptys.keys()]) this.close(id)
  }
}
