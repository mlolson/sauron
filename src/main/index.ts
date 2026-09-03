import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { AppPaths, Persistence } from './services/persistence'
import { AppState } from './state'
import { registerIpc } from './ipc'
import { SocketServer } from './services/socket-server'
import { installCliShim } from './services/cli-shim'
import { installFileLogging } from './services/logging'
import { existsSync } from 'node:fs'

const logFile = installFileLogging(join(app.getPath('logs'), 'main.log'))
let mainWindow: BrowserWindow | null = null
const pendingOpens: string[] = []

// Unpackaged builds would otherwise use the lowercase package name.
app.setPath('userData', join(app.getPath('appData'), 'Sauron'))
const paths = new AppPaths(app.getPath('userData'))
const state = new AppState(new Persistence(paths))
const socketServer = new SocketServer(state, paths.socketFile)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    title: 'Sauron',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  win.on('focus', () => {
    state.windowFocused = true
  })
  win.on('blur', () => {
    state.windowFocused = false
  })
  win.on('closed', () => {
    mainWindow = null
  })
  return win
}

function broadcast(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

state.on('snapshot', (s) => broadcast('snapshot', s))
state.on('error', (e) => broadcast('error', e))
state.on('select', (t) => broadcast('select', t))

// Folder opened via Finder, `open -a Sauron <dir>`, or drag to the Dock icon.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (state.loaded) void state.addProjects([path])
  else pendingOpens.push(path)
})

// sauron:// URLs (registered when packaged).
app.on('open-url', (event, url) => {
  event.preventDefault()
  console.log('open-url', url)
})

app.on('second-instance', (_event, argv) => {
  mainWindow?.focus()
  for (const arg of argv.slice(1)) if (arg.startsWith('/')) void state.addProjects([arg])
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.mattolson.sauron')
    registerIpc(state, () => mainWindow, logFile)
    const devIcon = join(__dirname, '../../build/icon.png')
    if (!app.isPackaged && existsSync(devIcon)) app.dock?.setIcon(devIcon)
    mainWindow = createWindow()
    try {
      await paths.createLayout()
      state.sauronBin = await installCliShim(paths.binDir, join(__dirname, 'cli.js'), process.execPath)
    } catch (error) {
      state.report(error)
    }
    await state.load()
    if (pendingOpens.length) await state.addProjects(pendingOpens.splice(0))
    try {
      await socketServer.start()
    } catch (error) {
      state.report(error)
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // Keep running in the Dock like a normal Mac app; sessions live in tmux anyway.
})

app.on('before-quit', async (event) => {
  event.preventDefault()
  await socketServer.stop()
  await state.shutdown()
  app.exit(0)
})
