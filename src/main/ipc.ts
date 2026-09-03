import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { AppState } from './state'
import type { SauronApi } from '@shared/types'

type Handler<K extends keyof SauronApi> = SauronApi[K] extends (...args: infer A) => infer R
  ? (...args: A) => R
  : never

/** Registers every renderer-callable method. Channel names are the method names. */
export function registerIpc(state: AppState, getWindow: () => BrowserWindow | null): void {
  const handle = <K extends keyof SauronApi>(name: K, fn: Handler<K>) => {
    ipcMain.handle(name, (_event, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
  }
  const on = <K extends keyof SauronApi>(name: K, fn: Handler<K>) => {
    ipcMain.on(name, (_event, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
  }

  handle('getSnapshot', async () => state.snapshot())

  handle('addProjectDialog', async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Add Project',
      message: 'Choose a git repository directory.',
      buttonLabel: 'Add Project',
      properties: ['openDirectory', 'multiSelections'],
    })
    if (!result.canceled) await state.addProjects(result.filePaths)
  })
  handle('addProjects', (paths) => state.addProjects(paths))
  handle('removeProject', async (id) => state.removeProject(id))
  handle('resolveTools', () => state.refreshTools())

  handle('launchSession', async (projectId, tool, options) => {
    await state.launchSession(projectId, tool, options)
  })
  handle('refreshWorktrees', (projectId) => state.refreshWorktrees(projectId))
  handle('checkWorktreeRemoval', (projectId, path) => state.checkWorktreeRemoval(projectId, path))
  handle('removeWorktree', (projectId, path, force) => state.removeWorktree(projectId, path, force))
  handle('stopSession', (id) => state.stopSession(id))
  handle('detachSession', async (id) => state.detachSession(id))
  handle('resumeSession', (id) => state.resumeSession(id))
  handle('forgetSession', async (id) => state.forgetSession(id))
  handle('adoptOrphan', async (name) => state.adoptOrphan(name))
  handle('killOrphan', (name) => state.killOrphan(name))

  handle('ptyOpen', async (sessionId, cols, rows) => {
    const session = state.session(sessionId)
    const pty = state.pty
    if (!session?.tmuxName || !pty) return
    const win = getWindow()
    pty.open(sessionId, session.tmuxName, session.worktreePath ?? session.workingDir, cols, rows, {
      onData: (data) => win?.webContents.send(`pty:data:${sessionId}`, data),
      onExit: () => {
        win?.webContents.send(`pty:exit:${sessionId}`)
        void state.checkLiveness()
      },
    })
  })
  handle('ptyClose', async (sessionId) => state.pty?.close(sessionId))
  on('ptyInput', (sessionId, data) => state.pty?.write(sessionId, data))
  on('ptyResize', (sessionId, cols, rows) => state.pty?.resize(sessionId, cols, rows))

  on('revealInFinder', (path) => shell.showItemInFolder(path))
  on('copyToClipboard', (text) => clipboard.writeText(text))
}
