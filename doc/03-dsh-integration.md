# 03 · DSH 集成指南(核心)

> 本文是整套技术里最关键的一篇:宠物如何作为"第二个客户端"消费 DSH 已经暴露给浏览器的那套 `/api` + WebSocket 协议。所有结论基于 harness 源码,具体以仓库当前代码为准。

## 1. 先分清两套 SDK(避免踩坑)

| 包 | 作用 | 宠物用不用 |
|---|---|---|
| `@deepseek-ai/dsh-client-connection` + `@deepseek-ai/dsh-host-apiproxy` | **连接"已运行实例"**的浏览器/客户端传输与 API 面 | ✅ **用这个** |
| `@deepseek-ai/dsh-sdk-client` / `-server` / `-protocol` | stdio JSON-RPC,**客户端自己 spawn 一个全新 harness 子进程**(无头/内嵌模型) | ❌ 不用 |

宠物要控制的是"那个正在跑的 DSH"(127.0.0.1:3080 的实例),所以走第一条。

## 2. 依赖与精确导入路径

在 `apps/pet/package.json` 用 `workspace:^` 引用(与仓库其它包一致):

```jsonc
{
  "dependencies": {
    "@deepseek-ai/dsh-client-connection": "workspace:^",
    "@deepseek-ai/dsh-host-apiproxy": "workspace:^",
    "ws": "^8.21.0"
  }
}
```

只 import **client-safe 子路径**,不要 import 包根(包根会拖进 Node/Host 侧代码):

```ts
// 传输与类型
import { ConnectionController } from '@deepseek-ai/dsh-client-connection/client'
import type { IApiClient, ConnectionSinks, ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import { WebApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { AbstractApiClient, resultOf } from '@deepseek-ai/dsh-client-connection/client'

// API 面类型(纯类型,零运行时依赖)
import type { HostApi, SessionsApi, EventsApi, MuxFrame, HostFrame } from '@deepseek-ai/dsh-client-connection/client'
```

> 说明:`@deepseek-ai/dsh-client-connection/client` 里已经 re-export 了 `@deepseek-ai/dsh-host-apiproxy/api` 和 `/client` 的类型与 `AbstractApiClient`/`IApiClient`,大多数情况只需 import 这一个子路径即可。是否还需要直接 import `@deepseek-ai/dsh-host-apiproxy`,以你实际用到的符号所在导出为准。

## 3. 传输层:三个现成组件

### 3.1 `AbstractApiClient` / `IApiClient`
抽象的 API 客户端边界。定义了完整 API 面:`sessions / host / events / workspace / skills / models / goals / settings / credentials / llm / subagents / jobs` 等命名空间。

### 3.2 `WebApiClient`
浏览器载体:上行用 `fetch`,下行用两条 WebSocket。Electron 的 renderer 里有原生 `fetch` + `WebSocket`,所以 **renderer 里可直接复用 `WebApiClient`**。

```ts
// renderer 侧(有 fetch + WebSocket 的上下文)
const api: IApiClient = new WebApiClient({ baseUrl: 'http://127.0.0.1:3080' })
```

### 3.3 `ConnectionController`
在 `IApiClient` 之上封装了:

- 连接握手:`host.describe` 打通上行;
- 两条流 `events.mux` / `events.host` 的建立与读取;
- 断线**指数退避重连**(`backoffBaseMs` / `backoffFactor` / `backoffMaxMs`);
- 状态回调:`onConnected(description)`、`onStateChange('connected' | 'reconnecting')`;
- 帧回调:`onMuxEnvelope`、`onHostEnvelope`。

```ts
const controller = new ConnectionController(api, {
  onConnected(description) { /* 握手成功,拿到 HostDescription */ },
  onMuxEnvelope(envelope) { /* 会话帧 */ },
  onHostEnvelope(envelope) { /* 全局帧 */ },
  onStateChange(state) { /* connected | reconnecting */ },
})
controller.start()          // 幂等;断线会自动重连
// controller.stop()        // 停止并终止当前代际
```

> 框架事件字段:每条帧是 `RpcRequest<MuxFrame>` / `RpcRequest<HostFrame>`,含 `rpcId` 与 `payload`;`payload.type` 区分事件类型(如 `'stream/error'` 需要跳过)。以 `MuxFrame` / `HostFrame` 的联合类型为准。

## 4. 协议面(已核对)

### 4.1 路径常量
来自 `packages/client/connection/src/api-path.ts`:

- `API_PATH = '/api'`
- `MUX_EVENTS_PATH = '/api/events.mux'`(会话级多路帧)
- `HOST_EVENTS_PATH = '/api/events.host'`(全局 host 帧)

### 4.2 上行
`POST /api/<namespace>/<method>`,JSON 请求 → `apiProxy` → `typertGateway` → Host Service 方法。命名空间即 API 面的 `api.<namespace>`。

### 4.3 下行
两条 WebSocket,只读(服务端下行单向下发,客户端不往里面写)。

### 4.4 握手
`host.describe` 证明上行可达;两条 WS 的 `onOpen` 证明下行可达;三者齐了 `ConnectionController` 才触发 `onConnected`。

## 5. 信任边界与权限

- loopback(`127.0.0.1`/`localhost`)默认受信;宠物连 loopback 即与网页同级。
- 特权方法即使受信也锁 loopback(以下来自 `PRIVILEGED_METHODS`):

```
agentPreset.read / copy / openDocument / remove
host.pickDirectory / host.openPath
settings.describe / openDocument / update / replace / mutate
credentials.describe / set / unset
llm.discoverModels
```

含义:宠物**能**调用这些(因为它是 loopback),但不要把它部署到非 loopback 环境。模型目录(`llm.providers` / `llm.models`)刻意不在特权清单里,LAN 客户端可读。

## 6. 宠物需要哪些操作 → 对应哪个命名空间

| 功能 | API 命名空间(以仓库类型为准) |
|---|---|
| 连接/描述 Host | `api.host.describe(...)` |
| 订阅会话/全局事件 | `api.events.mux(...)` / `api.events.host(...)` |
| 会话(创建/列表/发消息/历史) | `api.sessions.*` |
| 工作区/文件 | `api.workspace.*` |
| 技能(skills) | `api.skills.*` |
| 模型(目录/选择/推理档位) | `api.models.*`、`api.llm.*` |
| 目标(goals) | `api.goals.*` |
| 设置/凭据(loopback 特权) | `api.settings.*`、`api.credentials.*` |
| 子 Agent | `api.subagents.*` |
| 任务(jobs) | `api.jobs.*` |

> 具体方法签名以各 `*Api` 类型定义为准(它们都在 `@deepseek-ai/dsh-client-connection/client` 的 re-export 里)。开工前先读这些类型的 `.d.ts`,不要凭印象猜方法名。

## 7. 需要新能力时的三条扩展路径

### 7.1 想让宠物调用一个 DSH 还没有的操作
给 Host 的某个 Service 方法加 `typertRemote` 绑定(`namespace` + `method`),它就会自动变成 `/api/<namespace>/<method>` 端点,两端强类型、走同一信任栅栏。这是"以后方便写 DSH 接口"的核心机制。

### 7.2 宠物私有的 Host 能力
用**动态 Cordis 插件(Host 半)**提供一个带 `typertRemote` 绑定的 Service 最快(临时/会话级);需要全局常驻的能力放 **host composition 的插件行**(持久)。

### 7.3 让 Agent 能调宠物
在 DSH 的 `cordis.yml` 加一个 `mcp-client` 行,指向宠物的 MCP server(见 [04-mcp-integration.md](./04-mcp-integration.md))。

## 8. 传输放在主进程还是 renderer?

| 位置 | 优点 | 缺点 |
|---|---|---|
| renderer(直接用 `WebApiClient`) | 复用浏览器载体,最省事 | renderer 崩溃/刷新会断连;主进程拿不到原始帧 |
| 主进程(Node) | 连接与窗口生命周期一致、更稳 | 需自己基于 `AbstractApiClient` 用 `ws`/`undici` 实现 Node 载体 |

**建议:主进程承载连接**。用 `AbstractApiClient` 为基类实现一个 Node 载体(上行 `undici`/`node:http`,下行 `ws`),事件经 `contextBridge` 以白名单方式推给 renderer。若追求最快 MVP,可先在 renderer 用 `WebApiClient` 跑通,再下沉到主进程。

## 9. 需在实现前核对的点

- 各 `*Api` 命名空间的确切方法签名(读 `lib/types/**/*.d.ts`)。
- `WebApiClient` 构造参数的确切形态(以 `.d.ts` 为准,不臆造字段名)。
- 动态插件/Remote 绑定的具体写法(加载 `cordis-plugin-development` 与 `editing-cordis-compositions` 两个 skill 后再动手)。
