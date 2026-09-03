import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { AppState } from './state'
import type { SauronApi } from '@shared/types'

type Handler<K extends keyof SauronApi> = SauronApi[K] extends (...args: infer A) => infer R
  ? (...args: A) => R
  : never

/** Registers every renderer-callable method. Channel names are the method names. */
export function registerIpc(state: AppState, getWindow: () => BrowserWindow | null, logFile: string): void {
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
  handle('renameSession', (id, title) => state.renameSession(id, title))
  handle('refreshWorktrees', (projectId) => state.refreshWorktrees(projectId))
  handle('checkWorktreeRemoval', (projectId, path) => state.checkWorktreeRemoval(projectId, path))
  handle('removeWorktree', (projectId, path, force) => state.removeWorktree(projectId, path, force))
  handle('closeSession', (id) => state.closeSession(id))
  handle('hideSession', async (id) => state.hideSession(id))
  handle('unhideSession', async (cliSessionId) => state.unhideSession(cliSessionId))
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

  on('setActiveSession', (sessionId) => {
    state.activeSessionId = sessionId
  })
  handle('setPreferences', async (prefs) => state.setPreferences(prefs))

  handle('refreshDocuments', (projectId) => state.refreshDocuments(projectId))
  handle('addKeyDocumentDialog', async (projectId) => {
    const project = state.project(projectId)
    if (!project) return
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Add Key Document',
      message: `Choose a file inside ${project.name}.`,
      defaultPath: project.path,
      properties: ['openFile', 'multiSelections'],
    })
    if (result.canceled) return
    for (const p of result.filePaths) await state.addKeyDocument(projectId, p)
  })
  handle('removeKeyDocument', (projectId, path) => state.removeKeyDocument(projectId, path))
  handle('readDocument', (projectId, path) => state.readDocument(projectId, path))

  handle('startMaster', () => state.startMaster())
  handle('stopMaster', () => state.stopMaster())
  handle('refreshStatus', async (projectId) => state.requestRefresh(projectId))
  handle('refreshAllStatuses', async () => {
    for (const p of state.projects) state.requestRefresh(p.id)
  })

  handle('transcriptOpen', async (sessionId) => {
    const win = getWindow()
    state.setTranscriptListener(sessionId, (entries) => win?.webContents.send(`transcript:append:${sessionId}`, entries))
    return state.transcriptOpen(sessionId)
  })
  handle('transcriptClose', async (sessionId) => state.transcriptClose(sessionId))
  handle('transcriptLoadOlder', async (sessionId, beforeIndex, count) => state.transcriptLoadOlder(sessionId, beforeIndex, count))

  on('revealInFinder', (path) => shell.showItemInFolder(path))
  on('revealLogs', () => shell.showItemInFolder(logFile))
  handle('chooseDirectory', async (title) => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), { title, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  on('copyToClipboard', (text) => clipboard.writeText(text))
}
