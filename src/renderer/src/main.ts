import { createActor } from 'xstate'
import type { PetActivityEntry, PetApi, PetEvent } from '../../shared/pet-event.ts'
import { petMachine, type PetState } from './fsm/pet-machine.ts'
import type { PetAnimator } from './pet/animator.ts'
import { createSpriteAnimator } from './pet/sprite-animator.ts'
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
const inputEl = document.querySelector<HTMLInputElement>('#msg-input')
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

  // 舞台 + 动画后端(占位球宠) + 状态机
  const stage = await createStage()
  const animator: PetAnimator = createSpriteAnimator(stage)
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

  // 若连接在订阅前已完成,补读当前状态(阶段 1 坑 6:首个 connected 可能早于订阅)
  void api.getState().then((state) => {
    if (state.connection) {
      connText = state.connection
      renderStatus()
      void panel.refreshSessions()
    }
  })

  // 窗口拖拽:由 #stage 的 -webkit-app-region: drag 原生处理(见 index.html),
  // 不再走 IPC 逐帧 setPosition(曾导致卡顿 + setPosition 参数转换崩溃)。

  // 气泡输入 → 发消息
  const send = (): void => {
    const text = inputEl?.value.trim()
    if (!text) return
    if (inputEl) inputEl.value = ''
    void api.sendMessage(text).then((result) => {
      if (!result.ok) {
        actor.send({ type: 'DSH_ERROR' })
        showBubble(`✗ ${result.summary}`, 3500)
      }
      // ok 时等待 turn-end 事件提示完成;op:result 事件本身不再重复弹
    })
  }
  sendBtn?.addEventListener('click', send)
  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send()
  })
}

void boot()
