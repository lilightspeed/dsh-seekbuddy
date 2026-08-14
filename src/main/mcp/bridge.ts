import { createServer, type Server } from 'node:http'
import type { PetEvent } from '../../shared/pet-event.ts'
import { BRIDGE_PATH, resolveBridgePort, type PetBridgeAction, type PetBridgeRequest, type PetBridgeResult } from '../../shared/mcp-bridge.ts'

/**
 * 阶段 4 反向链路:宠物主进程的 loopback HTTP bridge。
 *
 * 被 DSH spawn 的独立 MCP server 进程(stdio)收到工具调用后,
 * POST 到本 bridge(127.0.0.1:<port>/pet/bridge),主进程把动作翻译成
 * PetEvent 推给 renderer,并把 MCP 工具结果原样返回。
 *
 * 端口发现:两侧约定同一端口(环境变量 PET_BRIDGE_PORT 可覆盖,默认 39761,
 * 见 shared/mcp-bridge.ts),同机 loopback 受信;不需要跨进程文件协调。
 */

export interface BridgeHandle {
  /** 监听端口。 */
  port: number
  /** 关闭 HTTP server(bridge 生命周期挂在主进程)。 */
  close(): void
}

export function createBridge(onAction: (action: PetBridgeAction) => void): Promise<BridgeHandle> {
  const port = resolveBridgePort()
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== BRIDGE_PATH) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'not found' } satisfies PetBridgeResult))
        return
      }
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
        if (body.length > 1_000_000) {
          res.writeHead(413)
          res.end()
          req.destroy()
        }
      })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as PetBridgeRequest
          const action = parsed.action
          if (!action || typeof action !== 'object' || typeof (action as { kind?: unknown }).kind !== 'string') {
            throw new Error('invalid bridge request: missing action')
          }
          onAction(action)
          const result: PetBridgeResult = { ok: true, text: 'ok' }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (error) {
          const result: PetBridgeResult = { ok: false, error: String(error) }
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        }
      })
      req.on('error', () => {
        res.writeHead(400)
        res.end()
      })
    })

    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        close: () => server.close(),
      })
    })
  })
}

/** 把 bridge 动作翻译成 PetEvent(供 sendPetEvent 转发;notify 额外走系统通知)。 */
export function bridgeActionToEvent(action: PetBridgeAction): PetEvent {
  switch (action.kind) {
    case 'speak':
      return { type: 'pet:speak', text: action.text }
    case 'expression':
      return { type: 'pet:expression', state: action.state }
    case 'notify':
      return { type: 'pet:notify', title: action.title, body: action.body }
  }
}
