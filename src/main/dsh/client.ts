import { randomUUID } from 'node:crypto'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type { HostFrame, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import WebSocket from 'ws'

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
 * - 基址:阶段 5 起由调用方注入 getter(读持久化配置),支持运行时改 DSH 地址。
 */
export class DshApiClient extends AbstractApiClient {
  constructor(private readonly getBaseUrl: () => string) {
    super()
  }

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init)
  }

  protected override resolveBase(): string {
    return this.getBaseUrl()
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

  /**
   * 执行一条会话斜杠命令(如 `/permission danger-full-access`)。
   *
   * 走 Host 的 Typert Remote `commands/execute`(POST {base}/api/commands/execute,
   * 与浏览器 `ctx.remote.commands.execute` 同一 wire 格式):命令经命令注册表执行,
   * 只写领域事件、不会作为用户消息发给模型。无法执行(部署未挂载命令服务/命令不存在)
   * 时返回 ok:false,调用方按尽力而为处理。
   */
  async runCommand(sessionId: string, line: string): Promise<{ ok: boolean; summary: string }> {
    try {
      const url = new URL('/api/commands/execute', this.resolveBase())
      const message: ClientRequest = {
        type: 'client-request',
        rpcId: RpcId(randomUUID()),
        method: 'commands/execute',
        payload: { args: { agentId: sessionId, line } },
      }
      const response = await this.doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })
      if (!response.ok) return { ok: false, summary: `HTTP ${response.status}` }
      const full = serverResponseSchema.parse(await response.json())
      if (!full.result.ok) {
        return { ok: false, summary: full.result.error.code }
      }
      return { ok: true, summary: JSON.stringify(full.result.value) ?? 'ok' }
    } catch (error) {
      return { ok: false, summary: String(error) }
    }
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
