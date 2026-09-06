import { contextBridge, ipcRenderer } from 'electron'
import type { AppError, SauronApi, SelectionTarget, Snapshot } from '@shared/types'
import type { TranscriptEntry } from '@shared/transcript-types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: SauronApi = {
  getSnapshot: () => ipcRenderer.invoke('getSnapshot'),
  onSnapshot: (cb) => subscribe<Snapshot>('snapshot', cb),
  onError: (cb) => subscribe<AppError>('error', cb),
  onSelect: (cb) => subscribe<SelectionTarget>('select', cb),

  addProjectDialog: () => ipcRenderer.invoke('addProjectDialog'),
  addProjects: (paths) => ipcRenderer.invoke('addProjects', paths),
  removeProject: (id) => ipcRenderer.invoke('removeProject', id),
  archiveProject: (id, archived) => ipcRenderer.invoke('archiveProject', id, archived),
  resolveTools: () => ipcRenderer.invoke('resolveTools'),

  launchSession: (projectId, tool, options) => ipcRenderer.invoke('launchSession', projectId, tool, options),
  renameSession: (id, title) => ipcRenderer.invoke('renameSession', id, title),
  reorderSessions: (projectId, orderedIds) => ipcRenderer.invoke('reorderSessions', projectId, orderedIds),
  forkSession: (id, options) => ipcRenderer.invoke('forkSession', id, options),
  refreshWorktrees: (projectId) => ipcRenderer.invoke('refreshWorktrees', projectId),
  recentCommits: (projectId, limit, branch) => ipcRenderer.invoke('recentCommits', projectId, limit, branch),
  sessionCommits: (sessionId, branch) => ipcRenderer.invoke('sessionCommits', sessionId, branch),
  projectBranches: (projectId) => ipcRenderer.invoke('projectBranches', projectId),
  commitDiff: (projectId, hash) => ipcRenderer.invoke('commitDiff', projectId, hash),
  checkWorktreeRemoval: (projectId, path) => ipcRenderer.invoke('checkWorktreeRemoval', projectId, path),
  removeWorktree: (projectId, path, force) => ipcRenderer.invoke('removeWorktree', projectId, path, force),
  closeSession: (id) => ipcRenderer.invoke('closeSession', id),
  hideSession: (id) => ipcRenderer.invoke('hideSession', id),
  unhideSession: (cliSessionId) => ipcRenderer.invoke('unhideSession', cliSessionId),
  resumeSession: (id) => ipcRenderer.invoke('resumeSession', id),
  forgetSession: (id) => ipcRenderer.invoke('forgetSession', id),
  adoptOrphan: (name) => ipcRenderer.invoke('adoptOrphan', name),
  killOrphan: (name) => ipcRenderer.invoke('killOrphan', name),

  ptyOpen: (sessionId, cols, rows) => ipcRenderer.invoke('ptyOpen', sessionId, cols, rows),
  ptyClose: (sessionId) => ipcRenderer.invoke('ptyClose', sessionId),
  sessionClients: (sessionId) => ipcRenderer.invoke('sessionClients', sessionId),
  detachOtherClients: (sessionId) => ipcRenderer.invoke('detachOtherClients', sessionId),
  ptyInput: (sessionId, data) => ipcRenderer.send('ptyInput', sessionId, data),
  ptyResize: (sessionId, cols, rows) => ipcRenderer.send('ptyResize', sessionId, cols, rows),
  onPtyData: (sessionId, cb) => subscribe<string>(`pty:data:${sessionId}`, cb),
  onPtyExit: (sessionId, cb) => subscribe<void>(`pty:exit:${sessionId}`, () => cb()),

  setActiveSession: (sessionId) => ipcRenderer.send('setActiveSession', sessionId),
  setPreferences: (prefs) => ipcRenderer.invoke('setPreferences', prefs),
  getConfigFile: () => ipcRenderer.invoke('getConfigFile'),
  saveConfigFile: (content) => ipcRenderer.invoke('saveConfigFile', content),
  refreshDocuments: (projectId) => ipcRenderer.invoke('refreshDocuments', projectId),
  addKeyDocumentDialog: (projectId) => ipcRenderer.invoke('addKeyDocumentDialog', projectId),
  removeKeyDocument: (projectId, path) => ipcRenderer.invoke('removeKeyDocument', projectId, path),
  readDocument: (projectId, path) => ipcRenderer.invoke('readDocument', projectId, path),
  writeDocument: (projectId, path, content, expectedMtime) => ipcRenderer.invoke('writeDocument', projectId, path, content, expectedMtime),
  commitDocument: (projectId, path, message) => ipcRenderer.invoke('commitDocument', projectId, path, message),
  startMaster: () => ipcRenderer.invoke('startMaster'),
  stopMaster: () => ipcRenderer.invoke('stopMaster'),
  restartMaster: () => ipcRenderer.invoke('restartMaster'),
  refreshStatus: (projectId) => ipcRenderer.invoke('refreshStatus', projectId),
  refreshAllStatuses: () => ipcRenderer.invoke('refreshAllStatuses'),
  transcriptOpen: (sessionId) => ipcRenderer.invoke('transcriptOpen', sessionId),
  transcriptClose: (sessionId) => ipcRenderer.invoke('transcriptClose', sessionId),
  transcriptLoadOlder: (sessionId, beforeIndex, count) => ipcRenderer.invoke('transcriptLoadOlder', sessionId, beforeIndex, count),
  onTranscriptAppend: (sessionId, cb) => subscribe<TranscriptEntry[]>(`transcript:append:${sessionId}`, cb),
  handoffSession: (sessionId, tool) => ipcRenderer.invoke('handoffSession', sessionId, tool),
  lastCommitBySession: (projectId) => ipcRenderer.invoke('lastCommitBySession', projectId),
  saveProjectJobs: (projectId, jobs) => ipcRenderer.invoke('saveProjectJobs', projectId, jobs),
  runJob: (projectId, jobId) => ipcRenderer.invoke('runJob', projectId, jobId),
  mergeRun: (runId) => ipcRenderer.invoke('mergeRun', runId),
  discardRun: (runId) => ipcRenderer.invoke('discardRun', runId),
  openRun: (runId, prompt) => ipcRenderer.invoke('openRun', runId, prompt),
  runLog: (runId) => ipcRenderer.invoke('runLog', runId),
  revealInFinder: (path) => ipcRenderer.send('revealInFinder', path),
  openInVsCode: (path) => ipcRenderer.invoke('openInVsCode', path),
  revealLogs: () => ipcRenderer.send('revealLogs'),
  chooseDirectory: (title) => ipcRenderer.invoke('chooseDirectory', title),
  copyToClipboard: (text) => ipcRenderer.send('copyToClipboard', text),
}

contextBridge.exposeInMainWorld('sauron', api)
