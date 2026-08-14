import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import WebSocket from 'ws'

/** DSH 运行实例基址(loopback 受信,权限与 Web GUI 同级;不要改到非 loopback)。 */
export const DSH_BASE_URL = 'http://127.0.0.1:3080'
/** 下行事件流路径(与 packages/client/connection/src/api-path.ts 一致)。 */
export const MUX_EVENTS_PATH = '/api/events.mux'
export const HOST_EVENTS_PATH = '/api/events.host'

type SocketItem<F> = { kind: 'frame'; envelope: RpcRequest<F> } | { kind: 'end' }
type Parser<F> = { parse(value: unknown): F }

/**
 * 主进程 DSH 载体:继承 @deepseek-ai/dsh-host-apiproxy/client 的 AbstractApiClient
 * (该包在 Node 下可运行;@deepseek-ai/dsh-client-connection/client 是纯浏览器包,Node 加载即崩)。
 * - 上行:doFetch → 全局 fetch,POST /api/<method>(Node 侧无 CORS)。
 * - 下行:服务端事件流只接受 WebSocket(SSE GET 返回 426 Upgrade Required),
 *   这里用 ws 包实现 WS 读取,帧解析与浏览器 WebApiClient 同一套 schema。
 * - 基址默认取浏览器同源(无 location 时是占位 internal),必须覆写指向运行中的 DSH。
 */
export class DshApiClient extends AbstractApiClient {
  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }

  protected override resolveBase(): string {
    return DSH_BASE_URL
  }

  protected override openMux(
    _payload: unknown,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: unknown,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, hostFrameSchema, onOpen)
  }

  /** WS 下行:onOpen 在连接建立后触发;message → ServerRequest 信封 + 帧 schema 校验 → yield。 */
  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.resolveBase())
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    socket.on('open', () => onOpen?.())
    socket.on('message', (data) => {
      try {
        const full = serverRequestSchema.parse(JSON.parse(String(data)))
        const frame = frameSchema.parse(full.payload)
        enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
      } catch (error) {
        console.error(`[pet] dropping malformed WS frame on ${path}:`, error)
      }
    })
    socket.on('close', () => enqueue({ kind: 'end' }))
    socket.on('error', (error) => {
      console.error(`[pet] ws error on ${path}:`, error)
    })
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.close()
    }
  }
}
