import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PetConnectionState, PetEvent, PetOpResult } from '../shared/pet-event.ts'
import { createConnection, type ConnectionHandle } from './dsh/connection.ts'
import { createTray } from './tray.ts'

let connection: ConnectionHandle | undefined
let mainWindow: BrowserWindow | undefined

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 560,
    title: 'DSH Pet',
    // 桌面宠物壳:无边框 + 透明 + 置顶 + 不入任务栏(靠托盘管理)
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
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

function handleGetState(): PetConnectionState {
  return connection?.state() ?? { connection: null, description: null }
}

/** 目标会话:最近更新的会话;没有则新建一个。 */
async function ensureTargetSession(): Promise<SessionId | null> {
  if (!connection) return null
  const listResponse = await connection.api.sessions.list({})
  const list = listResponse.result
  if (!list.ok) return null
  const first = list.value.items[0]
  if (first) return first.sessionId
  const createResponse = await connection.api.sessions.create({})
  const created = createResponse.result
  return created.ok ? created.value.sessionId : null
}

async function handleSendMessage(text: string): Promise<PetOpResult> {
  if (!connection) return { label: 'session.prompt', ok: false, summary: 'connection not ready' }
  if (typeof text !== 'string' || text.trim() === '') {
    return { label: 'session.prompt', ok: false, summary: 'empty message' }
  }
  try {
    const sessionId = await ensureTargetSession()
    if (!sessionId) return { label: 'session.prompt', ok: false, summary: 'no target session' }
    const response = await connection.api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: text.trim() }],
    })
    const result = response.result
    if (!result.ok) {
      return { label: 'session.prompt', ok: false, summary: `rpc error: ${JSON.stringify(result.error)}` }
    }
    return { label: 'session.prompt', ok: true, summary: `accepted → session ${sessionId}` }
  } catch (error) {
    return { label: 'session.prompt', ok: false, summary: String(error) }
  }
}

/** 窗口拖拽:记录起点,移动时按屏幕坐标增量 setPosition。 */
let dragState: { startMouseX: number; startMouseY: number; startWinX: number; startWinY: number } | undefined

app.whenReady().then(() => {
  ipcMain.handle('pet:get-state', () => handleGetState())
  ipcMain.handle('pet:send-message', (_event, text: string) => handleSendMessage(text))

  ipcMain.on('pet:drag-start', (event, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    const [winX = 0, winY = 0] = win.getPosition()
    dragState = { startMouseX: x, startMouseY: y, startWinX: winX, startWinY: winY }
  })
  ipcMain.on('pet:drag-move', (event, x: number, y: number) => {
    if (!dragState) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    win.setPosition(
      dragState.startWinX + (x - dragState.startMouseX),
      dragState.startWinY + (y - dragState.startMouseY),
    )
  })
  ipcMain.on('pet:drag-end', () => {
    dragState = undefined
  })

  mainWindow = createWindow()
  connection = createConnection(sendPetEvent)
  connection.start()

  const tray = createTray(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isVisible()) {
      mainWindow.hide()
    } else {
      mainWindow.show()
    }
  })
  void tray

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
