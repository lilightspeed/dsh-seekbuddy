/**
 * 阶段 4 反向链路:DSH Agent → 宠物。
 *
 * 链路:DSH mcp-client(stdio)→ 宠物侧独立 MCP server 进程 → loopback HTTP
 * → 宠物 Electron 主进程 bridge → PetEvent → renderer。
 *
 * 这里定义 MCP server 与主进程 bridge 之间的 HTTP 协议(MCP server 是
 * 被 DSH spawn 的独立进程,不直接 import 主进程代码;两边只共享本协议类型)。
 */

/** 宠物侧 MCP server 支持的语义动作(与 PetEvent 一一对应)。 */
export type PetBridgeAction =
  /** 切换表情状态:idle / thinking / happy / sad / talking。 */
  | { kind: 'expression'; state: 'idle' | 'thinking' | 'happy' | 'sad' | 'talking' }
  /** 系统通知(主进程 Electron Notification)。 */
  | { kind: 'notify'; title: string; body: string }

/** bridge HTTP 响应(MCP 工具结果直接透传)。 */
export type PetBridgeResult =
  | { ok: true; text: string }
  | { ok: false; error: string }

/** MCP server → 主进程 bridge 的请求体。 */
export interface PetBridgeRequest {
  action: PetBridgeAction
}

/** MCP server 调用 bridge 的 HTTP 端点(loopback 受信)。 */
export const BRIDGE_PATH = '/pet/bridge'

/** bridge 默认监听端口(loopback);环境变量 PET_BRIDGE_PORT 可覆盖,两侧约定一致。 */
export const DEFAULT_BRIDGE_PORT = 39761

/** 从环境变量解析 bridge 端口(无效/缺省回退默认值);env 缺省时读 process.env(node 侧)。 */
export function resolveBridgePort(env?: Record<string, string | undefined>): number {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } }
  const source = env ?? g.process?.env ?? {}
  const port = Number(source['PET_BRIDGE_PORT'] ?? '')
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_BRIDGE_PORT
}
