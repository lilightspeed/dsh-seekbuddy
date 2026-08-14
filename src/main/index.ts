import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { PetConnectionState, PetEvent, PetOpResult } from '../shared/pet-event.ts'
import { createConnection, type ConnectionHandle } from './dsh/connection.ts'

let connection: ConnectionHandle | undefined
let mainWindow: BrowserWindow | undefined

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 560,
    title: 'DSH Pet',
    show: false,
    webPreferences: {
      // type:module 下 electron-vite 把 preload 输出为 .mjs,sandbox 必须关闭
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  // 开发:加载 electron-vite 的开发服务器;生产:加载 out/renderer/index.html
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

/** 把所有 PetEvent 转发给当前主窗口的 renderer(经 preload 白名单)。 */
function sendPetEvent(event: PetEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet:event', event)
  }
}

async function handleListSessions(): Promise<PetOpResult> {
  if (!connection) return { label: 'sessions.list', ok: false, summary: 'connection not ready' }
  try {
    const response = await connection.api.sessions.list({})
    const result = response.result
    if (!result.ok) {
      return { label: 'sessions.list', ok: false, summary: `rpc error: ${JSON.stringify(result.error)}` }
    }
    const { items } = result.value
    const running = items.filter(item => item.running).length
    const nonBlank = items.filter(item => !item.blank).length
    return {
      label: 'sessions.list',
      ok: true,
      summary: `${items.length} sessions(${running} running,${nonBlank} non-blank)`,
    }
  } catch (error) {
    return { label: 'sessions.list', ok: false, summary: String(error) }
  }
}

function handleGetState(): PetConnectionState {
  return connection?.state() ?? { connection: null, description: null }
}

app.whenReady().then(() => {
  ipcMain.handle('pet:get-state', () => handleGetState())
  ipcMain.handle('pet:list-sessions', () => handleListSessions())
  ipcMain.handle('pet:debug-reconnect', () => {
    if (!connection) return false
    connection.stop()
    connection.start()
    return true
  })

  mainWindow = createWindow()
  connection = createConnection(sendPetEvent)
  connection.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  connection?.stop()
})
