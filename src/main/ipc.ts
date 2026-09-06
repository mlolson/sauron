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
  handle('archiveProject', (id, archived) => state.archiveProject(id, archived))
  handle('resolveTools', () => state.refreshTools())

  handle('launchSession', async (projectId, tool, options) => {
    await state.launchSession(projectId, tool, options)
  })
  handle('renameSession', (id, title) => state.renameSession(id, title))
  handle('reorderSessions', async (projectId, orderedIds) => state.reorderSessions(projectId, orderedIds))
  handle('forkSession', async (id, options) => {
    return state.forkSession(id, options)
  })
  handle('refreshWorktrees', (projectId) => state.refreshWorktrees(projectId))
  handle('recentCommits', (projectId, limit, branch) => state.recentCommits(projectId, limit, branch))
  handle('sessionCommits', (sessionId, branch) => state.sessionCommits(sessionId, branch))
  handle('projectBranches', (projectId) => state.projectBranches(projectId))
  handle('commitDiff', (projectId, hash) => state.commitDiff(projectId, hash))
  handle('checkWorktreeRemoval', (projectId, path) => state.checkWorktreeRemoval(projectId, path))
  handle('removeWorktree', (projectId, path, force) => state.removeWorktree(projectId, path, force))
  handle('closeSession', (id) => state.closeSession(id))
  handle('hideSession', async (id) => state.hideSession(id))
  handle('unhideSession', async (cliSessionId) => state.unhideSession(cliSessionId))
  handle('resumeSession', (id) => state.resumeSession(id))
  handle('forgetSession', async (id) => state.forgetSession(id))
  handle('adoptOrphan', async (name) => state.adoptOrphan(name))
  handle('killOrphan', (name) => state.killOrphan(name))

  // Looked up per send, not captured at open: a pty outlives the window it was opened for
  // whenever the window closes first, and sending to a destroyed window throws.
  const sendToWindow = (channel: string, ...args: unknown[]) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  handle('ptyOpen', async (sessionId, cols, rows) => {
    const session = state.session(sessionId)
    const pty = state.pty
    if (!session?.tmuxName || !pty) return
    pty.open(sessionId, session.tmuxName, session.worktreePath ?? session.workingDir, cols, rows, {
      onData: (data) => sendToWindow(`pty:data:${sessionId}`, data),
      onExit: () => {
        sendToWindow(`pty:exit:${sessionId}`)
        void state.checkLiveness()
      },
    })
  })
  handle('ptyClose', async (sessionId) => state.pty?.close(sessionId))
  handle('sessionClients', (sessionId) => state.sessionClients(sessionId))
  handle('detachOtherClients', async (sessionId) => {
    await state.detachOtherClients(sessionId)
  })
  on('ptyInput', (sessionId, data) => state.pty?.write(sessionId, data))
  on('ptyResize', (sessionId, cols, rows) => state.pty?.resize(sessionId, cols, rows))

  on('setActiveSession', (sessionId) => {
    state.activeSessionId = sessionId
  })
  handle('setPreferences', async (prefs) => state.setPreferences(prefs))
  handle('getConfigFile', () => state.getConfigFile())
  handle('saveConfigFile', (content) => state.saveConfigFile(content))

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
  handle('writeDocument', (projectId, path, content, expectedMtime) => state.writeDocument(projectId, path, content, expectedMtime))
  handle('commitDocument', async (projectId, path, message) => {
    await state.commitDocument(projectId, path, message)
  })

  handle('startMaster', () => state.startMaster())
  handle('stopMaster', () => state.stopMaster())
  handle('restartMaster', () => state.restartMaster())
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

  handle('handoffSession', async (sessionId, tool) => {
    await state.handoffSession(sessionId, tool)
  })
  handle('lastCommitBySession', (projectId) => state.lastCommitBySession(projectId))
  handle('saveBackgroundAgents', async (templates) => state.saveBackgroundAgents(templates))
  handle('saveProjectJobs', async (projectId, jobs) => state.saveProjectJobs(projectId, jobs))
  handle('runJob', async (projectId, jobId) => state.runJob(projectId, jobId))
  handle('mergeRun', async (runId) => state.mergeRun(runId))
  handle('discardRun', async (runId) => state.discardRun(runId))
  handle('openRun', async (runId, prompt) => state.openRun(runId, prompt))
  handle('runLog', (runId) => state.runLog(runId))
  on('revealInFinder', (path) => shell.showItemInFolder(path))
  handle('openInVsCode', async (path) => {
    // VS Code registers this scheme when it is installed; openExternal rejects when nothing handles it.
    try {
      await shell.openExternal(`vscode://file${encodeURI(path)}`)
    } catch (error) {
      state.report(new Error(`Could not open ${path} in VS Code. Is VS Code installed? (${(error as Error).message})`))
    }
  })
  on('revealLogs', () => shell.showItemInFolder(logFile))
  handle('chooseDirectory', async (title) => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), { title, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  on('copyToClipboard', (text) => clipboard.writeText(text))
}
