# 04 · MCP 集成指南(让 Agent 反驱动宠物)

> 前两篇解决了"宠物控制 DSH + 观察 DSH"。这一篇解决反向链路:**DSH 的 Agent 调用宠物的工具**,让宠物开口说话、做动作、弹提醒。协议用 MCP(Model Context Protocol),DSH 侧已有现成的 `mcp-client` 插件。

## 1. 方向与角色

```
Agent(在 DSH 内) ──MCP──▶ 宠物 MCP server ──▶ 宠物表现层
   (工具调用者/客户端)        (工具提供者/服务器)
```

DSH 是 MCP **客户端**,宠物是 MCP **服务器**。与 03 篇方向相反,二者叠加才是完整双向闭环。

## 2. DSH 侧的现成插件

包名 `@deepseek-ai/dsh-mcp-client`,插件名 `mcp-client`,`inject: ['tools']`。每实例连一个 MCP server,把它列出的工具注册到 `ctx.tools`,命名契约:

```
mcp__<serverName>__<rawToolName>
```

示例:serverName=`pet`,工具 `speak` → 注册为 `mcp__pet__speak`。

工具名归一化规则以 `packages/mcp/mcp-client/src/tools.ts` 为准(`publicToolName`)。

## 3. 在 DSH 的 `cordis.yml` 里接入宠物 MCP server

`mcp-client` 支持两种传输。任选其一,写进 DSH 的 composition。

### 3.1 stdio(宠物作为子进程被拉起)

```yaml
# 示例:配置形状以 @deepseek-ai/dsh-mcp-client 的 Config schema 为准
- id: pet-mcp
  plugin: mcp-client
  config:
    serverName: pet
    command: <启动宠物 MCP 子进程的命令>
    # args / cwd / env 等按实际填写
```

### 3.2 streamable HTTP(宠物常驻,开放一个本地 HTTP 端点)

```yaml
- id: pet-mcp
  plugin: mcp-client
  config:
    serverName: pet
    url: http://127.0.0.1:8777/mcp
```

> 上面是示意。**精确的 config 字段名与 schema 以 `@deepseek-ai/dsh-mcp-client` 的 `Config` 为准**(`packages/mcp/mcp-client/src/index.ts`)。写之前用 `cordis_inspect_query` 或直接读该包 `.d.ts` 核对,不要照抄示意字段。

## 4. 宠物侧实现 MCP server

用官方 SDK(与 DSH 内部依赖同款):

```bash
pnpm add @modelcontextprotocol/sdk@^1.12.0
```

最小骨架(示意,以 SDK 当前 API 为准):

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const server = new McpServer({ name: 'dsh-pet', version: '0.1.0' })

server.registerTool(
  'speak',
  {
    title: '让宠物说话',
    description: '让桌面宠物用气泡或语音说出给定文本',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要说的话' },
        useVoice: { type: 'boolean', description: '是否用语音朗读', default: false },
      },
      required: ['text'],
    },
  },
  async ({ text, useVoice }) => {
    // 转发给表现层:气泡展示 / TTS 朗读
    return { content: [{ type: 'text', text: `已说:${text}` }] }
  },
)
```

> `registerTool` 的确切签名、schema 校验方式、返回 content 结构,以你安装的 `@modelcontextprotocol/sdk` 版本为准。DSH 的 e2e 测试里用的是 `McpServer`(见 `packages/mcp/mcp-client/tests/fixture-server.ts` 与 `mcp-client.e2e.ts`),可作为参考实现。

## 5. 建议暴露给 Agent 的工具集(第一期)

| 工具名 | 作用 | 参数(建议) |
|---|---|---|
| `pet.speak` | 气泡/TTS 说话 | text, useVoice |
| `pet.setExpression` | 切表情 | expression (枚举) |
| `pet.playAnimation` | 播动作 | animation (枚举) |
| `pet.notify` | 系统通知 | title, body |
| `pet.showBubble` | 气泡(不带语音) | text, durationMs |
| `pet.askConfirm` | 弹一个带按钮的确认框,返回用户选择 | question, options |

第二期可加桌面自动化类:`pet.openApp`、`pet.switchWindow`、`pet.openFile` 等——但要评估权限与安全,默认不放危险操作。

## 6. 命名与冲突注意

- `serverName` 必须 `[A-Za-z0-9_-]{1,32}` 且**在活着的 mcp-client 实例间唯一**(源码里有此约束)。
- 注册名会变 `mcp__<serverName>__<rawToolName>`;若与其它 MCP server 或本地工具撞名,注册会失败或冲突,起名时留前缀余量。

## 7. 生命周期

- stdio:宠物 MCP 子进程随 DSH 起停;进程崩溃 DSH `mcp-client` 有重连策略(`reconnect` 配置)。
- streamable HTTP:宠物常驻;DSH 断开会重连。二选一即可;个人项目建议先 stdio(简单),要常驻交互再换 HTTP。

> **本项目实际落地(0008/0011)**:pet 用 **loopback TCP bridge** 而非上面两种直连 —— 主进程在
> `127.0.0.1:39761` 开桥(`mcp/bridge.ts`),打包后的 `out/main/mcp-server.js` 由 DSH 用
> **裸 node stdio** spawn 连回该桥,再经 preload 事件驱动宠物表现。桥本身是进程内转发,不新增网络面。

## 8. 联动示例:一条完整双向闭环

1. 你在宠物气泡里输入"帮我查下今天的天气"。
2. 宠物经 `/api` 把消息发进某个 DSH session。
3. Agent 运行,宠物经 `events.mux` 显示"思考中"动作。
4. Agent 决定播报结果时,调用 `mcp__pet__speak`(text=结果摘要, useVoice=true)。
5. 宠物 TTS 朗读 + 气泡展示,完成"你 → 宠物 → DSH → Agent → 宠物"的闭环。
