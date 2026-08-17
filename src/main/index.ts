import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PetConnectionState, PetEvent, PetOpResult, PetApprovalRequest } from '../shared/pet-event.ts'
import type { PetConfig, PetConfigUpdate } from '../shared/pet-config.ts'
import { PetConfigStore, type PetConfigPatch } from './config.ts'
import { createConnection, type ConnectionHandle } from './dsh/connection.ts'
import { createPetOps, type PetOps } from './dsh/ops.ts'
import { createPluginOps, type PluginOps } from './dsh/plugin-ops.ts'
import { createBridge, bridgeActionToEvent, type BridgeHandle } from './mcp/bridge.ts'
import { createNotifier } from './notify.ts'
import { createTray } from './tray.ts'

/** 窗口基准尺寸(外观缩放以此为 1.0)。 */
const WINDOW_SIZE = { width: 420, height: 560 }

// 全局兜底:注册后 Electron 不再弹默认错误对话框,完整错误打到终端
// (默认对话框只显示截断堆栈,无法定位是哪条 IPC 消息、哪个参数)。
process.on('uncaughtException', (error) => {
  console.error('[pet] uncaughtException in main:', error)
})

// 阶段 5 单实例锁:第二个实例直接退出,已运行实例经 second-instance 唤起。
// 必须在 whenReady 之前请求(Windows 命名互斥量);没拿到锁的实例什么都不做。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  // 统一应用名:dev(electron-vite)与打包版(Nsis productName)的 userData
  // 都落在 %APPDATA%/DSH Pet,配置文件天然共用一份。
  app.setName('DSH Pet')

  let connection: ConnectionHandle | undefined
  let mainWindow: BrowserWindow | undefined
  let bridge: BridgeHandle | undefined
  let petOps: PetOps | undefined
  let pluginOps: PluginOps | undefined
  let notifier: ReturnType<typeof createNotifier> | undefined
  let config: PetConfigStore | undefined

  /** 目标会话:用户显式选择的会话(发消息的落点);null = 回退最近会话。 */
  let targetSessionId: string | null = null

  function createWindow(): BrowserWindow {
    const cfg = config?.get()
    const scale = cfg?.appearance.scale ?? 1
    const win = new BrowserWindow({
      width: Math.round(WINDOW_SIZE.width * scale),
      height: Math.round(WINDOW_SIZE.height * scale),
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

    if (cfg) win.setOpacity(cfg.appearance.opacity)
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

  /** 统一事件出口:通知 + 转发 renderer。pet:* 是 MCP 反向动作,同样推给 renderer。 */
  function onPetEvent(event: PetEvent): void {
    notifier?.onEvent(event)
    sendPetEvent(event)
  }

  /**
   * 光标轮询(0016):拖拽区域(`-webkit-app-region: drag`)会吞掉 renderer 的鼠标事件,
   * 视角跟随改由主进程全局读光标(screen.getCursorScreenPoint)转局部坐标后推送。
   * 光标在窗口外也照常推送(renderer 按窗口边缘夹取,宠物始终朝向光标方向)。
   */
  let cursorTimer: NodeJS.Timeout | undefined
  function startCursorPolling(): void {
    if (cursorTimer) return
    cursorTimer = setInterval(() => {
      const win = mainWindow
      if (!win || win.isDestroyed() || !win.isVisible()) return
      const cursor = screen.getCursorScreenPoint()
      const bounds = win.getBounds()
      const x = cursor.x - bounds.x
      const y = cursor.y - bounds.y
      const inside = x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height
      win.webContents.send('pet:cursor', { x, y, inside })
    }, 33)
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

  /** 重建 DSH 连接(改基址后调用;旧连接 stop,新连接立即起)。 */
  function restartConnection(): void {
    if (!config) return
    connection?.stop()
    connection = createConnection(onPetEvent, () => config!.get().dsh.baseUrl)
    connection.start()
  }

  /** 应用外观(透明度/缩放)到当前窗口。 */
  function applyAppearance(cfg: PetConfig): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.setOpacity(cfg.appearance.opacity)
    const width = Math.round(WINDOW_SIZE.width * cfg.appearance.scale)
    const height = Math.round(WINDOW_SIZE.height * cfg.appearance.scale)
    const [x, y] = mainWindow.getPosition()
    mainWindow.setBounds({ x: x ?? 0, y: y ?? 0, width, height })
  }

  /** 开机自启(Windows LoginItem);非 Windows 平台静默忽略。 */
  function applyLaunchAtLogin(enabled: boolean): void {
    if (process.platform !== 'win32') return
    try {
      app.setLoginItemSettings({ openAtLogin: enabled })
    } catch (error) {
      console.error('[pet] setLoginItemSettings failed:', error)
    }
  }

  /** IPC 侧配置补丁:只放行白名单字段(renderer 改不了 targetSessionId)。 */
  function sanitizeConfigUpdate(patch: PetConfigUpdate | undefined): PetConfigPatch {
    const out: PetConfigPatch = {}
    if (patch?.dshBaseUrl !== undefined) out.dshBaseUrl = String(patch.dshBaseUrl ?? '')
    if (typeof patch?.opacity === 'number' && Number.isFinite(patch.opacity)) out.opacity = patch.opacity
    if (typeof patch?.scale === 'number' && Number.isFinite(patch.scale)) out.scale = patch.scale
    if (typeof patch?.voiceEnabled === 'boolean') out.voiceEnabled = patch.voiceEnabled
    if (typeof patch?.launchAtLogin === 'boolean') out.launchAtLogin = patch.launchAtLogin
    // 宠物(Live2D)外观/跟随手感(0017):标量 + 范围收敛
    if (typeof patch?.petPositionX === 'number' && Number.isFinite(patch.petPositionX)) out.petPositionX = Math.min(1, Math.max(0, patch.petPositionX))
    if (typeof patch?.petPositionY === 'number' && Number.isFinite(patch.petPositionY)) out.petPositionY = Math.min(1, Math.max(0, patch.petPositionY))
    if (typeof patch?.petScale === 'number' && Number.isFinite(patch.petScale)) out.petScale = Math.min(3, Math.max(0.2, patch.petScale))
    if (typeof patch?.petHeadAmplitude === 'number' && Number.isFinite(patch.petHeadAmplitude)) out.petHeadAmplitude = Math.min(1, Math.max(0, patch.petHeadAmplitude))
    if (typeof patch?.petEyeAmplitude === 'number' && Number.isFinite(patch.petEyeAmplitude)) out.petEyeAmplitude = Math.min(1, Math.max(0, patch.petEyeAmplitude))
    if (typeof patch?.petBodyAmplitude === 'number' && Number.isFinite(patch.petBodyAmplitude)) out.petBodyAmplitude = Math.min(1, Math.max(0, patch.petBodyAmplitude))
    if (typeof patch?.petDeadZone === 'number' && Number.isFinite(patch.petDeadZone)) out.petDeadZone = Math.min(100, Math.max(0, patch.petDeadZone))
    if (typeof patch?.petDistance === 'number' && Number.isFinite(patch.petDistance)) out.petDistance = Math.min(2000, Math.max(20, patch.petDistance))
    if (typeof patch?.petResponse === 'number' && Number.isFinite(patch.petResponse)) out.petResponse = Math.min(5, Math.max(0.2, patch.petResponse))
    return out
  }

  app.whenReady().then(() => {
    // Windows 通知需要 appUserModelId(否则部分系统不显示)。
    if (process.platform === 'win32') app.setAppUserModelId('com.deepseek-ai.dsh-pet')

    config = new PetConfigStore()
    // 启动即应用持久化配置:目标会话记忆、外观、开机自启
    targetSessionId = config.get().targetSessionId
    applyLaunchAtLogin(config.get().launchAtLogin)

    petOps = createPetOps(
      () => connection,
      () => targetSessionId,
      (id) => {
        targetSessionId = id
        // 阶段 5:目标会话记忆 —— 每次切换/清除都落盘,重启后恢复
        if (config && config.get().targetSessionId !== id) {
          void config.update({ targetSessionId: id })
        }
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

    // B3(只读)插件监控:agent 中介读取目标会话插件清单
    pluginOps = createPluginOps({
      getConnection: () => connection,
      getTargetSession: () => ensureTargetSession(),
    })
    ipcMain.handle('pet:list-plugins', () =>
      pluginOps?.listPlugins() ?? { ok: false, summary: 'ops not ready', refreshedAt: 0, plugins: [] },
    )

    // 阶段 5 配置读写:get 返回完整配置;set 应用扁平补丁并按变更执行副作用
    // (DSH 地址变更 → 重建连接;外观 → 窗口;自启 → LoginItem)。
    ipcMain.handle('pet:get-config', () => config?.get() ?? null)
    ipcMain.handle('pet:set-config', (_event, patch: PetConfigUpdate | undefined) => {
      if (!config) return null
      const prev = config.get()
      const next = config.update(sanitizeConfigUpdate(patch))
      if (next.dsh.baseUrl !== prev.dsh.baseUrl) restartConnection()
      if (next.appearance.opacity !== prev.appearance.opacity || next.appearance.scale !== prev.appearance.scale) {
        applyAppearance(next)
      }
      if (next.launchAtLogin !== prev.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin)
      return next
    })

    mainWindow = createWindow()
    startCursorPolling()
    restartConnection()

    // 阶段 4 反向链路:loopback bridge,MCP server(被 DSH spawn)经它驱动宠物。
    // 端口约定固定值(环境变量 PET_BRIDGE_PORT 可覆盖),见 mcp/bridge.ts。
    createBridge((action) => {
      console.error(`[pet] bridge action: ${action.kind}`)
      onPetEvent(bridgeActionToEvent(action))
    })
      .then((handle) => {
        bridge = handle
        console.error(`[pet] mcp bridge listening on 127.0.0.1:${handle.port}`)
      })
      .catch((error) => {
        console.error('[pet] mcp bridge failed to start:', error)
      })

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

  // 阶段 5:第二个实例(或再次启动 exe)→ 唤起已运行实例的窗口。
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    if (cursorTimer) clearInterval(cursorTimer)
    connection?.stop()
    bridge?.close()
  })
}
