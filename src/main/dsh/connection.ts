import type { HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionState, HostDescription, PetEvent } from '../../shared/pet-event.ts'
import { DshApiClient } from './client.ts'
import { summaryEntryOf } from './summary.ts'

/** 连接句柄:renderer 经 preload 白名单间接使用。 */
export interface ConnectionHandle {
  start(): void
  stop(): void
  state(): { connection: ConnectionState | null; description: HostDescription | null }
  api: DshApiClient
}

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 30_000

/**
 * 宠物自己的连接循环(生命周期胶水,协议仍由 AbstractApiClient 承担):
 * 每代 = host.describe 握手 → 起 mux/host 两条 WS 流 → 泵帧到 onEvent;
 * 任一流结束/出错 → reconnecting → 指数退避(带抖动)重试。
 * getBaseUrl:阶段 5 起注入配置读取器,改 DSH 地址后由调用方重建连接。
 * isTargetSession:最近对话浮层只关注目标会话,其余会话的摘要不推送。
 */
export function createConnection(
  onEvent: (event: PetEvent) => void,
  getBaseUrl: () => string,
  isTargetSession: (sessionId: string) => boolean,
): ConnectionHandle {
  const api = new DshApiClient(getBaseUrl)
  let running = false
  let currentState: ConnectionState | null = null
  let description: HostDescription | null = null
  let generationAbort: AbortController | undefined
  /** tool/call 的 callId → 工具名(增量流内配对;供工具失败摘要显示)。 */
  const toolNames = new Map<string, string>()
  /**
   * 0039 推理段检测:是否正处于一次"推理段"中(assistant/chunk 的 reasoning 块连续出现)。
   * 一次 turn 可含多段(思考 → 工具调用 → 再思考…),每段结束独立触发 renderer 的
   * 思考表情判定;段起点按到达顺序维护。
   *
   * 0046:推理段**按会话隔离**(reasoningSessionId 记录所属会话)而非全局单标志 ——
   * 宠物表情只跟踪目标会话,若多个会话并行,全局标志会被非目标会话的文本块/step
   * 提前收尾,导致目标会话的 thinking-start 漏发/thinking-end 错配,思考表情判定失效。
   * 同一会话的重复 reasoning delta 仍只在段起点发一次(0041:重复发会让 renderer 的
   * 段计时被反复重置 —— 思考表情/困惑/恍然大悟的时长判定全部失效,执行任务的动作
   * 也会在每个 delta 上停掉重播而无法常驻)。
   */
  let reasoningSessionId: string | null = null

  function emitThinkingStart(sessionId: string, time: number): void {
    if (reasoningSessionId === sessionId) return
    reasoningSessionId = sessionId
    onEvent({ type: 'dsh:thinking-start', sessionId, time })
  }

  function emitThinkingEnd(sessionId: string, time: number): void {
    if (reasoningSessionId !== sessionId) return
    reasoningSessionId = null
    onEvent({ type: 'dsh:thinking-end', sessionId, time })
  }

  function emitState(state: ConnectionState): void {
    if (currentState === state) return
    currentState = state
    onEvent({ type: 'dsh:state', state })
  }

  async function pump(stream: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>, kind: 'mux' | 'host'): Promise<void> {
    for await (const envelope of stream) {
      const frame = envelope.payload
      const { frameType, eventType } = describeFrame(frame)
      onEvent({ type: 'dsh:frame', stream: kind, frameType, eventType })
      if (kind === 'mux') pumpMuxFrame(frame as MuxFrame, envelope.rpcId)
      else pumpHostFrame(frame as HostFrame)
    }
  }

  /** mux 帧 → 语义事件(阶段 2:turn 生命周期;阶段 3:审批;B2:会话活动增量;历史浮层:重要摘要;0039:推理段)。 */
  function pumpMuxFrame(frame: MuxFrame, rpcId: string): void {
    switch (frame.type) {
      case 'session/event': {
        const event = frame.event
        const sessionId = String(frame.sessionId)
        if (event.type === 'turn/start') {
          onEvent({ type: 'dsh:turn-start', sessionId })
          // B2 雷达:turn/start → running,带服务端事件时间
          onEvent({ type: 'dsh:session-update', sessionId, running: true, reason: null, time: event.time })
        }
        if (event.type === 'turn/end') {
          // 0039:turn 结束先收尾未关闭的推理段,再发 turn-end(顺序保证 renderer 先判段后切状态)
          emitThinkingEnd(sessionId, event.time)
          const reason = event.data.reason.kind
          onEvent({ type: 'dsh:turn-end', reason, sessionId })
          onEvent({ type: 'dsh:session-update', sessionId, running: false, reason, time: event.time })
        }
        // 0039 推理段检测:reasoning 块进入 = 段开始;非 reasoning 块(文本/工具调用/…)
        // 开始或 step 结束 = 段结束。一次 turn 可含多段,各段独立触发思考表情。
        if (event.type === 'assistant/chunk') {
          const chunk = event.data.chunk
          if (chunk.type === 'block-start') {
            if (chunk.blockType === 'reasoning') emitThinkingStart(sessionId, event.time)
            else emitThinkingEnd(sessionId, event.time)
          } else if (chunk.type === 'reasoning-delta') {
            // 兜底:部分适配器不发射 reasoning block-start,首个 delta 即段起点
            emitThinkingStart(sessionId, event.time)
          }
        }
        if (event.type === 'step/end') emitThinkingEnd(sessionId, event.time)
        // 0042 右上角操作通知:除 think 外的全部工具调用(Read/Edit/Glob/…)。
        // think(推理)不通知 —— 推理 delta 是模型内部活动,通知只会刷屏。
        if (event.type === 'tool/call') {
          const name = String(event.data.name)
          if (!/^think$/i.test(name)) {
            onEvent({ type: 'dsh:tool-call', sessionId, callId: String(event.data.callId), name })
          }
        }
        // 最近对话浮层:只推目标会话的重要消息摘要(噪音已在 summary.ts 过滤)
        if (isTargetSession(sessionId)) {
          const entry = summaryEntryOf(event, toolNames)
          if (entry) onEvent({ type: 'dsh:summary-update', sessionId, entry })
        }
        break
      }
      case 'approval/requested': {
        // approval/requested 是 answerable server-request:rpcId 是稳定的对账键,
        // 回包(approval:allowed-once/rejected)必须 echo 它。
        const ev: PetEvent = {
          type: 'approval:pending',
          rpcId: String(rpcId),
          sessionId: String(frame.sessionId),
          approvalId: String(frame.approvalId),
          toolName: frame.toolName,
        }
        if (frame.callId !== undefined) ev.callId = String(frame.callId)
        if (frame.reason !== undefined) ev.reason = frame.reason
        onEvent(ev)
        break
      }
      case 'approval/resolved': {
        onEvent({
          type: 'approval:resolved',
          sessionId: String(frame.sessionId),
          approvalId: String(frame.approvalId),
          outcome: frame.outcome,
        })
        break
      }
      default:
        break
    }
  }

  /** host 帧 → 语义事件(阶段 3:agent 错误)。 */
  function pumpHostFrame(frame: HostFrame): void {
    if (frame.type === 'host/agent-error') {
      onEvent({ type: 'agent:error', sessionId: String(frame.sessionId), message: frame.message })
    }
  }

  async function loop(): Promise<void> {
    let attempt = 0
    while (running) {
      const generation = new AbortController()
      generationAbort = generation
      // 新代增量流从头开始,tool/call → tool/result 配对也从头来;
      // 推理段状态同理重置(重连后段起点重新由 reasoning 块判定)
      toolNames.clear()
      reasoningSessionId = null
      try {
        // 握手:host.describe 证明上行可达(成功后下行流已在途)
        const describeResponse = await api.host.describe({}, generation.signal)
        const describe = describeResponse.result
        if (!describe.ok) {
          throw new Error(`host.describe failed: ${JSON.stringify(describe.error)}`)
        }
        // 下行:两条 WS 流(全部会话聚合 mux + 全局 host)
        const mux = api.events.mux({}, generation.signal)
        const host = api.events.host({}, generation.signal)
        description = describe.value
        attempt = 0
        emitState('connected')
        onEvent({ type: 'dsh:connected', description: describe.value })
        await Promise.all([pump(mux, 'mux'), pump(host, 'host')])
        // 流正常结束(未被 stop 中止)视为断线,进入重连
        if (!generation.signal.aborted) throw new Error('event stream ended')
      } catch (error) {
        if (!running || generation.signal.aborted) break
        description = null
        emitState('reconnecting')
        console.error('[pet] connection generation failed:', error)
        attempt += 1
        const cap = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
        await sleep(cap + Math.random() * cap)
      }
    }
  }

  return {
    start(): void {
      if (running) return
      running = true
      void loop()
    },
    stop(): void {
      running = false
      generationAbort?.abort()
    },
    state: () => ({ connection: currentState, description }),
    api,
  }
}

function describeFrame(
  frame: MuxFrame | HostFrame,
): { frameType: string; eventType: string | null } {
  const frameType = (frame as { type?: string }).type ?? 'unknown'
  if (frameType === 'session/event') {
    return { frameType, eventType: (frame as { event?: { type?: string } }).event?.type ?? null }
  }
  return { frameType, eventType: null }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
