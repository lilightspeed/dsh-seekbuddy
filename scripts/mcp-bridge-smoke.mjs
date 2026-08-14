/**
 * 阶段 4 临时验证脚本(不入库):模拟 DSH mcp-client 的 stdio 连接,
 * 调用宠物 MCP server 的 speak / setExpression / notify 三个工具,
 * 确认链路:DSH 侧调用 → MCP server → bridge → 宠物窗口表现。
 *
 * 用法:node scripts/mcp-bridge-smoke.mjs [speak|expression|notify|all]
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const serverScript = join(root, 'out', 'main', 'mcp-server.js')
const which = process.argv[2] ?? 'all'

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverScript],
  env: { ...process.env, PET_BRIDGE_PORT: '39761' },
})

const client = new Client({ name: 'bridge-smoke', version: '0.0.1' })
await client.connect(transport)

const tools = await client.listTools()
console.log('tools:', tools.tools.map((t) => t.name).join(', '))

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content.map((c) => c.text ?? '').join('')
  console.log(`${name}(${JSON.stringify(args)}) ->`, text)
}

if (which === 'speak' || which === 'all') await call('speak', { text: '你好!我是宠物,收到 Agent 的消息了 🐾' })
if (which === 'expression' || which === 'all') await call('setExpression', { state: 'happy' })
if (which === 'notify' || which === 'all') await call('notify', { title: '阶段 4 验证', body: 'MCP 反向链路打通!' })

await client.close()
console.log('done')
