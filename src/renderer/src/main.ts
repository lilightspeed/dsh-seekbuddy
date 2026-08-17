import { createActor } from 'xstate'
import type { PetActivityEntry, PetApi, PetEvent } from '../../shared/pet-event.ts'
import { petMachine, type PetState } from './fsm/pet-machine.ts'
import type { PetAnimator } from './pet/animator.ts'
import { createLive2dAnimator } from './pet/live2d/create-live2d-animator.ts'
import { createStage } from './pet/stage.ts'
import { createApprovalCenter, type PendingApproval } from './ui/approvals.ts'
import { createPanel } from './ui/panel.ts'

declare global {
  interface Window {
    petApi?: PetApi
  }
}

const api = window.petApi
const statusEl = document.querySelector<HTMLDivElement>('#status')
const bubbleEl = document.querySelector<HTMLDivElement>('#bubble')
const inputEl = document.querySelector<HTMLTextAreaElement>('#msg-input')
const sendBtn = document.querySelector<HTMLButtonElement>('#btn-send')
// 浮动审批卡
const approvalCardEl = document.querySelector<HTMLDivElement>('#approval-card')
const approvalToolEl = document.querySelector<HTMLDivElement>('#approval-tool')
const approvalReasonEl = document.querySelector<HTMLDivElement>('#approval-reason')
const approvalAllowBtn = document.querySelector<HTMLButtonElement>('#approval-allow')
const approvalRejectBtn = document.querySelector<HTMLButtonElement>('#approval-reject')

let bubbleTimer: ReturnType<typeof setTimeout> | undefined
let connText = 'connecting'
let petText = ''
/** 当前浮动卡显示的审批条目。 */
let cardApproval: PendingApproval | null = null
/** 当前有效发送目标(显式选择或自动回退;由面板回调同步)。 */
let targetSessionId: string | null = null
/** 运行中的会话集合(dsh:session-update 增量维护;列表快照播种)。 */
const runningSessions = new Set<string>()

/** 目标会话是否运行中:驱动"发送/停止"按钮。 */
function isTargetRunning(): boolean {
  return targetSessionId !== null && runningSessions.has(targetSessionId)
}

/** 发送按钮:目标会话运行中 → 红色"停止",否则蓝色"发送"。 */
function renderSendButton(): void {
  if (!sendBtn) return
  const running = isTargetRunning()
  sendBtn.textContent = running ? '停止' : '发送'
  sendBtn.classList.toggle('stop', running)
}

/**
 * 多行输入自动增高:先复位再按内容撑高;CSS max-height 封顶后转为内部滚动。
 * 测量期间临时隐藏垂直滚动条:避免"滚动条出现 → 宽度变窄 → 文本多换一行 →
 * scrollHeight 虚高 → 高度又被撑大"的循环,导致删除内容后空行不消失。
 */
function autoGrowInput(): void {
  if (!inputEl) return
  const prev = inputEl.style.overflowY
  inputEl.style.overflowY = 'hidden'
  inputEl.style.height = 'auto'
  inputEl.style.height = `${inputEl.scrollHeight}px`
  inputEl.style.overflowY = prev
}

/** 用会话列表的 running 快照补充运行中集合(覆盖"连接时回合已在跑"的情形)。 */
function seedRunningSessions(): void {
  void api?.listSessions().then((result) => {
    if (!result.ok) return
    for (const item of result.items) {
      if (item.running) runningSessions.add(item.sessionId)
    }
    renderSendButton()
  })
}

function renderStatus(): void {
  if (statusEl) statusEl.textContent = `${connText}${petText ? ` · pet: ${petText}` : ''}`
}

/** 气泡:显示 text,visibleMs 后自动隐藏。 */
function showBubble(text: string, visibleMs = 3000): void {
  if (!bubbleEl) return
  bubbleEl.textContent = text
  bubbleEl.classList.add('visible')
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => bubbleEl?.classList.remove('visible'), visibleMs)
}

/** 浮动审批卡:显示最新一条待审批;无待审批则隐藏。 */
function renderApprovalCard(list: PendingApproval[]): void {
  cardApproval = list[0] ?? null
  if (!approvalCardEl) return
  if (!cardApproval) {
    approvalCardEl.classList.add('hidden')
    return
  }
  if (approvalToolEl) approvalToolEl.textContent = cardApproval.toolName
  if (approvalReasonEl) approvalReasonEl.textContent = cardApproval.reason ?? cardApproval.sessionId
  approvalCardEl.classList.remove('hidden')
}

/** B2 多会话雷达:内存活动表,由 dsh:session-update 增量累积;订阅者拿快照。 */
type ActivityListener = (list: PetActivityEntry[]) => void
function createActivityStore(): {
  update(entry: PetActivityEntry): void
  clear(): void
  list(): PetActivityEntry[]
  subscribe(listener: ActivityListener): () => void
} {
  const map = new Map<string, PetActivityEntry>()
  const listeners = new Set<ActivityListener>()
  function emit(): void {
    const list = [...map.values()]
    for (const listener of listeners) listener(list)
  }
  return {
    update(entry: PetActivityEntry): void {
      const prev = map.get(entry.sessionId)
      if (prev && prev.running === entry.running && prev.reason === entry.reason && prev.time === entry.time) return
      map.set(entry.sessionId, entry)
      emit()
    },
    clear(): void {
      map.clear()
      emit()
    },
    list: () => [...map.values()],
    subscribe(listener: ActivityListener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

async function boot(): Promise<void> {
  if (!api) {
    connText = 'preload 未注入 window.petApi'
    renderStatus()
    return
  }

  // 舞台 + 动画后端(Live2D 优先,未接入 SDK 时回落占位球宠) + 状态机
  const stage = await createStage()
  const animator: PetAnimator = createLive2dAnimator(stage)

  // 启动即应用持久化的宠物外观/手感(位置/大小/跟随)与窗口透明度
  // (透明度用 CSS opacity,win.setOpacity 会破坏 acrylic 毛玻璃,见 main/index.ts)
  void api.getConfig().then((cfg) => {
    animator.applyPetSettings?.(cfg.pet)
    document.documentElement.style.opacity = String(Math.min(1, Math.max(0.3, cfg.appearance.opacity)))
  })
  const actor = createActor(petMachine)
  actor.subscribe((snapshot) => {
    petText = snapshot.value as PetState
    renderStatus()
    animator.play(snapshot.value as PetState)
  })
  actor.start()

  // 每帧驱动动画
  stage.app.ticker.add(() => animator.tick(stage.app.ticker.deltaMS / 1000))

  // 审批中心(浮动卡 + 面板角标共用)
  const approvals = createApprovalCenter(api, {
    onFlash: (text, ok) => {
      if (ok) {
        actor.send({ type: 'TALK' })
        showBubble(text, 2200)
      } else {
        actor.send({ type: 'DSH_ERROR' })
        showBubble(text, 3500)
      }
    },
    onCountChange: () => {
      renderApprovalCard(approvals.list())
    },
  })
  approvals.subscribe(renderApprovalCard)

  // B2 多会话雷达:活动表 + 面板订阅
  const activity = createActivityStore()

  // 会话面板(会话列表/切换 + 历史 + 审批 + 雷达 + 设置 tab)
  const panel = createPanel(api, {
    approvals: {
      list: () => approvals.list(),
      subscribe: (listener) => approvals.subscribe(listener),
      respond: (item, outcome) => approvals.respond(item, outcome),
    },
    activity: {
      list: () => activity.list(),
      subscribe: (listener) => activity.subscribe(listener),
    },
    onFlash: (text, ok) => {
      if (ok) {
        actor.send({ type: 'TALK' })
        showBubble(text, 2200)
      } else {
        actor.send({ type: 'DSH_ERROR' })
        showBubble(text, 3500)
      }
    },
    // 宠物设置变更:主进程落盘后,把新配置应用给 animator(实时生效)
    onPetSettingsChange: (patch) => {
      void api.setConfig(patch).then((cfg) => {
        animator.applyPetSettings?.(cfg.pet)
      })
    },
    // 有效发送目标(显式或自动回退)变化 → 刷新"发送/停止"按钮
    onTargetChange: (id) => {
      targetSessionId = id
      renderSendButton()
    },
  })
  void panel

  // 浮动卡按钮 → 审批中心
  approvalAllowBtn?.addEventListener('click', () => {
    if (cardApproval) void approvals.respond(cardApproval, 'allowed-once')
  })
  approvalRejectBtn?.addEventListener('click', () => {
    if (cardApproval) void approvals.respond(cardApproval, 'rejected')
  })

  // DSH 事件 → 状态机事件 + 气泡 + 审批
  api.onPetEvent((event: PetEvent) => {
    switch (event.type) {
      case 'dsh:connected':
        connText = 'connected'
        renderStatus()
        // 重连后会话列表可能变化,刷新面板;雷达活动表清空重建(旧代事件已过期)
        activity.clear()
        // 运行中集合同样进入新代:清空后用会话列表快照播种(覆盖"连接时已在跑"的回合)
        runningSessions.clear()
        seedRunningSessions()
        void panel.refreshSessions()
        break
      case 'dsh:state':
        connText = event.state
        renderStatus()
        break
      case 'dsh:turn-start':
        actor.send({ type: 'DSH_WORKING' })
        break
      case 'dsh:turn-end':
        if (event.reason === 'error' || event.reason === 'max-tokens' || event.reason === 'blocked') {
          actor.send({ type: 'DSH_ERROR' })
          showBubble(`✗ 回合异常:${event.reason}`, 3500)
        } else {
          actor.send({ type: 'DSH_DONE' })
          showBubble('✓ 完成', 2500)
        }
        break
      case 'approval:pending':
        approvals.add(event)
        actor.send({ type: 'TALK' })
        showBubble(`🔐 需要审批:${event.toolName}`, 4000)
        break
      case 'approval:resolved':
        approvals.removeByApprovalId(event.approvalId)
        if (event.outcome === 'allowed-once') {
          actor.send({ type: 'TALK' })
          showBubble('✅ 已允许', 2000)
        } else if (event.outcome === 'rejected') {
          actor.send({ type: 'TALK' })
          showBubble('⛔ 已拒绝', 2000)
        }
        break
      case 'agent:error':
        actor.send({ type: 'DSH_ERROR' })
        showBubble(`✗ DSH 报错:${event.message}`, 4000)
        break
      case 'dsh:session-update':
        // B2 雷达:增量进活动表,雷达 tab 订阅后自行渲染
        activity.update(event)
        // 运行中集合增量维护,驱动"发送/停止"按钮
        if (event.running) runningSessions.add(event.sessionId)
        else runningSessions.delete(event.sessionId)
        renderSendButton()
        break
      case 'pet:speak':
        actor.send({ type: 'TALK' })
        showBubble(event.text, 4000)
        break
      case 'pet:expression': {
        const state = event.state
        if (state === 'happy' || state === 'sad' || state === 'talking') {
          actor.send({ type: state === 'happy' ? 'DSH_DONE' : state === 'sad' ? 'DSH_ERROR' : 'TALK' })
        } else if (state === 'thinking') {
          actor.send({ type: 'DSH_WORKING' })
        } else {
          // idle:直接切到 idle(状态机无直接入口,用 happy 的超时回落近似)
          actor.send({ type: 'DSH_DONE' })
        }
        break
      }
      case 'pet:notify':
        showBubble(`🔔 ${event.title}:${event.body}`, 4000)
        break
      case 'op:result':
        if (event.ok) {
          actor.send({ type: 'TALK' })
          showBubble(`发送:${event.summary}`, 2200)
        } else {
          actor.send({ type: 'DSH_ERROR' })
          showBubble(`✗ ${event.summary}`, 3500)
        }
        break
      default:
        break
    }
  })

  // 若连接在订阅前已完成,补读当前状态(阶段 1 坑 6:首个 connected 可能早于订阅)。
  // 目标会话不从这里赋值:面板 refreshSessions → onTargetChange 提供"有效目标"
  // (含自动回退),避免显式 null 覆盖回退目标的竞态。
  void api.getState().then((state) => {
    if (state.connection) {
      connText = state.connection
      renderStatus()
      seedRunningSessions()
      void panel.refreshSessions()
    }
  })

  // 窗口拖拽:由 #stage 的 -webkit-app-region: drag 原生处理(见 index.html),
  // 不再走 IPC 逐帧 setPosition(曾导致卡顿 + setPosition 参数转换崩溃)。

  // 输入条:Enter 发送/停止(与按钮一致);Shift+Enter 换行;输入法组词回车不触发
  const send = (): void => {
    const text = inputEl?.value.trim()
    if (!text) return
    if (inputEl) inputEl.value = ''
    autoGrowInput()
    void api.sendMessage(text).then((result) => {
      if (!result.ok) {
        actor.send({ type: 'DSH_ERROR' })
        showBubble(`✗ ${result.summary}`, 3500)
      }
      // ok 时等待 turn-end 事件提示完成;op:result 事件本身不再重复弹
    })
  }

  /** 停止当前目标会话的运行中回合(sessions.cancel,主进程解析目标)。 */
  const stop = (): void => {
    void api.stopTurn().then((result) => {
      if (!result.ok) {
        actor.send({ type: 'DSH_ERROR' })
        showBubble(`✗ ${result.summary}`, 3500)
      }
    })
  }

  const onSendClick = (): void => {
    if (isTargetRunning()) stop()
    else send()
  }
  sendBtn?.addEventListener('click', onSendClick)
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    e.preventDefault()
    onSendClick()
  })
  // 自动增高:每次输入后按内容撑高,超过 CSS max-height 后转内部滚动。
  // 输入法组词期间跳过(isComposing):拼音串被当作不可断的整体,响应它的
  // input 事件会让输入框随拼音长度反复增高/换行;组词结束后再重算。
  inputEl?.addEventListener('input', (e) => {
    if (e.isComposing) return
    autoGrowInput()
  })
  inputEl?.addEventListener('compositionend', () => autoGrowInput())
}

void boot()
