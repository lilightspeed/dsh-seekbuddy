import type { HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionState, HostDescription, PetEvent } from '../../shared/pet-event.ts'
import { DshApiClient } from './client.ts'

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
 */
export function createConnection(
  onEvent: (event: PetEvent) => void,
  getBaseUrl: () => string,
): ConnectionHandle {
  const api = new DshApiClient(getBaseUrl)
  let running = false
  let currentState: ConnectionState | null = null
  let description: HostDescription | null = null
  let generationAbort: AbortController | undefined

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

  /** mux 帧 → 语义事件(阶段 2:turn 生命周期;阶段 3:审批;B2:会话活动增量)。 */
  function pumpMuxFrame(frame: MuxFrame, rpcId: string): void {
    switch (frame.type) {
      case 'session/event': {
        const event = frame.event
        if (event.type === 'turn/start') {
          onEvent({ type: 'dsh:turn-start', sessionId: String(frame.sessionId) })
          // B2 雷达:turn/start → running,带服务端事件时间
          onEvent({ type: 'dsh:session-update', sessionId: String(frame.sessionId), running: true, reason: null, time: event.time })
        }
        if (event.type === 'turn/end') {
          const reason = event.data.reason.kind
          onEvent({ type: 'dsh:turn-end', reason, sessionId: String(frame.sessionId) })
          onEvent({ type: 'dsh:session-update', sessionId: String(frame.sessionId), running: false, reason, time: event.time })
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
