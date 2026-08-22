/**
 * 阶段 4:宠物侧 MCP server(stdio 传输,独立进程)。
 *
 * 由 DSH 的 mcp-client 插件 spawn(`command: node, args: [out/main/mcp-server.js]`),
 * 通过 stdin/stdout JSON-RPC 与 DSH 通信。DSH Agent 调用 `mcp__pet__setExpression` /
 * `mcp__pet__notify` 等工具时,本进程把动作 POST 到宠物主进程的 loopback bridge(见 ./bridge.ts),
 * 主进程翻译成 PetEvent 推给 renderer —— 宠物变表情/弹通知。
 *
 * 端口发现:bridge 监听 loopback 固定端口(环境变量 PET_BRIDGE_PORT 可覆盖),
 * 默认 39761。主进程与 MCP server 约定一致;同机 loopback 受信。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { BRIDGE_PATH, resolveBridgePort, type PetBridgeResult } from '../../shared/mcp-bridge.ts'

/** 调用主进程 bridge;端口与主进程约定一致(shared/mcp-bridge.ts)。 */
function bridgeBaseUrl(): string {
  return `http://127.0.0.1:${resolveBridgePort()}`
}

/** 调用主进程 bridge,返回 MCP 工具结果文本;失败返回错误文本(不抛,让 Agent 看到原因)。 */
async function callBridge(action: unknown): Promise<string> {
  const response = await fetch(`${bridgeBaseUrl()}${BRIDGE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
    // loopback 受信;给足超时避免挂死 Agent 的工具调用
    signal: AbortSignal.timeout(5000),
  })
  const result = (await response.json()) as PetBridgeResult
  if (!response.ok || !result.ok) {
    const error = (result as { error?: string }).error
    return `[pet bridge] ${error ?? `HTTP ${response.status}`}`
  }
  return result.text
}

export async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'dsh-seekbuddy', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  )

  server.registerTool(
    'setExpression',
    {
      title: 'Pet Set Expression',
      description: '切换桌面宠物的表情状态。state 取值: idle 待机 / thinking 思考 / happy 开心 / sad 难过 / talking 说话。',
      inputSchema: { state: z.enum(['idle', 'thinking', 'happy', 'sad', 'talking']).describe('目标表情状态') },
    },
    async ({ state }) => {
      const reply = await callBridge({ kind: 'expression', state })
      return { content: [{ type: 'text', text: reply }] }
    },
  )

  server.registerTool(
    'notify',
    {
      title: 'Pet Notify',
      description: '让桌面宠物弹出系统通知。title 为通知标题,body 为通知正文。',
      inputSchema: {
        title: z.string().describe('通知标题'),
        body: z.string().describe('通知正文'),
      },
    },
    async ({ title, body }) => {
      const reply = await callBridge({ kind: 'notify', title, body })
      return { content: [{ type: 'text', text: reply }] }
    },
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // 不主动退出:生命周期由 DSH 端 stdio 关闭驱动
}

// 独立进程入口(electron-vite 多入口输出 out/main/mcp-server.js,由 DSH spawn)。
// 不设置 import.meta.url 守卫:本文件不会被主进程 index.ts 引用,顶层执行即入口。
void main().catch((error) => {
  console.error('[pet] mcp server failed:', error)
  process.exit(1)
})
