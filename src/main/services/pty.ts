import * as pty from 'node-pty'
import { attachArgs } from '@shared/tmux-args'

export interface PtyHandlers {
  onData: (data: string) => void
  onExit: () => void
}

/** One `tmux attach` client per open terminal tab. Closing kills only the client. */
export class PtyService {
  private ptys = new Map<string, { proc: pty.IPty; listeners: pty.IDisposable[] }>()

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
    const listeners = [
      proc.onData(handlers.onData),
      proc.onExit(() => {
        this.ptys.delete(sessionId)
        handlers.onExit()
      }),
    ]
    this.ptys.set(sessionId, { proc, listeners })
  }

  write(sessionId: string, data: string): void {
    this.ptys.get(sessionId)?.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 2) return
    this.ptys.get(sessionId)?.proc.resize(cols, rows)
  }

  close(sessionId: string): void {
    const entry = this.ptys.get(sessionId)
    if (!entry) return
    this.ptys.delete(sessionId)
    // Killing tmux's client makes it print a detach message, and node-pty flushes whatever is
    // buffered; with the listeners gone that output has nowhere to go and nothing to throw at.
    for (const listener of entry.listeners) listener.dispose()
    entry.proc.kill()
  }

  closeAll(): void {
    for (const id of [...this.ptys.keys()]) this.close(id)
  }
}
