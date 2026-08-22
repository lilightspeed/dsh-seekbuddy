import type { ResponseValue } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { PetConfig, PetConfigUpdate } from './pet-config.ts'

/** host.describe 的成功值(握手后拿到的主机描述)。 */
export type HostDescription = ResponseValue<'host.describe'>

/** 宠物侧粗粒度连接状态(与主进程连接循环对应)。 */
export type ConnectionState = 'connected' | 'reconnecting'

/**
 * 主进程 → renderer 的归一化宠物事件。
 * 阶段 3 新增:turn-end 带 reason、审批(approval:pending/resolved)、agent-error。
 */
export type PetEvent =
  | { type: 'dsh:connected'; description: HostDescription }
  | { type: 'dsh:state'; state: ConnectionState }
  | {
      type: 'dsh:frame'
      stream: 'mux' | 'host'
      frameType: string
      /** session/event 帧的 SessionEvent.type(其余帧为 null)。 */
      eventType: string | null
    }
  | { type: 'dsh:turn-start'; sessionId: string }
  /**
   * 自动切换目标会话:主进程在"启动回退最近会话"或"DSH 端发消息"时主动切换目标,
   * 通知 renderer 刷新会话面板(更新目标标记/输入条/最近对话浮层/状态机同步)。
   */
  | { type: 'dsh:target-changed'; sessionId: string }
  | {
      type: 'dsh:turn-end'
      /** TurnEndReason.kind:completed / error / aborted / max-tokens / … */
      reason: string
      sessionId: string
    }
  /**
   * 0039:一次"推理段"开始(assistant/chunk 的 reasoning 块进入)。
   * 一次 turn 可含多次推理段(思考 → 工具调用 → 再思考…),renderer 按段计时
   * 触发思考表情(困惑/恍然大悟),而非按整个任务计时。
   */
  | { type: 'dsh:thinking-start'; sessionId: string; time: number }
  /** 0039:推理段结束(非 reasoning 块开始 / step-end / turn-end 收尾)。 */
  | { type: 'dsh:thinking-end'; sessionId: string; time: number }
  /**
   * 0042:AI 发起一次工具调用(除 think 外的全部,如 read/edit/glob/grep/pwsh…)。
   * 右上角操作通知队列消费;think(推理)不通知 —— 推理 delta 是模型内部活动,弹出只会刷屏。
   */
  | { type: 'dsh:tool-call'; sessionId: string; callId: string; name: string }
  /** DSH 请求审批(服务端 answerable server-request;rpcId 用于回包)。 */
  | {
      type: 'approval:pending'
      rpcId: string
      sessionId: string
      approvalId: string
      toolName: string
      callId?: string
      reason?: string
    }
  /** 审批已结算(允许/拒绝/取消/不可达)。 */
  | {
      type: 'approval:resolved'
      sessionId: string
      approvalId: string
      outcome: string
    }
  /** host 级 agent 失败(无 turn 位置的错误)。 */
  | { type: 'agent:error'; sessionId: string; message: string }
  /** B2 多会话雷达:单个会话的 turn 活动增量(雷达 tab 消费,不推帧风暴)。 */
  | {
      type: 'dsh:session-update'
      sessionId: string
      /** 该会话是否有回合在跑。 */
      running: boolean
      /** 最后一次 turn 的 reason.kind(completed/error/aborted/max-tokens/blocked…);running 时 null。 */
      reason: string | null
      /** 事件时间戳(ms,服务端事件时间)。 */
      time: number
    }
  /**
   * 最近对话浮层:目标会话新增一条"重要消息"摘要。
   * 主进程已按重要性规则过滤(用户消息 / 助手最终回复 / 工具失败 / 回合异常)
   * 并折叠/截断;renderer 只按 seq 去重累积渲染。
   */
  | { type: 'dsh:summary-update'; sessionId: string; entry: PetSummaryEntry }
  /** 阶段 4 反向链路:MCP 工具切换表情状态。 */
  | { type: 'pet:expression'; state: 'idle' | 'thinking' | 'happy' | 'sad' | 'talking' }
  /** 阶段 4 反向链路:MCP 工具触发系统通知。 */
  | { type: 'pet:notify'; title: string; body: string }
  /**
   * 0060:DSH `ask_user_question` → 宠物提问卡。question/requested 是 answerable
   * server-request(与 approval 同机制):rpcId 是稳定对账键,回包必须 echo 它。
   */
  | { type: 'question:pending'; rpcId: string; sessionId: string; questions: PetQuestionItem[] }
  /** 0060:提问已结算(answered / cancelled),关掉对应提问卡。 */
  | {
      type: 'question:resolved'
      sessionId: string
      questionRpcId: string
      outcome: 'answered' | 'cancelled'
    }
  | { type: 'op:result'; label: string; ok: boolean; summary: string }

/** 会话列表里的一行(renderer 只消费扁平字段)。 */
export interface PetSessionSummary {
  sessionId: string
  /** 会话标题(projections.values.title;无则 null)。 */
  title: string | null
  updatedAt: number
  running: boolean
  blank: boolean
}

export interface PetSessionListResult {
  ok: boolean
  summary: string
  /** 当前目标会话(主进程持有)。 */
  targetSessionId: string | null
  items: PetSessionSummary[]
}

/** B2 雷达:单个会话的最新活动状态(由 dsh:session-update 增量累积)。 */
export interface PetActivityEntry {
  sessionId: string
  running: boolean
  /** 最后一次 turn 的 reason.kind;running 时为 null。 */
  reason: string | null
  /** 事件时间戳(ms)。 */
  time: number
}

/** B3(只读)插件监控:一个动态插件的扁平摘要(经 agent 中介读回)。 */
export interface PetPluginEntry {
  pluginId: string
  name: string
  /** defined / stopped / running / waiting / failed / client-pending / awaiting-approval。 */
  state: string
  packageCount: number
  currentPackageId: string | null
  nextPackageId: string | null
  activeRun: { pluginRunId: string; packageId: string } | null
  pendingApproval: { pluginRunId: string; packageId: string; mode: string } | null
  /** 原始摘要 JSON(调试/折叠展示)。 */
  raw: string
}

export interface PetPluginListResult {
  ok: boolean
  summary: string
  /** 成功时为拉取时间(ms),失败为 0。 */
  refreshedAt: number
  plugins: PetPluginEntry[]
  /** 解析失败/超时时的 agent 原始回复片段(诊断用)。 */
  rawReply?: string
}

/** 历史里的一行:主进程已把 SessionEvent 摊平成展示文本。 */
export interface PetHistoryEntry {
  seq: number
  time: number
  kind: 'user' | 'assistant' | 'tool' | 'meta'
  text: string
}

export interface PetHistoryResult {
  ok: boolean
  summary: string
  sessionId: string | null
  hasMore: boolean
  entries: PetHistoryEntry[]
}

/** 最近对话浮层:一条对话消息的扁平摘要(主进程已过滤,仅保留用户/助手消息)。 */
export interface PetSummaryEntry {
  /** 会话内事件序号(去重锚点;同一 seq 只进一次缓冲)。 */
  seq: number
  /** Unix epoch 毫秒。 */
  time: number
  kind: 'user' | 'assistant'
  /** 已折叠完整的展示文本。 */
  text: string
}

export interface PetSummaryResult {
  ok: boolean
  summary: string
  sessionId: string | null
  entries: PetSummaryEntry[]
}

export interface PetCreateResult {
  ok: boolean
  summary: string
  sessionId?: string
}

/** renderer → 主进程的审批回包请求(echo 服务端 rpcId)。 */
export interface PetApprovalRequest {
  rpcId: string
  sessionId: string
  approvalId: string
  outcome: 'allowed-once' | 'rejected'
}

/** 提问的一个选项(扁平化自 DSH AskUserQuestionOption)。 */
export interface PetQuestionOption {
  label: string
  description?: string
}

/** 提问条目(扁平化自 DSH AskUserQuestionItem;renderer 不依赖 DSH 类型)。 */
export interface PetQuestionItem {
  /** 调用方提供的问题 id,原样回显在答案里。 */
  id: string
  /** 问题文本。 */
  question: string
  /** 可选短标题/分组标签。 */
  header?: string
  /** 可选补充说明。 */
  detail?: string
  /** 可选选项列表(无则只给自由输入)。 */
  options?: PetQuestionOption[]
  /** 是否允许多选(缺省 = 单选)。 */
  multiSelect?: boolean
}

/** renderer → 主进程的提问回包请求(echo 服务端 rpcId,answers 按问题 id 对应)。 */
export interface PetQuestionRequest {
  rpcId: string
  sessionId: string
  answers: { id: string; selected: string[]; custom?: string }[]
}

/** 主进程轮询的光标位置(窗口局部坐标,CSS px;窗口外时 renderer 按边缘夹取)。 */
export interface PetCursorPosition {
  x: number
  y: number
  /** 光标是否在窗口矩形内。 */
  inside: boolean
  /**
   * 窗口位置增量 X(px,主进程 33ms 采样;0032):
   * 用户拖拽窗口时连续非零(右为正),静止/停止为 0 —— "左右拖动宠物"的物理反馈输入,
   * renderer 映射到 Live2D `ParamDragX`。
   */
  dragDx: number
  /** 窗口位置增量 Y(px;下为正),映射到 Live2D `ParamDragY`("上下拖动宠物")。 */
  dragDy: number
}

/** preload 暴露给 renderer 的 window.petApi 白名单(阶段 3)。 */
export interface PetApi {
  onPetEvent(handler: (event: PetEvent) => void): () => void
  /**
   * 主进程光标轮询(视角跟随用)。
   * 拖拽区域(`-webkit-app-region: drag`)会吞掉 renderer 的鼠标事件,故光标由主进程
   * 全局读取后推送(0016),光标在窗口外也照常推送。
   * 同事件携带窗口位置增量(dragDx/dragDy):拖动窗口时的位移 → 宠物拖动物理反馈(0032)。
   */
  onCursor(handler: (position: PetCursorPosition) => void): () => void
  getState(): Promise<PetConnectionState>
  /** 向当前目标会话发送一条文本消息(session.prompt)。 */
  sendMessage(text: string): Promise<PetOpResult>
  /** 立即重建 DSH 连接(手动重连:中断退避并开新代)。 */
  reconnect(): Promise<PetOpResult>
  /** 停止当前目标会话的运行中回合(sessions.cancel);无显式目标时回退最近非空会话。 */
  stopTurn(): Promise<PetOpResult>
  listSessions(): Promise<PetSessionListResult>
  /** 读会话历史;beforeSeq 为向上翻页锚点(省略 = 尾部页)。 */
  getHistory(sessionId: string, beforeSeq?: number, maxMessages?: number): Promise<PetHistoryResult>
  /** 拉目标会话尾部"重要消息"摘要(最近对话浮层基线;主进程过滤噪音并截断)。 */
  getHistorySummary(sessionId: string, maxMessages?: number): Promise<PetSummaryResult>
  /** 设置目标会话(发消息的落点);null = 回退到最近会话。 */
  selectSession(sessionId: string | null): Promise<PetOpResult>
  /** 新建会话并选为目标。 */
  createSession(): Promise<PetCreateResult>
  /** 回包审批(echo rpcId,允许/拒绝)。 */
  respondApproval(request: PetApprovalRequest): Promise<PetOpResult>
  /** 0060:回包提问(echo rpcId,answers 按问题 id 对应)。 */
  respondQuestion(request: PetQuestionRequest): Promise<PetOpResult>
  /** 阶段 5:读完整配置(DSH 地址/外观/自启/目标会话)。 */
  getConfig(): Promise<PetConfig>
  /** 阶段 5:应用扁平配置补丁;主进程执行副作用(重连/窗口/自启)后返回新配置。 */
  setConfig(patch: PetConfigUpdate): Promise<PetConfig>
  /** B3(只读):经 agent 中介读取目标会话的动态插件清单(会占用一次模型回合)。 */
  listPlugins(): Promise<PetPluginListResult>
  /**
   * 0056 窗口边缘拖拽调整大小:按下边缘手柄时通知主进程开始(edge ∈
   * n/s/e/w/ne/nw/se/sw)。主进程在已有的 33ms 光标轮询里按屏幕光标增量
   * 锚定对侧边 setBounds —— renderer 只发开始/结束两个信号,不做逐帧 IPC
   * (规避"逐帧 setPosition 卡顿 + 参数转换崩溃"的教训,见 AGENTS.md)。
   */
  resizeStart(edge: string): Promise<void>
  /** 0056:松开/取消边缘拖拽,主进程停止调整大小。 */
  resizeEnd(): Promise<void>
  /**
   * 0057/0063(win32 原生缩放):主进程推送"手动缩放手势开始/结束" —— 原生路径下
   * 边缘按下被系统非客户区命中测试吞掉(HTRIGHT 等),renderer 的 pointerdown 不
   * 触发,原手柄信号在 win32 上不可用;renderer 用该信号切换 body.pet-resizing
   * (禁用 drag 区域 + 玻璃组件降级防闪烁,见 index.html CSS)。开始=首次 resize,
   * 结束=resized 事件或"静默且左键已松开"兜底(拖拽中途停顿不再被误判为结束,
   * 0063)。非 win32 的轮询兜底路径仍由手柄 pointerdown/up 驱动。
   */
  onResizeGesture(handler: (active: boolean) => void): () => void
  /**
   * 0062 极简模式:设置窗口是否可缩放。极简模式下锁定窗口大小(不可拖动边缘缩放),
   * 退出极简模式时恢复可缩放。
   */
  setResizable(resizable: boolean): Promise<void>
  /**
   * 最小化(隐藏)宠物窗口:主页面"最小化"按钮点击 → 经主进程 mainWindow.hide()
   * 收起窗口;托盘"显示 / 隐藏"可再次唤出。与托盘隐藏共用同一套 show/hide 语义。
   */
  hideWindow(): Promise<void>
  /**
   * 0062 遗留(初版"窗口收缩"方案已弃用,当前 renderer 不调用,保留为程序化
   * 控制入口):读当前窗口 bounds(屏幕坐标)。与 setWindowBounds 配套,
   * 曾用于"窗口收缩到宠物大小、宠物屏幕位置/大小不变"。
   */
  getWindowBounds(): Promise<{ x: number; y: number; width: number; height: number } | null>
  /**
   * 0062 遗留(初版"窗口收缩"方案已弃用,当前 renderer 不调用,保留为程序化
   * 控制入口):程序化设置窗口 bounds(屏幕坐标)。主进程夹取尺寸到
   * WINDOW_SIZE_MIN/MAX、位置到显示器工作区;返回实际生效的 bounds。
   * 程序化 setBounds 不触发 will-resize/resized,不会误触发缩放手势或落盘尺寸。
   */
  setWindowBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<{
    x: number
    y: number
    width: number
    height: number
  } | null>
  /**
   * 0062 极简模式:主进程发起的配置变更推送(当前为托盘切换极简模式)。renderer
   * 据新配置执行进入/退出(renderer 自身发起的 setConfig 直接拿到返回的新配置)。
   */
  onConfigChanged(handler: (config: PetConfig) => void): () => void
}

export type PetConnectionState = {
  connection: ConnectionState | null
  description: HostDescription | null
  targetSessionId: string | null
}

export type PetOpResult = {
  label: string
  ok: boolean
  summary: string
}
