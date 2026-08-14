import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PetConnectionState, PetEvent, PetOpResult, PetApprovalRequest } from '../shared/pet-event.ts'
import { createConnection, type ConnectionHandle } from './dsh/connection.ts'
import { createPetOps, type PetOps } from './dsh/ops.ts'
import { createNotifier } from './notify.ts'
import { createTray } from './tray.ts'

// 全局兜底:注册后 Electron 不再弹默认错误对话框,完整错误打到终端
// (默认对话框只显示截断堆栈,无法定位是哪条 IPC 消息、哪个参数)。
process.on('uncaughtException', (error) => {
  console.error('[pet] uncaughtException in main:', error)
})

let connection: ConnectionHandle | undefined
let mainWindow: BrowserWindow | undefined

/** 目标会话:用户显式选择的会话(发消息的落点);null = 回退最近会话。 */
let targetSessionId: string | null = null
let petOps: PetOps | undefined
let notifier: ReturnType<typeof createNotifier> | undefined

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

/**
 * 把所有 PetEvent 转发给当前主窗口的 renderer(经 preload 白名单)。
 * 阶段 3:帧风暴保护 —— dsh:frame 不再逐帧推给 renderer(renderer 不消费),
 * 只推语义事件(状态/turn/审批/错误);主进程侧仍可经 dsh:frame 调试。
 */
function sendPetEvent(event: PetEvent): void {
  if (event.type === 'dsh:frame') return
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet:event', event)
  }
}

/** 统一事件出口:通知 + 转发 renderer。 */
function onPetEvent(event: PetEvent): void {
  notifier?.onEvent(event)
  sendPetEvent(event)
}

function handleGetState(): PetConnectionState {
  return { ...(connection?.state() ?? { connection: null, description: null }), targetSessionId }
}

/** 目标会话:显式选择优先;否则最近更新的非空会话;没有则新建。 */
async function ensureTargetSession(): Promise<SessionId | null> {
  if (!connection) return null
  const listResponse = await connection.api.sessions.list({})
  const list = listResponse.result
  if (!list.ok) return null
  const items = list.value.items
  if (targetSessionId) {
    const chosen = items.find((item) => String(item.sessionId) === targetSessionId)
    if (chosen) return chosen.sessionId
  }
  const first = items.find((item) => !item.blank) ?? items[0]
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

/** 窗口拖拽:由 renderer 的 -webkit-app-region: drag 原生处理,无 IPC。 */

app.whenReady().then(() => {
  // Windows 通知需要 appUserModelId(否则部分系统不显示)。
  if (process.platform === 'win32') app.setAppUserModelId('com.deepseek-ai.dsh-pet')

  petOps = createPetOps(
    () => connection,
    () => targetSessionId,
    (id) => {
      targetSessionId = id
    },
  )

  notifier = createNotifier({
    isWindowVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    isTargetSession: (sessionId) => sessionId !== null && sessionId === targetSessionId,
  })

  ipcMain.handle('pet:get-state', () => handleGetState())
  ipcMain.handle('pet:send-message', (_event, text: string) => handleSendMessage(text))
  ipcMain.handle('pet:list-sessions', () => petOps?.listSessions() ?? { ok: false, summary: 'ops not ready', targetSessionId: null, items: [] })
  ipcMain.handle('pet:get-history', (_event, sessionId: string, beforeSeq: number | null, maxMessages: number | null) =>
    petOps?.getHistory(sessionId, beforeSeq, maxMessages) ?? { ok: false, summary: 'ops not ready', sessionId, hasMore: false, entries: [] },
  )
  ipcMain.handle('pet:select-session', (_event, sessionId: string | null) => petOps?.selectSession(sessionId) ?? { label: 'session.select', ok: false, summary: 'ops not ready' })
  ipcMain.handle('pet:create-session', () => petOps?.createSession() ?? { ok: false, summary: 'ops not ready' })
  ipcMain.handle('pet:respond-approval', (_event, request: PetApprovalRequest) =>
    petOps?.respondApproval(request) ?? { label: 'approval.respond', ok: false, summary: 'ops not ready' },
  )

  mainWindow = createWindow()
  connection = createConnection(onPetEvent)
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
