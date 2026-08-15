/**
 * 阶段 5 临时验证脚本(不入库):证明打包后的 out/main/mcp-server.js 是自包含
 * bundle —— 用裸 node spawn 它(无 node_modules 兜底),能完成 stdio 握手 +
 * listTools + 工具调用(桥接失败属于预期,证明的是 bundle 本身可执行)。
 *
 * 用法:node scripts/mcp-server-boot-test.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const serverScript = join(root, 'out', 'main', 'mcp-server.js')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverScript],
  // 故意把 PET_BRIDGE_PORT 指向一个无人监听的端口:工具调用应返回错误文本而非崩溃
  env: { ...process.env, PET_BRIDGE_PORT: '39999' },
})

const client = new Client({ name: 'boot-test', version: '0.0.1' })
await client.connect(transport)

const tools = await client.listTools()
console.log('tools:', tools.tools.map((t) => t.name).join(', '))

for (const call of [
  ['speak', { text: 'boot test' }],
  ['setExpression', { state: 'happy' }],
  ['notify', { title: 't', body: 'b' }],
]) {
  const result = await client.callTool({ name: call[0], arguments: call[1] })
  const text = result.content.map((c) => c.text ?? '').join('')
  console.log(`${call[0]} ->`, text.slice(0, 120))
}

await client.close()
console.log('boot-test done: server alive, tools registered, handlers executed')
