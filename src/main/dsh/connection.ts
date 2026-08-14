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
 * 每代 = host.describe 握手 → 起 mux/host 两条 SSE 流 → 泵帧到 onEvent;
 * 任一流结束/出错 → reconnecting → 指数退避(带抖动)重试。
 * 说明:包的 ConnectionController 是包内私有(经 cordis 插件消费),主进程没有
 * cordis 运行时,这里按 doc 03 §8 的"AbstractApiClient 为基类实现 Node 载体"落地。
 */
export function createConnection(onEvent: (event: PetEvent) => void): ConnectionHandle {
  const api = new DshApiClient()
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
      onEvent({ type: 'dsh:frame', stream: kind, frameType: frameTypeOf(envelope) })
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
        // 下行:两条 SSE 流(全部会话聚合 mux + 全局 host)
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

function frameTypeOf(envelope: RpcRequest<MuxFrame | HostFrame>): string {
  return (envelope.payload as { type?: string }).type ?? 'unknown'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
