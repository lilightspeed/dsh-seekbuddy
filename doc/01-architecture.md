# 01 · 架构设计

## 1. 定位:宠物是什么

DSH 的运行时由两部分组成:

- **Host**:跑在 Node.js 进程里,承载所有能力(Agent、会话、工具、审批、持久化、动态 Cordis 插件、模型路由)。
- **Client**:浏览器里的 Web GUI,通过 `/api` + WebSocket 与 Host 通信。

本项目把"桌面宠物"做成 **DSH 的第二个客户端**:一个独立的 Electron 原生窗口,直接消费 Host 已经暴露给浏览器的那套 `/api` + WebSocket 协议。它和 Web GUI 是**平级关系**,不是 Web GUI 的附属,也不是 Agent 的附属。

## 2. 三层架构

```
┌───────────────────────────────────────────────────────────────┐
│  宠物进程 (Electron, 独立于 DSH 窗口)                          │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 表现层 (renderer)                                        │  │
│  │  · 角色渲染: Live2D(官方 Cubism SDK,独立 canvas)+      │  │
│  │            PixiJS 占位球宠(回落)                        │  │
│  │  · 状态机: XState (idle/thinking/happy/sad/talking)     │  │
│  │  · UI: vanilla DOM(气泡/输入条/面板;React 未引入)       │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ 控制层 (main)                                            │  │
│  │  · 窗口/托盘/全局快捷键/通知/开机自启                     │  │
│  │  · MCP server(被 Agent 调用的工具)                       │  │
│  └─────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ DSH 客户端层 (核心复用层)                                │  │
│  │  · 复用 @deepseek-ai/dsh-client-connection/client        │  │
│  │  · 复用 @deepseek-ai/dsh-host-apiproxy                   │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬───────────────────────────────┘
                                │ ① POST /api/<namespace>/<method>   (上行)
                                │ ② WS  /api/events.mux             (下行·会话)
                                │ ③ WS  /api/events.host            (下行·全局)
                                │ ④ MCP (stdio / streamable HTTP)   (反向·Agent→宠物)
                                ▼
                    已运行的 DSH Host (127.0.0.1:3080)
```

## 3. 四条链路

### ① 上行:宠物操作 DSH
`POST /api/<namespace>/<method>`,JSON 请求体 → Host 的 `client-connection` 插件 → `apiProxy`/`typertGateway` → 真实 Host Service 方法。这是"宠物能控制 DSH 绝大部分操作"的来源。

### ②③ 下行:DSH 推送状态给宠物
两条 WebSocket:

- `/api/events.mux`:会话级多路帧(某次对话的 token 流、工具调用、消息)。
- `/api/events.host`:全局 host 帧(连接状态、host 级事件)。

宠物订阅后把事件翻译成表现:`agent 忙碌 → 思考动作`、`需要审批 → 敲门冒泡`、`报错 → 变脸`、`完成 → 提示音`。

### ④ 反向:Agent 驱动宠物(已落地)
宠物内跑一个 MCP server,暴露 `pet.setExpression / pet.notify` 等工具(经主进程 loopback bridge,见 04 篇)。DSH 的 `mcp-client` 插件连接它,把工具注册成 `mcp__<serverName>__<toolName>`。于是 Agent 在回答过程中能反过来让宠物"做动作/弹提醒",形成三方互动闭环。

## 4. 信任边界(为什么宠物能拿到 Web GUI 同级权限)

`client-connection` 的信任栅栏(`packages/client/connection/src/index.ts`):

- loopback(`127.0.0.1` / `localhost`)默认**受信**。
- 非 loopback 部署需要额外声明 `trustedHosts`。
- 特权方法(settings/credentials/agentPreset/打开目录等)即使受信也**额外锁 loopback**,清单见 `PRIVILEGED_METHODS`。

宠物进程跑在本机、连 `127.0.0.1`,因此天然是受信客户端,权限与浏览器页面完全一致,不需要另开洞、不需要改信任配置。**这要求宠物始终连 loopback,不要部署到远端。**

## 5. 两条"深链接"路线的取舍(重要)

| 路线 | 说明 | 宠物用不用 |
|---|---|---|
| **A. 连已运行实例**(`/api` + WS) | 宠物要控制的"那个正在跑的 DSH 窗口/实例" | ✅ **用它** |
| B. 内嵌/无头 SDK(stdio JSON-RPC) | `@deepseek-ai/dsh-sdk-*`:`HarnessClient` 自己 spawn 一个全新 harness 子进程跑 Agent | ❌ 不用(它是另一个独立运行时,不是连到已运行实例) |

## 6. 组件职责划分

| 组件 | 职责 | 属于哪一半 |
|---|---|---|
| DSH 客户端层 | 握手、重连、调用 `/api`、订阅事件、序列化/反序列化 | **主进程**(`dsh/connection.ts`,Node 载体;renderer 不直连 DSH) |
| 事件总线 | 把 DSH 帧/事件归一化成内部 `PetEvent`,推给状态机和 UI | 主进程 → renderer(经 contextBridge) |
| 状态机 (XState) | 定义宠物状态与迁移,事件 → 动作 | renderer |
| 表现层 | 角色渲染、气泡、面板 | renderer |
| MCP server | 把宠物能力暴露成 MCP 工具 | 主进程 |
| 桌面能力 | 托盘、快捷键、通知、自启、窗口管理 | 主进程 |

## 7. 关键设计原则

1. **协议零自造**:所有 DSH 交互都走仓库已有的 client 包与 `/api` 协议,不自己发明 RPC。
2. **类型当契约**:调用面全部 import 仓库 client 类型,禁止手写接口类型。
3. **表现与逻辑分离**:DSH 事件先进状态机,状态机再驱动动画;不要在动画回调里直接调 `/api`。
4. **主进程承载一切系统/网络能力**,renderer 只拿白名单(经 `contextBridge`),避免安全面扩大。
