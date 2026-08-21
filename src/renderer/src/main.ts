import { createActor } from 'xstate'
import type { PetActivityEntry, PetApi, PetEvent, PetSummaryEntry } from '../../shared/pet-event.ts'
import { petMachine, type PetState } from './fsm/pet-machine.ts'
import type { PetAnimator } from './pet/animator.ts'
import { createLive2dAnimator } from './pet/live2d/create-live2d-animator.ts'
import { createStage } from './pet/stage.ts'
import { createApprovalCenter, type PendingApproval } from './ui/approvals.ts'
import { createQuestionCenter, type PendingQuestion } from './ui/questions.ts'
import { markdownToDom } from './ui/markdown.ts'
import { createNotifyQueue } from './ui/notify.ts'
import { createPanel } from './ui/panel.ts'
import { conceal, reveal } from './ui/reveal.ts'
import { createWindowResizeHandles } from './window-resize.ts'

declare global {
  interface Window {
    petApi?: PetApi
  }
}

const api = window.petApi
const bubbleEl = document.querySelector<HTMLDivElement>('#bubble')
// 右上角操作通知队列(0042):AI 工具调用/操作提示(除 think 外全部)
const notify = createNotifyQueue()
const inputEl = document.querySelector<HTMLTextAreaElement>('#msg-input')
const sendBtn = document.querySelector<HTMLButtonElement>('#btn-send')
// 顶部按钮:左 = 历史/重连;右 = 菜单。最近对话浮层由历史按钮开合。
const btnHistoryEl = document.querySelector<HTMLButtonElement>('#btn-history')
const summaryPopEl = document.querySelector<HTMLDivElement>('#summary-pop')
// 浮动审批卡
const approvalCardEl = document.querySelector<HTMLDivElement>('#approval-card')
const approvalToolEl = document.querySelector<HTMLDivElement>('#approval-tool')
const approvalReasonEl = document.querySelector<HTMLDivElement>('#approval-reason')
const approvalAllowBtn = document.querySelector<HTMLButtonElement>('#approval-allow')
const approvalRejectBtn = document.querySelector<HTMLButtonElement>('#approval-reject')
// 0060 浮动提问卡(DSH ask_user_question → 宠物窗口直接回答)
const questionCardEl = document.querySelector<HTMLDivElement>('#question-card')
const questionTitleEl = document.querySelector<HTMLDivElement>('#question-title')
const questionBodyEl = document.querySelector<HTMLDivElement>('#question-body')
const questionSubmitBtn = document.querySelector<HTMLButtonElement>('#question-submit')
const questionCancelBtn = document.querySelector<HTMLButtonElement>('#question-cancel')

let bubbleTimer: ReturnType<typeof setTimeout> | undefined
let connText = 'connecting'
/** 当前浮动卡显示的审批条目。 */
let cardApproval: PendingApproval | null = null
/** 0060:当前浮动卡显示的提问条目。 */
let cardQuestion: PendingQuestion | null = null
/** 当前有效发送目标(显式选择或自动回退;由面板回调同步)。 */
let targetSessionId: string | null = null
/** 运行中的会话集合(dsh:session-update 增量维护;列表快照播种)。 */
const runningSessions = new Set<string>()
/** 状态机当前语义状态(subscribe 同步;供同步目标状态时避免冗余发送)。 */
let petState: PetState = 'idle'

/**
 * 0046:宠物动作/表情只跟踪**目标会话** —— 其余并行会话的活动一律不驱动状态机。
 * 判断某事件是否属于当前有效目标会话(显式或自动回退;由 onTargetChange 提供)。
 */
function isTargetSession(sessionId: string | null): boolean {
  return targetSessionId !== null && sessionId !== null && sessionId === targetSessionId
}

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

/**
 * 顶部历史按钮:连接状态驱动文案与样式。
 * 已连接 → "点击展开历史"(开合最近对话浮层);未连接 → "reconnect"(点击立即重连)。
 * 未连接时浮层数据已过期,一并收起。
 */
function renderHistoryButton(): void {
  if (!btnHistoryEl) return
  const connected = connText === 'connected'
  btnHistoryEl.textContent = connected ? '点击展开历史' : 'reconnect'
  btnHistoryEl.classList.toggle('disconnected', !connected)
  if (!connected && summaryPopEl) {
    summaryPopEl.classList.add('hidden')
    summaryPopEl.textContent = ''
  }
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

/**
 * 0060 浮动提问卡:显示最新一条待回答提问;无待回答则隐藏。
 * 与审批卡同层贴输入条,审批卡可见时上移避让(避免互相遮挡)。
 */
function renderQuestionCard(list: PendingQuestion[]): void {
  cardQuestion = list[0] ?? null
  if (!questionCardEl) return
  if (!cardQuestion) {
    questionCardEl.classList.add('hidden')
    return
  }
  const approvalVisible = approvalCardEl !== null && !approvalCardEl.classList.contains('hidden')
  const baseBottom = 52
  questionCardEl.style.bottom = approvalVisible && approvalCardEl
    ? `${approvalCardEl.offsetHeight + baseBottom + 8}px`
    : `${baseBottom}px`
  if (questionTitleEl) {
    questionTitleEl.textContent = cardQuestion.questions.length > 1
      ? `❓ DSH 向你提问(${cardQuestion.questions.length} 题)`
      : '❓ DSH 向你提问'
  }
  buildQuestionBody(cardQuestion)
  questionCardEl.classList.remove('hidden')
}

/** 0060:按提问条目构建问题 DOM(文本 + 选项 + 自定义输入)。 */
function buildQuestionBody(item: PendingQuestion): void {
  if (!questionBodyEl) return
  questionBodyEl.textContent = ''
  item.questions.forEach((q, qi) => {
    const box = document.createElement('div')
    box.className = 'q-item'
    const text = document.createElement('div')
    text.className = 'q-text'
    text.textContent = q.question
    box.appendChild(text)
    if (q.detail) {
      const detail = document.createElement('div')
      detail.className = 'q-detail'
      detail.textContent = q.detail
      box.appendChild(detail)
    }
    if (q.options && q.options.length > 0) {
      const opts = document.createElement('div')
      opts.className = 'q-options'
      const groupName = `q-${item.rpcId}-${qi}`
      q.options.forEach((o) => {
        const row = document.createElement('label')
        row.className = 'q-option'
        const input = document.createElement('input')
        input.type = q.multiSelect ? 'checkbox' : 'radio'
        if (!q.multiSelect) input.name = groupName
        input.value = o.label
        const lab = document.createElement('span')
        lab.className = 'opt-label'
        lab.textContent = o.label
        if (o.description) {
          const desc = document.createElement('span')
          desc.className = 'opt-desc'
          desc.textContent = o.description
          lab.appendChild(desc)
        }
        row.append(input, lab)
        // 选中态由 input change 驱动(单选 radio 原生互斥;多选 checkbox 逐个切换),
        // 同步 .selected 高亮样式
        input.addEventListener('change', () => {
          opts.querySelectorAll<HTMLInputElement>('input').forEach((el) => {
            el.closest<HTMLElement>('.q-option')?.classList.toggle('selected', el.checked)
          })
        })
        opts.appendChild(row)
      })
      box.appendChild(opts)
    }
    const custom = document.createElement('input')
    custom.className = 'q-custom'
    custom.type = 'text'
    custom.placeholder = q.options && q.options.length > 0 ? '其他(可选)…' : '输入回答…'
    box.appendChild(custom)
    questionBodyEl?.appendChild(box)
  })
}

/** 0060:从提问卡 DOM 收集本次回答(selected = 选项 label;自定义输入进 custom)。 */
function collectAnswers(item: PendingQuestion): { id: string; selected: string[]; custom?: string }[] {
  if (!questionBodyEl) return []
  const boxes = questionBodyEl.querySelectorAll<HTMLElement>('.q-item')
  const answers: { id: string; selected: string[]; custom?: string }[] = []
  boxes.forEach((box, i) => {
    const q = item.questions[i]
    if (!q) return
    const selected = [...box.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')]
      .filter((el) => el.checked)
      .map((el) => el.value)
    const customValue = box.querySelector<HTMLInputElement>('.q-custom')?.value.trim() ?? ''
    answers.push({ id: q.id, selected, ...(customValue === '' ? {} : { custom: customValue }) })
  })
  return answers
}

/** 0060:提交无作答时的卡片内即时反馈(按钮变红 + 文字提示;不依赖气泡,气泡可能被卡片遮挡)。 */
let submitHintTimer: ReturnType<typeof setTimeout> | undefined
function flashSubmitHint(): void {
  if (!questionSubmitBtn) return
  questionSubmitBtn.textContent = '请先作答'
  questionSubmitBtn.classList.add('hint')
  if (submitHintTimer) clearTimeout(submitHintTimer)
  submitHintTimer = setTimeout(() => {
    questionSubmitBtn?.classList.remove('hint')
    if (questionSubmitBtn) questionSubmitBtn.textContent = '提交'
  }, 1600)
}

/**
 * B2 多会话雷达:内存活动表,由 dsh:session-update 增量累积;订阅者拿快照。
 */
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

// ---- 最近对话浮层(顶部历史按钮开合):目标会话的重要消息摘要(主进程已过滤噪音并截断) ----

/** 缓冲:按 seq 升序(去重;上限 50 条,超出丢最旧)。 */
let summaryEntries: PetSummaryEntry[] = []
/** 当前关注的会话(切会话竞态保护:基线/增量过期即丢弃)。 */
let summarySessionId: string | null = null

/** 浮层:完整列出缓冲;打开时滚到底,已在底部时新条目跟随滚动。 */
function renderSummaryPop(): void {
  if (!summaryPopEl) return
  const wasAtBottom = summaryPopEl.scrollHeight - summaryPopEl.scrollTop - summaryPopEl.clientHeight < 8
  summaryPopEl.textContent = ''
  if (summaryEntries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'summary-pop-empty'
    empty.textContent = '（暂无重要消息）'
    summaryPopEl.appendChild(empty)
    return
  }
  const frag = document.createDocumentFragment()
  for (const entry of summaryEntries) {
    const row = document.createElement('div')
    row.className = `summary-pop-row ${entry.kind}`
    const time = document.createElement('span')
    time.className = 'time'
    time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    row.appendChild(time)
    // 渲染 markdown(粗体/行内代码/代码块/列表…),文本一律 textContent 写入
    row.appendChild(markdownToDom(entry.text))
    frag.appendChild(row)
  }
  summaryPopEl.appendChild(frag)
  if (wasAtBottom) summaryPopEl.scrollTop = summaryPopEl.scrollHeight
}

/** 入缓冲:按 seq 去重(主进程已按目标会话过滤);浮层开着时刷新。 */
function pushSummaryEntry(entry: PetSummaryEntry): void {
  if (summaryEntries.some((e) => e.seq === entry.seq)) return
  summaryEntries.push(entry)
  if (summaryEntries.length > 50) summaryEntries.splice(0, summaryEntries.length - 50)
  if (summaryPopEl && !summaryPopEl.classList.contains('hidden')) renderSummaryPop()
}

/** 切换会话/重连:清空缓冲并拉一次尾部历史基线(经主进程过滤);竞态用 summarySessionId 保护。 */
function resetSummary(sessionId: string | null): void {
  summarySessionId = sessionId
  summaryEntries = []
  if (summaryPopEl) {
    summaryPopEl.classList.add('hidden')
    summaryPopEl.textContent = ''
  }
  if (!sessionId) return
  void api?.getHistorySummary(sessionId, 60).then((result) => {
    if (!result.ok || summarySessionId !== sessionId) return
    for (const entry of result.entries) pushSummaryEntry(entry)
  })
}

/** 点击历史按钮:展开/收起最近对话浮层(平滑过渡,打开时滚到底)。 */
function toggleSummaryPop(): void {
  if (!summaryPopEl) return
  const show = summaryPopEl.classList.contains('hidden')
  if (show) {
    renderSummaryPop()
    // 必须先显示再滚底:display:none 时 scrollTop 赋值无效,
    // reveal 移除 hidden 后元素才可滚动(否则首次打开视角停在顶部)
    reveal(summaryPopEl)
    summaryPopEl.scrollTop = summaryPopEl.scrollHeight
  } else {
    conceal(summaryPopEl)
  }
}

async function boot(): Promise<void> {
  if (!api) {
    connText = 'preload 未注入 window.petApi'
    renderHistoryButton()
    return
  }

  // 舞台 + 动画后端(Live2D 优先,未接入 SDK 时回落占位球宠) + 状态机
  const stage = await createStage()
  const animator: PetAnimator = createLive2dAnimator(stage)

  // 0056 窗口边缘拖拽调整大小:8 条透明 no-drag 手柄;按下/松开经 IPC 通知
  // 主进程,尺寸计算在主进程光标轮询里做(renderer 不逐帧发 IPC)。
  // win32 下手柄收不到 pointerdown(边缘按下被原生命中测试吞掉,0057),仅
  // 非 win32 轮询兜底路径生效;手势状态另有 onResizeGesture 主进程推送。
  createWindowResizeHandles(api)
  // 0057:主进程推送"手动缩放手势"状态 → body.pet-resizing(win32 原生路径的
  // 开始/结束信号;与手柄信号并存,同平台只走一条,互不冲突)
  api.onResizeGesture((active) => {
    document.body.classList.toggle('pet-resizing', active)
  })

  // 启动即应用持久化的宠物外观/手感(位置/大小/跟随)与背景透明度
  // (背景透明度用 CSS opacity 作用于 #bg-base 基色画布;win.setOpacity 会破坏 acrylic 毛玻璃)
  void api.getConfig().then((cfg) => {
    animator.applyPetSettings?.(cfg.pet)
    const opacity = Math.min(1, Math.max(0, cfg.appearance.opacity))
    document.querySelector<HTMLElement>('#bg-base')?.style.setProperty('opacity', String(opacity))
  })
  const actor = createActor(petMachine)
  actor.subscribe((snapshot) => {
    petState = snapshot.value as PetState
    animator.play(petState)
  })
  actor.start()

  /**
   * 0046:把宠物状态机同步到"目标会话当前是否在跑"。
   * 重启 / 切换会话 / 重连后,以 runningSessions(全会话实时集合)为准:
   * 目标在跑 → 思考;不在跑(且当前是思考)→ 复位待机。仅在需要时发送,避免多余的
   * 表情闪烁(thinking 时不再重复 DSH_WORKING,idle 时不再重复 DSH_DONE)。
   */
  function syncTargetState(): void {
    const target = targetSessionId
    const running = target !== null && runningSessions.has(target) && isTargetSession(target)
    if (running) {
      if (petState !== 'thinking') actor.send({ type: 'DSH_WORKING' })
    } else if (petState === 'thinking') {
      actor.send({ type: 'DSH_DONE' })
    }
  }

  /**
   * 用会话列表的 running 快照补充运行中集合(覆盖"连接时回合已在跑"的情形),
   * 并同步宠物状态(目标会话思考/待机)。
   */
  function seedRunningSessions(): void {
    void api?.listSessions().then((result) => {
      if (!result.ok) return
      for (const item of result.items) {
        if (item.running) runningSessions.add(item.sessionId)
      }
      renderSendButton()
      syncTargetState()
    })
  }

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

  // 0060 提问中心(浮动提问卡;与审批中心同构,DSH ask_user_question → 宠物回答)
  const questions = createQuestionCenter(api, {
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
      renderQuestionCard(questions.list())
    },
  })
  questions.subscribe(renderQuestionCard)

  // B2 多会话雷达:活动表 + 面板订阅
  const activity = createActivityStore()

  // 会话面板(会话列表/切换 + 审批 + 雷达 + 设置 tab;历史已并入"点击展开历史"浮层)
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
        // 0059:cfg 为 null(主进程配置未就绪)时跳过,避免 cfg.pet 抛错
        if (cfg) animator.applyPetSettings?.(cfg.pet)
      })
    },
    // 有效发送目标(显式或自动回退)变化 → 刷新"发送/停止"按钮 + 最近对话浮层切会话重拉基线
    onTargetChange: (id) => {
      targetSessionId = id
      renderSendButton()
      resetSummary(id)
      // 0046:切会话后重拉会话列表 running 快照(新目标可能在我方错过其 turn-start 前已在跑),
      // 再由 seedRunningSessions 把状态机同步到新目标当前状态(思考/待机)
      seedRunningSessions()
    },
    // 互斥:面板展开时先收起历史浮层
    onOpen: () => {
      if (summaryPopEl && !summaryPopEl.classList.contains('hidden')) conceal(summaryPopEl)
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

  // 0060 提问卡按钮:提交 → 汇总回答回包;取消 → 放弃(不回包,DSH 侧等待直到回合被取消)
  questionSubmitBtn?.addEventListener('click', () => {
    if (!cardQuestion) return
    const answers = collectAnswers(cardQuestion)
    const anyFilled = answers.some((a) => a.selected.length > 0 || a.custom !== undefined)
    if (!anyFilled) {
      flashSubmitHint()
      return
    }
    void questions.respond(cardQuestion, answers)
  })
  questionCancelBtn?.addEventListener('click', () => {
    if (!cardQuestion) return
    questions.removeByRpcId(cardQuestion.rpcId)
    actor.send({ type: 'TALK' })
    showBubble('已放弃回答(可在 Web 端停止该回合)', 3000)
  })

  // DSH 事件 → 状态机事件 + 气泡 + 审批
  api.onPetEvent((event: PetEvent) => {
    switch (event.type) {
      case 'dsh:connected':
        connText = 'connected'
        renderHistoryButton()
        // 重连后会话列表可能变化,刷新面板;雷达活动表清空重建(旧代事件已过期)
        activity.clear()
        // 运行中集合同样进入新代:清空后用会话列表快照播种(覆盖"连接时已在跑"的回合)
        runningSessions.clear()
        // 0046:seedRunningSessions 在播种后把状态机同步到目标会话当前状态(思考/待机),
        // 不再用"任意会话在跑"触发思考 —— 非目标会话的活动不影响宠物表情
        seedRunningSessions()
        void panel.refreshSessions()
        // 浮层缓冲属旧代事件,重置并重拉当前目标会话基线(refreshSessions 后
        // onTargetChange 若目标变化会再触发一次 resetSummary,幂等)
        resetSummary(targetSessionId)
        break
      case 'dsh:state':
        connText = event.state
        renderHistoryButton()
        break
      case 'dsh:turn-start':
        // 0046:只跟踪目标会话 —— 其余会话的回合不驱动思考表情
        if (!isTargetSession(event.sessionId)) break
        actor.send({ type: 'DSH_WORKING' })
        break
      case 'dsh:thinking-start':
        // 0046:只跟踪目标会话 —— 其余会话的推理段不触发思考表情
        if (!isTargetSession(event.sessionId)) break
        // 0039:推理段开始(一次 turn 可含多段)→ animator 按段计时触发思考表情
        animator.onThinkingSegmentStart?.()
        break
      case 'dsh:thinking-end':
        if (!isTargetSession(event.sessionId)) break
        animator.onThinkingSegmentEnd?.()
        break
      case 'dsh:tool-call':
        // 0046:只通知目标会话的工具调用 —— 其余会话的操作不弹右上角通知
        if (!isTargetSession(event.sessionId)) break
        // 0042:AI 工具调用 → 右上角通知队列(除 think 外全部;Read/Edit/Glob 等)
        notify.show(`🔧 ${event.name}`)
        break
      case 'dsh:turn-end':
        if (!isTargetSession(event.sessionId)) break
        if (event.reason === 'error' || event.reason === 'max-tokens' || event.reason === 'blocked') {
          actor.send({ type: 'DSH_ERROR' })
          showBubble(`✗ 回合异常:${event.reason}`, 3500)
        } else if (event.reason === 'aborted' || event.reason === 'interrupted') {
          // 任务被打断(用户停止/中断):先让状态机离开 thinking 回 idle(不走 happy
          // 庆祝),再播放愤怒表情 —— 此时表情门控已放开,请求直接生效。
          actor.send({ type: 'DSH_INTERRUPTED' })
          animator.playInterrupted?.()
          showBubble('■ 已停止', 2000)
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
      case 'question:pending':
        // 0060:DSH ask_user_question → 提问中心 + 浮动提问卡。
        // 不弹"向你提问"气泡:气泡(z-index 最高)会遮挡提问卡本体。
        questions.add(event)
        actor.send({ type: 'TALK' })
        break
      case 'question:resolved':
        // 0060:提问已结算(我方提交后 DSH 回执,或他端/取消)——关卡(幂等)
        questions.removeByRpcId(event.questionRpcId)
        if (event.outcome === 'answered') {
          actor.send({ type: 'TALK' })
          showBubble('✅ 已回答', 2000)
        } else if (event.outcome === 'cancelled') {
          actor.send({ type: 'TALK' })
          showBubble('❌ 提问已取消', 2000)
        }
        break
      case 'agent:error':
        // 0046:只报目标会话的 host 级错误 —— 其余会话的报错不触发宠物难过/气泡
        if (!isTargetSession(event.sessionId)) break
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
      case 'dsh:summary-update':
        // 最近对话浮层:主进程已按目标会话过滤;若 renderer 尚未锚定会话(面板回调
        // 晚于事件),以事件会话为准
        if (summarySessionId === null) summarySessionId = event.sessionId
        if (event.sessionId === summarySessionId) pushSummaryEntry(event.entry)
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
      renderHistoryButton()
      // 0046:启动时把状态机同步到目标会话当前状态(seedRunningSessions 播种后触发),
      // 不再用"任意会话在跑"触发思考 —— 非目标会话的活动不影响宠物表情
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

  // 顶部历史按钮:已连接 → 开合最近对话浮层(互斥:菜单面板开着先收起);未连接 → 立即重连
  btnHistoryEl?.addEventListener('click', () => {
    if (connText === 'connected') {
      if (panel.isOpen()) panel.close()
      toggleSummaryPop()
    } else void api?.reconnect()
  })
}

void boot()
