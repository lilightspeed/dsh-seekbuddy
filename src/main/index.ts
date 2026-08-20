import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import type { PetConnectionState, PetEvent, PetOpResult, PetApprovalRequest } from '../shared/pet-event.ts'
import type { PetConfigUpdate } from '../shared/pet-config.ts'
import { WINDOW_SIZE, WINDOW_SIZE_MAX, WINDOW_SIZE_MIN } from '../shared/pet-config.ts'
import { PetConfigStore, type PetConfigPatch } from './config.ts'
import { createConnection, type ConnectionHandle } from './dsh/connection.ts'
import { createPetOps, type PetOps } from './dsh/ops.ts'
import { createPluginOps, type PluginOps } from './dsh/plugin-ops.ts'
import { createBridge, bridgeActionToEvent, type BridgeHandle } from './mcp/bridge.ts'
import { createNotifier } from './notify.ts'
import { createTray } from './tray.ts'
import { applySystemRoundedCorners } from './rounded-window.ts'

/**
 * 0056 窗口边缘拖拽调整大小:允许的拖拽方向。
 * 主进程在光标轮询里锚定对侧边计算新 bounds,renderer 只发开始/结束信号。
 * 尺寸夹取范围见 shared/pet-config.ts 的 WINDOW_SIZE_MIN/MAX(拖拽与配置共用)。
 */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const
type ResizeEdge = (typeof RESIZE_EDGES)[number]
/**
 * 0056 边缘拖拽的**专用**采样间隔(ms):60Hz,与显示刷新对齐 —— 显示器每帧
 * 最多展示一次窗口位置,高于刷新率的 setBounds 是纯浪费:只会让 renderer 收到
 * 更多 resize 事件(layout + canvas 重分配 + 视图矩阵重建),超出其帧产出的
 * 部分表现为**内容(宠物/组件)跳帧**,而窗口边缘(由 DWM 合成)反而看不出差别。
 * 早期 33ms(30fps)边缘顿挫、8ms(125fps)边缘平滑但内容跳动,16ms 是两者之间
 * 与显示对齐的稳态:边缘逐帧平滑,renderer 每帧至多处理一次尺寸变化。
 * 视角跟随的 33ms 轮询保持不变(跟随不需要更高频率)。
 */
const RESIZE_POLL_MS = 16

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

  /**
   * 0057 缩放手势状态(win32 原生路径):Electron 的 will-resize/resized 只在
   * **手动**缩放时触发(程序化 setBounds 不触发)。will-resize 在拖拽中高频
   * 触发,按"状态变化"去重后推送 renderer 切换 body.pet-resizing;resized
   * 表示手势结束 —— 恢复渲染态 + 把最终尺寸落盘(重启保持)。
   */
  let resizeGestureActive = false
  /** will-resize 高频触发,resized 偶发缺失的兜底:手势静默 400ms 视为结束。 */
  let resizeGestureTimer: NodeJS.Timeout | undefined

  function sendResizeGesture(active: boolean): void {
    if (resizeGestureActive === active) return
    resizeGestureActive = active
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pet:resize-gesture', active)
    }
  }

  /** 0057:把当前窗口尺寸落盘(win32 原生缩放的结束路径;夹取到拖拽允许范围)。 */
  function persistWindowSize(): void {
    if (!mainWindow || mainWindow.isDestroyed() || !config) return
    const b = mainWindow.getBounds()
    config.update({
      windowWidth: clampWindow(b.width, WINDOW_SIZE_MIN.width, WINDOW_SIZE_MAX.width),
      windowHeight: clampWindow(b.height, WINDOW_SIZE_MIN.height, WINDOW_SIZE_MAX.height),
    })
  }

  function createWindow(): BrowserWindow {
    // 0056:窗口尺寸 = 持久化的显式尺寸(默认 420×560);不再有"窗口缩放"倍率
    const cfg = config?.get()
    const width = clampWindow(cfg?.appearance.windowWidth ?? WINDOW_SIZE.width, WINDOW_SIZE_MIN.width, WINDOW_SIZE_MAX.width)
    const height = clampWindow(cfg?.appearance.windowHeight ?? WINDOW_SIZE.height, WINDOW_SIZE_MIN.height, WINDOW_SIZE_MAX.height)
    const win = new BrowserWindow({
      width,
      height,
      title: 'DSH Pet',
      // 桌面宠物壳:无边框 + 透明 + 置顶 + 不入任务栏(靠托盘管理)
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      // 0057:win32 必须创建即 resizable:true —— Electron 对 transparent 窗口强制
      // 关闭 thickFrame(WS_THICKFRAME 永远不在样式里),但**自带**frameless 边缘
      // 命中测试与缩放实现(实测生效:真实边缘拖拽由 Electron 原生驱动,内容与框架
      // 同步移动,无弹跳)。非 win32 保持 resizable:false,沿用 0056 手柄+轮询兜底。
      resizable: process.platform === 'win32',
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      // 应用图标(win32):窗口/任务栏显示 ymcog-jpmci-001.ico;其他平台不设
      // (nativeImage 不认 .ico,且 dev 下无 exe 图标可用)。
      ...(process.platform === 'win32'
        ? { icon: join(import.meta.dirname, '../../assets/pet/icons/ymcog-jpmci-001.ico') }
        : {}),
      webPreferences: {
        // type:module 下 electron-vite 把 preload 输出为 .mjs,sandbox 必须关闭
        preload: join(import.meta.dirname, '../preload/index.mjs'),
        sandbox: false,
      },
    })

    // 0056e:MIN/MAX 夹取走 WM_GETMINMAXINFO —— 建窗时设好,原生缩放自动生效
    // (win32 实测夹取有效);非 win32 轮询兜底路径的 applyResize 另有手动夹取。
    win.setMinimumSize(WINDOW_SIZE_MIN.width, WINDOW_SIZE_MIN.height)
    win.setMaximumSize(WINDOW_SIZE_MAX.width, WINDOW_SIZE_MAX.height)

    // 高斯模糊背景(Win11 22H2+):让窗口背后的桌面/其他应用被系统 DWM 模糊,
    // 配合半透明窗口形成毛玻璃效果。低版本系统抛错时静默忽略(保持纯透明)。
    try {
      if (process.platform === 'win32') win.setBackgroundMaterial('acrylic')
    } catch (error) {
      console.warn('[pet] backgroundMaterial(acrylic) 不可用,保持纯透明窗口:', error)
    }
    // 系统圆角(Win11 22H2+):DWM 把窗口本身裁成圆角,连 acrylic 高斯模糊一起裁圆
    // —— 圆角外无模糊(SetWindowRgn 在 Electron 43 的 DComp 透明窗口上静默失效,
    // 见 rounded-window.ts)。Electron 建窗时会设回 DONOTROUND,故此处必须重设。
    void applySystemRoundedCorners(win)
    // 注意:窗口透明度**不用** win.setOpacity —— 透明度 <100% 时 Electron 会把窗口
    // 切成分层窗口(WS_EX_LAYERED),DWM 的 acrylic 材质被绕过,背后内容会清晰透出,
    // 毛玻璃失效(实测)。透明度改由 renderer 用 CSS opacity 实现(见 main.ts),
    // 窗口本身始终保持不透明,acrylic 常驻,调低透明度露出的是被模糊的背景。
    win.on('ready-to-show', () => {
      win.show()
      // 窗口真正显示后 DWM 才完成 acrylic 绘制,此时再设置一次确保圆角生效
      void applySystemRoundedCorners(win)
    })
    // 圆角偏好只在缩放**结束**后重设(DWM 属性重拍在拖拽中无意义且可能闪烁),
    // 用 debounce 兜住连续 resize;手势结束路径(resized)里也会重设一次。
    let cornerDebounce: NodeJS.Timeout | undefined
    win.on('resize', () => {
      if (cornerDebounce) clearTimeout(cornerDebounce)
      cornerDebounce = setTimeout(() => void applySystemRoundedCorners(win), 150)
    })
    // 0057:win32 手动缩放的开始/结束信号(will-resize 拖拽中高频触发,resized
    // 在手势结束时触发;setBounds 等程序化缩放不触发这两个事件,不影响非 win32)。
    win.on('will-resize', () => {
      sendResizeGesture(true)
      // 兜底:resized 偶发缺失时,手势静默 400ms 也视为结束(恢复正常渲染态并落盘)
      if (resizeGestureTimer) clearTimeout(resizeGestureTimer)
      resizeGestureTimer = setTimeout(() => {
        resizeGestureTimer = undefined
        if (!resizeGestureActive) return
        sendResizeGesture(false)
        persistWindowSize()
        void applySystemRoundedCorners(win)
      }, 400)
    })
    win.on('resized', () => {
      if (resizeGestureTimer) {
        clearTimeout(resizeGestureTimer)
        resizeGestureTimer = undefined
      }
      sendResizeGesture(false)
      persistWindowSize()
      void applySystemRoundedCorners(win)
    })

    // 窗口重建(如 mac activate)后拖动采样从零开始,避免旧窗口位置算出虚假位移(0032)
    prevWindowPos = null

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
   * 0032:同一轮询采样窗口位置增量 —— 用户拖拽窗口时连续非零,作为"拖动宠物"的
   * 物理反馈输入随 pet:cursor 推给 renderer(映射 ParamDragX/Y)。
   */
  let cursorTimer: NodeJS.Timeout | undefined
  /** 上次采样到的窗口位置(拖动检测用,0032);窗口隐藏/重建时重置避免虚假位移。 */
  let prevWindowPos: { x: number; y: number } | null = null
  /**
   * 0056 窗口边缘拖拽调整大小进行中:按下边缘手柄时记录起始窗口 bounds 与
   * 屏幕光标,之后每次光标轮询按增量重算 bounds(锚定对侧边)并 setBounds;
   * 松开(pet:resize-end)或窗口不可见时清空。
   */
  let resizeState: {
    edge: ResizeEdge
    startBounds: { x: number; y: number; width: number; height: number }
    startCursor: { x: number; y: number }
  } | null = null
  /** 0056b:拖拽期间专用的缩放循环(仅 resizeState 非空时运行,60Hz 与显示对齐)。 */
  let resizeTimer: NodeJS.Timeout | undefined

  /**
   * 0056 按当前屏幕光标调整窗口大小:只移动/伸缩被拖动的边,对侧边保持原位。
   * 夹取到 MIN/MAX 时被拖动边停住(对侧边坐标随之修正,不漂移)。
   */
  function applyResize(win: BrowserWindow, cursor: { x: number; y: number }): void {
    const s = resizeState
    if (!s) return
    const dx = cursor.x - s.startCursor.x
    const dy = cursor.y - s.startCursor.y
    let x = s.startBounds.x
    let y = s.startBounds.y
    let width = s.startBounds.width
    let height = s.startBounds.height
    const west = s.edge.includes('w')
    const east = s.edge.includes('e')
    const north = s.edge.includes('n')
    const south = s.edge.includes('s')
    if (west) {
      width = s.startBounds.width - dx
      x = s.startBounds.x + dx
    }
    if (east) width = s.startBounds.width + dx
    if (north) {
      height = s.startBounds.height - dy
      y = s.startBounds.y + dy
    }
    if (south) height = s.startBounds.height + dy
    // 夹取:被拖动边停住,对侧边保持原位(修正锚点坐标)
    if (width < WINDOW_SIZE_MIN.width) {
      if (west) x = s.startBounds.x + s.startBounds.width - WINDOW_SIZE_MIN.width
      width = WINDOW_SIZE_MIN.width
    } else if (width > WINDOW_SIZE_MAX.width) {
      if (west) x = s.startBounds.x + s.startBounds.width - WINDOW_SIZE_MAX.width
      width = WINDOW_SIZE_MAX.width
    }
    if (height < WINDOW_SIZE_MIN.height) {
      if (north) y = s.startBounds.y + s.startBounds.height - WINDOW_SIZE_MIN.height
      height = WINDOW_SIZE_MIN.height
    } else if (height > WINDOW_SIZE_MAX.height) {
      if (north) y = s.startBounds.y + s.startBounds.height - WINDOW_SIZE_MAX.height
      height = WINDOW_SIZE_MAX.height
    }
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
  }

  /**
   * 0056b:启动专用高频缩放循环(幂等;仅在拖拽期间运行)。每 tick 读屏幕光标
   * 并 applyResize —— applyResize 从 startBounds + 当前光标重算,任意频率调用
   * 都收敛到同一结果,高频只让窗口边缘更跟手、更平滑。
   */
  function startResizeTimer(): void {
    if (resizeTimer) return
    resizeTimer = setInterval(() => {
      const win = mainWindow
      if (!win || win.isDestroyed() || !win.isVisible() || !resizeState) {
        // 窗口不可见/状态丢失:自愈收尾(不落盘,尺寸未完成)
        stopResize(false)
        return
      }
      applyResize(win, screen.getCursorScreenPoint())
    }, RESIZE_POLL_MS)
  }

  /** 0056b:结束边缘拖拽 —— 停专用循环、清状态;persist=true 时把当前窗口尺寸落盘。 */
  function stopResize(persist: boolean): void {
    if (resizeTimer) {
      clearInterval(resizeTimer)
      resizeTimer = undefined
    }
    if (!resizeState) return
    resizeState = null
    if (persist && mainWindow && !mainWindow.isDestroyed() && config) {
      const b = mainWindow.getBounds()
      config.update({
        windowWidth: clampWindow(b.width, WINDOW_SIZE_MIN.width, WINDOW_SIZE_MAX.width),
        windowHeight: clampWindow(b.height, WINDOW_SIZE_MIN.height, WINDOW_SIZE_MAX.height),
      })
    }
  }

  function startCursorPolling(): void {
    if (cursorTimer) return
    cursorTimer = setInterval(() => {
      const win = mainWindow
      if (!win || win.isDestroyed() || !win.isVisible()) {
        // 不可见时不采样:拖动状态丢失,恢复可见后从零开始(否则旧位置算出一次性大位移)
        prevWindowPos = null
        // 0056:窗口不可见时挂起的 resize 一并收尾(专用循环随后自愈,这里兜底)
        stopResize(false)
        return
      }
      const cursor = screen.getCursorScreenPoint()
      // 0056c:缩放改由专用循环(16ms/60Hz)驱动,不再占用 33ms 视角跟随轮询
      const bounds = win.getBounds()
      const x = cursor.x - bounds.x
      const y = cursor.y - bounds.y
      const inside = x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height

      // 窗口位置增量(px,33ms 采样):拖动中连续非零、静止为 0。
      // 位移 < 1px 视为 0:避免慢速拖动时 ±1px 抖动产生高频微小反馈。
      let dragDx = 0
      let dragDy = 0
      const pos = win.getPosition()
      const posX = pos[0] ?? 0
      const posY = pos[1] ?? 0
      if (prevWindowPos) {
        const dx = posX - prevWindowPos.x
        const dy = posY - prevWindowPos.y
        if (Math.abs(dx) >= 1) dragDx = dx
        if (Math.abs(dy) >= 1) dragDy = dy
      }
      prevWindowPos = { x: posX, y: posY }
      win.webContents.send('pet:cursor', { x, y, inside, dragDx, dragDy })
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

  /** 停止用目标会话解析:显式目标优先;否则最近的非空会话;不新建(停止不该产生会话)。 */
  async function resolveTargetSession(): Promise<SessionId | null> {
    if (!connection) return null
    const listResponse = await connection.api.sessions.list({})
    const list = listResponse.result
    if (!list.ok) return null
    const items = list.value.items
    if (targetSessionId) {
      const chosen = items.find((item) => String(item.sessionId) === targetSessionId)
      if (chosen) return chosen.sessionId
    }
    const first = items.find((item) => !item.blank)
    return first ? first.sessionId : null
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
    // isTargetSession:最近对话浮层只推送目标会话的重要消息摘要(其余会话不推)
    connection = createConnection(onPetEvent, () => config!.get().dsh.baseUrl, (sessionId) => sessionId === targetSessionId)
    connection.start()
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

  /** 0056:窗口尺寸夹取(建窗/配置写入统一收敛;拖拽期间的夹取在 applyResize)。 */
  function clampWindow(n: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)))
  }

  /** IPC 侧配置补丁:只放行白名单字段(renderer 改不了 targetSessionId)。 */
  function sanitizeConfigUpdate(patch: PetConfigUpdate | undefined): PetConfigPatch {
    const out: PetConfigPatch = {}
    if (patch?.dshBaseUrl !== undefined) out.dshBaseUrl = String(patch.dshBaseUrl ?? '')
    if (typeof patch?.opacity === 'number' && Number.isFinite(patch.opacity)) out.opacity = patch.opacity
    // 0056:窗口尺寸只由主进程 resize-end 落盘;renderer 无设置入口,白名单保留以便程序化控制
    if (typeof patch?.windowWidth === 'number' && Number.isFinite(patch.windowWidth)) {
      out.windowWidth = clampWindow(patch.windowWidth, WINDOW_SIZE_MIN.width, WINDOW_SIZE_MAX.width)
    }
    if (typeof patch?.windowHeight === 'number' && Number.isFinite(patch.windowHeight)) {
      out.windowHeight = clampWindow(patch.windowHeight, WINDOW_SIZE_MIN.height, WINDOW_SIZE_MAX.height)
    }
    if (typeof patch?.voiceEnabled === 'boolean') out.voiceEnabled = patch.voiceEnabled
    if (typeof patch?.launchAtLogin === 'boolean') out.launchAtLogin = patch.launchAtLogin
    // 宠物(Live2D)外观/跟随手感(0017):标量 + 范围收敛
    if (typeof patch?.petPositionX === 'number' && Number.isFinite(patch.petPositionX)) out.petPositionX = Math.min(1, Math.max(0, patch.petPositionX))
    if (typeof patch?.petPositionY === 'number' && Number.isFinite(patch.petPositionY)) out.petPositionY = Math.min(1, Math.max(0, patch.petPositionY))
    if (typeof patch?.petScale === 'number' && Number.isFinite(patch.petScale)) out.petScale = Math.min(3, Math.max(0.2, patch.petScale))
    if (typeof patch?.petHeadAmplitude === 'number' && Number.isFinite(patch.petHeadAmplitude)) out.petHeadAmplitude = Math.min(1, Math.max(0, patch.petHeadAmplitude))
    if (typeof patch?.petEyeAmplitude === 'number' && Number.isFinite(patch.petEyeAmplitude)) out.petEyeAmplitude = Math.min(1, Math.max(0, patch.petEyeAmplitude))
    if (typeof patch?.petDeadZone === 'number' && Number.isFinite(patch.petDeadZone)) out.petDeadZone = Math.min(100, Math.max(0, patch.petDeadZone))
    if (typeof patch?.petDistance === 'number' && Number.isFinite(patch.petDistance)) out.petDistance = Math.min(2000, Math.max(20, patch.petDistance))
    if (typeof patch?.petResponse === 'number' && Number.isFinite(patch.petResponse)) out.petResponse = Math.min(5, Math.max(0.2, patch.petResponse))
    // 瞳孔收缩(0029/0030):灵敏度 px/s 收敛 200..2000,幅度 0..1
    if (typeof patch?.petPupilSensitivity === 'number' && Number.isFinite(patch.petPupilSensitivity)) out.petPupilSensitivity = Math.min(2000, Math.max(200, patch.petPupilSensitivity))
    if (typeof patch?.petPupilMax === 'number' && Number.isFinite(patch.petPupilMax)) out.petPupilMax = Math.min(1, Math.max(0, patch.petPupilMax))
    // 拖动反馈强度(0033):0..1
    if (typeof patch?.petDragStrength === 'number' && Number.isFinite(patch.petDragStrength)) out.petDragStrength = Math.min(1, Math.max(0, patch.petDragStrength))
    // 显示点击判定网格(0037):布尔
    if (typeof patch?.petShowHitMesh === 'boolean') out.petShowHitMesh = patch.petShowHitMesh
    // 摸头力度(0037n/0037q):0..8(按住摸头期间的角度灵敏度增益)
    if (typeof patch?.petPatStrength === 'number' && Number.isFinite(patch.petPatStrength)) out.petPatStrength = Math.min(8, Math.max(0, patch.petPatStrength))
    // 思考表情阈值(0039):A 0..600s,B 0.1..600s(A>=B 由 animator 归一,不在此强改)
    if (typeof patch?.petThinkExclaimAfterSec === 'number' && Number.isFinite(patch.petThinkExclaimAfterSec)) out.petThinkExclaimAfterSec = Math.min(600, Math.max(0, patch.petThinkExclaimAfterSec))
    if (typeof patch?.petThinkDizzyAfterSec === 'number' && Number.isFinite(patch.petThinkDizzyAfterSec)) out.petThinkDizzyAfterSec = Math.min(600, Math.max(0.1, patch.petThinkDizzyAfterSec))
    // 入睡阈值(0058):10..86400s(设置面板 min=10,0 由 clamp 兜底到 10 = 最短待机即睡)
    if (typeof patch?.petSleepAfterSec === 'number' && Number.isFinite(patch.petSleepAfterSec)) out.petSleepAfterSec = Math.min(86400, Math.max(10, patch.petSleepAfterSec))
    // 唤醒加速度阈值(0059):500..20000 px/s²
    if (typeof patch?.petWakeAccel === 'number' && Number.isFinite(patch.petWakeAccel)) out.petWakeAccel = Math.min(20000, Math.max(500, patch.petWakeAccel))
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
      () => resolveTargetSession(),
    )

    notifier = createNotifier({
      isWindowVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      isTargetSession: (sessionId) => sessionId !== null && sessionId === targetSessionId,
    })

    ipcMain.handle('pet:get-state', () => handleGetState())
    ipcMain.handle('pet:send-message', (_event, text: string) => handleSendMessage(text))
    // 手动重连:stop 旧连接并立即起新代(中断指数退避),与改地址重建同一路径
    ipcMain.handle('pet:reconnect', () => {
      restartConnection()
      return { label: 'connection.reconnect', ok: true, summary: 'reconnecting' }
    })
    ipcMain.handle('pet:stop-turn', () => petOps?.stopTurn() ?? { label: 'session.cancel', ok: false, summary: 'ops not ready' })
    ipcMain.handle('pet:list-sessions', () => petOps?.listSessions() ?? { ok: false, summary: 'ops not ready', targetSessionId: null, items: [] })
    ipcMain.handle('pet:get-history', (_event, sessionId: string, beforeSeq: number | null, maxMessages: number | null) =>
      petOps?.getHistory(sessionId, beforeSeq, maxMessages) ?? { ok: false, summary: 'ops not ready', sessionId, hasMore: false, entries: [] },
    )
    ipcMain.handle('pet:get-history-summary', (_event, sessionId: string, maxMessages: number | null) =>
      petOps?.getHistorySummary(sessionId, maxMessages) ?? { ok: false, summary: 'ops not ready', sessionId: null, entries: [] },
    )
    ipcMain.handle('pet:select-session', (_event, sessionId: string | null) => petOps?.selectSession(sessionId) ?? { label: 'session.select', ok: false, summary: 'ops not ready' })
    ipcMain.handle('pet:create-session', () => petOps?.createSession() ?? { ok: false, summary: 'ops not ready' })
    ipcMain.handle('pet:respond-approval', (_event, request: PetApprovalRequest) =>
      petOps?.respondApproval(request) ?? { label: 'approval.respond', ok: false, summary: 'ops not ready' },
    )

    // 0056/0057 窗口边缘拖拽调整大小。win32:Electron 原生边缘缩放(创建即
    // resizable:true,0057),renderer 手柄的 IPC 在原生路径下收不到 pointerdown
    // (边缘按下被系统非客户区命中测试吞掉),这里仅作防御性兜底;手势状态由
    // will-resize/resized 驱动(见 createWindow),不在此处理。
    // 非 win32:沿用 0056 手柄 + 专用循环(16ms/60Hz,与显示对齐)锚定对侧边
    // setBounds —— 不占 33ms 视角跟随轮询(0056b/c)。
    ipcMain.handle('pet:resize-start', async (_event, edge: unknown) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const name = String(edge ?? '')
      if (!(RESIZE_EDGES as readonly string[]).includes(name)) return
      const win = mainWindow
      const cursor = screen.getCursorScreenPoint()
      if (process.platform === 'win32') {
        // 防御性兜底:win32 原生缩放已接管,忽略手柄 IPC(实测手柄在此收不到事件)
        console.error(`[pet] resize:win32 已走原生缩放,忽略手柄 IPC(${name})`)
        return
      }
      const bounds = win.getBounds()
      resizeState = {
        edge: name as ResizeEdge,
        startBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        startCursor: { x: cursor.x, y: cursor.y },
      }
      startResizeTimer()
    })
    ipcMain.handle('pet:resize-end', () => {
      // 停专用循环 + 清状态;实际拖拽过才把当前窗口尺寸落盘(重启后保持)。
      // win32 原生路径下 resizeState 恒为空,此处理解为 no-op(尺寸由 resized 落盘)。
      stopResize(true)
    })

    // B3(只读)插件监控:agent 中介读取目标会话插件清单
    pluginOps = createPluginOps({
      getConnection: () => connection,
      getTargetSession: () => ensureTargetSession(),
    })
    ipcMain.handle('pet:list-plugins', () =>
      pluginOps?.listPlugins() ?? { ok: false, summary: 'ops not ready', refreshedAt: 0, plugins: [] },
    )

    // 阶段 5 配置读写:get 返回完整配置;set 应用扁平补丁并按变更执行副作用
    // (DSH 地址变更 → 重建连接;自启 → LoginItem;透明度由 renderer CSS 应用;
    // 窗口尺寸只由边缘拖拽 resize-end 落盘,不在此处理)。
    ipcMain.handle('pet:get-config', () => config?.get() ?? null)
    ipcMain.handle('pet:set-config', (_event, patch: PetConfigUpdate | undefined) => {
      if (!config) return null
      const prev = config.get()
      const next = config.update(sanitizeConfigUpdate(patch))
      if (next.dsh.baseUrl !== prev.dsh.baseUrl) restartConnection()
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
    if (resizeTimer) clearInterval(resizeTimer)
    if (resizeGestureTimer) clearTimeout(resizeGestureTimer)
    connection?.stop()
    bridge?.close()
  })
}
