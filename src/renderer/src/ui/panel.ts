import type { PetActivityEntry, PetApi, PetPluginEntry, PetPluginListResult, PetSessionSummary } from '../../../shared/pet-event.ts'
import type { PetConfigUpdate } from '../../../shared/pet-config.ts'
import type { PendingApproval } from './approvals.ts'
import { conceal, reveal } from './reveal.ts'

export interface PanelHooks {
  /** 审批中心(面板审批 tab 与浮动卡共用)。 */
  approvals: {
    list(): PendingApproval[]
    subscribe(listener: (list: PendingApproval[]) => void): () => void
    respond(item: PendingApproval, outcome: 'allowed-once' | 'rejected'): Promise<void>
  }
  /** B2 雷达:会话活动表(主进程事件增量累积)。 */
  activity: {
    list(): PetActivityEntry[]
    subscribe(listener: (list: PetActivityEntry[]) => void): () => void
  }
  onFlash(text: string, ok: boolean): void
  /** 宠物(Live2D)外观/手感变更(0017):主进程负责落盘并应用到 animator。 */
  onPetSettingsChange?(patch: PetConfigUpdate): void
  /** 有效发送目标(显式目标或自动回退)变化通知:驱动输入条"发送/停止"按钮状态。 */
  onTargetChange?(sessionId: string | null): void
  /** 面板即将展开(互斥):调用方在此收起历史浮层等已展开的浮层。 */
  onOpen?(): void
}

/** 相对时间("刚刚 / 5 分钟前 / 2 小时前 / 8月15日")。 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 应用"背景透明度"(CSS opacity,0..1)—— 只作用于背景**基色画布** #bg-base。
 *
 * 不用 win.setOpacity:透明度 <100% 时 Electron 会把窗口切成分层窗口,
 * DWM 的 acrylic 毛玻璃材质被绕过,背后内容会清晰透出(实测);也不作用于
 * <html> 根元素(透明窗口下根元素 opacity 不生效)。#bg-base 是普通层,
 * opacity 稳定生效:调低背景透明度 → 淡蓝基色画布变透明 → 露出被 acrylic
 * 模糊的桌面背景;蓝色装饰色块(.bg-blob)与宠物/UI 是独立层,保持原样。
 */
function applyBackgroundOpacity(value: number): void {
  const opacity = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1))
  document.querySelector<HTMLElement>('#bg-base')?.style.setProperty('opacity', String(opacity))
}

/** 短标题:优先 projections 标题;空/blank 会话给占位。 */
function shortTitle(session: PetSessionSummary): string {
  if (session.title) return session.title
  if (session.blank) return '(空会话)'
  return `会话 ${session.sessionId.slice(0, 8)}`
}

/**
 * 会话面板:会话列表(切换目标)+ 审批 + 插件 + 设置 tab(历史已并入"点击展开历史"浮层)。
 * vanilla DOM(React/Zustand 待复杂 UI 再引入)。
 */
export function createPanel(api: PetApi, hooks: PanelHooks) {
  const panelEl = document.querySelector<HTMLDivElement>('#panel')
  const btnEl = document.querySelector<HTMLButtonElement>('#btn-panel')
  const sessionsEl = document.querySelector<HTMLDivElement>('#tab-sessions')
  const approvalsEl = document.querySelector<HTMLDivElement>('#tab-approvals')
  const pluginsEl = document.querySelector<HTMLDivElement>('#tab-plugins')
  const settingsEl = document.querySelector<HTMLDivElement>('#tab-settings')
  const badgeEl = document.querySelector<HTMLSpanElement>('#approval-badge')
  /** 会话页运行中角标(B2 雷达并入会话页)。 */
  const runningBadgeEl = document.querySelector<HTMLSpanElement>('#session-running-badge')

  let targetSessionId: string | null = null
  /** 最近一次通知给外部(输入条)的有效目标;去重避免重复回调。 */
  let notifiedTarget: string | null | undefined = undefined
  /** 最近一次会话列表(雷达行基线:标题/running/updatedAt)。 */
  let sessionItems: PetSessionSummary[] = []
  /** B3 插件监控:最近一次查询结果与状态文案。 */
  let lastPluginResult: PetPluginListResult | null = null
  let lastPluginSummary = '未刷新'
  let pluginLoading = false

  function switchTab(name: 'sessions' | 'approvals' | 'plugins' | 'settings'): void {
    document.querySelectorAll<HTMLButtonElement>('#panel .panel-tabs button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset['tab'] === name)
    })
    sessionsEl?.classList.toggle('active', name === 'sessions')
    approvalsEl?.classList.toggle('active', name === 'approvals')
    pluginsEl?.classList.toggle('active', name === 'plugins')
    settingsEl?.classList.toggle('active', name === 'settings')
    if (name === 'approvals') renderApprovals()
    if (name === 'plugins') renderPlugins()
    if (name === 'settings') void refreshSettings()
  }

  function toggle(): void {
    if (!panelEl) return
    const show = panelEl.classList.contains('hidden')
    if (show) {
      // 互斥:面板展开时收起历史浮层(由调用方经 hooks.onOpen 处理)
      hooks.onOpen?.()
      void refreshSessions()
      renderApprovals()
      if (settingsEl?.classList.contains('active')) void refreshSettings()
      reveal(panelEl)
    } else {
      conceal(panelEl)
    }
  }

  /** 面板是否处于展开状态(供外部互斥判断)。 */
  function isOpen(): boolean {
    return panelEl !== null && !panelEl.classList.contains('hidden')
  }

  /** 收起面板(若展开;conceal 内部对已隐藏元素为空操作)。 */
  function close(): void {
    if (panelEl) conceal(panelEl)
  }

  async function refreshSessions(): Promise<PetSessionSummary[] | null> {
    const result = await api.listSessions()
    if (!result.ok) {
      hooks.onFlash(`✗ 会话列表:${result.summary}`, false)
      return null
    }
    targetSessionId = result.targetSessionId
    sessionItems = result.items
    renderSessions(result.items)
    updateRunningBadge()
    return result.items
  }

  /**
   * 目标会话解析:显式目标优先;未选时回退"最近更新的非空会话"(与主进程
   * ensureTargetSession 一致)。返回目标会话 id,无可用会话时为 null。
   */
  function resolveTarget(items: PetSessionSummary[]): string | null {
    const explicit = targetSessionId ? items.find((item) => item.sessionId === targetSessionId) : undefined
    if (explicit) return explicit.sessionId
    const fallback = items.find((item) => !item.blank)
    return fallback?.sessionId ?? null
  }

  /** 会话页:顶部"新建会话"按钮(继承目标会话的工作目录/模式/权限)+ 会话列表(含实时状态)。 */
  function renderSessions(items: PetSessionSummary[]): void {
    if (!sessionsEl) return
    sessionsEl.textContent = ''
    const target = resolveTarget(items)
    // 有效目标(显式或自动回退)变化 → 通知输入条刷新"发送/停止"按钮
    const effectiveId = target
    if (effectiveId !== notifiedTarget) {
      notifiedTarget = effectiveId
      hooks.onTargetChange?.(effectiveId)
    }
    // B2 实时状态:活动表(回合增量)叠加在列表基线上
    const activity = new Map(hooks.activity.list().map((e) => [e.sessionId, e]))

    // 顶部新建按钮:新建会话继承当前"目标"会话的工作目录 / 模式 / 权限
    const createBtn = document.createElement('button')
    createBtn.className = 'panel-btn'
    createBtn.textContent = '＋ 新建会话'
    createBtn.addEventListener('click', () => void createSession())
    sessionsEl.appendChild(createBtn)

    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'session-row'
      if (item.sessionId === target) row.classList.add('selected')
      const dot = document.createElement('span')
      // 实时状态(活动表)与列表基线取并集:任一 running 即脉冲绿点
      const act = activity.get(item.sessionId)
      const isRunning = item.running || act?.running === true
      dot.className = `dot${isRunning ? ' running' : ''}`
      const title = document.createElement('span')
      title.className = 'title'
      title.textContent = shortTitle(item)
      title.title = item.sessionId
      // 状态列:运行中 > 最近回合结果(带时间)> 基线更新时间
      const status = document.createElement('span')
      status.className = 'session-status'
      if (isRunning) {
        status.textContent = '● 运行中'
        status.classList.add('running')
      } else if (act?.reason) {
        status.textContent = `${reasonText(act.reason)} · ${relativeTime(act.time)}`
      } else {
        status.textContent = relativeTime(item.updatedAt)
      }
      row.append(dot, title, status)
      if (item.sessionId === target) {
        const tag = document.createElement('span')
        tag.className = 'target-tag'
        tag.textContent = '目标'
        row.appendChild(tag)
      }
      row.addEventListener('click', () => void selectSession(item.sessionId))
      sessionsEl.appendChild(row)
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    const result = await api.selectSession(sessionId)
    if (!result.ok) {
      hooks.onFlash(`✗ 切换会话:${result.summary}`, false)
      return
    }
    targetSessionId = sessionId
    // 只把该会话设为目标,停留在会话页(选中标记/徽标由 refreshSessions 同步更新)
    await refreshSessions()
  }

  async function createSession(): Promise<void> {
    const result = await api.createSession()
    if (!result.ok || !result.sessionId) {
      hooks.onFlash(`✗ 新建会话:${result.summary}`, false)
      return
    }
    hooks.onFlash(`✅ ${result.summary}`, true)
    await refreshSessions()
  }

  function renderApprovals(): void {
    if (!approvalsEl) return
    approvalsEl.textContent = ''
    const list = hooks.approvals.list()
    if (list.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'history-row meta'
      empty.textContent = '暂无待审批'
      approvalsEl.appendChild(empty)
      return
    }
    for (const item of list) {
      const card = document.createElement('div')
      card.className = 'history-row tool'
      card.textContent = `🔐 ${item.toolName}${item.reason ? ` — ${item.reason}` : ''}`
      const actions = document.createElement('div')
      actions.className = 'approval-actions'
      const allowBtn = document.createElement('button')
      allowBtn.className = 'approval-allow-btn'
      allowBtn.textContent = '允许'
      allowBtn.addEventListener('click', () => void hooks.approvals.respond(item, 'allowed-once'))
      const rejectBtn = document.createElement('button')
      rejectBtn.className = 'approval-reject-btn'
      rejectBtn.textContent = '拒绝'
      rejectBtn.addEventListener('click', () => void hooks.approvals.respond(item, 'rejected'))
      actions.append(allowBtn, rejectBtn)
      card.appendChild(actions)
      approvalsEl.appendChild(card)
    }
  }

  // ---- 设置 tab(阶段 5:DSH 地址 / 外观 / 自启 / 语音开关)----
  const urlInput = document.querySelector<HTMLInputElement>('#set-dsh-url')
  const urlApplyBtn = document.querySelector<HTMLButtonElement>('#set-dsh-apply')
  const opacitySlider = document.querySelector<HTMLInputElement>('#set-opacity')
  const opacityVal = document.querySelector<HTMLSpanElement>('#set-opacity-val')
  const autostartCheck = document.querySelector<HTMLInputElement>('#set-autostart')
  const voiceCheck = document.querySelector<HTMLInputElement>('#set-voice')

  /** 从主进程拉最新配置并回填控件(输入框正在编辑时跳过,避免打断输入)。 */
  async function refreshSettings(): Promise<void> {
    if (!settingsEl) return
    let cfg: Awaited<ReturnType<PetApi['getConfig']>>
    try {
      cfg = await api.getConfig()
    } catch {
      return
    }
    // 输入框/滑块正在交互时不回填,避免打断用户输入
    if (urlInput && document.activeElement !== urlInput) urlInput.value = cfg.dsh.baseUrl
    if (opacitySlider && document.activeElement !== opacitySlider) opacitySlider.value = String(Math.round(cfg.appearance.opacity * 100))
    if (opacityVal) opacityVal.textContent = `${Math.round(cfg.appearance.opacity * 100)}%`
    // 应用持久化的背景透明度(CSS opacity 作用于 #bg;win.setOpacity 会破坏 acrylic 毛玻璃)
    applyBackgroundOpacity(cfg.appearance.opacity)
    if (autostartCheck) autostartCheck.checked = cfg.launchAtLogin
    if (voiceCheck) voiceCheck.checked = cfg.voice.enabled
    // 宠物(Live2D)外观/手感
    const p = cfg.pet
    if (petX && document.activeElement !== petX) petX.value = String(Math.round(p.positionX * 100))
    if (petY && document.activeElement !== petY) petY.value = String(Math.round(p.positionY * 100))
    if (petScale && document.activeElement !== petScale) petScale.value = String(Math.round(p.scale * 100))
    if (petHead && document.activeElement !== petHead) petHead.value = String(Math.round(p.headAmplitude * 100))
    if (petEye && document.activeElement !== petEye) petEye.value = String(Math.round(p.eyeAmplitude * 100))
    if (petPupilSensitivity && document.activeElement !== petPupilSensitivity) petPupilSensitivity.value = String(Math.round(p.pupilSensitivity))
    if (petPupilMax && document.activeElement !== petPupilMax) petPupilMax.value = String(Math.round(p.pupilMax * 100))
    if (petDeadZone && document.activeElement !== petDeadZone) petDeadZone.value = String(Math.round(p.deadZone))
    if (petDistance && document.activeElement !== petDistance) petDistance.value = String(Math.round(p.distance))
    if (petResponse && document.activeElement !== petResponse) petResponse.value = String(Math.round(p.response * 100))
    if (petDrag && document.activeElement !== petDrag) petDrag.value = String(Math.round(p.dragStrength * 100))
    if (petPatStrength && document.activeElement !== petPatStrength) petPatStrength.value = String(Math.round(p.patStrength * 100))
    if (petShowHitMesh) petShowHitMesh.checked = p.showHitMesh
    // 思考表情阈值(0039):输入框正在编辑时不回填,避免打断输入
    if (thinkAInput && document.activeElement !== thinkAInput) thinkAInput.value = String(p.thinkExclaimAfterSec)
    if (thinkBInput && document.activeElement !== thinkBInput) thinkBInput.value = String(p.thinkDizzyAfterSec)
    // 入睡阈值(0058):输入框正在编辑时不回填,避免打断输入
    if (sleepAfterInput && document.activeElement !== sleepAfterInput) sleepAfterInput.value = String(p.sleepAfterSec)
    // 唤醒加速度阈值(0059):输入框正在编辑时不回填,避免打断输入
    if (wakeAccelInput && document.activeElement !== wakeAccelInput) wakeAccelInput.value = String(p.wakeAccel)
    refreshPetLabels()
  }

  // 背景透明度滑块:实时预览,拖动停顿 120ms 才落盘一次(只动 #bg 的 CSS opacity,无反馈回路)。
  // 不用 win.setOpacity —— 那会破坏 acrylic 毛玻璃,见 main/index.ts。
  let opacityTimer: ReturnType<typeof setTimeout> | undefined
  function debounceOpacity(value: number): void {
    if (opacityTimer) clearTimeout(opacityTimer)
    opacityTimer = setTimeout(() => {
      void api.setConfig({ opacity: value }).then((cfg) => {
        if (opacityVal) opacityVal.textContent = `${Math.round(cfg.appearance.opacity * 100)}%`
      })
    }, 120)
  }

  urlApplyBtn?.addEventListener('click', () => {
    const value = urlInput?.value.trim() ?? ''
    if (!value) return
    void api.setConfig({ dshBaseUrl: value }).then((cfg) => {
      hooks.onFlash(`✅ DSH 地址 → ${cfg.dsh.baseUrl}`, true)
      if (urlInput) urlInput.value = cfg.dsh.baseUrl
    })
  })
  opacitySlider?.addEventListener('input', () => {
    if (!opacitySlider) return
    if (opacityVal) opacityVal.textContent = `${opacitySlider.value}%`
    applyBackgroundOpacity(Number(opacitySlider.value) / 100)
    debounceOpacity(Number(opacitySlider.value) / 100)
  })
  // 0056:"窗口缩放"滑块已移除 —— 窗口大小只由拖拽窗口边缘/四角调整并自动保存
  autostartCheck?.addEventListener('change', () => {
    if (!autostartCheck) return
    void api.setConfig({ launchAtLogin: autostartCheck.checked }).then((cfg) => {
      hooks.onFlash(cfg.launchAtLogin ? '🚀 已开启开机自启' : '已关闭开机自启', true)
    })
  })
  voiceCheck?.addEventListener('change', () => {
    if (!voiceCheck) return
    void api.setConfig({ voiceEnabled: voiceCheck.checked }).then((cfg) => {
      hooks.onFlash(cfg.voice.enabled ? '🔊 语音已开启(阶段 6 生效)' : '🔇 语音已关闭', true)
    })
  })

  // ---- 宠物(Live2D)外观/手感(0017):拖动实时应用 + 120ms 防抖落盘 ----
  const petX = document.querySelector<HTMLInputElement>('#pet-x')
  const petXVal = document.querySelector<HTMLSpanElement>('#pet-x-val')
  const petY = document.querySelector<HTMLInputElement>('#pet-y')
  const petYVal = document.querySelector<HTMLSpanElement>('#pet-y-val')
  const petScale = document.querySelector<HTMLInputElement>('#pet-scale')
  const petScaleVal = document.querySelector<HTMLSpanElement>('#pet-scale-val')
  const petHead = document.querySelector<HTMLInputElement>('#pet-head')
  const petHeadVal = document.querySelector<HTMLSpanElement>('#pet-head-val')
  const petEye = document.querySelector<HTMLInputElement>('#pet-eye')
  const petEyeVal = document.querySelector<HTMLSpanElement>('#pet-eye-val')
  const petPupilSensitivity = document.querySelector<HTMLInputElement>('#pet-pupil-sensitivity')
  const petPupilSensitivityVal = document.querySelector<HTMLSpanElement>('#pet-pupil-sensitivity-val')
  const petPupilMax = document.querySelector<HTMLInputElement>('#pet-pupil-max')
  const petPupilMaxVal = document.querySelector<HTMLSpanElement>('#pet-pupil-max-val')
  const petDeadZone = document.querySelector<HTMLInputElement>('#pet-deadzone')
  const petDeadZoneVal = document.querySelector<HTMLSpanElement>('#pet-deadzone-val')
  const petDistance = document.querySelector<HTMLInputElement>('#pet-distance')
  const petDistanceVal = document.querySelector<HTMLSpanElement>('#pet-distance-val')
  const petResponse = document.querySelector<HTMLInputElement>('#pet-response')
  const petResponseVal = document.querySelector<HTMLSpanElement>('#pet-response-val')
  const petDrag = document.querySelector<HTMLInputElement>('#pet-drag')
  const petDragVal = document.querySelector<HTMLSpanElement>('#pet-drag-val')
  const petPatStrength = document.querySelector<HTMLInputElement>('#pet-pat-strength')
  const petPatStrengthVal = document.querySelector<HTMLSpanElement>('#pet-pat-strength-val')
  const petShowHitMesh = document.querySelector<HTMLInputElement>('#pet-show-hitmesh')
  // 思考表情阈值(0039):数字输入,秒;change 时落盘(见下方事件绑定)
  const thinkAInput = document.querySelector<HTMLInputElement>('#set-think-a')
  const thinkBInput = document.querySelector<HTMLInputElement>('#set-think-b')
  // 入睡阈值(0058):数字输入,秒;change 时落盘(见下方事件绑定)
  const sleepAfterInput = document.querySelector<HTMLInputElement>('#set-sleep-after')
  // 唤醒加速度阈值(0059):数字输入,px/s²;change 时落盘(见下方事件绑定)
  const wakeAccelInput = document.querySelector<HTMLInputElement>('#set-wake-accel')
  const petSliders: Array<HTMLInputElement | null> = [petX, petY, petScale, petHead, petEye, petPupilSensitivity, petPupilMax, petDeadZone, petDistance, petResponse, petDrag, petPatStrength]

  /** 从滑块值构造宠物设置补丁(扁平 pet* 键,全量 11 项 + 网格开关)。 */
  function petPatchFromSliders(): PetConfigUpdate {
    const num = (el: HTMLInputElement | null): number => (el ? Number(el.value) : 0)
    return {
      petPositionX: num(petX) / 100,
      petPositionY: num(petY) / 100,
      petScale: num(petScale) / 100,
      petHeadAmplitude: num(petHead) / 100,
      petEyeAmplitude: num(petEye) / 100,
      petPupilSensitivity: num(petPupilSensitivity),
      petPupilMax: num(petPupilMax) / 100,
      petDeadZone: num(petDeadZone),
      petDistance: num(petDistance),
      petResponse: num(petResponse) / 100,
      petDragStrength: num(petDrag) / 100,
      petShowHitMesh: petShowHitMesh?.checked ?? false,
      petPatStrength: num(petPatStrength) / 100,
    }
  }

  function refreshPetLabels(): void {
    if (petXVal) petXVal.textContent = `${petX?.value ?? '0'}%`
    if (petYVal) petYVal.textContent = `${petY?.value ?? '0'}%`
    if (petScaleVal) petScaleVal.textContent = `${petScale?.value ?? '0'}%`
    if (petHeadVal) petHeadVal.textContent = `${petHead?.value ?? '0'}%`
    if (petEyeVal) petEyeVal.textContent = `${petEye?.value ?? '0'}%`
    if (petPupilSensitivityVal) petPupilSensitivityVal.textContent = `${petPupilSensitivity?.value ?? '0'}px/s`
    if (petPupilMaxVal) petPupilMaxVal.textContent = `${petPupilMax?.value ?? '0'}%`
    if (petDeadZoneVal) petDeadZoneVal.textContent = `${petDeadZone?.value ?? '0'}px`
    if (petDistanceVal) petDistanceVal.textContent = `${petDistance?.value ?? '0'}px`
    if (petResponseVal) petResponseVal.textContent = `${petResponse?.value ?? '0'}%`
    if (petDragVal) petDragVal.textContent = `${petDrag?.value ?? '0'}%`
    if (petPatStrengthVal) petPatStrengthVal.textContent = `${petPatStrength?.value ?? '0'}%`
  }

  let petTimer: ReturnType<typeof setTimeout> | undefined
  function debouncePetSettings(): void {
    if (petTimer) clearTimeout(petTimer)
    petTimer = setTimeout(() => {
      hooks.onPetSettingsChange?.(petPatchFromSliders())
    }, 120)
  }
  for (const el of petSliders) {
    el?.addEventListener('input', () => {
      refreshPetLabels()
      debouncePetSettings()
    })
  }
  // 点击判定网格开关:即时应用并落盘(与其他宠物设置一致走防抖)
  petShowHitMesh?.addEventListener('change', () => {
    hooks.onPetSettingsChange?.({ petShowHitMesh: petShowHitMesh.checked })
  })
  // 思考表情阈值(0039):数字输入,change(失焦/回车)时应用并落盘,clamp 与主进程一致
  thinkAInput?.addEventListener('change', () => {
    const a = Number(thinkAInput?.value)
    if (!Number.isFinite(a)) return
    hooks.onPetSettingsChange?.({ petThinkExclaimAfterSec: Math.min(600, Math.max(0, a)) })
  })
  thinkBInput?.addEventListener('change', () => {
    const b = Number(thinkBInput?.value)
    if (!Number.isFinite(b)) return
    hooks.onPetSettingsChange?.({ petThinkDizzyAfterSec: Math.min(600, Math.max(0.1, b)) })
  })
  // 入睡阈值(0058):数字输入,change(失焦/回车)时应用并落盘,clamp 与主进程一致
  sleepAfterInput?.addEventListener('change', () => {
    const s = Number(sleepAfterInput?.value)
    if (!Number.isFinite(s)) return
    hooks.onPetSettingsChange?.({ petSleepAfterSec: Math.min(86400, Math.max(10, s)) })
  })
  // 唤醒加速度阈值(0059):数字输入,change(失焦/回车)时应用并落盘,clamp 与主进程一致
  wakeAccelInput?.addEventListener('change', () => {
    const a = Number(wakeAccelInput?.value)
    if (!Number.isFinite(a)) return
    hooks.onPetSettingsChange?.({ petWakeAccel: Math.min(20000, Math.max(500, a)) })
  })

  // ---- B2 雷达 tab:全会话活动(运行中/完成/出错),点击设目标 ----

  /** turn reason → 展示文本。 */
  function reasonText(reason: string): string {
    switch (reason) {
      case 'completed':
        return '✓ 完成'
      case 'error':
        return '✗ 出错'
      case 'max-tokens':
        return '✗ 超长'
      case 'aborted':
        return '■ 中断'
      case 'blocked':
        return '⛔ 阻塞'
      default:
        return reason
    }
  }

  /** 运行中会话数 = 活动表 running ∪ 会话列表 running;驱动会话页角标。 */
  function runningCount(): number {
    const activityRunning = new Set(hooks.activity.list().filter((e) => e.running).map((e) => e.sessionId))
    for (const s of sessionItems) {
      if (s.running) activityRunning.add(s.sessionId)
    }
    return activityRunning.size
  }

  /** 会话 tab 角标:同时在跑的会话数。 */
  function updateRunningBadge(): void {
    if (!runningBadgeEl) return
    const n = runningCount()
    runningBadgeEl.textContent = String(n)
    runningBadgeEl.classList.toggle('hidden', n === 0)
  }

  // ---- B3 只读插件监控 tab:agent 中介读目标会话插件清单 ----

  /** 插件 id / packageId 过长时截断展示。 */
  function shortId(id: string): string {
    return id.length > 20 ? `${id.slice(0, 18)}…` : id
  }

  /** 一张插件卡:id + 状态 + 元信息 + 可折叠原始 JSON。 */
  function pluginCard(p: PetPluginEntry): HTMLElement {
    const card = document.createElement('div')
    card.className = 'plugin-card'
    const head = document.createElement('div')
    head.className = 'plugin-head'
    const id = document.createElement('span')
    id.className = 'plugin-id'
    id.textContent = p.pluginId
    const state = document.createElement('span')
    state.className = `plugin-state ${p.state}`
    state.textContent = p.state
    head.append(id, state)
    card.appendChild(head)
    if (p.name) {
      const name = document.createElement('div')
      name.className = 'plugin-name'
      name.textContent = p.name
      card.appendChild(name)
    }
    const meta = document.createElement('div')
    meta.className = 'plugin-meta'
    const bits: string[] = [`packages: ${p.packageCount}`]
    if (p.currentPackageId) bits.push(`current: ${shortId(p.currentPackageId)}`)
    if (p.nextPackageId) bits.push(`next: ${shortId(p.nextPackageId)}`)
    if (p.activeRun) bits.push(`run: ${shortId(p.activeRun.packageId)}`)
    if (p.pendingApproval) bits.push('⏳ 待审批')
    meta.textContent = bits.join(' · ')
    card.appendChild(meta)
    const raw = document.createElement('details')
    raw.className = 'plugin-raw'
    const summary = document.createElement('summary')
    summary.textContent = '原始 JSON'
    const pre = document.createElement('pre')
    pre.textContent = p.raw
    raw.append(summary, pre)
    card.appendChild(raw)
    return card
  }

  function renderPlugins(): void {
    if (!pluginsEl) return
    pluginsEl.textContent = ''
    const toolbar = document.createElement('div')
    toolbar.className = 'plugin-toolbar'
    const refreshBtn = document.createElement('button')
    refreshBtn.className = 'setting-apply'
    refreshBtn.textContent = '🔄 刷新'
    refreshBtn.disabled = pluginLoading
    refreshBtn.addEventListener('click', () => void refreshPlugins())
    const hint = document.createElement('span')
    hint.className = 'plugin-hint'
    hint.textContent = '只读监控 · 完整管理(define/run/stop)待 DSH 原生 API'
    toolbar.append(refreshBtn, hint)
    pluginsEl.appendChild(toolbar)

    if (pluginLoading) {
      const loading = document.createElement('div')
      loading.className = 'history-row meta'
      loading.textContent = '查询中…(占用一次模型回合,请稍候)'
      pluginsEl.appendChild(loading)
      return
    }
    const status = document.createElement('div')
    status.className = 'plugin-status'
    status.textContent = lastPluginSummary
    pluginsEl.appendChild(status)

    if (!lastPluginResult) return
    if (!lastPluginResult.ok) {
      const err = document.createElement('div')
      err.className = 'plugin-error'
      err.textContent = `✗ ${lastPluginResult.summary}`
      pluginsEl.appendChild(err)
      if (lastPluginResult.rawReply) {
        const raw = document.createElement('details')
        raw.className = 'plugin-raw'
        const summary = document.createElement('summary')
        summary.textContent = 'agent 原始回复'
        const pre = document.createElement('pre')
        pre.textContent = lastPluginResult.rawReply
        raw.append(summary, pre)
        pluginsEl.appendChild(raw)
      }
      return
    }
    if (lastPluginResult.plugins.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'history-row meta'
      empty.textContent = '（该会话暂无动态插件）'
      pluginsEl.appendChild(empty)
      return
    }
    for (const p of lastPluginResult.plugins) pluginsEl.appendChild(pluginCard(p))
  }

  async function refreshPlugins(): Promise<void> {
    if (pluginLoading) return
    pluginLoading = true
    lastPluginSummary = '查询中…'
    renderPlugins()
    try {
      const result = await api.listPlugins()
      lastPluginResult = result
      lastPluginSummary = result.ok
        ? `刷新于 ${new Date(result.refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${result.summary}`
        : result.summary
    } catch (error) {
      lastPluginResult = { ok: false, summary: String(error), refreshedAt: 0, plugins: [] }
      lastPluginSummary = '查询失败'
    } finally {
      pluginLoading = false
      renderPlugins()
    }
  }

  // 活动增量(B2 雷达并入会话页):角标实时更新;会话页开着时整页重渲染(实时状态列)
  hooks.activity.subscribe(() => {
    updateRunningBadge()
    if (sessionsEl?.classList.contains('active') && sessionItems.length > 0) renderSessions(sessionItems)
  })

  // 审批角标
  hooks.approvals.subscribe((list) => {
    if (!badgeEl) return
    badgeEl.textContent = String(list.length)
    badgeEl.classList.toggle('hidden', list.length === 0)
    if (approvalsEl?.classList.contains('active')) renderApprovals()
  })

  btnEl?.addEventListener('click', toggle)
  document.querySelectorAll<HTMLButtonElement>('#panel .panel-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset['tab'] as 'sessions' | 'approvals' | 'plugins' | 'settings'))
  })

  return { toggle, close, isOpen, refreshSessions }
}
